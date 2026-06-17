import type { Hex } from "./internal/bytes.js";

/**
 * The PoolCell payload. Mirrors `PoolData` in
 * `crates/up_down/contracts/common/src/pool_data.rs`. `pool_id` is NOT here — it
 * lives in the pool_type script args (the typeID). The UP/DOWN share-token
 * identities are derived, not stored (see `ckb/scripts`).
 *
 * Integer fields are `bigint` to match the on-chain u64/u128/i64 ranges exactly.
 */
export interface PoolData {
  /** 0 = CKB-native, 1 = xUDT. */
  variant: number;
  /** 32-byte hex; present iff `variant === VARIANT_XUDT`. */
  assetTypeHash?: Hex;
  /** Pyth feed id (oracle type script args). 32-byte hex. */
  feedId: Hex;
  /** Commitment to the trusted oracle identity. 32-byte hex. See `oracleCommit`. */
  oracleCommit: Hex;
  startTime: bigint;
  closeTime: bigint;
  upTotal: bigint;
  downTotal: bigint;
  /** Signed i64. */
  startPrice: bigint;
  /** Signed i64. */
  settlePrice: bigint;
  /** publish_time of the tick backing the current phase's price. 0 until activation. */
  usedPt: bigint;
  rakeBps: number;
  status: number;
  winner: number;
}

/** A CKB script as CCC expects it. */
export interface Script {
  codeHash: Hex;
  hashType: "type" | "data" | "data1" | "data2";
  args: Hex;
}

/**
 * The pinned script identities for a deployment, normally read from the
 * deployment toolbox artifacts (`deployment/artifacts/<network>.<family>.json`,
 * canonical `versions`). All are referenced by data hash under `data2`.
 */
export interface PoolDeployment {
  poolTypeCodeHash: Hex;
  shareXudtCodeHash: Hex;
  treasuryLockCodeHash: Hex;
  poolAdminLockCodeHash: Hex;
}
