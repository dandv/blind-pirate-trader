import { Button } from '@/components/ui/button';

export function GameIntro({ onStart, loading, error }: {
   onStart: () => void;
   loading: boolean;
   prepared?: boolean;
   preparing?: boolean;
   error: string | null;
}) {
   return (
      <div className='fixed inset-0 z-30 flex items-center justify-center bg-background/85 backdrop-blur-sm'>
         <div className='w-full max-w-xl text-center rounded-2xl border border-border bg-card p-6 shadow-2xl'>
            <div className='text-xs uppercase tracking-[0.2em] text-muted-foreground'>
               Blind Pirate Trader
            </div>
            <h1 className='mt-1 bg-gradient-to-r from-[color:var(--brand-a)] to-[color:var(--brand-b)] bg-clip-text text-2xl font-bold text-transparent sm:text-3xl'>
               Trade an unknown Kraken asset
            </h1>
            <p className='mt-3 text-sm text-muted-foreground'>
               You're about to trade one of Kraken's top crypto/USD pairs over a real historical
               window — but you won't know which, or when. Price is normalized around{' '}
               <span className='font-semibold text-foreground'>$100</span>.
            </p>

            <ul className='mt-4 space-y-1.5 text-sm'>
               <Rule>Start with $10,000 cash.</Rule>
               <Rule>Buy or sell in $100 / $500 / $1000 lots.</Rule>
               <Rule>Each trade advances the simulator by 1 minute.</Rule>
               <Rule>Fast-forward 5m → 1d to skip ahead.</Rule>
               <Rule>End any time, or play to the end of the series.</Rule>
               <Rule>The asset is revealed at the end with full P&L.</Rule>
            </ul>

            {error && (
               <div className='mt-4 rounded-md border border-[color:var(--loss)]/40 bg-[color:var(--loss)]/10 p-3 text-sm text-[color:var(--loss)]'>
                  {error}
               </div>
            )}

            <div className='mt-6 flex items-center justify-end gap-3'>
               <Button size='lg' onClick={onStart} disabled={loading}>
                  {loading ? 'Loading market…' : 'Start trading'}
               </Button>
            </div>
         </div>
      </div>
   );
}

function Rule({ children }: { children: React.ReactNode }) {
   return (
      <li className='flex items-start gap-2'>
         <span className='mt-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--brand-a)]' />
         <span>{children}</span>
      </li>
   );
}
