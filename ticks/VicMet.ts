/**
 * @file VictoriaMetrics client for writing Kraken ticks ({@link VicMet#dumpTicks}).
 *
 * VictoriaMetrics has no InfluxDB-style databases — one instance per ticks metric prefix
 * (typically `ticks`). Long-retention / low-latency flags live in `deno.jsonc` task `vicmet`.
 */

/** Minimal logger interface matching the subset of `console` used here. */
export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

const TICK_TYPES = ["bid", "bidSize", "ask", "askSize", "last", "lastSize"] as const;
type TickType = (typeof TICK_TYPES)[number];

/** Tick row accepted by {@linkcode VicMet#dumpTicks}. */
export type TickWithSymbol = {
  time: Date;
  symbol?: string;
} & { [K in TickType]?: number };

interface VicMetConstructorParams {
  url: string;
  ticksMetricPrefix?: string;
  logger?: Logger;
}

/** Build `path?query` with support for repeated array params (e.g. `extra_label`). */
function createUrlWithQuery(
  path: string,
  params: Record<string, string | number | string[]> = {},
): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) searchParams.append(key, item.toString());
    } else {
      searchParams.set(key, value.toString());
    }
  }
  return path + (searchParams.size ? "?" + searchParams.toString() : "");
}

export class VicMetError extends Error {
  constructor(
    public method: string,
    public url: string,
    public errorType: string,
    public error: string,
  ) {
    super(`VicMet.${method} error ${errorType} for ${url}: ${error}`);
    this.name = "VictoriaMetricsError";
  }
}

export class VicMet {
  readonly baseUrl: string;
  readonly ticksMetricPrefix: string;
  readonly logger: Logger;
  #dumpTicksInProgress = false;

  /**
   * @param params.url - URL the VictoriaMetrics server is listening at
   * @param [params.ticksMetricPrefix = 'ticks'] - prefix for tick metrics; no trailing `_`
   * @param [params.logger = console] - logger with `debug` / `info` / `warn` / `error`
   */
  constructor({ url, ticksMetricPrefix, logger }: VicMetConstructorParams) {
    this.ticksMetricPrefix = ticksMetricPrefix || "ticks";
    this.logger = logger ?? console;
    this.baseUrl = url + "/api/v1/"; // must end with `/` for URL resolution
  }

  /**
   * GET text from VictoriaMetrics at `path` with `params`.
   *
   * @param path - endpoint relative to {@link baseUrl}, e.g. `export`
   * @param params - query parameters
   */
  async getText(
    path: string,
    params: Record<string, string | number | string[]> = {},
  ): Promise<string> {
    const url = createUrlWithQuery(new URL(path, this.baseUrl).toString(), params);
    this.logger.debug(decodeURIComponent(url));
    const response = await fetch(url);
    // /admin/tsdb/delete_series returns 204 — https://github.com/VictoriaMetrics/VictoriaMetrics/issues/5552#issuecomment-2692246521
    if (response.status === 204) return "";
    if (response.status !== 200) {
      const vmError = await response.text();
      try {
        const vmErrorObject = JSON.parse(vmError);
        throw new VicMetError("getText", url, vmErrorObject.errorType, vmErrorObject.error);
      } catch (e) {
        if (e instanceof VicMetError) throw e;
        // VicMet is inconsistent; some errors are plain text.
        throw new VicMetError(
          "getText",
          url,
          response.status.toString(),
          vmError.replace(/remoteAddr: ".*?";\s*/, "").replace(/\n$/, ""),
        );
      }
    }
    return response.text();
  }

  private async postText(
    path: string,
    params: Record<string, string | number | string[]>,
    payload?: string,
  ): Promise<string | null> {
    const url = createUrlWithQuery(new URL(path, this.baseUrl).toString(), params);
    this.logger.debug(decodeURIComponent(url));
    const response = await fetch(url, {
      method: "POST",
      ...(payload && { body: payload }),
    });
    if (response.status === 204) return null;
    const text = await response.text();
    if (response.status !== 200) throw new VicMetError("postText", path, "TODO", text);
    return text;
  }

  /**
   * Dump ticks into one time series per tick field (`ticks_bid`, `ticks_last`, …).
   *
   * Ticks may be appended to `ticks` while dumping. On success, splices dumped rows off the
   * front of the array. On failure, leaves the array unchanged for retry.
   *
   * Uses `/import/csv` (compact; `/import` JSON has a 10MB default limit).
   *
   * @param params.exchange - exchange label for all ticks
   * @param [params.source] - optional source label (e.g. `"ws"`)
   * @param [params.symbol] - if set, all ticks share this symbol; otherwise each tick needs `.symbol`
   * @param params.ticks - mutable buffer of ticks to dump
   * @returns number of ticks dumped
   */
  async dumpTicks({
    exchange,
    source,
    symbol,
    ticks,
  }: {
    exchange: string;
    source?: string;
    symbol?: string;
    ticks: TickWithSymbol[];
  }): Promise<number> {
    if (!ticks.length) return 0;

    if (this.#dumpTicksInProgress) {
      // Assume caller will retry with a longer buffer; returning 0 avoids concurrent POSTs.
      this.logger.warn(`WARNING: already dumping ticks to ${this.baseUrl}...`);
      return 0;
    }

    this.#dumpTicksInProgress = true;
    const ticksWithSymbol: { [symbol: string]: TickWithSymbol[] } = {};
    if (symbol) ticksWithSymbol[symbol] = ticks;
    else
      for (const t of ticks) {
        if (!t.symbol) throw new Error(`Tick didn't have .symbol: ${JSON.stringify(t)}`);
        if (!(t.symbol in ticksWithSymbol)) ticksWithSymbol[t.symbol] = [];
        ticksWithSymbol[t.symbol]!.push(t);
      }

    const format =
      "1:time:unix_ms," +
      TICK_TYPES.map((t, i) => `${i + 2}:metric:${this.ticksMetricPrefix}_${t}`).join(",");
    let ticksCount = 0;

    try {
      for (const [sym, tix] of Object.entries(ticksWithSymbol)) {
        let csv = "";
        for (const tick of tix) {
          csv += tick.time.getTime() + ",";
          for (const tickType of TICK_TYPES) csv += (tick[tickType] ?? "") + ",";
          csv += "\n";
        }
        const result = await this.postText(
          "import/csv",
          {
            format,
            extra_label: [
              `exchange=${exchange}`,
              ...(source !== undefined ? [`source=${source}`] : []),
              `symbol=${sym}`,
            ],
          },
          csv,
        );
        if (result) throw new Error(`VicMet.dumpTicks: import/csv had something to say: ${result}`);
        ticksCount += tix.length;
      }
      ticks.splice(0, ticksCount);
    } finally {
      this.#dumpTicksInProgress = false;
    }
    return ticksCount;
  }

  /**
   * Flush ingested points so they are queryable immediately.
   * @see https://github.com/VictoriaMetrics/VictoriaMetrics/issues/5555
   */
  async flush(): Promise<void> {
    // GET returns 200 + empty string (POST returns 204) — https://github.com/VictoriaMetrics/VictoriaMetrics/issues/5552#issuecomment-2692246521
    await this.getText("../../internal/force_flush");
  }
}
