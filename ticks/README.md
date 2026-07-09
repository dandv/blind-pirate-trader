# Tick collection

Kraken Spot market data → VictoriaMetrics ingest for Blind Pirate Trader historical price data.

Two collectors share the same top-20 /USD pair discovery (`discover_pairs.ts`):

| Collector | Source label | What it writes |
| --- | --- | --- |
| `collect_ws.ts` | `source=ws` | Live BBO + trade ticks via Kraken WS v2 |
| `collect_trades.ts` | `source=trades` | Raw public trades backfilled from REST `/Trades` (1 month) |

Both dump with `exchange=kraken`. The game builds **5-second** OHLCV from VictoriaMetrics via PromQL (`first/max/min/last_over_time` on `ticks_last`, `sum_over_time` on `ticks_lastSize`) — collectors do not pre-aggregate bars.

## WS vs REST trades (API tick perspective)

On the wire they look different; once stored as `ticks_last` they are almost the same tape.

| | WS (`collect_ws`) | REST trades (`collect_trades`) |
| --- | --- | --- |
| Kraken API | Public WS v2 `ticker` + `trade` | REST `/0/public/Trades` (paginated) |
| VicMet labels | `source=ws` (legacy long-run series often omit `source`) | `source=trades` |
| Fields | BBO (`bid`/`ask`/sizes) + last trade | Last trade only (`last` / `lastSize`) |
| Cadence | Live stream; one stored value per ms for `last` | Full print history; multiple prints can share a ms |
| History | Only while the collector is running | Backfill (~1 month) via `since` cursor |

**Measured overlap (BTC/USD on VicMet :57003, ~29 days from 2026-06-09):** unique millisecond timestamps matched **99.9%**. Raw sample counts were ~1.94× higher for `source=trades` because REST keeps every print in a same-ms burst while the unlabeled WS series kept one. Non-zero inter-arrival gap histograms matched; long quiet periods were shared market silence (one ~22 min REST backfill hole on Jun 11).

For the game’s **5s OHLCV**, that means switching `source=trades` vs WS does not make a difference, because extra same-millisecond ticks collapse into the same candle.

Full charts and tables: [BTC/USD trades vs WS report](https://dandv.github.io/blind-pirate-trader/reports/btc-usd-trades-vs-ws/) (static HTML under `public/reports/`, published with GitHub Pages).

## Layout

| File | Role |
| --- | --- |
| `discover_pairs.ts` | Top-N /USD pair ranking (shared) |
| `collect_ws.ts` | Live WS collector |
| `collect_trades.ts` | Historical raw-trade backfill from `/Trades` |
| `VicMet.ts` | Thin VicMet client (`dumpTicks` / `flush`) |
| `collect_ws.test.ts` | Integration test: live WS → VicMet |
| `deno.jsonc` | Tasks + JSR imports |

## Environment (repo-root `.env`)

| Variable | Used by | Purpose |
| --- | --- | --- |
| `VICMET_URL_TEST` | test | Local test VicMet (`http://127.0.0.1:7357`; 7357 ≈ “test”) |
| `VICMET_URL` | `collect`, `collect:trades` | Live ingest target (e.g. `http://127.0.0.1:8428` or remote) |

The game app separately uses `VICMET_BASE` (CORS gateway) — not this package.

Load dotenv into the task shell with Deno’s `--env-file` (relative to the directory you invoke from):

```bash
cd ticks
deno task --env-file=../.env collect
deno task --env-file=../.env collect:trades
deno task --env-file=../.env test
```

From the repo root, the `ticks` / `ticks:trades` / `ticks:test` tasks already pass `--env-file`.

## Usage

`deno task vicmet` starts a **test** instance on `:7357` in the foreground (logs stay visible). Live collection uses `VICMET_URL` from `.env`, which need not be that instance.

```bash
cd ticks

# Terminal A — test VicMet on :7357
deno task vicmet

# Terminal B — live WS collect into VICMET_URL from .env
deno task --env-file=../.env collect

# Terminal B — 1-month raw-trade backfill from REST Trades
deno task --env-file=../.env collect:trades

# Terminal B — integration test (requires VicMet on VICMET_URL_TEST)
deno task --env-file=../.env test
```

`collect` / `collect:trades` depend on `vicmet:ready` (`$VICMET_URL/health`).  
`test` depends on `vicmet:test:ready` (`$VICMET_URL_TEST/health`).

From the repo root:

```bash
deno task ticks:vicmet   # terminal A — foreground test VicMet on :7357
deno task ticks          # terminal B — live WS → VICMET_URL
deno task ticks:trades   # terminal B — REST Trades backfill → VICMET_URL
deno task ticks:test     # terminal B — test against VICMET_URL_TEST
```

In Cursor/VS Code, open `collect_ws.test.ts` and run from Test Explorer (Deno extension; workspace settings under `.vscode/` load `.env` via `deno.envFile`). Start `ticks:vicmet` first.

## Live WS channels (`collect_ws`)

- `ticker` (snapshot + on trades) → bid / ask / bidSize / askSize
- `trade` (snapshot) → last / lastSize

Symbol overrides: `XBT/USD` → `BTC/USD`, `XDG/USD` → `DOGE/USD` (AssetPairs returns a WS-invalid `XDG/USD` wsname).

## Historical raw trades (`collect_trades`)

### Why not `/public/OHLC`?

Kraken’s OHLC endpoint only returns the **most recent 720 candles**, regardless of `since`. At `interval=1` that is only ~12 hours of trades, and we're aiming for a month in the game. We ingest the public **Trades** tape instead (full history), and leave 5s candle aggregation to the game’s VicMet queries.

### Can we request more than one pair per call?

**No.** Both `/public/Trades` and `/public/OHLC` take a single `pair`. Comma-separated values return `EQuery:Unknown asset pair`. We loop pairs sequentially.

### Trades pagination

Endpoint: `GET https://api.kraken.com/0/public/Trades`

| Param | Role |
| --- | --- |
| `pair` | One instrument (we use display names via `assetVersion=1`, e.g. `BTC/USD`) |
| `since` | Nanosecond cursor — return trades **after** this time |
| `count` | Page size, max **1000** |

Each response includes:

- an array of trades: `[price, volume, time, side, orderType, misc, trade_id]`
- `result.last` — opaque **nanosecond** token for the next page

Algorithm:

1. Start `since` at `(now − 30 days)` encoded as a nanosecond string (`${unixSec}000000000`).
2. Request up to 1000 trades.
3. Dump each print as a VicMet tick (`last` = price, `lastSize` = size) with `source=trades`.
4. Set `since = result.last` (keep it as a **string** — never `Number(...)`; float64 drops ns precision and can loop forever).
5. Sleep ~1.2s between pages (Kraken recommends 1–2s for bulk historical pulls).
6. Stop when a trade reaches “now”, the page is empty, or `last` stops advancing.

Progress is saved under `logs/.collect_trades_progress.json` (per-pair `since`) so a restart resumes instead of re-downloading.

A month of BTC/USD can still be a large number of trades → many pages; expect a longish run and respect rate limits (`EAPI:Rate limit exceeded` / `EService: Throttled` → we back off 5s and retry).
