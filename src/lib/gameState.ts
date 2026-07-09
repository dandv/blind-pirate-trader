/**
 * Game state, reducer, and pure helpers for the trading sim.
 */

import type { Candle } from "./victoriametrics";

export type TradeSide = "BUY" | "SELL";

export interface Trade {
  /** Game-time offset (seconds since t=0). */
  tOffsetSec: number;
  side: TradeSide;
  /** Notional USD value of this trade (positive). */
  notionalUsd: number;
  /** Normalized price at execution. */
  priceNorm: number;
  /** Asset units transacted. */
  units: number;
}

export type GamePhase = "intro" | "playing" | "ended";

export interface GameState {
  phase: GamePhase;
  symbol: string;
  /** Multiplicative factor that maps real price -> normalized: norm = real / factor. */
  normFactor: number;
  /** Full series for the picked window (real prices). */
  series: Candle[];
  /** Final wall-clock second for the playable/revealed window. */
  endSec: number;
  /** Index of the bar currently treated as "now" (inclusive). */
  cursor: number;
  cashUsd: number;
  /** Asset units held. */
  units: number;
  /** Weighted-average cost basis for current units, in normalized price. */
  avgCostNorm: number;
  tradeVolumeUsd: number;
  trades: Trade[];
  /** Animation key bumped each fast-forward to retrigger price flash. */
  flashKey: number;
  /** % delta of the last fast-forward, used for sizing the flash. */
  lastDeltaPct: number;
  error: string | null;
}

export const INITIAL_CASH = 10_000;
export const VOLUME_CHOICES = [100, 500, 1000] as const;
export type VolumeChoice = (typeof VOLUME_CHOICES)[number];

export type Action =
  | {
      type: "init";
      symbol: string;
      series: Candle[];
      normFactor: number;
      initialCursor: number;
      endSec: number;
    }
  | { type: "appendSeries"; series: Candle[] }
  /** Replace the loaded series (e.g. mid-game tick-source switch); keeps cursor clamped. */
  | { type: "replaceSeries"; series: Candle[]; endSec?: number }
  /** No further candles available — clamp the playable horizon to loaded data. */
  | { type: "dataExhausted" }
  | { type: "fastForward"; seconds: number }
  | { type: "trade"; side: TradeSide }
  | { type: "setTradeVolume"; usd: number }
  | { type: "end" }
  | { type: "error"; message: string };

export function createInitial(): GameState {
  return {
    phase: "intro",
    symbol: "",
    normFactor: 1,
    series: [],
    endSec: 0,
    cursor: 0,
    cashUsd: INITIAL_CASH,
    units: 0,
    avgCostNorm: 0,
    tradeVolumeUsd: 100,
    trades: [],
    flashKey: 0,
    lastDeltaPct: 0,
    error: null,
  };
}

export function normPrice(s: GameState, real: number): number {
  return real / s.normFactor;
}

export function currentRealPrice(s: GameState): number {
  const c = s.series[s.cursor];
  return c ? c.close : 0;
}

export function currentNormPrice(s: GameState): number {
  return normPrice(s, currentRealPrice(s));
}

export function assetValueUsd(s: GameState): number {
  return s.units * currentNormPrice(s);
}

export function netLiq(s: GameState): number {
  return s.cashUsd + assetValueUsd(s);
}

export function tOffsetSec(s: GameState, idx: number = s.cursor): number {
  if (!s.series.length) return 0;
  return s.series[idx].time - s.series[0].time;
}

/** Advance cursor to the first bar with time >= target. */
function advanceBySeconds(series: Candle[], cursor: number, seconds: number): number {
  if (series.length === 0) return cursor;
  const target = series[cursor].time + Math.max(0, seconds);
  let next = cursor;
  while (next < series.length - 1 && series[next + 1].time <= target) next++;
  // If we asked for any forward motion and didn't move, nudge by one bar so the user
  // still sees progress on sparse data.
  if (seconds > 0 && next === cursor && cursor < series.length - 1) next = cursor + 1;
  return next;
}

