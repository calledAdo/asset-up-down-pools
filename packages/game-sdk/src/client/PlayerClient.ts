//! Player-facing client: deposits and redemptions, plus all the inherited reads.
//! Each draft returns a fee-less transaction — run `complete(tx, signer)` (or the
//! free `completeFeeAndChange`) then sign.

import type { ccc } from "@ckb-ccc/core";

import {
  initiateBurnShares,
  initiateDeposit,
  initiateRedeem,
  initiateWithdraw,
  type InitiateBurnSharesParams,
  type InitiateDepositParams,
  type InitiateRedeemParams,
  type InitiateWithdrawParams,
} from "../tx/workflows.js";
import { PoolReaderClient } from "./PoolReaderClient.js";

/** Params for a client draft method: the client + deployment come from the client. */
type DraftArgs<T> = Omit<T, "client" | "deployment">;

/** @public */
export class PlayerClient extends PoolReaderClient {
  /** Draft a DEPOSIT (buy UP/DOWN shares) for a pool. */
  draftDeposit(params: DraftArgs<InitiateDepositParams>): Promise<ccc.Transaction> {
    return initiateDeposit({ client: this.client, deployment: this.config.deployment, ...params });
  }

  /** Draft a WITHDRAW (pull stake back out while OPEN, burning shares) for a pool. */
  draftWithdraw(params: DraftArgs<InitiateWithdrawParams>): Promise<ccc.Transaction> {
    return initiateWithdraw({ client: this.client, deployment: this.config.deployment, ...params });
  }

  /** Draft a REDEEM (claim winnings or a refund) for a pool. */
  draftRedeem(params: DraftArgs<InitiateRedeemParams>): Promise<ccc.Transaction> {
    return initiateRedeem({ client: this.client, deployment: this.config.deployment, ...params });
  }

  /** Draft a BURN: destroy held shares (e.g. a losing position) to reclaim their CKB. */
  draftBurnShares(params: DraftArgs<InitiateBurnSharesParams>): Promise<ccc.Transaction> {
    return initiateBurnShares({ client: this.client, deployment: this.config.deployment, ...params });
  }
}
