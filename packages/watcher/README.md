# ckb-up-down-watcher

Operational backend for the CKB Up/Down prediction pools. Three concerns that can
run together (`all`) or split by role for scale (see [Deployment](#deployment)):

1. **Keeper** — runs rolling pools per *lane* (`(feedId, duration)` cadence: 5m,
   15m, 1h, 1d …): mints the next round so an OPEN deposit pool is always
   available, drives the lifecycle (activate → resolve → finalize, void on a missed
   window), and tears down terminal pools (CLOSE after the duration-proportional
   teardown grace — a use-it-or-lose-it window).
2. **Indexer** — projects live on-chain pools + share positions into SQLite so the
   frontend gets fast reads.
3. **API** — a Fastify server over that SQLite projection.

The chain is the source of truth; the DB is a refreshable projection. The watcher
provides liveness + indexing, not safety — the contract authenticates all
prices/winners via oracle `publish_time`.

## Status: v1 (oracle deferred)

Oracle wiring is pluggable behind `OracleSource`; v1 ships the no-op
`StubOracleSource`. So **CREATE and CLOSE (oracle-free) fire live**, while
activate/resolve/finalize are planned + built but **skipped (logged)** until a real
source is wired (`ckb-up-down-sdk/oracle`). Corrections are modeled but not wired.

## Architecture

Pure-core + thin-shell. The **planner** (`src/planner.ts`) is pure —
`(now, pools, lanes) -> Action[]` — and exhaustively unit-tested. The
indexer, executor, and API are I/O shells around it and the DB.

```
src/
  config.ts        lanes + service knobs; grace/voidTime/lane helpers (reuse SDK)
  planner.ts       PURE decision core
  actions.ts       Action ADT
  indexer.ts       chain -> SQLite projection
  executor.ts      Action -> tx via KeeperClient; tx_log idempotency
  odds.ts          parimutuel display odds (reuse SDK redeemPayout/mulDivFloor)
  oracle/source.ts OracleSource seam + stub
  db/              schema + better-sqlite3 repo
  api/server.ts    Fastify routes
  service.ts       compose db + workers + API (start/stop)
  bin/server.ts    entrypoint
  presets/lanes.ts example BTC lanes
```

## API

| Route | Description |
|---|---|
| `GET /health` | liveness + `lastIndexedAt` |
| `GET /lanes` | configured lanes + each lane's current OPEN pool |
| `GET /pools?status=&lane=` | list/filter pools (with odds) |
| `GET /pools/:poolId` | pool detail: totals, odds, prices, timing, status |
| `GET /pools/:poolId/positions?lock=` | a holder's position in one pool |
| `GET /positions?lock=<lockHash>` | a holder's positions across pools |
| `GET /history?lane=` | finalized/void rounds |

Bigints are serialized as decimal strings; permissive CORS for browser use.

## Run

```bash
npm install && npm run build
cp .env.example .env   # fill in RPC, creator key, offckb secp override
node --env-file=.env dist/bin/server.js
```

## Deployment

`WATCHER_ROLE` picks what a process runs:

- **`all`** — keeper + indexer + API + oracle in one process, one wallet. Simplest;
  good for devnet or a single-board deploy.
- **`keeper`** — drives the lifecycle for its lanes and writes pool txs. Owns a
  private DB (just its `tx_log` idempotency); no API. **Run one per feed, with its
  own wallet.** It handles every configured duration for its feed, but only its
  exact configured `(feedId, durationSecs)` lane set — never a retired duration that
  shares its creator lock.
- **`oracle`** — the SOLE writer of every feed's oracle cell; advances each cell at
  the boundaries + boundaries+grace any lane needs, so keepers stay pure readers.
  Own wallet. **Run exactly one per chain.**
- **`indexer`** — the sole writer of the shared projection DB + the Fastify API the
  frontend reads. **Run exactly one.**

`WATCHER_LANES` (comma-list of lane labels, e.g. `BTC-15m`) pins which cadences a
keeper handles; empty means all configured. The bundled `docker-compose.yml` wires
one `indexer`, one `oracle` writer, and **one keeper per feed** (`keeper-btc`, all
BTC durations), each reading its own key from `WATCHER_KEY_ORACLE`/`WATCHER_KEY_BTC`.

Why per-feed, not per-cadence: all of a feed's durations read the *same* oracle cell,
so one process can fold their coincident boundary transitions (resolve the closing
round + activate the next, across durations) into a single tx — `pool_type` allows one
oracle dep per feed per tx, and only a shared executor/wallet can co-sign that batch.
Separate cadence keepers would lose the batching and multiply wallets/DBs/RPC; shard a
feed into per-cadence keepers only later, if transaction size or failure isolation
demands it. Separate wallets avoid CKB cell contention; the projection DB stays
single-writer (the indexer) so the frontend reads one consistent store.

```bash
docker compose --env-file .env up --build
```

## Test

```bash
npm test   # grace, keeper core + runtime, indexer, executor, oracle, api — pure/in-memory, no chain
```

Opt-in devnet smoke (needs a running offckb devnet + funded creator key):

```bash
node --env-file=.env tests/integration/devnet/smoke.test.mjs
```

## Lanes

Lanes are config-driven (`LaneConfig`). `presets/lanes.ts` ships a default BTC
board (5m/15m/1h/1d, CKB-staked, 2% rake). Each lane carries its `oracleIdentity`;
`oracle_commit` is derived per lane via the SDK's `oracleCommit`.
