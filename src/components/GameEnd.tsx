import { useEffect, useRef, useState } from "react";
import confetti from "canvas-confetti";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { GameState } from "@/lib/gameState";
import { INITIAL_CASH, netLiq } from "@/lib/gameState";

const LB_KEY = "sim:leaderboard";

interface LbEntry {
  name: string;
  pnl: number;
  symbol: string;
  trades: number;
  at: number;
}

function readLeaderboard(): LbEntry[] {
  try {
    const raw = localStorage.getItem(LB_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LbEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn("[leaderboard] parse failed", e);
    return [];
  }
}

function writeLeaderboard(entries: LbEntry[]): void {
  localStorage.setItem(LB_KEY, JSON.stringify(entries.slice(0, 50)));
}

export function GameEnd({ state, onRestart }: { state: GameState; onRestart: () => void }) {
  const pnl = netLiq(state) - INITIAL_CASH;
  const isProfit = pnl > 0;
  const buys = state.trades.filter((t) => t.side === "BUY").length;
  const sells = state.trades.filter((t) => t.side === "SELL").length;
  const fired = useRef(false);
  const [name, setName] = useState("");
  const [saved, setSaved] = useState<LbEntry[] | null>(null);
  const [minimized, setMinimized] = useState(false);

  useEffect(() => {
    if (isProfit && !fired.current) {
      fired.current = true;
      confetti({ particleCount: 140, spread: 80, origin: { y: 0.6 } });
      setTimeout(() => confetti({ particleCount: 80, spread: 100, origin: { y: 0.5 } }), 250);
    }
  }, [isProfit]);

  const onSave = () => {
    if (!name.trim()) return;
    const entry: LbEntry = {
      name: name.trim().slice(0, 32),
      pnl,
      symbol: state.symbol,
      trades: state.trades.length,
      at: Date.now(),
    };
    const next = [...readLeaderboard(), entry].sort((a, b) => b.pnl - a.pnl);
    writeLeaderboard(next);
    setSaved(next.slice(0, 10));
    setName("");
  };

  const top =
    saved ??
    readLeaderboard()
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 10);

  if (minimized) {
    return (
      <div className="fixed bottom-4 right-4 z-30 flex items-center gap-3 rounded-xl border border-border bg-card/95 px-4 py-2 shadow-xl backdrop-blur-sm">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">
          {state.symbol}
        </span>
        <span
          className="text-sm font-semibold tabular-nums"
          style={{ color: isProfit ? "var(--gain)" : "var(--loss)" }}
        >
          {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
        </span>
        <Button size="sm" variant="outline" onClick={() => setMinimized(false)}>
          Results
        </Button>
        <Button size="sm" onClick={onRestart}>
          Play again
        </Button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-background/85 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-2xl border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Game over — asset revealed
            </div>
            <h2 className="mt-1 bg-gradient-to-r from-[color:var(--brand-a)] to-[color:var(--brand-b)] bg-clip-text text-3xl font-bold text-transparent sm:text-4xl">
              {state.symbol}
            </h2>
          </div>
          <Button size="sm" variant="outline" onClick={() => setMinimized(true)}>
            View chart
          </Button>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="P&L"
            value={`${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`}
            color={isProfit ? "var(--gain)" : "var(--loss)"}
          />
          <Stat label="Trades" value={String(state.trades.length)} />
          <Stat label="Buys" value={String(buys)} />
          <Stat label="Sells" value={String(sells)} />
        </div>

        {isProfit && (
          <div className="mt-5 rounded-xl border border-[color:var(--gain)]/40 bg-[color:var(--gain)]/10 p-4">
            <div className="text-sm font-semibold text-[color:var(--gain)]">
              Profit! Save your run.
            </div>
            <div className="mt-2 flex gap-2">
              <Input
                placeholder="Your handle"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={32}
              />
              <Button onClick={onSave} disabled={!name.trim()}>
                Save
              </Button>
            </div>
          </div>
        )}

        {top.length > 0 && (
          <div className="mt-5">
            <div className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">
              Leaderboard (local)
            </div>
            <ol className="space-y-1 text-sm">
              {top.map((e, i) => (
                <li
                  key={`${e.at}-${i}`}
                  className="flex items-center justify-between rounded-md border border-border/60 px-3 py-1.5"
                >
                  <span className="tabular-nums text-muted-foreground">#{i + 1}</span>
                  <span className="flex-1 px-3 font-medium">{e.name}</span>
                  <span className="text-xs text-muted-foreground">{e.symbol}</span>
                  <span
                    className="ml-3 tabular-nums font-semibold"
                    style={{ color: e.pnl >= 0 ? "var(--gain)" : "var(--loss)" }}
                  >
                    {e.pnl >= 0 ? "+" : ""}${e.pnl.toFixed(2)}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}

        <div className="mt-6 flex justify-end">
          <Button size="lg" onClick={onRestart}>
            Play again
          </Button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-3">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className="mt-1 text-xl font-semibold tabular-nums"
        style={color ? { color } : undefined}
      >
        {value}
      </div>
    </div>
  );
}
