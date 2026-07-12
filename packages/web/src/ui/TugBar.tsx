//! The signature element: a parimutuel tug-of-war. UP pulls the fill left, DOWN
//! pulls it right, and the fulcrum sits at the live implied probability — the
//! same ratio that sets the payout multiples. Recurs at three scales (the
//! featured hero, each market row, the pool detail) so the whole app reads as
//! one idea.

import type { PoolOdds } from "../api/types.js";
import { fmtCkb, fmtMultiple, fmtPct } from "../format.js";

type Scale = "row" | "hero" | "detail";

export function TugBar({ odds, scale = "row" }: { odds: PoolOdds; scale?: Scale }) {
  // Parimutuel: implied prob == stake share. With an empty pool both sides read
  // 0 — sit the fulcrum dead centre and mute the bar rather than divide by zero.
  const empty = odds.up.impliedProb + odds.down.impliedProb < 1e-9;
  const upPct = empty ? 50 : odds.up.impliedProb * 100;

  return (
    <div className={`tug tug-${scale}${empty ? " is-empty" : ""}`}>
      <div className="tug-heads">
        <div className="tug-head up">
          <span className="th-side">UP</span>
          <span className="th-prob">{empty ? "—" : fmtPct(odds.up.impliedProb)}</span>
          <span className="th-mult">{fmtMultiple(odds.up.payoutMultiple)} payout</span>
        </div>
        <div className="tug-head down">
          <span className="th-side">DOWN</span>
          <span className="th-prob">{empty ? "—" : fmtPct(odds.down.impliedProb)}</span>
          <span className="th-mult">{fmtMultiple(odds.down.payoutMultiple)} payout</span>
        </div>
      </div>

      <div className="tug-track" role="img" aria-label={`UP ${fmtPct(odds.up.impliedProb)}, DOWN ${fmtPct(odds.down.impliedProb)}`}>
        <div className="tug-fill up" style={{ width: `${upPct}%` }} />
        <div className="tug-fill down" style={{ width: `${100 - upPct}%` }} />
        <span className="tug-fulcrum" style={{ left: `${upPct}%` }} />
      </div>

      <div className="tug-foot">
        <span className="tf-up">{fmtCkb(odds.up.pool)}</span>
        <span className="tf-total">{fmtCkb(odds.total)} CKB pool</span>
        <span className="tf-down">{fmtCkb(odds.down.pool)}</span>
      </div>
    </div>
  );
}
