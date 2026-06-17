import type { Trade } from '@/lib/gameState';
import { formatElapsed } from '@/lib/gameState';

export function TradeHistory({ trades }: { trades: Trade[] }) {
   if (trades.length === 0) {
      return (
         <div className='flex h-full items-center justify-center text-sm text-muted-foreground'>
            No trades yet — buy or sell to begin.
         </div>
      );
   }
   return (
      <div className='h-full overflow-auto'>
         <table className='w-full text-sm'>
            <thead className='sticky top-0 bg-card text-xs uppercase tracking-wider text-muted-foreground'>
               <tr>
                  <th className='px-3 py-2 text-left'>Time</th>
                  <th className='px-3 py-2 text-left'>Side</th>
                  <th className='px-3 py-2 text-right'>Volume</th>
                  <th className='px-3 py-2 text-right'>Price</th>
               </tr>
            </thead>
            <tbody>
               {[...trades].reverse().map((t, i) => (
                  <tr key={trades.length - 1 - i} className='border-t border-border/60'>
                      <td className='whitespace-nowrap px-3 py-1.5 tabular-nums text-muted-foreground'>
                         {formatElapsed(t.tOffsetSec)}
                      </td>
                     <td
                        className='px-3 py-1.5 font-semibold'
                        style={{ color: t.side === 'BUY' ? 'var(--gain)' : 'var(--loss)' }}
                     >
                        {t.side}
                     </td>
                     <td className='px-3 py-1.5 text-right tabular-nums'>${t.notionalUsd}</td>
                     <td className='px-3 py-1.5 text-right tabular-nums'>${t.priceNorm.toFixed(2)}</td>
                  </tr>
               ))}
            </tbody>
         </table>
      </div>
   );
}

