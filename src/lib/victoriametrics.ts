/**
 * VictoriaMetrics data layer for the trading sim.
 * Browser talks to the CORS-enabled vmauth gateway directly (dev and Pages).
 * Base URL comes from VICMET_BASE in `.env` (exposed via vite `envPrefix`).
 */
const VICMET_BASE = import.meta.env.VICMET_BASE;
if (!VICMET_BASE) {
  throw new Error("VICMET_BASE is not set; add it to .env");
}
const EXCHANGE = "kraken";

/**
 * Which tick feed to read.
 * - `trades` — REST `/Trades` backfill (`source="trades"`)
 * - `ws` — live WS collector (legacy series have no `source` label; also matches `source="ws"`)
 */
export type TickSource = "trades" | "ws";

export const TICK_SOURCES = ["trades", "ws"] as const satisfies readonly TickSource[];

export interface Candle {
  /** Unix seconds (UTC) at the open of the bar. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Notional traded volume for the bar (sum of ticks_lastSize). */
  volume: number;
}

export interface SeriesBundle {
  symbol: string;
  stepSec: number;
  candles: Candle[];
}

interface VmMatrixSeries {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

interface VmRangeResponse {
  status: string;
  data?: {
    resultType: string;
    result: VmMatrixSeries[];
  };
  error?: string;
  errorType?: string;
}

interface VmVectorResponse {
  status: string;
  data?: {
    resultType: string;
    result: Array<{ metric: Record<string, string>; value: [number, string] }>;
  };
  error?: string;
}

const log = {
  info: (...a: unknown[]) => console.info("[vm]", ...a),
  warn: (...a: unknown[]) => console.warn("[vm]", ...a),
  error: (...a: unknown[]) => console.error("[vm]", ...a),
};

/**
 * PromQL label fragment selecting one feed.
 * WS legacy series omit `source`; `source!="trades"` covers those and future `source="ws"`.
 */
export function sourceSelector(source: TickSource): string {
  return source === "trades" ? ',source="trades"' : ',source!="trades"';
}

async function vmFetch<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) usp.set(k, String(v));
  const url = `${VICMET_BASE}${path}?${usp.toString()}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "GET" });
  } catch (e) {
    log.error("network error", url, e);
    throw new Error(`Failed to reach VictoriaMetrics at ${VICMET_BASE}. Check your network.`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    log.error("http error", res.status, url, "\nbody:", text);
    throw new Error(`VictoriaMetrics responded ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { status: string; error?: string };
  if (json.status !== "success") {
    log.error("vm error", json);
    throw new Error(`VictoriaMetrics query failed: ${json.error ?? "unknown error"}`);
  }
  return json as T;
}

/** Lists all symbols traded on Kraken that have ticks recorded for `source`. */
export async function listKrakenSymbols(source: TickSource = "trades"): Promise<string[]> {
  const res = await vmFetch<{ status: string; data: Array<Record<string, string>> }>(
    "/api/v1/series",
    { "match[]": `ticks_last{exchange="${EXCHANGE}"${sourceSelector(source)}}` },
  );
  const symbols = res.data
    .map((s) => s.symbol)
    .filter((s): s is string => Boolean(s))
    // Drop futures / non-spot lookalikes that contain spaces.
    .filter((s) => /^[A-Z0-9]+\/USD$/.test(s));
  if (symbols.length === 0) throw new Error("No Kraken USD pairs returned by VictoriaMetrics.");
  return [...new Set(symbols)].sort();
}

/** Returns the most recent sample epoch (seconds) for the symbol, or null. */
export async function latestSampleTime(
  symbol: string,
  source: TickSource = "trades",
): Promise<number | null> {
  // Instant selectors only return a sample within VM's staleness window (~5m).
  // REST backfill (`source=trades`) can lag hours behind "now", so use
  // tlast_over_time to get the actual last sample timestamp.
  const res = await vmFetch<VmVectorResponse>("/api/v1/query", {
    query: `tlast_over_time(ticks_last{symbol="${symbol}",exchange="${EXCHANGE}"${sourceSelector(source)}}[30d])`,
  });
  const v = res.data?.result?.[0]?.value;
  return v ? Number(v[1]) : null;
}

