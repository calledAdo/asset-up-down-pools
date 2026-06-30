//! Fee / capacity completion. The transaction builders deliberately return a
//! *structurally* complete draft with **no fee inputs and no change output** — so
//! the caller (watcher or player wallet) owns its own fee policy and signer. This
//! is the last step before signing: add capacity-covering inputs and a change
//! output, then `signer.sendTransaction(tx)`.

import { ccc } from "@ckb-ccc/core";

/** @public */
export interface CompleteFeeOptions {
  /**
   * Fee rate in shannons per 1000 bytes. When omitted, CCC queries the chain's
   * fee-rate statistics. Pass an explicit value on devnet (offckb returns null
   * statistics) — e.g. `1000n`.
   */
  feeRate?: bigint;
}

/**
 * Restrict fuel selection to PLAIN cells: no type script (`scriptLenRange [0,1)`) and
 * empty data (`outputDataLenRange [0,1)`). This guarantees fee/capacity completion never
 * consumes a *meaningful* cell that shares the signer's lock — e.g. a deployed contract
 * code cell, an oracle cell, or the signer's own share/xUDT cells — which would either
 * fail to resolve on-chain or destroy state. (Staked-asset / share inputs are added
 * explicitly by the builders, never by capacity completion.)
 */
const PLAIN_FUEL_FILTER: { scriptLenRange: [number, number]; outputDataLenRange: [number, number] } = {
  scriptLenRange: [0, 1],
  outputDataLenRange: [0, 1],
};

/**
 * Add fee-paying inputs (by capacity) and a change output to a draft transaction,
 * funded from `signer` using only PLAIN cells. Mutates and returns `tx`. The result is
 * ready to sign and broadcast (`await signer.sendTransaction(tx)`).
 */
export async function completeFeeAndChange(
  tx: ccc.Transaction,
  signer: ccc.Signer,
  options?: CompleteFeeOptions,
): Promise<ccc.Transaction> {
  await tx.completeInputsByCapacity(signer, 0, PLAIN_FUEL_FILTER);
  await tx.completeFeeBy(signer, options?.feeRate, PLAIN_FUEL_FILTER);
  return tx;
}
