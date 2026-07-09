/**
 * @file collect_ws — Monitor live market data for the top 20 traded /USD spot pairs
 * by 24h volume (dynamically discovered at startup via Kraken public REST /Ticker + /AssetPairs)
 * via Kraken's public WebSocket v2 API (ticker for BBO + last, trade for per-trade
 * last+lastSize).
 *
 * Pairs are ranked by approximate notional volume (24h base volume * last price) among
 * online /USD pairs that have leverage enabled and are not stablecoin bases (USDT, USDC, etc.).
 * We follow the official guidance for WS symbols: pull "wsname" from the REST /0/public/AssetPairs response
 * (https://support.kraken.com/articles/360000920306-api-symbols-and-tickers). Two small overrides are applied:
 * - project-canonical label BTC instead of XBT
 * - DOGE instead of XDG because the AssetPairs endpoint incorrectly returns the wsname for XDGUSD as "XDG/USD",
 *   which fails for WS - `{"error":"Currency pair not supported XDG/USD","method":"subscribe","success":false,"symbol":"XDG/USD"}`
 * Falls back to BTC, ETH, SOL /USD on any discovery error.
 *
 * Stores to VictoriaMetrics using the Tick structure and dumpTicks path, with `exchange: 'kraken'` label
 * (e.g. symbol="BTC/USD", exchange="kraken").
 *
 * Uses native Deno WebSocket (no extra deps). Subscribes to both `ticker`
 * (event_trigger=trades, snapshot) and `trade` (snapshot) channels so that:
 * - bid/ask/bidSize/askSize come from ticker updates (only on change)
 * - last/lastSize come from the trade channel (real per-trade events with Kraken's timestamp)
 *
 * Robustness:
 * - lastSnapshot persisted to suppress init burst / duplicate state on restart
 * - periodic flush every 15s via VicMet#dumpTicks
 * - watchdog exits after ~30s silence (for supervisor to restart cleanly)
 * - gap warnings on resume after long silence
 * - periodic "latest prices" logging
 * - final flush + snapshot persist on shutdown
 * - intentional close flag to distinguish expected vs. fatal disconnects
 *
 * Reconnects: on any close/error we exit (supervisor loop in deno task may do `while true; sleep 10`,
 * or systemd unit may have `RestartSec=10s`).
 * Kraken rate limit note: Cloudflare ~150 reconnects / 10min per IP — the sleep + 30s watchdog makes this safe.
 *
 * Usage:
 *   cd ticks && deno task collect
 *
 * Logs and the last-snapshot file are *always* written next to this script
 * (ticks/logs/), using import.meta-derived absolute paths. This works even
 * when invoking from the repo root with an explicit config + full module path.
 *
 * TODO(P2):
 *  - the top 20 is never recalculated, and the script has no reason to exit & be restarted
 *  - if an asset made it into the top 20, then dipped just below when the script was restarted, it will ignored until the next restart (maybe), so the DB ends up with a gap
 *
 * @module collect_ws
 */

import { Logger as TimestampLogger } from "@dandv/timestamp-logger";
import { VicMet, type Logger } from "./VicMet.ts";

/** Broker-independent market data tick. */
export interface Tick {
  time: Date;
  bid?: number;
  bidSize?: number;
  ask?: number;
  askSize?: number;
  last?: number;
  lastSize?: number;
  /** Total volume traded in this tick window, as opposed to {@linkcode lastSize}. */
  lastVol?: number;
}

export interface TickWithSymbol extends Tick {
  symbol?: string;
}

/** Kraken REST /AssetPairs entry (fields we use). */
interface AssetPairEntry {
  status?: string;
  wsname?: string;
  leverage_buy?: number[];
}

/** Kraken REST /Ticker entry (fields we use). */
interface TickerEntry {
  v?: [string, string];
  c?: [string, string];
  o?: string;
}

/** Kraken WS v2 ticker channel update. */
interface WsTickerData {
  symbol?: string;
  timestamp?: string;
  last?: number;
  bid?: number;
  bid_qty?: number;
  ask?: number;
  ask_qty?: number;
  [key: string]: unknown;
}

/** Kraken WS v2 trade channel update. */
interface WsTradeData {
  symbol?: string;
  price?: number | string;
  qty?: number | string;
  timestamp?: string;
}

