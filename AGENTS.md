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

Uses standard Vite + TanStack Start + Nitro (no Lovable tooling).

## Session notes

- 2026-06-17: Removed `@lovable.dev/vite-tanstack-config`, Lovable error reporting, and sandbox-only plugins. Replaced with direct Vite/TanStack/Nitro config. Fixed `@/hooks/useTheme` → `@/hooks/use-theme` import mismatch that broke builds.
