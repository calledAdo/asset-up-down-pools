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

## Status

The real oracle path is wired and verified live on devnet end-to-end. Oracle access is
pluggable behind `OracleSource`: the `oracle` role runs an `OracleWorker` that advances each
feed's Lean Oracle cell from real Pyth/Hermes updates (`ckb-up-down-sdk/oracle` +
`lean-oracle-sdk`), while keepers read the cell as a pure `ReadOnlyOracleSource`. A no-op
`StubOracleSource` remains the default when `WATCHER_ORACLE` is unset (CREATE and CLOSE still
fire; activate/resolve/finalize are skipped + logged). Set `WATCHER_ORACLE=live` for the real
source. Corrections (CORRECT-start/settle) and VOID are modeled and driven by the keeper.

## Architecture

The keeper is **edge-triggered and self-scheduling**: every pool and cadence carries its own
timer to its next due moment, and at fire time a pure `decide(pool, now, tick)` derives the
action from fresh chain state (never a stored action), so third-party transitions and crash
recovery take the same path. A low-frequency safety sweep re-derives the schedule from chain
truth as a backstop. The indexer, executor, oracle worker, and API are I/O shells around the
pure core (`keeperCore.ts`) and the DB.

```
src/
  config.ts        lanes + service knobs; grace/voidTime/lane helpers (reuse SDK)
  keeperCore.ts    PURE core: Cadence grid math, Timeline scheduler, decide/nextWakeTime
  keeper.ts        edge-triggered keeper (onWake single-flight, onSweep backstop)
  actions.ts       Action ADT
  indexer.ts       chain -> SQLite projection
  executor.ts      Action -> tx via KeeperClient; batch-by-cell + tx_log idempotency
  reconcile.ts     confirmed post-state read after execution
  mutex.ts         per-wallet serialized tx queue
  odds.ts          parimutuel display odds (reuse SDK redeemPayout/mulDivFloor)
  oracle/
    source.ts      OracleSource seam + StubOracleSource
    worker.ts      OracleWorker — sole cell writer, self-schedules to boundaries+grace
    leanSource.ts  Lean Oracle reader (keeper) + advancer (worker) via lean-oracle-sdk
    liveSource.ts  LiveOracleSource effects
    leanNetwork.ts load a lean-oracle deployment config + derive OracleIdentity
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
| `GET /pools/:poolId/positions?address=` | a holder's position in one pool (CKB address) |
| `GET /positions?address=<ckbAddress>` | a holder's positions across pools (CKB address) |
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
