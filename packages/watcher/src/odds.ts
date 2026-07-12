//! Parimutuel display math for the API. The rake matches the contract exactly
//! (`mulDivFloor(loserTotal, rakeBps, 10000)`, via the SDK); the multiples are
//! floats for display only — settlement uses the SDK's integer `redeemPayout`.

import { mulDivFloor } from "ckb-up-down-sdk";

export interface SideOdds {
  /** Staked on this side (decimal string). */
  pool: string;
  /** Market-implied probability this side wins (staked share of the total). */
  impliedProb: number;
  /** Payout per 1 unit staked if this side wins, or null if the side is empty. */
  payoutMultiple: number | null;
}

export interface PoolOdds {
  up: SideOdds;
  down: SideOdds;
  total: string;
  /** Rake taken from the losing side if UP wins / if DOWN wins (decimal strings). */
  rakeIfUpWins: string;
  rakeIfDownWins: string;
}

function ratio(numer: bigint, denom: bigint): number | null {
  if (denom === 0n) return null;
  return Number(numer) / Number(denom);
}

/**
 * Implied odds for a pool from its side totals and rake. If a side wins, the
 * losing side (minus rake) is distributed pro-rata to winners, who also get their
 * own stake back: per-unit multiple = (winnerTotal + loserTotal − rake) / winnerTotal.
 */
export function poolOdds(p: { upTotal: bigint; downTotal: bigint; rakeBps: number }): PoolOdds {
  const { upTotal, downTotal } = p;
  const total = upTotal + downTotal;
  const bps = BigInt(p.rakeBps);
  // denom 10000 is never zero, so the null branch is unreachable.
  const rakeIfUpWins = mulDivFloor(downTotal, bps, 10_000n) ?? 0n; // loser = down
  const rakeIfDownWins = mulDivFloor(upTotal, bps, 10_000n) ?? 0n; // loser = up

  return {
    up: {
      pool: upTotal.toString(),
      impliedProb: total === 0n ? 0.5 : Number(upTotal) / Number(total),
      payoutMultiple: ratio(upTotal + downTotal - rakeIfUpWins, upTotal),
    },
    down: {
      pool: downTotal.toString(),
      impliedProb: total === 0n ? 0.5 : Number(downTotal) / Number(total),
      payoutMultiple: ratio(upTotal + downTotal - rakeIfDownWins, downTotal),
    },
    total: total.toString(),
    rakeIfUpWins: rakeIfUpWins.toString(),
    rakeIfDownWins: rakeIfDownWins.toString(),
  };
}
