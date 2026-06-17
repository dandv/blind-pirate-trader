import { Monitor, Moon, Sun } from 'lucide-react';

import type { Theme } from '@/hooks/useTheme';

export function ThemeSelector({ value, onChange }: { value: Theme; onChange: (t: Theme) => void }) {
   const opts: Array<{ v: Theme; label: string; icon: React.ReactNode }> = [
      { v: 'system', label: 'System', icon: <Monitor className='h-3.5 w-3.5' /> },
      { v: 'light', label: 'Light', icon: <Sun className='h-3.5 w-3.5' /> },
      { v: 'dark', label: 'Dark', icon: <Moon className='h-3.5 w-3.5' /> },
   ];
   return (
      <div className='inline-flex items-center gap-0.5 rounded-full border border-border bg-card/60 p-0.5'>
         {opts.map((o) => (
            <button
               key={o.v}
               onClick={() => onChange(o.v)}
               className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition-colors ${
                  value === o.v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
               }`}
               aria-pressed={value === o.v}
               title={o.label}
            >
               {o.icon}
               <span className='hidden sm:inline'>{o.label}</span>
            </button>
         ))}
      </div>
   );
}

