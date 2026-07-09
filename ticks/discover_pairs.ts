/**
 * @file discover_pairs — Rank Kraken /USD spot pairs by 24h notional volume.
 *
 * Used by both the live WS collector and the historical trades backfill.
 *
 * Ranking: approximate notional (24h base volume × last price) among online /USD
 * pairs that have leverage enabled and are not stablecoin bases.
 * Canonical labels come from AssetPairs `wsname`, with two overrides:
 * - BTC instead of XBT (project convention)
 * - DOGE instead of XDG (AssetPairs returns a WS-invalid `XDG/USD` wsname)
 *
 * @module discover_pairs
 */

/** Fallback when discovery fails or yields nothing. */
export const DEFAULT_PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD"] as const;

export const TOP_N = 20;

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

/** Project-canonical labels overriding AssetPairs `wsname`. */
const WS_SYMBOL_OVERRIDES: Record<string, string> = {
  "XBT/USD": "BTC/USD",
  "XDG/USD": "DOGE/USD",
};

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

/**
 * Discover the top `/USD` pairs by 24h notional volume.
 *
 * @returns Canonical symbols (e.g. `BTC/USD`), or `[]` on failure (caller should fall back).
 */
export async function discoverTopPairs(limit: number = TOP_N): Promise<string[]> {
  try {
    const apRes = await fetch("https://api.kraken.com/0/public/AssetPairs");
    if (!apRes.ok) throw new Error(`AssetPairs ${apRes.status}`);
    const ap = await apRes.json();

    const metaByKey: Record<string, { ws: string; lev: number[] }> = {};
    // Official WS symbol: AssetPairs `wsname`.
    // https://support.kraken.com/articles/360000920306-api-symbols-and-tickers
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
