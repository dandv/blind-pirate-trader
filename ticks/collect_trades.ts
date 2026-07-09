/**
 * @file collect_trades — Backfill raw public trades from Kraken REST `/Trades`.
 *
 * Discovers the same top 20 /USD pairs as {@linkcode ./collect_ws.ts}, then for each pair
 * paginates the public trade history from one month ago to now and dumps each print to
 * VictoriaMetrics as a tick (`last` + `lastSize`) with `exchange=kraken` and `source=trades`.
 *
 * No bar aggregation here — the game builds 5s OHLCV in VicMet via PromQL
 * (`first/max/min/last_over_time` on `ticks_last`, `sum_over_time` on `ticks_lastSize`).
 *
 * Why Trades instead of OHLC: `/public/OHLC` only returns the most recent 720 candles
 * (~12 hours at `interval=1`). Month-scale history needs `/public/Trades` (full tape,
 * paginated, 1000 trades per call).
 *
 * One pair per request — Kraken rejects comma-separated `pair` values (`EQuery:Unknown asset pair`).
 *
 * Pagination: see ticks/README.md ("Trades pagination").
 *
 * Usage:
 *   cd ticks && deno task --env-file=../.env collect:trades
 *
 * @module collect_trades
 */

import { Logger as TimestampLogger } from "@dandv/timestamp-logger";
import { DEFAULT_PAIRS, discoverTopPairs } from "./discover_pairs.ts";
import { VicMet, type Logger, type TickWithSymbol } from "./VicMet.ts";

/** Reads a required env var, throwing if missing or empty. */
function requiredEnv(key: string, errMsg?: string): string {
  const value = Deno.env.get(key);
  if (!value) throw new Error(errMsg || `Missing required environment variable: ${key}`);
  return value;
}

const MODULE_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const LOGS_DIR = `${MODULE_DIR}/logs`;
const PROGRESS_PATH = `${LOGS_DIR}/.collect_trades_progress.json`;

const LOG_VERSION = "v1.1";
const EXCHANGE_ID = "kraken";
const SOURCE_ID = "trades";

const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const TRADES_PER_PAGE = 1000;
/** Delay between Trades pages — Kraken recommends 1–2s for bulk historical collection. */
const PAGE_DELAY_MS = 1_200;
const FLUSH_EVERY_TRADES = 2_000;

/** One public trade from `/0/public/Trades` (fields we use). */
type Trade = {
  price: number;
  qty: number;
  /** Trade time in unix seconds (fractional). */
  timeSec: number;
};

type Progress = {
  /** Per-pair nanosecond `since` cursor (string — never Number; float loses ns precision). */
  sinceByPair: { [symbol: string]: string };
};

type KrakenTradesResponse = {
  error: string[];
  result?: {
    last: string;
    [pair: string]: string | Array<[string, string, number, string, string, string, number?]>;
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Unix-seconds start → nanosecond `since` string (Kraken pagination token). */
function sinceFromUnixSec(sec: number): string {
  return `${Math.floor(sec)}000000000`;
}

/** Nanosecond `since` cursor → ISO8601 for logs (truncates to whole seconds). */
function cursorToIso(cursor: string): string {
  const sec = Number(cursor.slice(0, -9) || "0");
  return new Date(sec * 1000).toISOString();
}

function loadProgress(): Progress {
  try {
    const raw = JSON.parse(Deno.readTextFileSync(PROGRESS_PATH)) as Progress & {
      openBarByPair?: unknown;
    };
    // Drop legacy 1m-bar resume state from earlier collector versions.
    return { sinceByPair: raw.sinceByPair ?? {} };
  } catch {
    return { sinceByPair: {} };
  }
}

function saveProgress(progress: Progress): void {
  Deno.writeTextFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));
}

/**
 * Fetch one page of public trades.
 *
 * @param pair - display symbol (`BTC/USD`); we pass `assetVersion=1` so keys match
 * @param since - nanosecond cursor as a **string** (must not be coerced through Number)
 */