/** Parsed Kraken WS v2 message (subset of fields we handle). */
interface WsMessage {
  channel?: string;
  method?: string;
  type?: string;
  success?: boolean;
  error?: string;
  result?: unknown;
  data?: Array<WsTickerData | WsTradeData | { system?: string; api_version?: string; version?: string }>;
}

/** Reads a required env var, throwing if missing or empty. */
function requiredEnv(key: string, errMsg?: string): string {
  const value = Deno.env.get(key);
  if (!value) throw new Error(errMsg || `Missing required environment variable: ${key}`);
  return value;
}

// ── Configuration ────────────────────────────────────────────────────

// Compute paths relative to *this script file* (not CWD) so logs + snapshot
// always land next to collect_ws.ts no matter where the process is started from.
const MODULE_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const LOGS_DIR = `${MODULE_DIR}/logs`;

const LOG_VERSION = "v1.1";
const EXCHANGE_ID = "kraken";

const SNAPSHOT_PATH = `${LOGS_DIR}/.collect_ws_last_snapshot.json`;
const FLUSH_INTERVAL_MS = 15_000;
const ACCEPTABLE_MD_GAP_MS = 30_000;
const LOG_PRICES_INTERVAL_MS = 10 * 60_000;

const DEFAULT_PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD"] as const;
const TOP_N = 20;
const STABLE_BASES = new Set([
  "USDT",
  "USDC",
  "DAI",
  "USDE",
  "TUSD",
  "BUSD",
  "GUSD",
  "FDUSD",
  "PYUSD",
  "USDS",
  "RLUSD",
  "USD",
  "USDD",
]);

let PAIRS: readonly string[] = DEFAULT_PAIRS;
type Pair = string;

const ticks: TickWithSymbol[] = [];
const lastSnapshot: { [symbol: string]: Partial<Tick> } = {};

let lastFlushWithData = Date.now();
let lastTickReceived = Date.now();

let ws: WebSocket | null = null;
let intentionallyClosed = false;
let pingTimer: ReturnType<typeof setInterval> | undefined;

// ── Helpers ──────────────────────────────────────────────────────────

async function discoverTopPairs(limit: number = TOP_N): Promise<string[]> {
  try {
    const apRes = await fetch("https://api.kraken.com/0/public/AssetPairs");
    if (!apRes.ok) throw new Error(`AssetPairs ${apRes.status}`);
    const ap = await apRes.json();

    const metaByKey: Record<string, { ws: string; lev: number[] }> = {};
    // Official way to get the WS symbol for a pair: use the "wsname" field returned by the
    // REST /AssetPairs endpoint. See https://support.kraken.com/articles/360000920306-api-symbols-and-tickers
    const WS_SYMBOL_OVERRIDES: Record<string, string> = {
      "XBT/USD": "BTC/USD", // project convention (canonical symbology prefers BTC)
      "XDG/USD": "DOGE/USD", // WS v2 rejects AssetPairs' incorrect "XDG/USD" wsname
    };
    const apResult = (ap.result ?? {}) as Record<string, AssetPairEntry>;
    for (const [key, e] of Object.entries(apResult)) {
      if (e?.status !== "online") continue;
      let wsName = String(e.wsname || "");
      wsName = WS_SYMBOL_OVERRIDES[wsName] ?? wsName;
      if (!wsName.endsWith("/USD")) continue;
      metaByKey[key] = {
        ws: wsName,
        lev: Array.isArray(e.leverage_buy) ? e.leverage_buy : [],
      };
    }

    const tkRes = await fetch("https://api.kraken.com/0/public/Ticker");
    if (!tkRes.ok) throw new Error(`Ticker ${tkRes.status}`);
    const tk = await tkRes.json();

    const cands: Array<{ symbol: string; notional: number }> = [];
    const tkResult = (tk.result ?? {}) as Record<string, TickerEntry>;
    for (const [key, t] of Object.entries(tkResult)) {
      const m = metaByKey[key];
      if (!m || m.lev.length === 0) continue;
      const base = m.ws.split("/")[0];
      if (STABLE_BASES.has(base)) continue;
      const vol = parseFloat(t?.v?.[1] ?? "0");
      const px = parseFloat(t?.c?.[0] ?? t?.o ?? "0");
      if (!(vol > 0 && px > 0)) continue;
      cands.push({ symbol: m.ws, notional: vol * px });
    }

    cands.sort((a, b) => b.notional - a.notional);
    const top = cands.slice(0, limit).map((c) => c.symbol);
    return top.length ? top : [];
  } catch (e) {
    // Discovery is best-effort; caller falls back to DEFAULT_PAIRS.
    console.warn("discoverTopPairs failed:", e instanceof Error ? e.message : e);
    return [];
  }
}


