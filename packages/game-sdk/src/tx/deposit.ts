//! DEPOSIT: buy UP and/or DOWN shares while a pool is OPEN (`OPEN → OPEN` in the
//! pool_type group). Mirrors `validate_deposit` in `pool_type/src/main.rs`.
//!
//! Conservation, per the contract: each side's net share mint equals that side's
//! total delta, and the staked amount `total = up_d + down_d` enters the pool —
//! as added PoolCell **capacity** (CKB pools) or as added **TreasuryCell balance**
//! funded by depositor asset cells (xUDT pools). The PoolCell input's lock
//! (`pool_admin_lock`) passes permissionlessly on continuation, and the share
//! token mints because the PoolCell is present in inputs.
//!
//! Pure — no chain reads. Pass the already-fetched PoolCell (and, for xUDT, the
//! TreasuryCell and the depositor's asset input cells). The returned draft has no
//! fee inputs/change; run `completeFeeAndChange` then sign.

import { ccc } from "@ckb-ccc/core";

import { SIDE_DOWN, SIDE_UP, STATUS_OPEN, VARIANT_CKB, VARIANT_XUDT } from "../constants.js";
import { encodeAmount } from "../ckb/cellData.js";
import { encodePoolDataHex } from "../codec/poolData.js";
import { shareScript, treasuryLockScript } from "../ckb/scripts.js";
import type { Hex } from "../internal/bytes.js";
import type { PoolView } from "../query/pools.js";
import type {
  CellDepInfo,
  PoolCodeDeps,
  PoolData,
  PoolDeployment,
  Script,
} from "../types.js";
import { occupiedCapacity } from "./cellCapacity.js";
import {
  attachCodeDep,
  attachPoolAdminDep,
  attachPoolTypeDep,
  attachShareDep,
  attachTreasuryDep,
} from "./readDeps.js";

/** @public */
export interface AssetInputCell {
  outPoint: { txHash: Hex; index: number };
  /** xUDT amount carried by this cell. */
  amount: bigint;
  since?: bigint;
}

/** @public */
export interface TreasuryCellRef {
  outPoint: { txHash: Hex; index: number };
  /** The TreasuryCell's CKB capacity (carried through unchanged). */
  capacity: bigint;
  /** Current staked-asset balance. */
  balance: bigint;
}

/** @public */
export interface BuildDepositParams {
  deploy: PoolDeployment;
  deps: PoolCodeDeps;
  /** The current PoolCell to consume (status must be OPEN). */
  pool: PoolView;
  /** Lock that will own the minted shares (and any xUDT asset change). */
  depositorLock: Script;
  /** UP shares to buy (== amount staked on UP). */
  upAmount: bigint;
  /** DOWN shares to buy. */
  downAmount: bigint;
  /** xUDT only: the staked asset's type script. */
  assetType?: Script;
  /** xUDT only: code dep for the staked asset. */
  assetTypeDep?: CellDepInfo;
  /** xUDT only: the pool's current TreasuryCell. */
  treasury?: TreasuryCellRef;
  /** xUDT only: depositor's staked-asset input cells; Σ amount must cover `total`. */
  assetInputs?: AssetInputCell[];
}

/**
 * Build a DEPOSIT draft. `output[0]` is the continued PoolCell; minted share
 * cells (and, for xUDT, the grown treasury and any asset change) follow.
 */
