//! WITHDRAW: pull stake back out of a pool while it is still OPEN (`OPEN → OPEN`
//! in the pool_type group). The inverse of DEPOSIT — it burns share tokens and
//! shrinks the pool's totals + funds instead of minting and growing them. Mirrors
//! the invariant-based `validate_deposit` in `pool_type/src/main.rs`, which permits
//! totals to FALL on either side (deposit and withdraw are the same OPEN→OPEN
//! transition, distinguished only by direction).
//!
//! For each side, the contract enforces `side_out + prev.side_total == side_in +
//! next.side_total`, i.e. `Σ(burned shares) == Δtotal` on that side. So to withdraw
//! `upAmount`/`downAmount` the caller supplies share cells covering at least those
//! amounts; any surplus is returned as a single per-side **share-change** cell, and
//! the rest is burned. Funds leave the pool symmetrically to DEPOSIT:
//!   - CKB pools: PoolCell capacity shrinks by `total`; the freed CKB returns to the
//!     withdrawer via `completeFeeAndChange`'s change output.
//!   - xUDT pools: the TreasuryCell balance shrinks by `total` (absolute check:
//!     `treasury_out == next.up_total + next.down_total`) and `total` is paid out to
//!     the withdrawer as a staked-asset cell.
//!
//! Pure — no chain reads. The returned draft has no fee inputs/change; run
//! `completeFeeAndChange` then sign.

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
import type { TreasuryCellRef } from "./deposit.js";
import type { ShareInputCell } from "./redeem.js";
import {
  attachCodeDep,
  attachPoolAdminDep,
  attachPoolTypeDep,
  attachShareDep,
  attachTreasuryDep,
} from "./readDeps.js";

/** @public */
export interface BuildWithdrawParams {
  deploy: PoolDeployment;
  deps: PoolCodeDeps;
  /** The current PoolCell to consume (status must be OPEN). */
  pool: PoolView;
  /** Lock that receives the withdrawn funds (freed CKB / asset payout) and share change. */
  withdrawerLock: Script;
  /** UP shares to burn (== amount pulled off the UP side). */
  upAmount: bigint;
  /** DOWN shares to burn. */
  downAmount: bigint;
  /** Share cells to spend; Σ per side must cover that side's withdraw amount. */
  shareInputs: ShareInputCell[];
  /** xUDT only: the staked asset's type script. */
  assetType?: Script;
  /** xUDT only: code dep for the staked asset. */
  assetTypeDep?: CellDepInfo;
  /** xUDT only: the pool's current TreasuryCell. */
  treasury?: TreasuryCellRef;
}

/**
 * Build a WITHDRAW draft. `output[0]` is the continued PoolCell (capacity reduced
 * by `total` for CKB pools). Supplied share cells are burned; any per-side surplus
 * returns as a share-change cell. For xUDT pools the treasury shrinks by `total`
 * and the funds are paid out to the withdrawer as a staked-asset cell.
 */
