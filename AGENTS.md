# Blind Trader

TanStack Start (React 19) crypto trading simulator using real Kraken tick data via VictoriaMetrics.

## Local dev

```bash
deno install
deno task dev
```

App listens on http://localhost:8080. The browser fetches market data directly from `VICMET_BASE` in `.env` (default `https://vicmet.dandv.me`, CORS-enabled vmauth gateway). Vite exposes it via `envPrefix: ["VITE_", "VICMET_"]`.

Vite tasks pass `--unstable-no-legacy-abort` (and `unstable: ["no-legacy-abort"]` is set in `deno.jsonc`) so Vite's `Deno.serve` does not abort `request.signal` on successful responses (see https://docs.deno.com/go/unstable-no-legacy-abort). The CLI flag is required in practice for `npm:vite`.

## Build

```bash
deno task build
deno task preview
```

## GitHub Pages

Deployed via GitHub Actions (`.github/workflows/deploy-pages.yml`) on every push to `main`. The workflow runs `deno task build:pages`, copies `index.html` → `404.html` for SPA deep-link routing, and publishes `.output/public` using the official `upload-pages-artifact`/`deploy-pages` actions.

Repo Pages setting must be **Source: GitHub Actions** (Settings → Pages). No `gh-pages` branch is used; no built files live in git.

To build locally for inspection:

```bash
deno task build:pages   # output in .output/public; base derived from repo name (GITHUB_REPOSITORY in CI, else /blind-pirate-trader/)
```

Stack: Deno + Vite + TanStack Start. `nitro()` is in `vite.config.ts` because Start uses Nitro as its server/deploy build layer (SSR, server routes, adapters). This app's GitHub Pages path is SPA-only (`build:pages`), so Nitro's hosting adapters are unused in production; static files come from `.output/public`. Deno Deploy also lists TanStack Start as a supported framework via Nitro.

Under Deno, Nitro auto-selects `deno-server`. That preset currently hangs after SPA prerender process shutdown, so `build:pages` forces `nitro({ preset: "node" })` (static `.output/public` is all Pages needs). Direct dep `@tanstack/query-core` is listed in `deno.jsonc` because Deno's isolated `node_modules` layout otherwise breaks Vite resolution of that nested package.