function mergeSeries(current: Candle[], incoming: Candle[]): Candle[] {
  if (incoming.length === 0) return current;
  const byTime = new Map<number, Candle>();
  for (const candle of current) byTime.set(candle.time, candle);
  for (const candle of incoming) byTime.set(candle.time, candle);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function reducer(state: GameState, action: Action): GameState {
  switch (action.type) {
    case "init":
      return {
        ...createInitial(),
        phase: "playing",
        symbol: action.symbol,
        series: action.series,
        endSec: action.endSec,
        normFactor: action.normFactor,
        cursor: action.initialCursor,
      };

    case "appendSeries":
      return {
        ...state,
        series: mergeSeries(state.series, action.series),
        error: state.error === "Loading more market data…" ? null : state.error,
      };

    case "replaceSeries": {
      if (action.series.length === 0) return state;
      const cursor = Math.min(state.cursor, action.series.length - 1);
      return {
        ...state,
        series: action.series,
        cursor,
        endSec: action.endSec ?? state.endSec,
        error: state.error === "Loading more market data…" ? null : state.error,
      };
    }

    case "dataExhausted": {
      const lastLoadedTime = state.series[state.series.length - 1]?.time ?? state.endSec;
      const atEnd = state.cursor >= state.series.length - 1;
      return {
        ...state,
        endSec: Math.min(state.endSec, lastLoadedTime),
        phase: atEnd ? "ended" : state.phase,
        error: state.error === "Loading more market data…" ? null : state.error,
      };
    }

    case "fastForward": {
      if (state.phase !== "playing") return state;
      const prevPrice = currentNormPrice(state);
      const nextCursor = advanceBySeconds(state.series, state.cursor, action.seconds);
      const newState: GameState = {
        ...state,
        cursor: nextCursor,
        flashKey: state.flashKey + 1,
      };
      const newPrice = currentNormPrice(newState);
      newState.lastDeltaPct = prevPrice > 0 ? ((newPrice - prevPrice) / prevPrice) * 100 : 0;
      const lastLoadedTime = state.series[state.series.length - 1]?.time ?? 0;
      const currentTime = state.series[nextCursor]?.time ?? 0;
      const step = stepSec(state);
      // endSec is the last raw tick (may be fractional / mid-bar). A bar at T covers
      // [T, T+step), so the series is exhausted once lastLoadedTime + step >= endSec.
      // Do not compare against wall-clock now — REST trades can end hours earlier.
      const reachedDataEnd =
        currentTime + step >= state.endSec ||
        (nextCursor >= state.series.length - 1 && lastLoadedTime + step >= state.endSec);
      if (reachedDataEnd) {
        newState.phase = "ended";
        newState.error = null;
      } else if (nextCursor >= state.series.length - 1) {
        newState.error = "Loading more market data…";
      }
      return newState;
    }

    case "trade": {
      if (state.phase !== "playing") return state;
      const price = currentNormPrice(state);
      if (price <= 0) return state;
      const usd = state.tradeVolumeUsd;
      const units = usd / price;
      if (action.side === "BUY") {
        if (state.cashUsd < usd) {
          return { ...state, error: `Not enough cash to buy $${usd}.` };
        }
        const newUnits = state.units + units;
        const newAvg =
          newUnits > 0 ? (state.units * state.avgCostNorm + units * price) / newUnits : 0;
        const trades: Trade[] = [
          ...state.trades,
          { tOffsetSec: tOffsetSec(state), side: "BUY", notionalUsd: usd, priceNorm: price, units },
        ];
        return reducer(
          {
            ...state,
            cashUsd: state.cashUsd - usd,
            units: newUnits,
            avgCostNorm: newAvg,
            trades,
            error: null,
          },
          { type: "fastForward", seconds: 60 },
        );
      }
      // SELL
      if (state.units * price < usd - 0.0001) {
        return { ...state, error: `Not enough position to sell $${usd}.` };
      }
      const newUnits = state.units - units;
      const newAvg = newUnits > 1e-9 ? state.avgCostNorm : 0;
      const trades: Trade[] = [
        ...state.trades,
        { tOffsetSec: tOffsetSec(state), side: "SELL", notionalUsd: usd, priceNorm: price, units },
      ];
      return reducer(
        {
          ...state,
          cashUsd: state.cashUsd + usd,
          units: newUnits,
          avgCostNorm: newAvg,
          trades,
          error: null,
        },
        { type: "fastForward", seconds: 60 },
      );
    }

    case "setTradeVolume":
      return { ...state, tradeVolumeUsd: action.usd };

    case "end":
      return { ...state, phase: "ended" };

    case "error":
      return { ...state, error: action.message };
  }
}

export function stepSec(s: GameState): number {
  if (s.series.length < 2) return 5;
  return s.series[1].time - s.series[0].time;
}

export function formatElapsed(seconds: number): string {
  const sign = seconds < 0 ? "-" : "";
  const s = Math.abs(Math.round(seconds));
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (days > 0) return `${sign}${days}d ${h}h ${m}m`;
  if (h > 0) return `${sign}${h}h ${m}m ${sec}s`;
  if (m > 0) return `${sign}${m}m ${sec}s`;
  return `${sign}${sec}s`;
}
