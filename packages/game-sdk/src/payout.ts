//! Parimutuel redeem math — a faithful mirror of `validate_redeem` in
//! `pool_type`. Pure functions: a redeem builder uses `redeemPayout` to set the
//! treasury delta, and a UI uses it to preview winnings.

import {
  SIDE_DOWN,
  SIDE_UP,
  STATUS_FINALIZED,
  STATUS_VOID,
  WINNER_VOID,
} from "./constants.js";

/** `floor(a * b / d)` in bigint, or null on `d == 0`. */
export function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint | null {
  if (d === 0n) return null;
  return (a * b) / d;
}

export interface RedeemInputs {
  status: number;
  winner: number;
  upTotal: bigint;
  downTotal: bigint;
  rakeBps: number;
  /** Net burned (inputs − outputs) of each side's share token in this redeem. */
  burnedUp: bigint;
  burnedDown: bigint;
}

/**
 * The exact payout the treasury must release for a redeem, matching the
 * contract. Throws on the same conditions the contract rejects (so a builder
 * never assembles an invalid redeem).
 *
 * - VOID, or a FINALIZED tie (winner == VOID): 1:1 refund of burned principal
 *   (both sides; no minting).
 * - FINALIZED with a UP/DOWN winner: only winning shares may burn; payout is
 *   `x + floor(x * (loser − rake) / winner)`, `rake = floor(loser * rakeBps / 10000)`.
 */
export function redeemPayout(r: RedeemInputs): bigint {
  const refund1to1 =
    r.status === STATUS_VOID || (r.status === STATUS_FINALIZED && r.winner === WINNER_VOID);

  if (refund1to1) {
    if (r.burnedUp < 0n || r.burnedDown < 0n) {
      throw new Error("refund cannot mint shares (burned must be >= 0)");
    }
    const total = r.burnedUp + r.burnedDown;
    if (total === 0n) throw new Error("nothing burned");
    return total; // 1:1 principal refund
  }

  if (r.status !== STATUS_FINALIZED) {
    throw new Error(`cannot redeem from status ${r.status}`);
  }

  let winnerTotal: bigint;
  let loserTotal: bigint;
  let burnedWinner: bigint;
  let burnedLoser: bigint;
  if (r.winner === SIDE_UP) {
    winnerTotal = r.upTotal;
    loserTotal = r.downTotal;
    burnedWinner = r.burnedUp;
    burnedLoser = r.burnedDown;
  } else if (r.winner === SIDE_DOWN) {
    winnerTotal = r.downTotal;
    loserTotal = r.upTotal;
    burnedWinner = r.burnedDown;
    burnedLoser = r.burnedUp;
  } else {
    throw new Error(`invalid winner ${r.winner} for a finalized payout`);
  }

  if (burnedWinner <= 0n || burnedLoser !== 0n) {
    throw new Error("only winning shares may burn");
  }
  if (winnerTotal === 0n) throw new Error("winner total is zero");

  const x = burnedWinner;
  const rake = mulDivFloor(loserTotal, BigInt(r.rakeBps), 10_000n);
  if (rake === null) throw new Error("rake division failed");
  const distributable = loserTotal - rake;
  const profit = mulDivFloor(x, distributable, winnerTotal);
  if (profit === null) throw new Error("profit division failed");
  return x + profit;
}
