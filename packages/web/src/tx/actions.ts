//! The three player write flows. Each: POST an intent to the backend, which builds
//! a fully-formed UNSIGNED transaction (inputs, outputs, fee, change) and returns
//! it as molecule hex. The browser deserializes it, the wallet signs, and we
//! broadcast. No SDK, no cell selection, no fee math here — just sign + send.

import { ccc } from "@ckb-ccc/connector-react";

import { api, type LockLike } from "../api/client.js";
import type { Hex } from "../api/types.js";

export interface TxContext {
  signer: ccc.Signer;
  /** The connected wallet's lock — the build intent's owner. */
  lock: LockLike;
}

/** Deserialize the backend's unsigned tx, sign with the wallet, broadcast. */
async function signAndSend(signer: ccc.Signer, txHex: Hex): Promise<Hex> {
  const tx = ccc.Transaction.fromBytes(txHex);
  // sendTransaction prepares witnesses, signs, and broadcasts. It does not
  // re-complete fees — the backend already did, so the inputs/change are fixed.
  return (await signer.sendTransaction(tx)) as Hex;
}

/** Buy UP/DOWN shares. Amounts are in base units (shannons for CKB pools). */
export async function deposit(
  ctx: TxContext,
  args: { poolId: Hex; upAmount: bigint; downAmount: bigint },
): Promise<Hex> {
  const { tx } = await api.buildDeposit({
    poolId: args.poolId,
    lock: ctx.lock,
    up: args.upAmount.toString(),
    down: args.downAmount.toString(),
  });
  return signAndSend(ctx.signer, tx);
}

/** Withdraw staked shares back out of an OPEN pool (the inverse of deposit). */
export async function withdraw(
  ctx: TxContext,
  args: { poolId: Hex; upAmount: bigint; downAmount: bigint },
): Promise<Hex> {
  const { tx } = await api.buildWithdraw({
    poolId: args.poolId,
    lock: ctx.lock,
    up: args.upAmount.toString(),
    down: args.downAmount.toString(),
  });
  return signAndSend(ctx.signer, tx);
}

/** Claim winnings or a void refund. */
export async function redeem(ctx: TxContext, args: { poolId: Hex }): Promise<Hex> {
  const { tx } = await api.buildRedeem({ poolId: args.poolId, lock: ctx.lock });
  return signAndSend(ctx.signer, tx);
}

/** Burn held shares standalone to reclaim their CKB capacity (e.g. a loser). */
export async function burnShares(
  ctx: TxContext,
  args: { poolId: Hex; sides?: number[] },
): Promise<Hex> {
  const { tx } = await api.buildBurn({ poolId: args.poolId, lock: ctx.lock, sides: args.sides });
  return signAndSend(ctx.signer, tx);
}
