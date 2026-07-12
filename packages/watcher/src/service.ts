//! The watcher service, composed by role (`config.role`):
//!   - "keeper"  — reconcile + the keeper loop (drives the lifecycle, writes to
//!     chain). Private DB for `tx_log`; no API. One per cadence, own wallet.
//!   - "indexer" — the indexer loop + Fastify API (the sole writer of the shared
//!     projection DB the frontend reads).
//!   - "all"     — both, in one process (devnet / single-wallet deploys).
//! The chain is the source of truth; the indexer keeps SQLite in sync and the
//! keeper drives the pools. Re-entrancy guards keep overlapping ticks from piling up.

import { ccc } from "@ckb-ccc/core";

import {
  PlayerClient,
  SIDE_DOWN,
  SIDE_UP,
  STATUS_CLOSED,
  type Hex,
  type KeeperClient,
  type PoolView,
  type Script,
} from "ckb-up-down-sdk";

import type { WatcherConfig } from "./config.js";
import { openDb, type WatcherDb } from "./db/db.js";
import { execute, executeBatch, type ExecContext, type ExecResult } from "./executor.js";
import { needsTick, type TransitionAction } from "./actions.js";
import { indexOnce } from "./indexer.js";
import { plan, nextKeeperWake } from "./planner.js";
import { reconcile } from "./reconcile.js";
import { StubOracleSource, type OracleSource } from "./oracle/source.js";
import { OracleWorker } from "./oracle/worker.js";
import { Mutex } from "./mutex.js";
import { buildServer } from "./api/server.js";
import { createTxBuilder } from "./api/txBuilder.js";

/** Fee rate (shannons / 1000 bytes) for server-built txs; devnet needs an explicit value. */
const DEFAULT_FEE_RATE = 1000n;

/**
 * Wake this long after a due boundary, so the oracle worker has advanced the cell
 * before the keeper reads it for activate/resolve/finalize.
 */
const KEEPER_POST_BOUNDARY_DELAY_MS = 5000;

/**
 * Re-attempt soon when a transition this tick skipped (oracle cell not advanced yet)
 * or failed (e.g. a batch fell back to per-pool and one had a stale cell). Short, so
 * a transient miss doesn't wait for the pool's next lifecycle event.
 */
const KEEPER_RETRY_DELAY_MS = 5000;

export interface ServiceDeps {
  config: WatcherConfig;
  /** Keeper client (wraps the CCC client + deployment). */
  keeper: KeeperClient;
  /** Signer that owns `creatorLock` (funds fees, authorizes CREATE/CLOSE). */
  signer: ccc.Signer;
  /** Lock that owns every created pool — must be the signer's lock. */
  creatorLock: Script;
  /**
   * The keeper's oracle **reader** (keeper/all roles): reads the feed's cell, never
   * advances it. Defaults to the no-op stub. Advancing is the oracle worker's job.
   */
  oracle?: OracleSource;
  /**
   * The oracle **advancer** for the oracle worker (oracle/all roles): an advancing
   * source (a `LiveOracleSource`). When present and the role runs the oracle worker,
   * it becomes the sole writer of every feed's cell.
   */
  oracleAdvancer?: OracleSource;
  /** Optional logger; defaults to console. */
  log?: (msg: string) => void;
}

