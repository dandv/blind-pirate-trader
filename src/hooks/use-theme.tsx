import { useEffect, useState } from 'react';

export type Theme = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'sim:theme';

function applyTheme(theme: Theme): void {
   const root = document.documentElement;
   const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
   const dark = theme === 'dark' || (theme === 'system' && sysDark);
   root.classList.toggle('dark', dark);
}

export function useTheme(): [Theme, (t: Theme) => void] {
   const [theme, setTheme] = useState<Theme>(() => {
      if (typeof window === 'undefined') return 'system';
      return (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? 'system';
   });

   useEffect(() => {
      applyTheme(theme);
      localStorage.setItem(STORAGE_KEY, theme);
      if (theme !== 'system') return;
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => applyTheme('system');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
   }, [theme]);

   return [theme, setTheme];
}