export function buildWithdrawTx(params: BuildWithdrawParams): ccc.Transaction {
  const { pool, upAmount, downAmount, shareInputs } = params;
  if (upAmount < 0n || downAmount < 0n) {
    throw new Error("withdraw amounts must be non-negative");
  }
  const total = upAmount + downAmount;
  if (total <= 0n) {
    throw new Error("withdraw must pull a positive amount off UP and/or DOWN");
  }
  if (pool.data.status !== STATUS_OPEN) {
    throw new Error(`can only withdraw from an OPEN pool (status ${pool.data.status})`);
  }
  if (upAmount > pool.data.upTotal || downAmount > pool.data.downTotal) {
    throw new Error(
      `withdraw exceeds side totals (up ${upAmount}/${pool.data.upTotal}, down ${downAmount}/${pool.data.downTotal})`,
    );
  }

  const isXudt = pool.data.variant === VARIANT_XUDT;
  if (pool.data.variant !== VARIANT_CKB && !isXudt) {
    throw new Error(`unsupported pool variant: ${pool.data.variant}`);
  }

  // Tally supplied share inputs per side; the surplus over the burn amount is
  // returned as change so the caller only ever burns what they asked to withdraw.
  let inUp = 0n;
  let inDown = 0n;
  for (const s of shareInputs) {
    if (s.amount <= 0n) throw new Error("share input amount must be positive");
    if (s.side === SIDE_UP) inUp += s.amount;
    else if (s.side === SIDE_DOWN) inDown += s.amount;
    else throw new Error(`invalid share side: ${s.side}`);
  }
  if (inUp < upAmount || inDown < downAmount) {
    throw new Error(
      `share inputs do not cover the withdrawal (up ${inUp}/${upAmount}, down ${inDown}/${downAmount})`,
    );
  }
  const changeUp = inUp - upAmount;
  const changeDown = inDown - downAmount;

  const poolTypeHash = ccc.Script.from(pool.typeScript).hash() as Hex;

  const nextData: PoolData = {
    ...pool.data,
    upTotal: pool.data.upTotal - upAmount,
    downTotal: pool.data.downTotal - downAmount,
  };
  const nextDataHex = encodePoolDataHex(nextData);

  const inputs: ccc.CellInputLike[] = [
    { previousOutput: pool.outPoint, since: 0n },
  ];
  // PoolCell continues at output[0]. CKB pools shrink the PoolCell capacity by
  // `total` (the freed CKB flows to the withdrawer via change); xUDT pools hold
  // funds in the treasury, so PoolCell capacity is fixed.
  const outputs: ccc.CellOutputLike[] = [
    {
      lock: pool.lock,
      type: pool.typeScript,
      capacity: isXudt ? pool.capacity : pool.capacity - total,
    },
  ];
  const outputsData: Hex[] = [nextDataHex];

  // Burn the supplied share cells (consumed as inputs), and re-mint any per-side
  // surplus as a single share-change cell back to the withdrawer.
  for (const s of shareInputs) {
    inputs.push({ previousOutput: s.outPoint, since: s.since ?? 0n });
  }
  const changeShare = (side: number, amount: bigint): void => {
    if (amount <= 0n) return;
    const type = shareScript(params.deploy, poolTypeHash, side);
    const data = encodeAmount(amount);
    outputs.push({
      lock: params.withdrawerLock,
      type,
      capacity: occupiedCapacity(params.withdrawerLock, type, data),
    });
    outputsData.push(data);
  };
  changeShare(SIDE_UP, changeUp);
  changeShare(SIDE_DOWN, changeDown);

  if (isXudt) {
    if (!params.assetType || !params.assetTypeDep || !params.treasury) {
      throw new Error("xUDT withdraw requires assetType, assetTypeDep, and treasury");
    }
    const assetTypeHash = ccc.Script.from(params.assetType).hash() as Hex;
    if (pool.data.assetTypeHash && assetTypeHash.toLowerCase() !== pool.data.assetTypeHash.toLowerCase()) {
      throw new Error(
        `assetType hash ${assetTypeHash} does not match pool asset_type_hash ${pool.data.assetTypeHash}`,
      );
    }
    if (params.treasury.balance < total) {
      throw new Error(`treasury (${params.treasury.balance}) cannot cover withdrawal (${total})`);
    }

    // Treasury shrinks by exactly `total`; its balance must equal next totals.
    const treasuryLock = treasuryLockScript(params.deploy, poolTypeHash);
    const treasuryDataHex = encodeAmount(params.treasury.balance - total);
    inputs.push({ previousOutput: params.treasury.outPoint, since: 0n });
    outputs.push({
      lock: treasuryLock,
      type: params.assetType,
      capacity: params.treasury.capacity,
    });
    outputsData.push(treasuryDataHex);

    // Pay the withdrawn stake out to the withdrawer in the staked asset.
    const payoutData = encodeAmount(total);
    outputs.push({
      lock: params.withdrawerLock,
      type: params.assetType,
      capacity: occupiedCapacity(params.withdrawerLock, params.assetType, payoutData),
    });
    outputsData.push(payoutData);
  }

  const tx = ccc.Transaction.from({
    version: 0n,
    cellDeps: [],
    // No HeaderDep: withdraw is an OPEN→OPEN transition, gated by status not clock.
    headerDeps: [],
    inputs,
    outputs,
    outputsData,
    witnesses: [],
  });

  // pool_type runs on the PoolCell (in+out); its lock (pool_admin_lock) runs on the
  // input; share_xudt runs on the burned share inputs (and any change output). xUDT
  // adds the treasury lock (treasury input) and the staked asset's type script.
  attachPoolTypeDep(tx, params.deps);
  attachPoolAdminDep(tx, params.deps);
  attachShareDep(tx, params.deps);
  if (isXudt) {
    attachTreasuryDep(tx, params.deps);
    attachCodeDep(tx, params.assetTypeDep as CellDepInfo);
  }

  return tx;
}