export function buildDepositTx(params: BuildDepositParams): ccc.Transaction {
  const { pool, upAmount, downAmount } = params;
  if (upAmount < 0n || downAmount < 0n) {
    throw new Error("deposit amounts must be non-negative");
  }
  const total = upAmount + downAmount;
  if (total <= 0n) {
    throw new Error("deposit must buy a positive amount of UP and/or DOWN shares");
  }
  if (pool.data.status !== STATUS_OPEN) {
    throw new Error(`can only deposit into an OPEN pool (status ${pool.data.status})`);
  }

  const isXudt = pool.data.variant === VARIANT_XUDT;
  if (pool.data.variant !== VARIANT_CKB && !isXudt) {
    throw new Error(`unsupported pool variant: ${pool.data.variant}`);
  }

  const poolTypeHash = ccc.Script.from(pool.typeScript).hash() as Hex;

  const nextData: PoolData = {
    ...pool.data,
    upTotal: pool.data.upTotal + upAmount,
    downTotal: pool.data.downTotal + downAmount,
  };
  const nextDataHex = encodePoolDataHex(nextData);

  const inputs: ccc.CellInputLike[] = [
    { previousOutput: pool.outPoint, since: 0n },
  ];
  // PoolCell continues at output[0]. CKB pools grow the PoolCell capacity by
  // `total`; xUDT pools hold funds in the treasury, so PoolCell capacity is fixed.
  const outputs: ccc.CellOutputLike[] = [
    {
      lock: pool.lock,
      type: pool.typeScript,
      capacity: isXudt ? pool.capacity : pool.capacity + total,
    },
  ];
  const outputsData: Hex[] = [nextDataHex];

  const mintShare = (side: number, amount: bigint): void => {
    if (amount <= 0n) return;
    const type = shareScript(params.deploy, poolTypeHash, side);
    const data = encodeAmount(amount);
    outputs.push({
      lock: params.depositorLock,
      type,
      capacity: occupiedCapacity(params.depositorLock, type, data),
    });
    outputsData.push(data);
  };
  mintShare(SIDE_UP, upAmount);
  mintShare(SIDE_DOWN, downAmount);

  if (isXudt) {
    if (!params.assetType || !params.assetTypeDep || !params.treasury || !params.assetInputs) {
      throw new Error(
        "xUDT deposit requires assetType, assetTypeDep, treasury, and assetInputs",
      );
    }
    const assetTypeHash = ccc.Script.from(params.assetType).hash() as Hex;
    if (pool.data.assetTypeHash && assetTypeHash.toLowerCase() !== pool.data.assetTypeHash.toLowerCase()) {
      throw new Error(
        `assetType hash ${assetTypeHash} does not match pool asset_type_hash ${pool.data.assetTypeHash}`,
      );
    }

    // Treasury grows by exactly `total`.
    const treasuryLock = treasuryLockScript(params.deploy, poolTypeHash);
    const treasuryDataHex = encodeAmount(params.treasury.balance + total);
    inputs.push({ previousOutput: params.treasury.outPoint, since: 0n });
    outputs.push({
      lock: treasuryLock,
      type: params.assetType,
      capacity: params.treasury.capacity,
    });
    outputsData.push(treasuryDataHex);

    // Depositor asset cells fund the stake; the remainder returns as change.
    let assetIn = 0n;
    for (const cell of params.assetInputs) {
      inputs.push({ previousOutput: cell.outPoint, since: cell.since ?? 0n });
      assetIn += cell.amount;
    }
    if (assetIn < total) {
      throw new Error(`asset inputs (${assetIn}) do not cover the deposit total (${total})`);
    }
    const change = assetIn - total;
    if (change > 0n) {
      const changeData = encodeAmount(change);
      outputs.push({
        lock: params.depositorLock,
        type: params.assetType,
        capacity: occupiedCapacity(params.depositorLock, params.assetType, changeData),
      });
      outputsData.push(changeData);
    }
  }

  const tx = ccc.Transaction.from({
    version: 0n,
    cellDeps: [],
    // No HeaderDep: `validate_deposit` no longer reads the header clock — deposits
    // are bounded by the status machine (OPEN→OPEN), not a `start_time` timestamp.
    // Only CLOSE still reads "now". (Was `headerDeps: [tipHeader]`.)
    headerDeps: [],
    inputs,
    outputs,
    outputsData,
    witnesses: [],
  });

  // pool_type runs on the PoolCell (in+out); its lock (pool_admin_lock) runs on the
  // input; share_xudt runs on the minted share outputs. xUDT adds the treasury lock
  // (treasury input) and the staked asset's type script (treasury/asset cells).
  attachPoolTypeDep(tx, params.deps);
  attachPoolAdminDep(tx, params.deps);
  attachShareDep(tx, params.deps);
  if (isXudt) {
    attachTreasuryDep(tx, params.deps);
    attachCodeDep(tx, params.assetTypeDep as CellDepInfo);
  }

  return tx;
}
