//! REDEEM: claim winnings or a refund (`FINALIZED → FINALIZED` or
//! `VOID → VOID`). Mirrors `validate_redeem` in `pool_type/src/main.rs`.
//!
//! PoolData is immutable across a redeem — the payout ratio and share supply are
//! fixed by settlement. The treasury (PoolCell capacity for CKB pools, the
//! TreasuryCell balance for xUDT pools) shrinks by exactly the parimutuel
//! `payout`, computed by `redeemPayout`:
//!   - VOID / finalized tie: 1:1 refund of burned principal (either side).
//!   - finalized UP/DOWN winner: burn only winning shares; payout
//!     `= x + floor(x·(loser − rake)/winner)`.
//!
//! This builder burns the caller-supplied winning/refund share cells **in full**
//! (no partial redemption / share change — pre-split a cell to redeem less). The
//! draft has no fee inputs/change; run `completeFeeAndChange` then sign.

import { ccc } from "@ckb-ccc/core";

import { SIDE_DOWN, SIDE_UP, VARIANT_CKB, VARIANT_XUDT } from "../constants.js";
import { encodeAmount } from "../ckb/cellData.js";
import { encodePoolDataHex } from "../codec/poolData.js";
import { treasuryLockScript } from "../ckb/scripts.js";
import type { Hex } from "../internal/bytes.js";
import { redeemPayout } from "../payout.js";
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
  attachShareDep,
  attachTreasuryDep,
} from "./readDeps.js";

/** @public */
export interface ShareInputCell {
  outPoint: { txHash: Hex; index: number };
  /** SIDE_UP or SIDE_DOWN. */
  side: number;
  /** Share amount in this cell (burned in full). */
  amount: bigint;
  since?: bigint;
}

/** @public */
export interface BuildRedeemParams {
  deploy: PoolDeployment;
  deps: PoolCodeDeps;
  /** The settled PoolCell (status FINALIZED or VOID). */
  pool: PoolView;
  /** Lock receiving the payout (xUDT cell) and freed CKB. */
  redeemerLock: Script;
  /** Share cells to burn (winning side for a finalized win; either side for a refund). */
  shareInputs: ShareInputCell[];
  /** xUDT only: the staked asset's type script + code dep. */
  assetType?: Script;
  assetTypeDep?: CellDepInfo;
  /** xUDT only: the pool's current TreasuryCell. */
  treasury?: TreasuryCellRef;
}

/**
 * Build a REDEEM draft. `output[0]` is the PoolCell carried through unchanged
 * (capacity reduced by `payout` for CKB pools). Share inputs are burned; for xUDT
 * pools the treasury shrinks by `payout` and the payout is paid out as an asset
 * cell to the redeemer.
 */
export function buildRedeemTx(params: BuildRedeemParams): ccc.Transaction {
  const { pool, shareInputs } = params;
  if (shareInputs.length === 0) {
    throw new Error("redeem requires at least one share input to burn");
  }

  const isXudt = pool.data.variant === VARIANT_XUDT;
  if (pool.data.variant !== VARIANT_CKB && !isXudt) {
    throw new Error(`unsupported pool variant: ${pool.data.variant}`);
  }

  let burnedUp = 0n;
  let burnedDown = 0n;
  for (const s of shareInputs) {
    if (s.amount <= 0n) throw new Error("share input amount must be positive");
    if (s.side === SIDE_UP) burnedUp += s.amount;
    else if (s.side === SIDE_DOWN) burnedDown += s.amount;
    else throw new Error(`invalid share side: ${s.side}`);
  }

  // redeemPayout enforces the contract's rules (winner-only burn, no minting,
  // nothing-burned) and throws otherwise — so we never assemble an invalid redeem.
  const payout = redeemPayout({
    status: pool.data.status,
    winner: pool.data.winner,
    upTotal: pool.data.upTotal,
    downTotal: pool.data.downTotal,
    rakeBps: pool.data.rakeBps,
    burnedUp,
    burnedDown,
  });

  const poolTypeHash = ccc.Script.from(pool.typeScript).hash() as Hex;
  const poolDataHex = encodePoolDataHex(pool.data); // unchanged

  if (!isXudt && payout > pool.capacity) {
    throw new Error(`payout (${payout}) exceeds PoolCell capacity (${pool.capacity})`);
  }

  const inputs: ccc.CellInputLike[] = [{ previousOutput: pool.outPoint, since: 0n }];
  const outputs: ccc.CellOutputLike[] = [
    {
      lock: pool.lock,
      type: pool.typeScript,
      capacity: isXudt ? pool.capacity : pool.capacity - payout,
    },
  ];
  const outputsData: Hex[] = [poolDataHex];

  // Burn share cells (consumed, not re-output).
  for (const s of shareInputs) {
    inputs.push({ previousOutput: s.outPoint, since: s.since ?? 0n });
  }

  if (isXudt) {
    if (!params.assetType || !params.assetTypeDep || !params.treasury) {
      throw new Error("xUDT redeem requires assetType, assetTypeDep, and treasury");
    }
    const assetTypeHash = ccc.Script.from(params.assetType).hash() as Hex;
    if (pool.data.assetTypeHash && assetTypeHash.toLowerCase() !== pool.data.assetTypeHash.toLowerCase()) {
      throw new Error(
        `assetType hash ${assetTypeHash} does not match pool asset_type_hash ${pool.data.assetTypeHash}`,
      );
    }
    if (params.treasury.balance < payout) {
      throw new Error(`treasury (${params.treasury.balance}) cannot cover payout (${payout})`);
    }
    const treasuryLock = treasuryLockScript(params.deploy, poolTypeHash);
    const treasuryDataHex = encodeAmount(params.treasury.balance - payout);
    inputs.push({ previousOutput: params.treasury.outPoint, since: 0n });
    outputs.push({
      lock: treasuryLock,
      type: params.assetType,
      capacity: params.treasury.capacity,
    });
    outputsData.push(treasuryDataHex);

    // Pay the redeemer in the staked asset.
    const payoutData = encodeAmount(payout);
    outputs.push({
      lock: params.redeemerLock,
      type: params.assetType,
      capacity: occupiedCapacity(params.redeemerLock, params.assetType, payoutData),
    });
    outputsData.push(payoutData);
  }

  const tx = ccc.Transaction.from({
    version: 0n,
    cellDeps: [],
    headerDeps: [],
    inputs,
    outputs,
    outputsData,
    witnesses: [],
  });

  // pool_type (PoolCell in+out), pool_admin_lock (PoolCell input lock), share_xudt
  // (burned share inputs). For CKB the payout flows to the redeemer as change.
  attachPoolTypeDep(tx, params.deps);
  attachPoolAdminDep(tx, params.deps);
  attachShareDep(tx, params.deps);
  if (isXudt) {
    attachTreasuryDep(tx, params.deps);
    attachCodeDep(tx, params.assetTypeDep as CellDepInfo);
  }

  return tx;
}
