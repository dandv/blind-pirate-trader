# Blind Trader

TanStack Start (React 19) crypto trading simulator using real Kraken tick data via VictoriaMetrics.

## Local dev

```bash
bun install
bun run dev
```

App listens on http://localhost:8080. Market data is proxied through `/api/vm/*` to VictoriaMetrics (`VM_UPSTREAM_URL`, default `https://vicmet.dandv.me` — a vmauth gateway that terminates TLS and forwards to VM).

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

Uses standard Vite + TanStack Start + Nitro (no Lovable tooling).

## Session notes

- 2026-06-17: Removed `@lovable.dev/vite-tanstack-config`, Lovable error reporting, and sandbox-only plugins. Replaced with direct Vite/TanStack/Nitro config. Fixed `@/hooks/useTheme` → `@/hooks/use-theme` import mismatch that broke builds.
- 2026-06-17: Switched Pages deployment to GitHub Actions. Cleaned up a broken `gh-pages` branch (created by Cursor) that wrongly committed source + build output and left the working tree with source files deleted. Source was always safe on `main`. Note: `build:pages` does NOT emit `404.html` or `.nojekyll`; the workflow adds the SPA `404.html`. `.nojekyll` is unnecessary with the Actions deploy method (Jekyll never runs).
