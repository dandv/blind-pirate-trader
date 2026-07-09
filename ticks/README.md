# Tick collection

Kraken Spot WebSocket → VictoriaMetrics ingest for Blind Pirate Trader historical price data.

`collect_ws.ts` discovers the top 20 traded /USD spot pairs (by 24h notional volume among leveraged, non-stablecoin bases), subscribes to Kraken WS v2 `ticker` + `trade`, and dumps ticks into VicMet with `exchange=kraken`.

## Layout

| File | Role |
| --- | --- |
| `collect_ws.ts` | Live collector |
| `VicMet.ts` | Thin VicMet client (`dumpTicks` / `flush`) |
| `collect_ws.test.ts` | Integration test: live WS → VicMet |
| `deno.jsonc` | Tasks + JSR imports |

## Environment (repo-root `.env`)

| Variable | Used by | Purpose |
| --- | --- | --- |
| `VICMET_URL_TEST` | test | Local test VicMet (`http://127.0.0.1:7357`; 7357 ≈ “test”) |
| `VICMET_URL` | `collect` | Live ingest target (e.g. `http://127.0.0.1:8428` or remote) |

The game app separately uses `VICMET_BASE` (CORS gateway) — not this package.

Load dotenv into the task shell with Deno’s `--env-file` (relative to the directory you invoke from):

```bash
cd ticks
deno task --env-file=../.env collect
deno task --env-file=../.env test
```

From the repo root, the `ticks` / `ticks:test` tasks already pass `--env-file`.

## Usage

`deno task vicmet` starts a **test** instance on `:7357` in the foreground (logs stay visible). Live collection uses `VICMET_URL` from `.env`, which need not be that instance.

```bash
cd ticks

# Terminal A — test VicMet on :7357
deno task vicmet

# Terminal B — collect into VICMET_URL from .env
deno task --env-file=../.env collect

# Terminal B — integration test (requires VicMet on VICMET_URL_TEST)
deno task --env-file=../.env test
```

`collect` depends on `vicmet:ready` (`$VICMET_URL/health`).  
`test` depends on `vicmet:test:ready` (`$VICMET_URL_TEST/health`).

From the repo root:

```bash
deno task ticks:vicmet   # terminal A — foreground test VicMet on :7357
deno task ticks          # terminal B — collect into VICMET_URL
deno task ticks:test     # terminal B — test against VICMET_URL_TEST
```

In Cursor/VS Code, open `collect_ws.test.ts` and run from Test Explorer (Deno extension; workspace settings under `.vscode/` load `.env` via `deno.envFile`). Start `ticks:vicmet` first.

## Channels

- `ticker` (snapshot + on trades) → bid / ask / bidSize / askSize
- `trade` (snapshot) → last / lastSize

Symbol overrides: `XBT/USD` → `BTC/USD`, `XDG/USD` → `DOGE/USD` (AssetPairs returns a WS-invalid `XDG/USD` wsname).
