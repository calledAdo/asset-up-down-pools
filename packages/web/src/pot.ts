//! The pot — parimutuel display math, and the one place the payout rule lives
//! on the client.
//!
//! This mirrors `poolOdds` in packages/watcher/src/odds.ts exactly. The rake
//! comes off the LOSING side only; winners get their own stake back plus a
//! pro-rata share of what's left of the losers:
//!
//!     rake     = loser · rakeBps / 10000
//!     multiple = (winner + loser − rake) / winner
//!
//! Display-only — settlement uses the SDK's integer `redeemPayout` on-chain —
//! but it stays in bigint until the final division so a big pot can't drift.
//!
//! The reason this file exists at all is the one thing that makes a pool not a
//! market: **your own stake dilutes your side**. To show that honestly the
//! client has to be able to re-price the pot as if your money were already in
//! it, which no amount of reading the server's snapshot can do.

import type { PoolOdds } from "./api/types.js";

export const SHANNON = 100_000_000n;

export type Side = "up" | "down";

/** The two side totals, in base units. Everything here is derived from these. */
export interface Pot {
  up: bigint;
  down: bigint;
}

export interface SideQuote {
  /** Base units staked on this side. */
  pool: bigint;
  /** Payout per unit staked if this side wins. `null` when EITHER side is
   *  empty: with nothing on this side there is no stake to pay a multiple on,
   *  and with nothing opposite the round voids, so there is no payout to
   *  quote. Both are an absence, not a number. */
  multiple: number | null;
  /** This side's share of the pot, 0..1. `null` when the pot is empty. */
  share: number | null;
}

export function potOf(odds: PoolOdds): Pot {
  return { up: BigInt(odds.up.pool), down: BigInt(odds.down.pool) };
}

export function total(pot: Pot): bigint {
  return pot.up + pot.down;
}

/** The pot as it would stand with `add` more base units on `side`. */
export function withStake(pot: Pot, side: Side, add: bigint): Pot {
  return side === "up" ? { up: pot.up + add, down: pot.down } : { up: pot.up, down: pot.down + add };
}

export function quote(pot: Pot, rakeBps: number, side: Side): SideQuote {
  const winner = side === "up" ? pot.up : pot.down;
  const loser = side === "up" ? pot.down : pot.up;
  const sum = winner + loser;
  const rake = (loser * BigInt(rakeBps)) / 10_000n;
  return {
    pool: winner,
    // Two different absences, and neither one is a number:
    //   · nothing on THIS side — there is no stake to pay a multiple on;
    //   · nothing on the OTHER side — there is nobody to win from, so the
    //     round voids at lock and every stake is refunded.
    // The second case is the one worth being careful about. The arithmetic
    // happily returns 1.00× for it, and 1.00× is a lie dressed as a payout:
    // it reads as "you get your money back, guaranteed", when what it means
    // is "this round does not happen". A refund is not a payout, so there is
    // no multiple to quote and the board says so with an em dash.
    multiple: winner === 0n || loser === 0n ? null : Number(winner + loser - rake) / Number(winner),
    share: sum === 0n ? null : Number(winner) / Number(sum),
  };
}

/** UP's share of the pot, 0..1 — the position of the seam. `null` = empty pot,
 *  which is a state, not a 50/50 split, and must be drawn as one. */
export function seam(pot: Pot): number | null {
  return quote(pot, 0, "up").share;
}

export interface StakeQuote {
  /** The side's multiple as it stands now. */
  before: number | null;
  /** The multiple you would actually be locking in at this instant... */
  after: number | null;
  /** ...though it keeps moving until the round locks. */
  payoutCkb: number;
  profitCkb: number;
  /** True when you'd be the only money on your side. */
  alone: boolean;
  /** True when the other side is empty — nobody to win from, so the round
   *  would void and everyone would just get their stake back. */
  noTakers: boolean;
  pot: Pot;
}

/** Price a stake of `add` base units on `side`. */
export function stakeQuote(pot: Pot, rakeBps: number, side: Side, add: bigint): StakeQuote {
  const after = withStake(pot, side, add);
  const q = quote(after, rakeBps, side);
  const mine = side === "up" ? after.up : after.down;
  const others = side === "up" ? after.down : after.up;

  // Your slice of the winning side, times the whole post-rake pot.
  const payout = mine === 0n ? 0 : (Number(add) / Number(mine)) * Number(mine + others - (others * BigInt(rakeBps)) / 10_000n);

  return {
    before: quote(pot, rakeBps, side).multiple,
    after: q.multiple,
    payoutCkb: payout / Number(SHANNON),
    profitCkb: (payout - Number(add)) / Number(SHANNON),
    alone: (side === "up" ? pot.up : pot.down) === 0n,
    noTakers: others === 0n,
    pot: after,
  };
}
