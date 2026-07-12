//! Server-side transaction building for the frontend. The browser never runs the
//! SDK: it POSTs an *intent* (pool + the user's lock + amounts/sides), we build the
//! pool-specific draft with `PlayerClient`, then complete fees + change + funding
//! inputs against a **key-less** `SignerCkbScriptReadonly` for the user's lock —
//! yielding a FULLY-FORMED, UNSIGNED transaction. The frontend deserializes it,
//! has the wallet sign, and broadcasts. No private key ever leaves the browser and
//! no SDK ships to it.

import { ccc } from "@ckb-ccc/core";
import { SIDE_DOWN, SIDE_UP, type PlayerClient } from "ckb-up-down-sdk";

export type Hex = `0x${string}`;

/** A lock script as the frontend sends it (from `signer.getRecommendedAddressObj`). */
export interface LockLike {
  codeHash: Hex;
  hashType: "type" | "data" | "data1" | "data2";
  args: Hex;
}

export interface PoolTxBuilder {
  deposit(i: { poolId: Hex; lock: LockLike; upAmount: bigint; downAmount: bigint }): Promise<Hex>;
  withdraw(i: { poolId: Hex; lock: LockLike; upAmount: bigint; downAmount: bigint }): Promise<Hex>;
  redeem(i: { poolId: Hex; lock: LockLike }): Promise<Hex>;
  burn(i: { poolId: Hex; lock: LockLike; sides?: number[] }): Promise<Hex>;
}

/**
 * Build a tx-builder bound to a player client + fee rate. The same CCC client the
 * client reads with is used to resolve the user's cells for completion.
 */
export function createTxBuilder(player: PlayerClient, feeRate: bigint): PoolTxBuilder {
  // Finalize a pool-specific draft into a complete unsigned tx for `lock`.
  async function finalize(lock: LockLike, draft: ccc.Transaction): Promise<Hex> {
    const readonly = new ccc.SignerCkbScriptReadonly(player.client, ccc.Script.from(lock));
    await player.complete(draft, readonly, { feeRate });
    return ccc.hexFrom(draft.toBytes()) as Hex;
  }

  return {
    async deposit({ poolId, lock, upAmount, downAmount }) {
      const draft = await player.draftDeposit({
        poolId,
        depositorLock: ccc.Script.from(lock),
        upAmount,
        downAmount,
      });
      return finalize(lock, draft);
    },

    async withdraw({ poolId, lock, upAmount, downAmount }) {
      const draft = await player.draftWithdraw({
        poolId,
        withdrawerLock: ccc.Script.from(lock),
        upAmount,
        downAmount,
      });
      return finalize(lock, draft);
    },

    async redeem({ poolId, lock }) {
      const draft = await player.draftRedeem({ poolId, redeemerLock: ccc.Script.from(lock) });
      return finalize(lock, draft);
    },

    async burn({ poolId, lock, sides }) {
      const draft = await player.draftBurnShares({
        poolId,
        holderLock: ccc.Script.from(lock),
        sides: sides ?? [SIDE_UP, SIDE_DOWN],
      });
      return finalize(lock, draft);
    },
  };
}
