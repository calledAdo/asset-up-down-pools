//! THE SEAM — the geometry of the one object, kept apart from the component
//! that draws it.
//!
//! `pot.ts` owns the money: what a side pays, what your stake would do to it.
//! This file owns the only question the picture asks — *where does the line
//! sit* — and it is the same question, because with rake set aside the
//! multiple is `total / W`, the reciprocal of a side's share of one bar. The
//! seam's position therefore IS the payout, and the rule this module exists
//! to enforce is that geometry is never faked to be legible:
//!
//!   · An empty pot has no seam. Not one at 50% — none. There is nothing to
//!     cut, and a centred line would draw an even split that does not exist.
//!   · A one-sided pot pins the seam at the very end. That extreme position
//!     is the void condition, so it is the warning, and we do not pull it in
//!     to make the bar look better.
//!   · A pot of 1,284,000 against 40 puts the seam 0.003% from the edge. It
//!     stays there. DOWN really does pay 31,459× and the picture says so.

import { seam as upShare, total, withStake, type Pot, type Side } from "./pot.js";

/** Which of the three shapes a pot is in. The renderer switches on this, and
 *  so does every caption — the states are named the same way in words. */
export type SeamShape = "empty" | "one-sided" | "cut";

export interface SeamGeometry {
  shape: SeamShape;
  /** UP's share as a percentage, 0–100. `null` only when the pot is empty. */
  at: number | null;
  /** Which side is holding all the money, when the pot is one-sided. */
  loneSide: Side | null;
  /** Your own money, drawn hatched: the span it occupies and which side it
   *  belongs to. `null` when you have not typed an amount. */
  ghost: { from: number; to: number; side: Side } | null;
  /** Where the seam sat before your stake — drawn as a faint interior rule so
   *  the movement, not just the destination, is visible. */
  wasAt: number | null;
  /** Where the seam lands once a withdrawal completes. Drawn dashed. */
  willBeAt: number | null;
}

const pct = (part: bigint, whole: bigint) => (whole === 0n ? 0 : (Number(part) / Number(whole)) * 100);

/** The pot as it stands, with nothing pending. */
export function geometry(pot: Pot): SeamGeometry {
  const share = upShare(pot);
  if (share === null) {
    return { shape: "empty", at: null, loneSide: null, ghost: null, wasAt: null, willBeAt: null };
  }
  const lone = pot.down === 0n ? "up" : pot.up === 0n ? "down" : null;
  return {
    shape: lone ? "one-sided" : "cut",
    at: share * 100,
    loneSide: lone,
    ghost: null,
    wasAt: null,
    willBeAt: null,
  };
}

/** The pot as it *would* stand with `add` base units landing on `side`.
 *
 *  The bar re-normalises to the larger total, which is the whole point: your
 *  money does not sit on top of the pot, it joins it, so everyone else's
 *  share — and the seam — moves. */
export function landing(pot: Pot, side: Side, add: bigint): SeamGeometry {
  if (add <= 0n) return geometry(pot);

  const after = withStake(pot, side, add);
  const sum = total(after);
  const upEnd = pct(after.up, sum);
  // The hatched span sits at the inner edge of its own side, against the seam:
  // UP's money grows rightward toward the cut, DOWN's grows leftward from it.
  const ghost =
    side === "up"
      ? { from: pct(pot.up, sum), to: upEnd, side }
      : { from: upEnd, to: upEnd + pct(add, sum), side };

  return {
    shape: total(after) === 0n ? "empty" : after.up === 0n || after.down === 0n ? "one-sided" : "cut",
    at: upEnd,
    loneSide: after.down === 0n ? "up" : after.up === 0n ? "down" : null,
    ghost,
    // Where the cut was before you: the same absolute money, measured against
    // the new, larger total — so the rule marks a real earlier position on
    // this bar rather than a position on a bar that no longer exists.
    wasAt: pct(pot.up, sum),
    willBeAt: null,
  };
}

/** The pot as it stands now, with `take` base units of yours about to leave it.
 *
 *  The dashed rule marks the TRUE post-withdrawal share — `(up − take) /
 *  (total − take)` — not the edge of the hatched block. Those two are very
 *  different numbers (on 5,200/2,286 with 2,000 leaving: 58.3% against 42.7%)
 *  and only the first one is the multiple quoted beside the bar. Marking the
 *  block's edge would draw a 2.34× next to a caption reading 1.70×. */
export function leaving(pot: Pot, side: Side, take: bigint): SeamGeometry {
  const held = side === "up" ? pot.up : pot.down;
  const amount = take > held ? held : take;
  if (amount <= 0n) return geometry(pot);

  const sum = total(pot);
  const upEnd = pct(pot.up, sum);
  const ghost =
    side === "up"
      ? { from: pct(pot.up - amount, sum), to: upEnd, side }
      : { from: upEnd, to: upEnd + pct(amount, sum), side };

  const after = side === "up" ? { up: pot.up - amount, down: pot.down } : { up: pot.up, down: pot.down - amount };
  const afterShare = upShare(after);

  return {
    shape: "cut",
    at: upEnd,
    loneSide: null,
    ghost,
    wasAt: null,
    willBeAt: afterShare === null ? null : afterShare * 100,
  };
}

/** The reciprocal odds scale that runs under a hero bar.
 *
 *  A side holding share `s` pays about `1/s`, so a tick for multiple `m` goes
 *  at `x = 1/m`. The scale is therefore NOT linear, and it is labelled as
 *  such — it is the one axis in the app that converts the picture back into
 *  the number without the reader doing any arithmetic. */
export function oddsTicks(dense = true): { multiple: number; at: number }[] {
  // Nothing below 1.2×. A tick at 1.05× would sit at 95% of the bar, close
  // enough to the end to crowd its neighbour and to run off the edge of a
  // narrow rail — and a side paying 1.05× needs no help being read as "nearly
  // all of the pot is already here".
  const ms = dense ? [1.2, 1.5, 2, 3, 5, 10] : [1.5, 2, 3, 5];
  return ms.map((m) => ({ multiple: m, at: (1 / m) * 100 }));
}