/**
 * Probes backwards from `latest` to discover the earliest available sample time.
 * Uses an expanding-window scan over candidate offsets in hours.
 */
export async function earliestSampleTime(
  symbol: string,
  latest: number,
  source: TickSource = "trades",
): Promise<number> {
  const candidates = [3600, 6 * 3600, 12 * 3600, 24 * 3600, 36 * 3600, 48 * 3600, 72 * 3600];
  let deepest = candidates[0];
  const sel = `ticks_last{symbol="${symbol}",exchange="${EXCHANGE}"${sourceSelector(source)}}`;
  for (const offset of candidates) {
    const start = latest - offset;
    const data = await vmFetch<VmRangeResponse>("/api/v1/query_range", {
      query: sel,
      start,
      end: start + 600,
      step: "60000ms",
    });
    const found = (data.data?.result?.[0]?.values?.length ?? 0) > 0;
    if (found) deepest = offset;
    else break;
  }
  return latest - deepest;
}

/**
 * Fetch OHLCV candles for the given symbol and time range.
 * Issues 5 queries in parallel: open / high / low / close / volume.
 */
export async function fetchOhlcv(
  symbol: string,
  startSec: number,
  endSec: number,
  stepSec: number,
  source: TickSource = "trades",
): Promise<Candle[]> {
  const stepMs = `${stepSec * 1000}ms`;
  const src = sourceSelector(source);
  const baseSel = `ticks_last{symbol="${symbol}",exchange="${EXCHANGE}"${src}}`;
  const sizeSel = `ticks_lastSize{symbol="${symbol}",exchange="${EXCHANGE}"${src}}`;
  const rng = `[${stepSec}s]`;
  const queries: Array<[string, string]> = [
    ["open", `first_over_time(${baseSel}${rng})`],
    ["high", `max_over_time(${baseSel}${rng})`],
    ["low", `min_over_time(${baseSel}${rng})`],
    ["close", `last_over_time(${baseSel}${rng})`],
    ["volume", `sum_over_time(${sizeSel}${rng})`],
  ];

  // VictoriaMetrics caps query_range at 30000 points per series. Chunk by
  // time so each sub-request stays under that limit, then merge.
  const MAX_POINTS = 25000;
  const chunkSpan = MAX_POINTS * stepSec;
  const chunks: Array<[number, number]> = [];
  for (let s = startSec; s < endSec; s += chunkSpan) {
    chunks.push([s, Math.min(s + chunkSpan - stepSec, endSec)]);
  }

  const results = await Promise.all(
    queries.map(async ([name, q]) => {
      const perChunk = await Promise.all(
        chunks.map(async ([cs, ce]) => {
          const r = await vmFetch<VmRangeResponse>("/api/v1/query_range", {
            query: q,
            start: cs,
            end: ce,
            step: stepMs,
          });
          return r.data?.result?.[0]?.values ?? [];
        }),
      );
      return [name, perChunk.flat()] as const;
    }),
  );

  const byTime = new Map<number, Partial<Candle> & { time: number }>();
  for (const [name, vals] of results) {
    for (const [t, v] of vals) {
      const time = Number(t);
      const num = Number(v);
      if (!Number.isFinite(num)) continue;
      let row = byTime.get(time);
      if (!row) {
        row = { time };
        byTime.set(time, row);
      }
      (row as Record<string, number>)[name] = num;
    }
  }

  const candles: Candle[] = [];
  for (const row of [...byTime.values()].sort((a, b) => a.time - b.time)) {
    if (row.open == null || row.high == null || row.low == null || row.close == null) continue;
    candles.push({
      time: row.time,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume ?? 0,
    });
  }
  log.info(`fetched ${candles.length} candles for ${symbol} (${source}) @ ${stepSec}s`);
  return candles;
}
