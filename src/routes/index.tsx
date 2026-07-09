import { createFileRoute } from "@tanstack/react-router";
import { Github } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { Chart } from "@/components/Chart";
import { Controls } from "@/components/Controls";
import { Dashboard } from "@/components/Dashboard";
import { GameEnd } from "@/components/GameEnd";
import { GameIntro } from "@/components/GameIntro";
import { ThemeSelector } from "@/components/ThemeSelector";
import { TradeHistory } from "@/components/TradeHistory";
import { useTheme } from "@/hooks/use-theme";
import { createInitial, reducer, tOffsetSec, type VolumeChoice } from "@/lib/gameState";
import {
  earliestSampleTime,
  fetchOhlcv,
  latestSampleTime,
  listKrakenSymbols,
  type Candle,
  type TickSource,
} from "@/lib/victoriametrics";

const REPO_URL = "https://github.com/dandv/blind-pirate-trader";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Blind Pirate Trader — Crypto Trading Sim" },
      {
        name: "description",
        content:
          "A blinded crypto trading simulator over real Kraken historical data. Buy, sell, fast-forward, and reveal the asset at the end.",
      },
      { property: "og:title", content: "Blind Pirate Trader — Crypto Trading Sim" },
      {
        property: "og:description",
        content:
          "Trade an unknown Kraken USD pair over real historical data, normalized around $100. Beat the market.",
      },
    ],
  }),
  component: Index,
});

const STEP_SEC = 5;
/** When picking a random start, leave at least this much forward data to play with. */
const MIN_PLAY_HOURS = 48;
const MAX_SYMBOL_ATTEMPTS = 8;
const CHUNK_SEC = 2 * 24 * 60 * 60;
/** Keep one full 2d chunk ahead so a 1d FF should not hit an unloaded boundary. */
const PREFETCH_THRESHOLD_SEC = CHUNK_SEC;

interface PreparedGame {
  symbol: string;
  startSec: number;
  endSec: number;
  candles: Candle[];
  normFactor: number;
  source: TickSource;
}