async function flushData(vm: VicMet, logger: Logger): Promise<void> {
  let tickCount = 0;
  if (ticks.length) {
    try {
      tickCount = await vm.dumpTicks({ exchange: EXCHANGE_ID, ticks });
      if (tickCount > 0) {
        const now = Date.now();
        const gapMs = now - lastFlushWithData;
        const threshold = 1.5 * Math.max(FLUSH_INTERVAL_MS, ACCEPTABLE_MD_GAP_MS);
        if (gapMs > threshold) {
          const gapSec = Math.round(gapMs / 1000);
          logger.warn(
            `⚠ Market data collection resumed after ${Math.floor(gapSec / 60)}m${gapSec % 60}s gap`,
          );
        }
        lastFlushWithData = now;
      }
    } catch (e) {
      logger.error(
        `Error flushing ${ticks.length} ticks, will retry:`,
        e instanceof Error ? e.message : e,
      );
      if (ticks.length > 100_000) logger.error(`☢☢☢ CRITICAL: ${ticks.length} unwritten ticks`);
      else if (ticks.length > 50_000) logger.warn(`⚠⚠⚠ ${ticks.length} unwritten ticks`);
    }
  }

  if (tickCount > 0) logger.info(`Flushed ${tickCount} ticks`);
}


function logLastPrices(logger: Logger): void {
  if (Date.now() - lastFlushWithData > LOG_PRICES_INTERVAL_MS) return;

  const lines: string[] = [];
  for (const sym of PAIRS) {
    const snap = lastSnapshot[sym];
    if (!snap?.last) continue;
    const bidSide = snap.bidSize !== undefined ? `${snap.bidSize} x ${snap.bid ?? "?"}` : "?";
    const askSide = snap.ask !== undefined ? `${snap.ask} x ${snap.askSize ?? "?"}` : "?";
    lines.push(
      `  ${sym}: ${bidSide} / ${askSide} | ${snap.lastSize ?? "?"} @ ${snap.last} at ${snap.time?.toISOString() ?? "?"}`,
    );
  }

  if (lines.length) {
    logger.info(`\n── Latest prices ──`);
    for (const line of lines) logger.info(line);
  }
}


async function extractText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return await data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  // @ts-expect-error fallback for TypedArray-like payloads
  if (data?.buffer) return new TextDecoder().decode(data);
  return String(data);
}

function handleTicker(data: WsTickerData): void {
  if (!data?.symbol) return;
  const sym = data.symbol as Pair;
  if (!PAIRS.includes(sym)) return;

  const time = data.timestamp ? new Date(data.timestamp) : new Date();
  const snap = (lastSnapshot[sym] ??= {});

  // Capture last (price only) for logging / snapshot continuity. Real last+size come from trade channel.
  if (typeof data.last === "number") {
    if (data.last !== snap.last) snap.last = data.last;
    if (!snap.time || time > snap.time) snap.time = time;
  }

  // BBO (Best Bid and Offer) state ticks — emit only on change (dedup)
  const bbo: Array<[keyof Tick, keyof WsTickerData]> = [
    ["bid", "bid"],
    ["bidSize", "bid_qty"],
    ["ask", "ask"],
    ["askSize", "ask_qty"],
  ];
  for (const [field, kfield] of bbo) {
    const val = data[kfield];
    if (typeof val !== "number") continue;
    if (field.endsWith("Size") && val < 0) continue;
    if (val !== snap[field]) {
      ticks.push({ symbol: sym, time, [field]: val } as TickWithSymbol);
      (snap as Record<string, unknown>)[field] = val;
      if (!snap.time || time > snap.time) snap.time = time;
    }
  }
}