async function fetchTradesPage(
  pair: string,
  since: string,
): Promise<{ trades: Trade[]; last: string }> {
  const url = new URL("https://api.kraken.com/0/public/Trades");
  url.searchParams.set("pair", pair);
  url.searchParams.set("since", since);
  url.searchParams.set("count", String(TRADES_PER_PAGE));
  url.searchParams.set("assetVersion", "1");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Trades HTTP ${res.status} for ${pair}`);
  const body = (await res.json()) as KrakenTradesResponse;
  if (body.error?.length) throw new Error(`Trades API ${pair}: ${body.error.join("; ")}`);
  if (!body.result?.last) throw new Error(`Trades API ${pair}: missing result.last`);

  const last = String(body.result.last);
  const trades: Trade[] = [];
  for (const [key, value] of Object.entries(body.result)) {
    if (key === "last" || !Array.isArray(value)) continue;
    for (const row of value) {
      const price = Number(row[0]);
      const qty = Number(row[1]);
      const timeSec = Number(row[2]);
      if (!Number.isFinite(price) || !Number.isFinite(qty) || !Number.isFinite(timeSec)) continue;
      trades.push({ price, qty, timeSec });
    }
  }
  return { trades, last };
}

function tradesToTicks(symbol: string, trades: Trade[], endMs: number): TickWithSymbol[] {
  const ticks: TickWithSymbol[] = [];
  for (const t of trades) {
    const tradeMs = Math.floor(t.timeSec * 1000);
    if (tradeMs >= endMs) break;
    ticks.push({
      symbol,
      time: new Date(tradeMs),
      last: t.price,
      lastSize: t.qty,
    });
  }
  return ticks;
}

async function flushTicks(
  vm: VicMet,
  logger: Logger,
  ticks: TickWithSymbol[],
): Promise<number> {
  if (!ticks.length) return 0;
  const n = await vm.dumpTicks({ exchange: EXCHANGE_ID, source: SOURCE_ID, ticks });
  if (n > 0) logger.info(`Flushed ${n} trades`);
  return n;
}

/**
 * Backfill one pair from `since` until `endMs`.
 *
 * @returns final nanosecond cursor
 */
async function backfillPair(
  pair: string,
  since: string,
  endMs: number,
  vm: VicMet,
  logger: Logger,
  onProgress: (cursor: string) => void,
): Promise<string> {
  let cursor = since;
  let pending: TickWithSymbol[] = [];
  let pages = 0;
  let tradeCount = 0;

  logger.info(
    `${pair}: starting from since=${cursorToIso(cursor)} until ${new Date(endMs).toISOString()}`,
  );

  while (true) {
    let trades: Trade[];
    let last: string;
    try {
      ({ trades, last } = await fetchTradesPage(pair, cursor));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/Rate limit|Throttled/i.test(msg)) {
        logger.warn(`${pair}: rate limited — sleeping 5s (${msg})`);
        await sleep(5_000);
        continue;
      }
      throw e;
    }

    pages++;
    if (!trades.length) {
      logger.info(`${pair}: empty page at since=${cursorToIso(cursor)} — done`);
      break;
    }

    const reachedEnd = trades.some((t) => t.timeSec * 1000 >= endMs);
    const ticks = tradesToTicks(pair, trades, endMs);
    tradeCount += ticks.length;
    pending.push(...ticks);

    if (pending.length >= FLUSH_EVERY_TRADES) {
      await flushTicks(vm, logger, pending);
      pending = [];
    }

    if (last === cursor) {
      logger.info(`${pair}: cursor did not advance (last=${cursorToIso(last)}) — done`);
      break;
    }
    cursor = last;
    onProgress(cursor);

    if (reachedEnd) break;

    if (pages % 50 === 0) {
      logger.info(`${pair}: ${pages} pages, ${tradeCount} trades, cursor=${cursorToIso(cursor)}`);
    }

    await sleep(PAGE_DELAY_MS);
  }

  await flushTicks(vm, logger, pending);
  logger.info(`${pair}: finished — ${pages} pages, ${tradeCount} trades`);
  return cursor;
}

async function main(): Promise<void> {
  try {
    Deno.mkdirSync(LOGS_DIR, { recursive: true });
  } catch {
    /* may already exist */
  }

  const logger = new TimestampLogger({
    level: "info",
    filename: `${LOGS_DIR}/collect_trades_${LOG_VERSION}.log`,
  });
  const VICMET_URL = requiredEnv("VICMET_URL");
  const endMs = Date.now();
  const startMs = endMs - LOOKBACK_MS;
  const defaultSince = sinceFromUnixSec(startMs / 1000);

  logger.info(`VictoriaMetrics target: ${VICMET_URL}`);
  logger.info(
    `Backfill window: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()} (raw trades)`,
  );

  const vm = new VicMet({ url: VICMET_URL, logger: new TimestampLogger({ level: "warn" }) });

  const top = await discoverTopPairs();
  const pairs = top.length > 0 ? top : [...DEFAULT_PAIRS];
  if (top.length > 0) {
    logger.info(
      `Using top ${pairs.length} Kraken /USD pairs (first few: ${pairs.slice(0, 3).join(" ")}...)`,
    );
  } else {
    logger.info(`Discovery yielded none or failed; falling back to ${pairs.length} defaults`);
  }

  const progress = loadProgress();

  for (const pair of pairs) {
    const since = progress.sinceByPair[pair] ?? defaultSince;
    // Skip pairs already past the window (resume after a completed run).
    const sinceSec = Number(since.slice(0, -9) || "0");
    if (sinceSec * 1000 >= endMs) {
      logger.info(`${pair}: already complete through ${new Date(sinceSec * 1000).toISOString()}`);
      continue;
    }

    try {
      progress.sinceByPair[pair] = await backfillPair(
        pair,
        since,
        endMs,
        vm,
        logger,
        (cursor) => {
          progress.sinceByPair[pair] = cursor;
          saveProgress(progress);
        },
      );
      saveProgress(progress);
    } catch (e) {
      saveProgress(progress);
      logger.error(`${pair}: aborted:`, e instanceof Error ? e.message : e);
      throw e;
    }
  }

  await vm.flush();
  logger.info("Done.");
}

if (import.meta.main) await main();