function Index() {
  const [theme, setTheme] = useTheme();
  const [state, dispatch] = useReducer(reducer, undefined, createInitial);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showVolume, setShowVolume] = useState(true);
  const [tickSource, setTickSource] = useState<TickSource>("trades");
  const [sourceSwitching, setSourceSwitching] = useState(false);
  const [pulseLabel, setPulseLabel] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedGame | null>(null);
  const [preparing, setPreparing] = useState(false);
  const pulseSeq = useRef(0);
  const preparedRef = useRef<PreparedGame | null>(null);
  const preparePromiseRef = useRef<Promise<PreparedGame> | null>(null);
  const prepareGenRef = useRef(0);
  const chunkRequestRef = useRef<string | null>(null);
  const tickSourceRef = useRef(tickSource);
  tickSourceRef.current = tickSource;

  const dark =
    theme === "dark" ||
    (theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches);

  const triggerPulse = useCallback((label: string) => {
    pulseSeq.current += 1;
    setPulseLabel(`${label}#${pulseSeq.current}`);
  }, []);

  const prepareNextGame = useCallback(async (): Promise<PreparedGame> => {
    const source = tickSourceRef.current;
    if (preparedRef.current?.source === source) return preparedRef.current;
    if (preparePromiseRef.current) return preparePromiseRef.current;

    const gen = ++prepareGenRef.current;
    setPreparing(true);
    const promise = (async () => {
      const allSymbols = await listKrakenSymbols(source);
      const pool = [...allSymbols];
      const minPlay = MIN_PLAY_HOURS * 3600;

      let symbol = "";
      let latest = 0;
      let earliest = 0;
      const rejections: Array<{ symbol: string; reason: string }> = [];

      for (let attempt = 0; attempt < MAX_SYMBOL_ATTEMPTS && pool.length; attempt++) {
        const idx = Math.floor(Math.random() * pool.length);
        const candidate = pool.splice(idx, 1)[0];
        console.info("[game] trying symbol", candidate, `(${source}, attempt ${attempt + 1})`);

        const lt = await latestSampleTime(candidate, source);
        if (!lt) {
          rejections.push({ symbol: candidate, reason: "no current tick" });
          continue;
        }
        const er = await earliestSampleTime(candidate, lt, source);
        const spanH = (lt - er) / 3600;
        console.info("[game] span", candidate, `${spanH.toFixed(2)}h`);
        if (lt - er < minPlay + 600) {
          rejections.push({ symbol: candidate, reason: `only ${spanH.toFixed(2)}h available` });
          continue;
        }
        symbol = candidate;
        latest = lt;
        earliest = er;
        break;
      }

      if (!symbol) {
        console.error("[game] no usable symbol", {
          tried: rejections,
          minPlayHours: MIN_PLAY_HOURS,
          source,
        });
        throw new Error(
          `Couldn't find a Kraken pair with at least ${MIN_PLAY_HOURS}h of recent data after ${rejections.length} tries. Try again.`,
        );
      }

      const playWindow = latest - earliest;
      const maxStartOffset = playWindow - minPlay;
      const startOffset = Math.floor(Math.random() * maxStartOffset);
      const startSec = earliest + startOffset;
      const endSec = latest;
      const firstChunkEndSec = Math.min(endSec, startSec + CHUNK_SEC);
      console.info("[game] prepared range", {
        symbol,
        source,
        startISO: new Date(startSec * 1000).toISOString(),
        firstChunkEndISO: new Date(firstChunkEndSec * 1000).toISOString(),
        endISO: new Date(endSec * 1000).toISOString(),
      });

      const candles = await fetchOhlcv(symbol, startSec, firstChunkEndSec, STEP_SEC, source);
      if (candles.length < 60) {
        throw new Error(`Insufficient candles fetched (${candles.length}). Try again.`);
      }

      return { symbol, startSec, endSec, candles, normFactor: candles[0].open / 100, source };
    })();

    preparePromiseRef.current = promise;
    try {
      const game = await promise;
      if (gen !== prepareGenRef.current) return game;
      preparedRef.current = game;
      setPrepared(game);
      return game;
    } finally {
      if (preparePromiseRef.current === promise) preparePromiseRef.current = null;
      if (gen === prepareGenRef.current) setPreparing(false);
    }
  }, []);

  useEffect(() => {
    if (state.phase !== "intro") return;
    prepareNextGame().catch((e) => {
      const msg = e instanceof Error ? e.message : "Unknown error loading the market.";
      console.error("[game] prepare failed", e);
      setLoadError(msg);
    });
  }, [state.phase, tickSource, prepareNextGame]);

  const changeTickSource = useCallback(
    async (next: TickSource) => {
      if (next === tickSource) return;
      prepareGenRef.current += 1;
      preparedRef.current = null;
      setPrepared(null);
      preparePromiseRef.current = null;
      chunkRequestRef.current = null;
      setTickSource(next);
      setLoadError(null);

      if (state.phase === "intro") return;

      // Mid-game: refetch the same wall-clock window from the other feed for A/B.
      const origin = state.series[0]?.time;
      if (!origin || !state.symbol) return;
      setSourceSwitching(true);
      try {
        const endSec = state.endSec;
        const loadedEnd = Math.max(
          state.series[state.series.length - 1]?.time ?? origin,
          Math.min(endSec, origin + CHUNK_SEC),
        );
        const candles = await fetchOhlcv(state.symbol, origin, loadedEnd, STEP_SEC, next);
        if (candles.length < 2) {
          dispatch({
            type: "error",
            message: `No ${next} candles for this window — try the other source or end the game.`,
          });
          return;
        }
        dispatch({ type: "replaceSeries", series: candles, endSec });
      } catch (e) {
        console.error("[game] source switch failed", e);
        dispatch({
          type: "error",
          message: e instanceof Error ? e.message : "Failed to switch tick source.",
        });
      } finally {
        setSourceSwitching(false);
      }
    },
    [tickSource, state.phase, state.series, state.symbol, state.endSec],
  );

  const startGame = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      let game = preparedRef.current;
      if (!game || game.source !== tickSourceRef.current) {
        preparedRef.current = null;
        game = await prepareNextGame();
      }
      const initialCursor = Math.min(game.candles.length - 1, Math.floor((5 * 60) / STEP_SEC));
      dispatch({
        type: "init",
        symbol: game.symbol,
        series: game.candles,
        normFactor: game.normFactor,
        initialCursor,
        endSec: game.endSec,
      });
      preparedRef.current = null;
      setPrepared(null);

      // Queue the next market while this game is being played.
      prepareNextGame().catch((e) => console.warn("[game] background prepare failed", e));

      // Five 5-minute fast-forwards to unroll the chart for the user, with a pulse on the button.
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 320));
        dispatch({ type: "fastForward", seconds: 5 * 60 });
        triggerPulse("5m");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error loading the market.";
      console.error("[game] start failed", e);
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  }, [prepareNextGame, triggerPulse]);

  const restart = useCallback(() => {
    void startGame();
  }, [startGame]);

  const onBuy = useCallback(() => dispatch({ type: "trade", side: "BUY" }), []);
  const onSell = useCallback(() => dispatch({ type: "trade", side: "SELL" }), []);
  const onFf = useCallback(
    (minutes: number) => dispatch({ type: "fastForward", seconds: minutes * 60 }),
    [],
  );
  const onSetVol = useCallback(
    (v: VolumeChoice) => dispatch({ type: "setTradeVolume", usd: v }),
    [],
  );
  const onEnd = useCallback(() => dispatch({ type: "end" }), []);

  useEffect(() => {
    if (state.phase !== "playing" || state.series.length === 0) return;
    const currentTime = state.series[state.cursor]?.time ?? 0;
    const latestLoaded = state.series[state.series.length - 1]?.time ?? 0;
    if (
      latestLoaded + STEP_SEC >= state.endSec ||
      latestLoaded - currentTime > PREFETCH_THRESHOLD_SEC
    ) {
      return;
    }

    const nextStart = latestLoaded + STEP_SEC;
    const nextEnd = Math.min(state.endSec, latestLoaded + CHUNK_SEC);
    const source = tickSourceRef.current;
    const requestKey = `${state.symbol}:${source}:${nextStart}:${nextEnd}`;
    if (chunkRequestRef.current === requestKey) return;
    chunkRequestRef.current = requestKey;

    fetchOhlcv(state.symbol, nextStart, nextEnd, STEP_SEC, source)
      .then((candles) => {
        if (candles.length > 0) {
          dispatch({ type: "appendSeries", series: candles });
          return;
        }
        // Past the last available bar for this series (e.g. trades lag hours behind now).
        dispatch({ type: "dataExhausted" });
      })
      .catch((e) => {
        console.error("[game] chunk prefetch failed", e);
        dispatch({
          type: "error",
          message: "Could not load the next market-data chunk. Try ending the game or FF again.",
        });
        chunkRequestRef.current = null;
      });
  }, [state.phase, state.symbol, state.series, state.cursor, state.endSec, tickSource]);

  // Keyboard shortcuts.
  useEffect(() => {
    if (state.phase !== "playing") return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
        // Radix Select trigger / open listbox / vol-select button.
        const role = target.getAttribute("role");
        if (role === "combobox" || role === "listbox" || role === "option") return;
        if (target.id === "vol-select" || target.closest("#vol-select")) return;
      }

      if (e.key === "Escape") {
        onEnd();
        e.preventDefault();
        return;
      }
      if (e.key === "Enter") {
        onFf(1440);
        triggerPulse("1d");
        e.preventDefault();
        return;
      }

      const code = e.key.toLowerCase();
      if (code === "b") {
        onBuy();
        triggerPulse("BUY");
        e.preventDefault();
        return;
      }
      if (code === "s") {
        onSell();
        triggerPulse("SELL");
        e.preventDefault();
        return;
      }
      if (code === "v") {
        const el = document.getElementById("vol-select");
        el?.focus();
        e.preventDefault();
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          onFf(30);
          triggerPulse("30m");
        } else if (e.shiftKey) {
          onFf(15);
          triggerPulse("15m");
        } else {
          onFf(5);
          triggerPulse("5m");
        }
        return;
      }
      if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          onFf(720);
          triggerPulse("12h");
        } else if (e.shiftKey) {
          onFf(240);
          triggerPulse("4h");
        } else {
          onFf(60);
          triggerPulse("1h");
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [state.phase, onBuy, onSell, onFf, onEnd, triggerPulse]);

  const visibleCandles =
    state.phase === "ended" ? state.series : state.series.slice(0, state.cursor + 1);
  const originSec = state.series[0]?.time ?? 0;
  const revealed = state.phase === "ended";
  const chartNormFactor = revealed ? 1 : state.normFactor;

  return (
    <div className="flex h-screen w-screen flex-col gap-2 p-2 sm:p-3">
      {/* Top bar */}
      <header className="flex items-center justify-between gap-3 px-1">
        <div className="flex items-baseline gap-2">
          <h1 className="font-display text-lg font-bold tracking-tight sm:text-xl">
            <span className="bg-gradient-to-r from-[color:var(--brand-a)] to-[color:var(--brand-b)] bg-clip-text text-transparent">
              Blind Pirate Trader
            </span>
          </h1>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {state.phase === "playing"
                ? `Mystery asset · ${tickSource} · t = ${formatElapsedShort(tOffsetSec(state))}`
                : state.phase === "ended"
                  ? `Revealed: ${state.symbol}`
                  : "Ready"}
            </span>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center rounded-full border border-border bg-card/60 p-2 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="View source on GitHub"
            title="View source on GitHub"
          >
            <Github className="h-4 w-4" />
          </a>
          <ThemeSelector value={theme} onChange={setTheme} />
        </div>
      </header>

      {state.error && (
        <div className="rounded-md border border-[color:var(--loss)]/40 bg-[color:var(--loss)]/10 px-3 py-1.5 text-xs text-[color:var(--loss)]">
          {state.error}
        </div>
      )}

      {/* Main area: chart + side panel (history) */}
      <main className="grid min-h-0 flex-1 grid-cols-1 gap-2 lg:grid-cols-[1fr_minmax(260px,300px)]">
        <section className="min-h-[300px] overflow-hidden rounded-2xl border border-border bg-card/40 backdrop-blur-sm">
          {state.phase !== "intro" && state.series.length > 0 ? (
            <Chart
              candles={visibleCandles}
              originSec={originSec}
              normFactor={chartNormFactor}
              showVolume={showVolume}
              dark={dark}
              absoluteTime={revealed}
              lastDeltaPct={state.lastDeltaPct}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Chart will appear once the game starts.
            </div>
          )}
        </section>
        <aside className="hidden min-h-0 flex-col gap-2 overflow-hidden lg:flex">
          {state.phase !== "intro" && (
            <div className="flex shrink-0 flex-col gap-2 rounded-lg border border-border bg-card/60 p-2 backdrop-blur-sm">
              <Dashboard state={state} />
              <Controls
                tradeVolumeUsd={state.tradeVolumeUsd}
                onSetVolume={onSetVol}
                onBuy={onBuy}
                onSell={onSell}
                onFastForward={onFf}
                onEnd={onEnd}
                showVolume={showVolume}
                onToggleVolume={setShowVolume}
                tickSource={tickSource}
                onTickSource={(s) => void changeTickSource(s)}
                sourceSwitching={sourceSwitching}
                disabled={state.phase !== "playing"}
                pulseLabel={pulseLabel}
              />
            </div>
          )}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card/40 backdrop-blur-sm">
            <div className="shrink-0 border-b border-border px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Trade history
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <TradeHistory trades={state.trades} />
            </div>
          </div>
        </aside>
      </main>

      {state.phase !== "intro" && (
        <section className="rounded-2xl border border-border bg-card/60 p-3 backdrop-blur-sm lg:hidden">
          <div className="flex flex-col gap-3">
            <Dashboard state={state} />
            <Controls
              tradeVolumeUsd={state.tradeVolumeUsd}
              onSetVolume={onSetVol}
              onBuy={onBuy}
              onSell={onSell}
              onFastForward={onFf}
              onEnd={onEnd}
              showVolume={showVolume}
              onToggleVolume={setShowVolume}
              tickSource={tickSource}
              onTickSource={(s) => void changeTickSource(s)}
              sourceSwitching={sourceSwitching}
              disabled={state.phase !== "playing"}
              pulseLabel={pulseLabel}
            />
          </div>
        </section>
      )}

      {/* Mobile trade history toggleable strip */}
      <details className="lg:hidden">
        <summary className="cursor-pointer rounded-md border border-border bg-card/60 px-3 py-1.5 text-xs uppercase tracking-wider text-muted-foreground">
          Trade history ({state.trades.length})
        </summary>
        <div className="mt-2 max-h-60 overflow-hidden rounded-xl border border-border bg-card/60">
          <TradeHistory trades={state.trades} />
        </div>
      </details>

      {state.phase === "intro" && (
        <GameIntro
          onStart={startGame}
          loading={loading}
          prepared={Boolean(prepared)}
          preparing={preparing}
          error={loadError}
          tickSource={tickSource}
          onTickSource={(s) => void changeTickSource(s)}
        />
      )}
      {state.phase === "ended" && <GameEnd state={state} onRestart={restart} />}
    </div>
  );
}

function formatElapsedShort(s: number): string {
  const sec = Math.max(0, Math.round(s));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
