//! BURN: a holder destroys their own share cells (any side) to reclaim the cells'
//! CKB capacity as plain CKB. Mirrors `share_xudt`'s TRANSFER/BURN mode in
//! `share_xudt/src/main.rs`: with **no PoolCell present**, supply may not increase
//! but may freely decrease, so the burn is permitted and `pool_type` never runs.
//!
//! This is pure self-cleanup — it touches no treasury and yields no payout (a
//! payout needs a redeem, i.e. the live PoolCell). Its main use is a *loser*
//! reclaiming the CKB an otherwise-inert losing position was tying up; a winner
//! could burn too, but would forfeit the payout, so prefer REDEEM for winners.
//!
//! The draft burns the supplied share cells in full (no share output) and has no
//! fee inputs/change; run `completeFeeAndChange` then sign — the reclaimed CKB
//! returns to the holder via the change output.

import { ccc } from "@ckb-ccc/core";

import type { PoolCodeDeps } from "../types.js";
import type { ShareInputCell } from "./redeem.js";
import { attachShareDep } from "./readDeps.js";

/** @public */
export interface BuildBurnSharesParams {
  deps: PoolCodeDeps;
  /** Share cells to burn (in full). Must NOT be accompanied by their PoolCell. */
  shareInputs: ShareInputCell[];
}

/**
 * Build a BURN draft: consume the holder's share cells with no share output, so
 * `share_xudt` sees a pure supply decrease (TRANSFER/BURN mode). The PoolCell is
 * deliberately absent. The burned cells' CKB returns to the holder as change.
 */
export function buildBurnSharesTx(params: BuildBurnSharesParams): ccc.Transaction {
  if (params.shareInputs.length === 0) {
    throw new Error("burn requires at least one share input");
  }
  const tx = ccc.Transaction.from({
    version: 0n,
    cellDeps: [],
    headerDeps: [],
    inputs: params.shareInputs.map((s) => ({ previousOutput: s.outPoint, since: s.since ?? 0n })),
    outputs: [],
    outputsData: [],
    witnesses: [],
  });
  // Only share_xudt runs (on the burned inputs). No pool_type / treasury deps:
  // with no PoolCell, share_xudt is the sole gate and permits the decrease.
  attachShareDep(tx, params.deps);
  return tx;
}
