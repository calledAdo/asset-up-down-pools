//! CLOSE: terminal teardown of a settled pool (`1 → 0` in the pool_type group —
//! the PoolCell is consumed and not recreated). Mirrors `validate_close` in
//! `pool_type/src/main.rs`.
//!
//! Only a FINALIZED or VOID pool may close, and only after `close_time +
//! closeGrace(duration)` (enforced on-chain via the header time). Authorization is the
//! lock's job: teardown is not continuation, so `pool_admin_lock` takes the
//! **creator-escape** path — an input must be locked by the creator. This builder
//! therefore includes a caller-supplied creator-locked input.
//!
//! CLOSE is also the **only** time an xUDT pool's TreasuryCell can be swept: its
//! `treasury_lock` is spendable only while the PoolCell is in inputs, and after
//! CLOSE that PoolCell never exists again. So for xUDT pools this builder
//! co-consumes the treasury and pays its remaining balance (the rake) to the
//! creator. The draft has no fee inputs/change; run `completeFeeAndChange` (with
//! the creator's signer) then sign — the swept CKB returns via the change output.

import { ccc } from "@ckb-ccc/core";

import { STATUS_FINALIZED, STATUS_VOID, VARIANT_XUDT } from "../constants.js";
import { encodeAmount } from "../ckb/cellData.js";
import { treasuryLockScript } from "../ckb/scripts.js";
import type { Hex } from "../internal/bytes.js";
import type { PoolView } from "../query/pools.js";
import type {
  CellDepInfo,
  PoolCodeDeps,
  PoolDeployment,
  Script,
} from "../types.js";
import { occupiedCapacity } from "./cellCapacity.js";
import type { TreasuryCellRef } from "./deposit.js";
import {
  attachCodeDep,
  attachPoolAdminDep,
  attachPoolTypeDep,
  attachTreasuryDep,
} from "./readDeps.js";

/** @public */
export interface BuildCloseParams {
  deploy: PoolDeployment;
  deps: PoolCodeDeps;
  /** The settled PoolCell to destroy (status FINALIZED or VOID). */
  pool: PoolView;
  /**
   * The creator's lock — must hash to the PoolCell lock's args
   * (`pool_admin_lock` creator). Swept funds and CKB change go here.
   */
  creatorLock: Script;
  /** A cell locked by `creatorLock`, included to satisfy the creator-escape path. */
  creatorInput: { outPoint: { txHash: Hex; index: number }; since?: bigint };
  /** xUDT only: the staked asset's type script + code dep. */
  assetType?: Script;
  assetTypeDep?: CellDepInfo;
  /** xUDT only: the pool's TreasuryCell (swept here; its balance is paid to the creator). */
  treasury?: TreasuryCellRef;
  /**
   * A recent block hash, attached as `HeaderDep[0]`. CLOSE is gated on
   * `close_time + closeGrace(duration)`, checked against this header's timestamp,
   * so it is required on-chain. The workflow supplies the tip header.
   */
  headerDep?: Hex;
}

/**
 * Build a CLOSE draft. Consumes the PoolCell (no PoolCell output) plus a
 * creator-locked input; for xUDT pools also consumes the treasury and pays its
 * remaining balance to the creator.
 */
export function buildCloseTx(params: BuildCloseParams): ccc.Transaction {
  const { pool } = params;
  if (pool.data.status !== STATUS_FINALIZED && pool.data.status !== STATUS_VOID) {
    throw new Error(`only FINALIZED or VOID pools may close (status ${pool.data.status})`);
  }

  const creatorLockHash = ccc.Script.from(params.creatorLock).hash() as Hex;
  if (creatorLockHash.toLowerCase() !== pool.lock.args.toLowerCase()) {
    throw new Error(
      `creatorLock hash ${creatorLockHash} does not match PoolCell lock args ${pool.lock.args}`,
    );
  }

  const isXudt = pool.data.variant === VARIANT_XUDT;
  const poolTypeHash = ccc.Script.from(pool.typeScript).hash() as Hex;

  const inputs: ccc.CellInputLike[] = [
    { previousOutput: pool.outPoint, since: 0n },
    { previousOutput: params.creatorInput.outPoint, since: params.creatorInput.since ?? 0n },
  ];
  const outputs: ccc.CellOutputLike[] = [];
  const outputsData: Hex[] = [];

  if (isXudt) {
    if (!params.assetType || !params.assetTypeDep || !params.treasury) {
      throw new Error("xUDT close requires assetType, assetTypeDep, and treasury");
    }
    const assetTypeHash = ccc.Script.from(params.assetType).hash() as Hex;
    if (pool.data.assetTypeHash && assetTypeHash.toLowerCase() !== pool.data.assetTypeHash.toLowerCase()) {
      throw new Error(
        `assetType hash ${assetTypeHash} does not match pool asset_type_hash ${pool.data.assetTypeHash}`,
      );
    }
    // Sweep the treasury; its asset must be conserved, so pay any balance out.
    inputs.push({ previousOutput: params.treasury.outPoint, since: 0n });
    if (params.treasury.balance > 0n) {
      const sweptData = encodeAmount(params.treasury.balance);
      outputs.push({
        lock: params.creatorLock,
        type: params.assetType,
        capacity: occupiedCapacity(params.creatorLock, params.assetType, sweptData),
      });
      outputsData.push(sweptData);
    }
  }

  const tx = ccc.Transaction.from({
    version: 0n,
    cellDeps: [],
    headerDeps: params.headerDep ? [params.headerDep] : [],
    inputs,
    outputs,
    outputsData,
    witnesses: [],
  });

  // pool_type runs on the consumed PoolCell; pool_admin_lock authorizes via the
  // creator input. xUDT adds treasury_lock (treasury input) + the asset type dep.
  attachPoolTypeDep(tx, params.deps);
  attachPoolAdminDep(tx, params.deps);
  if (isXudt) {
    attachTreasuryDep(tx, params.deps);
    attachCodeDep(tx, params.assetTypeDep as CellDepInfo);
  }

  return tx;
}
