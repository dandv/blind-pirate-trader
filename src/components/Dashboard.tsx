import type { GameState } from "@/lib/gameState";
import { assetValueUsd, netLiq, INITIAL_CASH } from "@/lib/gameState";

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function Dashboard({ state }: { state: GameState }) {
  const cash = state.cashUsd;
  const assets = assetValueUsd(state);
  const pnl = netLiq(state) - INITIAL_CASH;

  const pnlColor = pnl > 0 ? "text-[color:var(--gain)]" : pnl < 0 ? "text-[color:var(--loss)]" : "";

  return (
    <div className="grid grid-cols-3 gap-2 lg:grid-cols-1">
      <Stat label="Cash">
        <div className="text-sm font-semibold tabular-nums">{fmtUsd(cash)}</div>
      </Stat>
      <Stat label="Asset">
        <div className="text-sm font-semibold tabular-nums">{fmtUsd(assets)}</div>
        <div className="mt-0.5 text-[9px] text-muted-foreground tabular-nums">
          {state.units.toFixed(4)} u
          {state.units > 1e-9 && state.avgCostNorm > 0
            ? ` · avg $${state.avgCostNorm.toFixed(2)}`
            : ""}
        </div>
      </Stat>
      <Stat label="P&L">
        <div className={`text-sm font-semibold tabular-nums ${pnlColor}`}>
          {pnl >= 0 ? "+" : ""}
          {fmtUsd(pnl)}
        </div>
      </Stat>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-card/60 px-2.5 py-2 backdrop-blur-sm">
      <div className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}