export interface Service {
  db: WatcherDb;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Wire the workers + API into one start/stop-able service. */
export function createService(deps: ServiceDeps): Service {
  const { config, keeper, signer, creatorLock } = deps;
  const log = deps.log ?? ((m: string) => console.log(`[watcher] ${m}`));
  const oracle = deps.oracle ?? new StubOracleSource();
  const db = openDb(config.dbPath);
  const client = keeper.client;
  const deploy = keeper.deploy;
  const lanes = config.lanes;
  const feeds = new Set(lanes.map((l) => l.feedId.toLowerCase()));
  // The keeper only manages ITS OWN pools (CLOSE is admin-gated to the creator lock),
  // so it lists scoped to its own creator hash — never touching other creators' pools.
  const ownCreatorHash = ccc.Script.from(creatorLock).hash();
  // The indexer projects pools under these creator locks (a `pool_admin_lock` search
  // per lock). Defaults to just ours; with per-feed keepers, set `operatorLockHashes`
  // to the union of all keeper creator locks so one indexer aggregates them.
  const creatorLockHashes = config.operatorLockHashes ?? [ownCreatorHash];

  const role = config.role;
  const runsKeeper = role === "keeper" || role === "all";
  const runsIndexer = role === "indexer" || role === "all";
  const runsOracle = role === "oracle" || role === "all";

  // All wallet-spending ops (keeper transitions + oracle advances) share this one
  // wallet + CCC client, so they must be serialized — otherwise concurrent cell
  // selection collides and a tx references another's unconfirmed output.
  const walletMutex = new Mutex();
  const execCtx: ExecContext = {
    keeper, signer, client, creatorLock, oracle, db, log,
    feeRate: config.feeRate ?? DEFAULT_FEE_RATE,
    // Drop cached cells before each draft so batched/fallback txs build against the
    // current chain (a deposit may have moved a PoolCell mid-tick).
    refresh: () => client.cache.clear(),
  };
  // The API serves reads AND builds unsigned write txs (frontend signs + submits).
  // A key-less PlayerClient sharing the keeper's client suffices: it only reads the
  // chain to build + complete drafts; the user's wallet signs.
  const player = new PlayerClient({ config: config.config, cccClient: client });
  const txBuilder = createTxBuilder(player, config.feeRate ?? DEFAULT_FEE_RATE);
  // Positions are read on-demand from chain (not stored): resolve the holder's
  // address to a lock script, then read their share balances for each non-terminal
  // pool via the SDK's lock-scoped query. One query per pool the holder might be in.
  const readPositions = async (address: string, poolId?: Hex) => {
    const holderLock = (await ccc.Address.fromString(address, client)).script;
    const poolIds = poolId
      ? [poolId]
      : db.listPools().filter((p) => p.status !== STATUS_CLOSED).map((p) => p.poolId);
    const out: { poolId: Hex; side: number; amount: bigint }[] = [];
    for (const pid of poolIds) {
      let bal: { up: bigint; down: bigint };
      try {
        bal = await player.getShareBalances(pid, holderLock);
      } catch {
        continue; // pool vanished between listing and query
      }
      if (bal.up > 0n) out.push({ poolId: pid, side: SIDE_UP, amount: bal.up });
      if (bal.down > 0n) out.push({ poolId: pid, side: SIDE_DOWN, amount: bal.down });
    }
    return out;
  };
  const app = runsIndexer ? buildServer({ db, lanes, txBuilder, positions: readPositions }) : undefined;

  // Oracle worker (oracle/all roles): the SOLE writer of every feed's cell. Advances
  // at the grid boundaries + boundaries+grace any lane needs, so keepers stay pure
  // readers. Shares walletMutex so its advances never collide with keeper txs.
  const oracleWorker =
    runsOracle && deps.oracleAdvancer
      ? new OracleWorker({ source: deps.oracleAdvancer, lanes, lock: walletMutex, log })
      : undefined;

  let indexing = false;
  let keeping = false;
  let keeperStopped = false;
  let indexTimer: NodeJS.Timeout | undefined;
  let keepTimer: NodeJS.Timeout | undefined;

  async function indexTick() {
    if (indexing) return;
    indexing = true;
    try {
      // Drop cached cells so we read current chain state — pool cells move when
      // players deposit/withdraw from external wallets (the keeper's cache can't see it).
      await client.cache.clear();
      const r = await indexOnce({ client, deploy, creatorLockHashes, lanes, db });
      log(`indexed ${r.pools} pools`);
    } catch (err) {
      log(`index error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      indexing = false;
    }
  }

  // One keeper pass; returns ms to sleep until the next due moment (capped by
  // pollIntervalSecs, which also bounds retries — e.g. a transition that skipped
  // because the oracle worker hadn't advanced the cell yet).
  async function keeperTick(): Promise<number> {
    const capMs = config.pollIntervalSecs * 1000;
    if (keeping) return capMs;
    keeping = true;
    let pools: PoolView[] = [];
    let results: ExecResult[] = [];
    try {
      // Drop cached cells so transitions build against the CURRENT pool cell. A pool
      // cell moves whenever a player deposits/withdraws (an external wallet/client), so
      // the keeper's own cache goes stale and would dep a spent outpoint → "Unknown OutPoint".
      await client.cache.clear();
      const now = (await client.getTipHeader()).timestamp / 1000n;
      pools = (await keeper.listPools({ creator: ownCreatorHash })).filter((p) =>
        feeds.has(p.data.feedId.toLowerCase()),
      );
      const actions = plan({ now, pools, lanes });
      // Oracle-driven transitions batch (boundary-coincident ones → one tx); CREATE
      // and CLOSE stay individual (typeID seed input / admin-gated, no batching gain).
      const transitions = actions.filter((a): a is TransitionAction => needsTick(a));
      const rest = actions.filter((a) => !needsTick(a));
      // Serialize all wallet-spending work against the oracle worker's advances — in
      // `all` mode they share the wallet + client; the mutex keeps cell selection apart.
      if (transitions.length > 0) {
        results = await walletMutex.run(() => executeBatch(transitions, execCtx));
      }
      for (const action of rest) {
        const r = await walletMutex.run(() => execute(action, execCtx));
        results.push(r);
        if (!r.skipped) log(`${action.kind} -> ${r.txHash ?? r.reason}`);
      }
    } catch (err) {
      log(`keeper error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      keeping = false;
    }
    // Retry soon if a tx skipped because the oracle cell wasn't advanced yet, or
    // failed (a batch fallback left a pool unmoved). Otherwise sleep to the next real
    // pool-state event; the cap is a long safety backstop, not the primary cadence.
    const retrySoon = results.some(
      (r) => (r.skipped && r.reason === "no tick") || (!r.skipped && !r.txHash),
    );
    if (retrySoon) return Math.min(KEEPER_RETRY_DELAY_MS, capMs);
    const wakeNow = BigInt(Math.floor(Date.now() / 1000));
    const due = nextKeeperWake(wakeNow, pools, lanes);
    const eventMs = due === null ? capMs : Number(due - wakeNow) * 1000 + KEEPER_POST_BOUNDARY_DELAY_MS;
    return Math.max(0, Math.min(eventMs, capMs));
  }

  function scheduleKeeper(): void {
    if (keeperStopped) return;
    void keeperTick().then((delayMs) => {
      if (!keeperStopped) keepTimer = setTimeout(scheduleKeeper, delayMs);
    });
  }

  return {
    db,
    async start() {
      if (runsKeeper) {
        // Resolve any tx_log rows left dangling by a prior crash before the
        // guards are consulted, so in-flight idempotency is accurate.
        await reconcile(db, client, log);
      }
      if (runsIndexer && app) {
        await indexTick(); // prime the DB before serving
        await app.listen({ host: "0.0.0.0", port: config.apiPort });
        log(`API listening on :${config.apiPort}`);
        indexTimer = setInterval(() => void indexTick(), config.indexIntervalSecs * 1000);
      }
      if (runsKeeper) {
        scheduleKeeper(); // sleeps to the next due event, not a fixed interval
      }
      if (oracleWorker) {
        oracleWorker.start();
        log(`oracle worker on (sole writer; ${new Set(lanes.map((l) => l.feedId)).size} feed(s))`);
      }
      const ran = [
        runsKeeper && `keeper event-driven (≤${config.pollIntervalSecs}s)`,
        runsIndexer && `index ${config.indexIntervalSecs}s`,
        oracleWorker && "oracle",
      ]
        .filter(Boolean)
        .join(", ");
      log(`role=${role} started (${ran})`);
    },
    async stop() {
      if (indexTimer) clearInterval(indexTimer);
      keeperStopped = true;
      if (keepTimer) clearTimeout(keepTimer);
      oracleWorker?.stop();
      if (app) await app.close();
      db.raw.close();
      log("stopped");
    },
  };
}
