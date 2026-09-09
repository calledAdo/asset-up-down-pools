//! THE ROUNDS. One question per card, with room around it.
//!
//! Every round here is the same question on a different clock — will this
//! asset be higher when the round closes than when it locked. So the card
//! answers, in order, the three things somebody actually asks: how long have
//! I got, what does each side pay, and where is the money sitting right now.
//! Everything else is a click away.
//!
//! What this screen refuses to do is put sixteen rounds in a table. The
//! comparison a table buys you is worth less than being able to read one
//! round without leaning in.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useLanes } from "../api/hooks.js";
import type { Pool } from "../api/types.js";
import { assetOf, durLabel, noteOf, phaseOf, roundId } from "../lanes.js";
import { potOf, quote } from "../pot.js";
import { fmtAmount, fmtMultiple } from "../format.js";
import { Bar } from "../ui/Bar.js";
import { Clock, useSecondsTo } from "../ui/Clock.js";
import { EmptyState, ErrorState } from "../ui/states.js";
import css from "./Rounds.module.css";

export function RoundsPage() {
  const { data: lanes, isLoading, error } = useLanes();
  const [asset, setAsset] = useState("all");

  const rounds = useMemo(
    () =>
      (lanes ?? [])
        .filter((l) => l.currentOpenPool)
        .map((l) => l.currentOpenPool!)
        .filter((p) => asset === "all" || assetOf(p.lane.label) === asset)
        .sort((a, b) => Number(a.startTime) - Number(b.startTime)),
    [lanes, asset],
  );

  const assets = useMemo(
    () => [...new Set((lanes ?? []).map((l) => assetOf(l.label)))],
    [lanes],
  );

  if (isLoading) {
    return (
      <div className="skeleton-grid">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton skeleton-card" />
        ))}
      </div>
    );
  }
  if (error) return <ErrorState error={error} what="the rounds" />;

  return (
    <>
      <div className={css.head}>
        <div className={css.headText}>
          <h1>Rounds open now</h1>
          <p>
            Pick a side before the clock runs out. Everyone's money goes into one pot, and
            whichever side is right splits it.
          </p>
        </div>

        {assets.length > 1 && (
          <div className={css.filters}>
            <button
              className={`${css.filter}${asset === "all" ? ` ${css.filterOn}` : ""}`}
              onClick={() => setAsset("all")}
            >
              All
            </button>
            {assets.map((a) => (
              <button
                key={a}
                className={`${css.filter}${asset === a ? ` ${css.filterOn}` : ""}`}
                onClick={() => setAsset(a)}
              >
                {a}
              </button>
            ))}
          </div>
        )}
      </div>

      {rounds.length === 0 ? (
        <EmptyState
          title="Nothing open right now"
          hint="Every round has locked. A new one opens on the next boundary — a five-minute round starts every five minutes."
        />
      ) : (
        <div className={css.grid}>
          {rounds.map((pool) => (
            <RoundCard key={pool.poolId} pool={pool} />
          ))}
        </div>
      )}
    </>
  );
}

function RoundCard({ pool }: { pool: Pool }) {
  const pot = potOf(pool.odds);
  const total = pot.up + pot.down;
  const up = quote(pot, pool.rakeBps, "up");
  const down = quote(pot, pool.rakeBps, "down");
  const phase = phaseOf(pool);
  const note = noteOf(pool, phase);
  const left = useSecondsTo(pool.startTime);
  const urgent = left > 0 && left < 60;

  const asset = assetOf(pool.lane.label);
  const empty = total === 0n;

  return (
    <article className={`card ${css.card}`}>
      <div className={css.cardTop}>
        <div>
          <p className={css.lane}>
            {asset} · {durLabel(pool.lane.durationSecs).toLowerCase()}
          </p>
          <p className={css.laneSub}>Round {roundId(pool.poolId)}</p>
        </div>
        <span className="pill pill-open">Open</span>
      </div>

      <div>
        <div className={css.clockRow}>
          <span className={`${css.clock} num${urgent ? ` ${css.clockUrgent}` : ""}`}>
            <Clock to={pool.startTime} size="hero" done="closing" />
          </span>
          <span className={css.clockLabel}>until it locks</span>
        </div>
        <p className={css.pot}>
          {empty ? (
            "Nobody has staked yet — you'd be first in."
          ) : (
            <>
              <strong className="num">{fmtAmount(total)} CKB</strong> in the pot
            </>
          )}
        </p>
      </div>

      <Bar pot={pot} size="md" legend={!empty} />

      <div className={css.pays}>
        <div className={`${css.pay} ${css.payUp}`}>
          <p className={`${css.payLabel} ${css.payLabelUp}`}>↑ Up pays</p>
          <p className={up.multiple === null ? css.payNone : `${css.payValue} num`}>
            {fmtMultiple(up.multiple)}
          </p>
          <p className={css.payNote}>
            {up.multiple === null ? "nothing to win yet" : "on every 1 CKB"}
          </p>
        </div>
        <div className={`${css.pay} ${css.payDown}`}>
          <p className={`${css.payLabel} ${css.payLabelDown}`}>↓ Down pays</p>
          <p className={down.multiple === null ? css.payNone : `${css.payValue} num`}>
            {fmtMultiple(down.multiple)}
          </p>
          <p className={css.payNote}>
            {down.multiple === null ? "nothing to win yet" : "on every 1 CKB"}
          </p>
        </div>
      </div>

      <div className={css.actions}>
        <Link className="btn btn-up" style={{ flex: 1 }} to={`/rounds/${pool.poolId}?side=up`}>
          Back Up
        </Link>
        <Link className="btn btn-down" style={{ flex: 1 }} to={`/rounds/${pool.poolId}?side=down`}>
          Back Down
        </Link>
      </div>

      <Link className={css.more} to={`/rounds/${pool.poolId}`}>
        How this round settles →
      </Link>

      <span className="sr">{note.text}</span>
    </article>
  );
}
