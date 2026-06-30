//! `ckb-up-down-sdk` — **curated public surface** for the CKB Up/Down parimutuel
//! pools.
//!
//! The package root intentionally exposes only the stable, consumer-facing API:
//! the role-split client classes, domain constants + types, the PoolData decode,
//! the parimutuel payout math, and the chain read/query layer.
//!
//! Lower-level building blocks live behind dedicated subpaths, each a barrel with
//! its own documented surface:
//!   - `ckb-up-down-sdk/presets` — network config authoring + bundled presets (devnet).
//!   - `ckb-up-down-sdk/tx`      — pure tx builders, `initiate*` workflows, plumbing.
//!   - `ckb-up-down-sdk/ckb`     — script derivation, typeID, codecs, client/signer.
//!   - `ckb-up-down-sdk/oracle`  — the optional oracle-tick adapter.

// ---- domain constants + types ----
export * from "./constants.js";
export * from "./types.js";
export { type Hex } from "./internal/bytes.js";

// ---- PoolData codec (decode is consumer-facing; encode pairs with it) ----
export { encodePoolData, encodePoolDataHex, decodePoolData } from "./codec/poolData.js";

// ---- parimutuel math ----
export { mulDivFloor, redeemPayout, type RedeemInputs } from "./payout.js";

// ---- chain reads / queries ----
export { asPool, poolIdOf, asShare, asTreasury, type CellView } from "./query/cells.js";
export {
  getPool,
  listPools,
  getTreasuryBalance,
  getShareBalances,
  collectShareCells,
  collectAssetCells,
  listShareCells,
  getShareSupply,
  poolTypeHashOf,
  type PoolView,
  type PoolFilter,
} from "./query/pools.js";

// ---- role-split clients ----
export { PoolReaderClient, type PoolClientOptions } from "./client/PoolReaderClient.js";
export { PlayerClient } from "./client/PlayerClient.js";
export { KeeperClient, type DraftCreateParams } from "./client/KeeperClient.js";