function handleTrade(trade: WsTradeData): void {
  if (!trade?.symbol) return;
  const sym = trade.symbol as Pair;
  if (!PAIRS.includes(sym)) return;

  const price = Number(trade.price);
  const qty = Number(trade.qty);
  const tsStr: string | undefined = trade.timestamp;
  if (!Number.isFinite(price) || !Number.isFinite(qty) || qty <= 0 || !tsStr) return;

  const time = new Date(tsStr);
  const snap = (lastSnapshot[sym] ??= {});

  // Snapshot trades on (re)connect are historical; skip if not newer than what we already have.
  if (snap.time && time <= snap.time) {
    snap.last = price;
    snap.lastSize = qty;
    return;
  }

  lastTickReceived = Date.now();
  ticks.push({ symbol: sym, time, last: price, lastSize: qty });
  snap.last = price;
  snap.lastSize = qty;
  snap.time = time;
}


async function handleMessage(ev: MessageEvent, logger: Logger): Promise<void> {
  let text: string;
  try {
    text = await extractText(ev.data);
  } catch {
    return;
  }
  let msg: WsMessage;
  try {
    msg = JSON.parse(text) as WsMessage;
  } catch {
    return;
  }

  if (msg.channel === "heartbeat" || msg.method === "pong") return;

  if (msg.channel === "status") {
    const s = msg.data?.[0] as { system?: string; api_version?: string; version?: string } | undefined;
    logger.info(
      `Kraken status: ${s?.system ?? "?"} (api ${s?.api_version ?? "?"}, ws v${s?.version ?? "?"})`,
    );
    return;
  }

  if (msg.method === "subscribe" || msg.method === "unsubscribe") {
    if (msg.success === false)
      logger.error(`Kraken ${msg.method} error: ${msg.error} ${JSON.stringify(msg.result ?? msg)}`);
    return;
  }

  if (msg.channel === "ticker" && msg.type && msg.data?.[0]) {
    handleTicker(msg.data[0] as WsTickerData);
    lastTickReceived = Date.now();
    return;
  }

  if (msg.channel === "trade" && Array.isArray(msg.data)) {
    for (const t of msg.data) handleTrade(t as WsTradeData);
    lastTickReceived = Date.now();
    return;
  }

  if (msg.error) logger.error(`Kraken message error: ${msg.error}`);
}


function subscribeAll(logger: Logger): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const base = { method: "subscribe", params: { symbol: [...PAIRS] } };

  ws.send(
    JSON.stringify({
      ...base,
      params: { ...base.params, channel: "ticker", snapshot: true, event_trigger: "trades" },
    }),
  );
  logger.info("Subscribed to ticker (snapshot + on trades)");

  ws.send(
    JSON.stringify({
      ...base,
      params: { ...base.params, channel: "trade", snapshot: true },
    }),
  );
  logger.info("Subscribed to trade (snapshot for gap backfill + dedup by time)");
}

function startPingLoop(): void {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ method: "ping", req_id: Date.now() }));
  }, 30_000);
}

function stopPingLoop(): void {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = undefined;
  }
}


function connect(logger: Logger, shutdown: () => void): Promise<void> {
  const url = "wss://ws.kraken.com/v2";
  logger.info(`Connecting to ${url}...`);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Kraken WebSocket connection timed out"));
    }, 15_000);

    ws = new WebSocket(url);

    ws.onopen = () => {
      clearTimeout(timeout);
      logger.info("WebSocket connected.");
      subscribeAll(logger);
      startPingLoop();
      resolve();
    };

    ws.onmessage = (ev) => {
      handleMessage(ev, logger).catch((e) =>
        logger.warn("handleMessage error:", e instanceof Error ? e.message : e),
      );
    };

    ws.onerror = (ev) => {
      const m = ev instanceof ErrorEvent ? ev.message : "unknown error";
      logger.error(`WebSocket error: ${m}`);
    };

    ws.onclose = (ev) => {
      clearTimeout(timeout);
      stopPingLoop();
      logger.warn(`WebSocket closed (code=${ev.code}, reason=${ev.reason || "none"})`);
      if (!intentionallyClosed) shutdown();
    };
  });
}

