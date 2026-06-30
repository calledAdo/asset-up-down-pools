//! CREATE: mint a new PoolCell (`0 → 1` in the pool_type group). Mirrors
//! `validate_create` + `validate_type_id_seed` in `pool_type/src/main.rs`.
//!
//! The PoolCell's `pool_id` is a typeID seeded by the transaction's first input
//! and the PoolCell's output index, so this builder fixes the seed cell as
//! `input[0]` and the PoolCell as `output[0]`. The returned draft has **no fee
//! inputs / change** — run `completeFeeAndChange` then sign. Capacity-completion
//! must only *append* inputs (CCC's `completeInputsByCapacity` does), so the seed
//! stays at index 0 and the typeID holds.
//!
//! An xUDT pool is born with its zero-balance TreasuryCell at `output[1]` (the
//! contract requires exactly one such cell); a CKB pool has no treasury.

import { ccc } from "@ckb-ccc/core";

import {
  SIDE_UNDECIDED,
  STATUS_OPEN,
  VARIANT_CKB,
  VARIANT_XUDT,
} from "../constants.js";
import { encodeAmount } from "../ckb/cellData.js";
import { encodePoolDataHex } from "../codec/poolData.js";
import {
  poolAdminLockScript,
  poolTypeScript,
  treasuryLockScript,
} from "../ckb/scripts.js";
import { computeTypeId, type FirstInputLike } from "../ckb/typeId.js";
import type { Hex } from "../internal/bytes.js";
import type {
  CellDepInfo,
  PoolCodeDeps,
  PoolData,
  PoolDeployment,
  Script,
} from "../types.js";
import { occupiedCapacity } from "./cellCapacity.js";
import { attachCodeDep, attachPoolTypeDep } from "./readDeps.js";

/** @public */
export interface BuildCreatePoolParams {
  deploy: PoolDeployment;
  deps: PoolCodeDeps;
  /** Cell consumed to seed the typeID; placed at `input[0]`. */
  seedInput: FirstInputLike;
  /** Lock that will own the PoolCell — the creator (sole CLOSE authority). */
  creatorLock: Script;
  /** `VARIANT_CKB` or `VARIANT_XUDT`. */
  variant: number;
  /** 32-byte Pyth feed id. */
  feedId: Hex;
  /** Oracle-identity commitment (see `oracleCommit`). */
  oracleCommit: Hex;
  startTime: bigint;
  closeTime: bigint;
  rakeBps: number;
  /** xUDT only: the staked asset's type script (also fixes `asset_type_hash`). */
  assetType?: Script;
  /** xUDT only: code dep for the staked asset (its type script runs on the treasury output). */
  assetTypeDep?: CellDepInfo;
}

/**
 * Build a CREATE draft (PoolCell at `output[0]`, plus a zero TreasuryCell at
 * `output[1]` for xUDT pools). Pure — no chain reads. The result still needs fee
 * inputs/change (`completeFeeAndChange`) and signing.
 */
export function buildCreatePoolTx(params: BuildCreatePoolParams): ccc.Transaction {
  const isXudt = params.variant === VARIANT_XUDT;
  if (params.variant !== VARIANT_CKB && !isXudt) {
    throw new Error(`unknown variant: ${params.variant}`);
  }
  if (params.startTime >= params.closeTime) {
    throw new Error(`startTime (${params.startTime}) must be < closeTime (${params.closeTime})`);
  }
  if (isXudt && (!params.assetType || !params.assetTypeDep)) {
    throw new Error("xUDT CREATE requires both assetType and assetTypeDep");
  }

  // PoolCell is output[0]; its typeID is seeded by input[0] + that index.
  const poolId = computeTypeId(params.seedInput, 0);
  const poolType = poolTypeScript(params.deploy, poolId);
  const poolTypeHash = ccc.Script.from(poolType).hash() as Hex;
  const creatorLockHash = ccc.Script.from(params.creatorLock).hash() as Hex;
  const poolLock = poolAdminLockScript(params.deploy, creatorLockHash);

  const assetTypeHash = isXudt
    ? (ccc.Script.from(params.assetType as Script).hash() as Hex)
    : undefined;

  const poolData: PoolData = {
    variant: params.variant,
    assetTypeHash,
    shareXudtCodeHash: params.deploy.shareXudtCodeHash,
    treasuryLockCodeHash: isXudt ? params.deploy.treasuryLockCodeHash : undefined,
    feedId: params.feedId,
    oracleCommit: params.oracleCommit,
    startTime: params.startTime,
    closeTime: params.closeTime,
    upTotal: 0n,
    downTotal: 0n,
    startPrice: 0n,
    settlePrice: 0n,
    usedPt: 0n,
    rakeBps: params.rakeBps,
    status: STATUS_OPEN,
    winner: SIDE_UNDECIDED,
  };
  const poolDataHex = encodePoolDataHex(poolData);

  const outputs: ccc.CellOutputLike[] = [
    {
      lock: poolLock,
      type: poolType,
      capacity: occupiedCapacity(poolLock, poolType, poolDataHex),
    },
  ];
  const outputsData: Hex[] = [poolDataHex];

  if (isXudt) {
    const treasuryLock = treasuryLockScript(params.deploy, poolTypeHash);
    const treasuryDataHex = encodeAmount(0n);
    outputs.push({
      lock: treasuryLock,
      type: params.assetType,
      capacity: occupiedCapacity(treasuryLock, params.assetType, treasuryDataHex),
    });
    outputsData.push(treasuryDataHex);
  }

  const tx = ccc.Transaction.from({
    version: 0n,
    cellDeps: [],
    // No HeaderDep: `validate_create` no longer reads the header clock. CREATE
    // only enforces intrinsic PoolData shape (including startTime < closeTime).
    headerDeps: [],
    inputs: [
      {
        previousOutput: params.seedInput.previousOutput,
        since: params.seedInput.since ?? 0n,
      },
    ],
    outputs,
    outputsData,
    witnesses: [],
  });

  // pool_type runs on the PoolCell output. The PoolCell's *lock* (pool_admin_lock)
  // does not execute here — it's an output, not an input. For xUDT, the staked
  // asset's type script runs on the treasury output, so its code dep is required.
  attachPoolTypeDep(tx, params.deps);
  if (isXudt) attachCodeDep(tx, params.assetTypeDep as CellDepInfo);

  return tx;
}
