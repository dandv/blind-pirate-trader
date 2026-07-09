# Blind Trader

TanStack Start (React 19) crypto trading simulator using real Kraken tick data via VictoriaMetrics.

## Local dev

```bash
bun install
bun run dev
```

App listens on http://localhost:8080. The browser fetches market data directly from `VICMET_BASE` in `.env` (default `https://vicmet.dandv.me`, CORS-enabled vmauth gateway). Vite exposes it via `envPrefix: ["VITE_", "VICMET_"]`.

## Build

```bash
bun run build
bun run preview
```

## GitHub Pages

Deployed via GitHub Actions (`.github/workflows/deploy-pages.yml`) on every push to `main`. The workflow runs `bun run build:pages`, copies `index.html` → `404.html` for SPA deep-link routing, and publishes `.output/public` using the official `upload-pages-artifact`/`deploy-pages` actions.

Repo Pages setting must be **Source: GitHub Actions** (Settings → Pages). No `gh-pages` branch is used; no built files live in git.

To build locally for inspection:

```bash
bun run build:pages   # output in .output/public; base derived from repo name (GITHUB_REPOSITORY in CI, else /blind-pirate-trader/)
```

Stack: Vite + TanStack Start. `nitro()` is in `vite.config.ts` because Start uses Nitro as its server/deploy build layer (SSR, server routes, adapters). This app's GitHub Pages path is SPA-only (`build:pages`), so Nitro's hosting adapters are unused in production; static files come from `.output/public`.