async function main(): Promise<void> {
  try {
    Deno.mkdirSync(LOGS_DIR, { recursive: true });
  } catch {
    /* may already exist; errors surface on first write */
  }

  const logger = new TimestampLogger({
    level: "info",
    filename: `${LOGS_DIR}/collect_ws_${LOG_VERSION}.log`,
  });
  const { promise: keepAlive, resolve: shutdown } = Promise.withResolvers<void>();
  const VICMET_URL = requiredEnv("VICMET_URL");

  // Restore lastSnapshot to suppress restart burst and dedup snapshot trades.
  try {
    const saved: { [label: string]: Partial<Tick> } = JSON.parse(
      Deno.readTextFileSync(SNAPSHOT_PATH),
    );
    for (const [label, snap] of Object.entries(saved)) {
      if (snap.time) snap.time = new Date(snap.time as unknown as string);
      lastSnapshot[label] = snap;
    }
    logger.info(`Restored ${Object.keys(saved).length} snapshots from ${SNAPSHOT_PATH}`);
  } catch {
    // first run or missing file
  }

  logger.info(`VictoriaMetrics target: ${VICMET_URL}`);
  const vm = new VicMet({ url: VICMET_URL, logger: new TimestampLogger({ level: "warn" }) });

  const top = await discoverTopPairs();
  if (top.length > 0) {
    PAIRS = top;
    logger.info(
      `Using top ${PAIRS.length} Kraken /USD pairs by 24h vol (first few: ${PAIRS.slice(0, 3).join(" ")}...)`,
    );
  } else {
    logger.info(`Discovery yielded none or failed; falling back to ${PAIRS.length} defaults`);
  }

  try {
    await connect(logger, shutdown);
  } catch (e) {
    logger.error("Initial connect failed:", e instanceof Error ? e.message : e);
    Deno.exit(1);
  }

  const wsForCleanup: WebSocket = ws!;

  logger.info(
    `Monitoring ${PAIRS.length} pairs (exchange=${EXCHANGE_ID}) via Kraken WS v2 (e.g. ${PAIRS.slice(0, 5).join(", ")}...).`,
  );
  logger.info("Press Ctrl+C **REPEATEDLY** to stop 🛑.");

  const initialLogTimer = setTimeout(() => logLastPrices(logger), 30_000);
  const logPricesTimer = setInterval(() => logLastPrices(logger), LOG_PRICES_INTERVAL_MS);
  const flushTimer = setInterval(() => flushData(vm, logger), FLUSH_INTERVAL_MS);

  const watchdogTimer = setInterval(() => {
    const silenceMs = Date.now() - lastTickReceived;
    if (silenceMs <= ACCEPTABLE_MD_GAP_MS) return;
    const silenceSec = Math.round(silenceMs / 1000);
    logger.warn(`🐕 Watchdog: no ticks for ${silenceSec}s — shutting down for supervisor restart`);
    shutdown();
  }, 1000);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] satisfies Deno.Signal[]) {
    Deno.addSignalListener(signal, () => {
      logger.warn(`Received ${signal}, shutting down...`);
      intentionallyClosed = true;
      shutdown();
    });
  }

  await keepAlive;

  clearInterval(flushTimer);
  clearInterval(watchdogTimer);
  clearTimeout(initialLogTimer);
  clearInterval(logPricesTimer);
  stopPingLoop();

  logger.info("Closing WebSocket...");
  intentionallyClosed = true;
  if (wsForCleanup.readyState === WebSocket.OPEN) {
    const w = wsForCleanup;
    try {
      w.send(
        JSON.stringify({
          method: "unsubscribe",
          params: { channel: "ticker", symbol: [...PAIRS] },
        }),
      );
      w.send(
        JSON.stringify({ method: "unsubscribe", params: { channel: "trade", symbol: [...PAIRS] } }),
      );
    } catch {
      /* ignore */
    }
    w.close();
    await new Promise((r) => setTimeout(r, 150));
  }

  logger.info("Final flush...");
  await flushData(vm, logger);

  try {
    Deno.writeTextFileSync(SNAPSHOT_PATH, JSON.stringify(lastSnapshot));
    logger.info(`Persisted ${Object.keys(lastSnapshot).length} snapshots to ${SNAPSHOT_PATH}`);
  } catch (e) {
    logger.error("Failed to persist snapshots:", e instanceof Error ? e.message : e);
  }

  logger.info("Done.");
}

if (import.meta.main) await main();
