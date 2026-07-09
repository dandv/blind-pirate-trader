import type { Trade } from "@/lib/gameState";
import { formatElapsed } from "@/lib/gameState";

export function TradeHistory({ trades }: { trades: Trade[] }) {
  if (trades.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No trades yet — buy or sell to begin.
      </div>
    );
  }
  return (
    <div className="h-full min-h-0 overflow-auto">
      <table className="w-full min-w-[240px] text-xs">
        <thead className="sticky top-0 bg-card text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 text-left">Time</th>
            <th className="px-2 py-1.5 text-left">Side</th>
            <th className="px-2 py-1.5 text-right">Vol</th>
            <th className="px-2 py-1.5 text-right">Price</th>
          </tr>
        </thead>
        <tbody>
          {[...trades].reverse().map((t, i) => (
            <tr key={trades.length - 1 - i} className="border-t border-border/60">
              <td className="whitespace-nowrap px-2 py-1 tabular-nums text-muted-foreground">
                {formatElapsed(t.tOffsetSec)}
              </td>
              <td
                className="px-2 py-1 font-semibold"
                style={{ color: t.side === "BUY" ? "var(--gain)" : "var(--loss)" }}
              >
                {t.side}
              </td>
              <td className="px-2 py-1 text-right tabular-nums">${t.notionalUsd}</td>
              <td className="px-2 py-1 text-right tabular-nums">${t.priceNorm.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
