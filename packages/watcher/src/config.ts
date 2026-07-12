//! Watcher configuration: lanes (a `(feedId, duration)` cadence) and the global
//! service knobs, plus the small timing helpers the planner and indexer share.
//! Timing mirrors the contract via the SDK (`grace`, the lifecycle constants) —
//! never re-derived here.

import { grace, type Hex, type Script } from "ckb-up-down-sdk";
import { oracleCommit, type OracleIdentity } from "ckb-up-down-sdk/ckb";
import { type PoolAsset } from "ckb-up-down-sdk/tx";
import { type PoolNetworkConfig } from "ckb-up-down-sdk/presets";

/**
 * One cadence the watcher runs: a feed observed over a fixed round `duration`.
 * Rounds tile absolute time on a `durationSecs` grid (a 5m lane runs at :00, :05,
 * …); each round's deposit window is the previous round's price window, so an OPEN
 * pool is always available. The watcher mints the next grid round `createLeadSecs`
 * before its boundary to pre-stage it.
 */
export interface LaneConfig {
  /** Human label, e.g. "BTC-15m". Stored on indexed pools for grouping. */
  label: string;
  /** Pyth feed id (the oracle cell's `type.args`). */
  feedId: Hex;
  /** Round length in seconds; `close_time - start_time`. */
  durationSecs: bigint;
  /** Rake taken from the losing side, in basis points (0–10000). */
  rakeBps: number;
  /** What the pool stakes (CKB or an xUDT). */
  asset: PoolAsset;
  /** Oracle trust-root identity; `oracle_commit` is derived from it per lane. */
  oracleIdentity: OracleIdentity;
  /**
   * Pre-stage lead: mint the next grid round this long before its boundary, so the
   * OPEN pool is ready with no gap. Small (seconds); the deposit window itself is
   * one full `durationSecs` (the prior round's price window), not this value.
   */
  createLeadSecs: bigint;
}

/**
 * What a process runs. The deployment splits the concerns so each scales on its
 * own wallet, and so exactly one writer owns each shared resource:
 *  - `"oracle"`  — the SOLE writer of every feed's oracle cell. Advances each cell
 *    at the times any lane needs a tick (grid boundaries + boundaries+grace), so
 *    keepers can be pure readers. Own wallet. Run exactly one per chain.
 *  - `"keeper"`  — drives the lifecycle for its lanes and writes pool txs. Owns a
 *    private DB (just its `tx_log`); no API. Run one per feed/cadence, each with its
 *    own wallet, so they never contend over cells. **Reads** the oracle cell (never
 *    advances it — that's the oracle worker's job).
 *  - `"indexer"` — the sole writer of the shared projection DB + the Fastify API.
 *    Run exactly one; indexes pools across all keeper creator locks.
 *  - `"all"`     — everything in one process (devnet/simple single-wallet deploys).
 */
export type WatcherRole = "all" | "keeper" | "indexer" | "oracle";

/** Everything a watcher process needs. */
export interface WatcherConfig {
  /** Which concern(s) this process runs. */
  role: WatcherRole;
  /** Network + deployment (build via the SDK's `devnetConfig` or your own). */
  config: PoolNetworkConfig;
  /** Lock that owns every pool the watcher creates (sole CLOSE authority). */
  creatorLock: Script;
  /**
   * Creator lock hashes whose pools the INDEXER should project. With one keeper
   * per feed/cadence each has its own wallet → its own creator lock, and the single
   * indexer must aggregate them all (a union search). Defaults to `[creatorLock's hash]`.
   */
  operatorLockHashes?: Hex[];
  /** The cadences to run (a keeper handles only these; the indexer all of them). */
  lanes: LaneConfig[];
  /** Keeper loop cadence (seconds). */
  pollIntervalSecs: number;
  /** Indexer cadence (seconds). */
  indexIntervalSecs: number;
  /**
   * SQLite file path (":memory:" for tests). A keeper points this at a private
   * file (its `tx_log`); the indexer points it at the shared projection DB.
   */
  dbPath: string;
  /** HTTP port for the Fastify API (indexer role only). */
  apiPort: number;
  /**
   * Fee rate (shannons / 1000 bytes) for server-built player txs. Defaults to
   * 1000 when omitted; set explicitly on devnet (offckb returns null fee stats).
   */
  feeRate?: bigint;
}

/** The `oracle_commit` a lane's pools carry, derived from its trust root. */
export function laneOracleCommit(lane: LaneConfig): Hex {
  return oracleCommit(lane.oracleIdentity);
}

/** A stable key for a lane: feed + duration. Pools group to lanes by these. */
export function laneKey(feedId: Hex, durationSecs: bigint): string {
  return `${feedId.toLowerCase()}:${durationSecs.toString()}`;
}

/** A pool's lane identity, inferred from its on-chain boundaries. */
export function laneKeyOf(pool: { data: { feedId: Hex; startTime: bigint; closeTime: bigint } }): string {
  return laneKey(pool.data.feedId, pool.data.closeTime - pool.data.startTime);
}

/**
 * `void_time = close_time + grace(duration)`, the boundary that proves the
 * contest window has closed. Mirrors the contract (`grace` is the SDK's).
 */
export function voidTimeOf(pool: { data: { startTime: bigint; closeTime: bigint } }): bigint {
  return pool.data.closeTime + grace(pool.data.closeTime - pool.data.startTime);
}
