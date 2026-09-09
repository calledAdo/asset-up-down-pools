//! The pot, drawn as one bar divided once.
//!
//! Where the divide sits IS the payout: with the rake set aside a side's
//! multiple is `total / that side`, the reciprocal of its share of the bar.
//! So this isn't a decoration next to the numbers, it's the same fact drawn.
//!
//! Two states are not splits and must never be drawn as one:
//!   · nothing in the pot — no divide at all, because there is nothing to
//!     divide. A 50/50 bar here would invent an even split that doesn't exist.
//!   · money on one side only — ringed, because with nobody opposite the
//!     round voids at lock and everyone is refunded.

import { seam, withStake, type Pot, type Side } from "../pot.js";
import { fmtAmount } from "../format.js";
import css from "./Bar.module.css";

export function Bar({
  pot,
  size = "md",
  ghost,
  legend = true,
}: {
  pot: Pot;
  size?: "sm" | "md" | "lg";
  /** Draw what `add` on `side` would do — striped, and not yet counted. */
  ghost?: { side: Side; add: bigint } | null;
  legend?: boolean;
}) {
  const staking = ghost && ghost.add > 0n ? ghost : null;
  const shown = staking ? withStake(pot, staking.side, staking.add) : pot;
  const share = seam(shown);
  const empty = share === null;
  const lonely = !empty && (shown.up === 0n || shown.down === 0n);

  const upPct = (share ?? 0) * 100;
  const total = shown.up + shown.down;
  const ghostPct = staking && total > 0n ? (Number(staking.add) / Number(total)) * 100 : 0;

  return (
    <div className={`${css.wrap} ${css[size]}`}>
      {empty ? (
        <div className={css.empty} role="img" aria-label="Nothing in the pot on either side" />
      ) : (
        <div className={lonely ? css.lonely : undefined}>
          <div className={css.track} role="img" aria-label={describe(upPct, staking)}>
            {/* UP, then your stake if it's on UP, then DOWN — your money sits
                against the divide so you can see which way it pushes it. */}
            <div className={css.up} style={{ width: `${upPct - (staking?.side === "up" ? ghostPct : 0)}%` }} />
            {staking?.side === "up" && (
              <div className={`${css.ghost} ${css.ghostUp}`} style={{ width: `${ghostPct}%` }} />
            )}
            {staking?.side === "down" && (
              <div className={`${css.ghost} ${css.ghostDown}`} style={{ width: `${ghostPct}%` }} />
            )}
            <div className={css.down} style={{ width: `${100 - upPct - (staking?.side === "down" ? ghostPct : 0)}%` }} />
          </div>
        </div>
      )}

      {legend && (
        <div className={css.legend}>
          <span className={`${css.side} ${css.sideUp}`}>
            ↑ Up <span className={`${css.amount} num`}>{fmtAmount(shown.up)}</span>
          </span>
          <span className={`${css.side} ${css.sideDown}`}>
            <span className={`${css.amount} num`}>{fmtAmount(shown.down)}</span> Down ↓
          </span>
        </div>
      )}
    </div>
  );
}

function describe(upPct: number, staking: { side: Side; add: bigint } | null): string {
  const base = `${Math.round(upPct)} percent of the pot is on up, ${Math.round(100 - upPct)} percent on down`;
  return staking ? `${base}, including the stake you're about to make` : base;
}
