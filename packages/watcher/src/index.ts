//! ckb-up-down-watcher — operational backend: rolling-pool keeper, chain indexer,
//! and frontend API. This barrel exposes the pure/testable pieces (config, timing
//! helpers, the keeper core + scheduler, the oracle seam); the runnable service is
//! `bin/server.ts`.

export {
  type LaneConfig,
  type WatcherConfig,
  type WatcherRole,
  laneOracleCommit,
  laneKey,
  laneKeyOf,
  laneKeySet,
  voidTimeOf,
} from "./config.js";
export { type OracleSource, StubOracleSource } from "./oracle/source.js";
export {
  LiveOracleSource,
  ReadOnlyOracleSource,
  tickFromCell,
  type OracleCellRead,
  type LiveOracleEffects,
} from "./oracle/liveSource.js";
export {
  createLeanOracleSource,
  createLeanReadOnlySource,
  type LeanOracleSourceConfig,
} from "./oracle/leanSource.js";
export { OracleWorker, type OracleWorkerDeps } from "./oracle/worker.js";
export { Mutex, noopMutex } from "./mutex.js";
export { loadLeanNetwork, oracleIdentityOf } from "./oracle/leanNetwork.js";
export {
  Cadence,
  Timeline,
  decide,
  nextWakeTime,
  voidTimeOfPool,
  closeTimeOfPool,
  type KeeperAction,
  type KeeperTransitionKind,
  type WakeEntry,
  type TimelineDeps,
} from "./keeperCore.js";
export {
  Keeper,
  type KeeperTimeline,
  type KeeperChain,
  type KeeperOracle,
  type KeeperExecutor,
  type KeeperDeps,
} from "./keeper.js";
export { type Action, type CreateAction, type TransitionAction, type CloseAction, needsTick } from "./actions.js";
export { openDb, type WatcherDb, type PoolRow, type TxLogRow } from "./db/db.js";
export { poolToRow, indexOnce, type IndexContext } from "./indexer.js";
export {
  execute,
  executeDecisions,
  type ExecContext,
  type ExecResult,
  type KeeperLike,
  type SignerLike,
  type ClientLike,
} from "./executor.js";
export { poolOdds, type PoolOdds, type SideOdds } from "./odds.js";
export { buildServer, type ApiDeps, type Position, type PositionsReader } from "./api/server.js";
export { createService, type Service, type ServiceDeps } from "./service.js";
export { reconcile, type ReconcileResult, type TxStatusClient } from "./reconcile.js";
export { defaultBtcLanes, BTC_USD_FEED } from "./presets/lanes.js";
