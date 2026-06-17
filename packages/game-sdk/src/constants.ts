//! Mirror of `crates/up_down/contracts/common/src/constants.rs` (the on-chain
//! source of truth). Keep these in sync with the Rust constants.

import type { Hex } from "./internal/bytes.js";

// --- Pool variants ---
export const VARIANT_CKB = 0;
export const VARIANT_XUDT = 1;

// --- Status (PoolData.status) ---
export const STATUS_OPEN = 0;
export const STATUS_LOCKED = 1;
export const STATUS_SETTLED = 2;
export const STATUS_CLOSED = 3;
export const STATUS_VOID = 4;
export const STATUS_FINALIZED = 5;

// --- Side / winner ---
export const SIDE_UNDECIDED = 0; // winner only
export const SIDE_UP = 1;
export const SIDE_DOWN = 2;
export const WINNER_VOID = 3; // winner only

// --- Bounds ---
export const RAKE_BPS_MAX = 10_000;
export const GRACE_MIN_SECS = 60n;
export const GRACE_MAX_SECS = 600n;
export const CLOSE_GRACE_SECS = 7n * 24n * 60n * 60n;

// --- PoolData byte lengths ---
export const POOL_LEN_CKB = 141;
export const POOL_LEN_XUDT = 173;

// --- Oracle cell ---
export const ORACLE_STATE_LEN = 152;

/**
 * Settlement grace: `clamp(duration / 10, 60s, 600s)`. `void_time = close_time +
 * grace`. Mirrors `constants::grace` in Rust.
 */
export function grace(durationSecs: bigint): bigint {
  const tenth = durationSecs / 10n;
  if (tenth < GRACE_MIN_SECS) return GRACE_MIN_SECS;
  if (tenth > GRACE_MAX_SECS) return GRACE_MAX_SECS;
  return tenth;
}

/**
 * Default Lean Oracle trust-root identity (testnet v2), mirroring the Rust
 * constants. The contract reads these from PoolData, not from here — they are
 * defaults the SDK uses to compute `oracleCommit` for new pools. Regenerate the
 * `oracleTypeCodeHash` when Lean Oracle v3 ships.
 */
export const TESTNET_ORACLE_IDENTITY = {
  oracleTypeCodeHash:
    "0x10c9bcc3af00fc3728cb95d5e14ec882716af5f531a010852526ce784f6958ec" as Hex,
  guardianSetTypeHash:
    "0x57bddf3d57ea45c88ab68d0de706bbaecd68895fd6062b099626deb157100119" as Hex,
  emitterChain: 26,
  emitterAddress:
    "0xe101faedac5851e32b9b23b5f9411a8c2bac4aae3ed4dd7b811dd1a72ea4aa71" as Hex,
} as const;
