import type { Hex } from "./internal/bytes.js";

/**
 * The PoolCell payload. Mirrors `PoolData` in
 * `crates/up_down/contracts/common/src/pool_data.rs`. `pool_id` is NOT here — it
 * lives in the pool_type script args (the typeID). The selected share script
 * code hash is stored here; UP/DOWN share args are derived from the PoolCell type
 * hash plus side.
 *
 * Integer fields are `bigint` to match the on-chain u64/u128/i64 ranges exactly.
 */
export interface PoolData {
  /** 0 = CKB-native, 1 = xUDT. */
  variant: number;
  /** 32-byte hex; present iff `variant === VARIANT_XUDT`. */
  assetTypeHash?: Hex;
  /** 32-byte code hash of the share_xudt script used by this pool. */
  shareXudtCodeHash: Hex;
  /** 32-byte code hash of the treasury_lock script; present iff `variant === VARIANT_XUDT`. */
  treasuryLockCodeHash?: Hex;
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
 * The pinned script identities the SDK derives from, supplied by the caller.
 * Each is the data (code) hash of a deployed contract binary; all are referenced
 * under `data2`. Where these hashes come from is the caller's concern — the SDK
 * takes them as given.
 */
export interface PoolDeployment {
  poolTypeCodeHash: Hex;
  shareXudtCodeHash: Hex;
  treasuryLockCodeHash: Hex;
  poolAdminLockCodeHash: Hex;
}

/**
 * Where a deployed contract binary's code cell lives on-chain, for attaching as a
 * `CellDep`. `PoolDeployment` (the code hashes) *identifies* a script; this
 * *locates* the cell that carries its code. The deployment toolbox records both
 * in its artifacts; the caller threads them in.
 */
export interface CellDepInfo {
  outPoint: { txHash: Hex; index: number };
  /** `code` references the binary cell directly; `depGroup` a group of deps. */
  depType: "code" | "depGroup";
}

/**
 * Code-cell dependencies for the four pool script binaries, by family. Pairs with
 * {@link PoolDeployment}: the hashes identify each script, these outpoints locate
 * the code a transaction must reference. Only the families a given transaction
 * touches need be present (e.g. a CKB-pool deposit never needs `treasuryLock`).
 */
export interface PoolCodeDeps {
  poolType: CellDepInfo;
  shareXudt: CellDepInfo;
  treasuryLock?: CellDepInfo;
  poolAdminLock?: CellDepInfo;
}
