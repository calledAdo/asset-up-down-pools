//! ONE ROUND, and the place you actually put money in.
//!
//! Everything that changes what your stake is worth lives on this screen and
//! nowhere else. The board is for choosing a round; this is for choosing an
//! amount, and the difference matters — a warning about a pot that might not
//! pay out is noise on a card you're only scanning, and is the single most
//! important sentence on the page once you're typing a number into it.
//!
//! The hard truth this screen has to tell: in a pool you don't buy at a
//! price, you join a side, and joining it makes it pay LESS. Manifold gave up
//! on dynamic parimutuel because bettors couldn't tell what they'd get. The
//! answer isn't to bury the drift — it's to quote the multiple *after* your
//! own stake, before you sign, with no wallet connected, and say plainly that
//! it keeps moving until the round locks.

import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { usePool } from "../api/hooks.js";
import type { Hex, Pool } from "../api/types.js";
import { assetOf, durLabel, phaseOf, roundId } from "../lanes.js";
import { potOf, quote, stakeQuote, type Side } from "../pot.js";
import { fmtAmount, fmtMultiple, safeShannons } from "../format.js";
import { useWallet } from "../wallet/useWallet.js";
import { deposit } from "../tx/actions.js";
import { Bar } from "../ui/Bar.js";
import { Clock, useSecondsTo } from "../ui/Clock.js";
import { ErrorState, Skeleton } from "../ui/states.js";
import css from "./Round.module.css";

const CHIPS = [500, 2000, 5000, 25000];

export function RoundPage() {
  const { poolId } = useParams<{ poolId: string }>();
  const { data: pool, isLoading, error } = usePool(poolId as Hex | undefined);

  if (isLoading) return <Skeleton rows={2} />;
  if (error) return <ErrorState error={error} what="this round" />;
  if (!pool) return <ErrorState error={new Error("No such round")} what="this round" />;

  return (
    <>
      <Link className={css.back} to="/">
        ← Back to the board
      </Link>

      <div className={css.layout}>
        <section className={`card ${css.panel}`}>
          <Summary pool={pool} />
          <Settles rakeBps={pool.rakeBps} />
        </section>

        <section className={`card ${css.panel}`}>
          <Ticket pool={pool} />
        </section>
      </div>
    </>
  );
}

function Summary({ pool }: { pool: Pool }) {
  const pot = potOf(pool.odds);
  const total = pot.up + pot.down;
  const left = useSecondsTo(pool.startTime);
  const urgent = left > 0 && left < 60;

  return (
    <>
      <div className={css.head}>
        <div>
          <p className={css.lane}>
            {assetOf(pool.lane.label)} · {durLabel(pool.lane.durationSecs).toLowerCase()}
          </p>
          <p className={css.laneSub}>Round {roundId(pool.poolId)}</p>
        </div>
        <span className="pill pill-open">Open</span>
      </div>

      <div className={css.clockRow}>
        <span className={`${css.clock} num${urgent ? ` ${css.clockUrgent}` : ""}`}>
          <Clock to={pool.startTime} done="closing" />
        </span>
        <span className={css.clockLabel}>until it locks</span>
      </div>

      <p className={css.pot}>
        {total === 0n ? (
          "Nobody has staked yet."
        ) : (
          <>
            <strong className="num">{fmtAmount(total)} CKB</strong> in the pot
          </>
        )}
      </p>

      <Bar pot={pot} size="lg" legend={total > 0n} />
    </>
  );
}

/** The resolution rules, on the page rather than behind a docs link. A round
 *  that can void has to say so where the decision is being made. */
function Settles({ rakeBps }: { rakeBps: number }) {
  const rules: [string, string][] = [
    ["When it locks", "Deposits close and the price at that moment becomes the line to beat. It isn't chosen now."],
    ["How it's decided", "A second price when the round closes. Higher than the line and Up takes the pot; anything else and Down takes it."],
    ["When nobody wins", "An exact tie, or one side with no money on it when it locks. Every stake is refunded in full."],
    ["The fee", `${(rakeBps / 100).toFixed(0)}%, taken from the losing side only. Your own stake is never shaved, and the payouts quoted here already include it.`],
  ];
  return (
    <div className={css.rules}>
      <p className={css.ruleTitle}>How this round settles</p>
      {rules.map(([k, v]) => (
        <div key={k} className={css.rule}>
          <p className={css.ruleKey}>{k}</p>
          <p className={css.ruleBody}>{v}</p>
        </div>
      ))}
    </div>
  );
}

function Ticket({ pool }: { pool: Pool }) {
  const [params] = useSearchParams();
  const { signer, lock, open } = useWallet();
  const [side, setSide] = useState<Side>(params.get("side") === "down" ? "down" : "up");
  const [amount, setAmount] = useState("2000");
  const [status, setStatus] = useState<string | null>(null);

  const pot = potOf(pool.odds);
  const add = safeShannons(amount);
  const q = stakeQuote(pot, pool.rakeBps, side, add);
  const locked = phaseOf(pool) !== "open" && phaseOf(pool) !== "locking";

  // Would this round pay out at all, as things stand? Both cases end the same
  // way — refunded in full — but they are different situations and the copy
  // says which one you're in.
  const potEmpty = pot.up === 0n && pot.down === 0n;
  const noTakers = (side === "up" ? pot.down : pot.up) === 0n && !potEmpty;

  const place = async () => {
    if (!signer || !lock) return open();
    setStatus("Waiting for your signature…");
    try {
      const hash = await deposit(
        { signer, lock },
        { poolId: pool.poolId, upAmount: side === "up" ? add : 0n, downAmount: side === "down" ? add : 0n },
      );
      setStatus(`Sent — waiting for a block. ${hash.slice(0, 10)}…`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  if (locked) {
    return (
      <>
        <p className={css.ticketTitle}>This round has locked</p>
        <p className="note">
          Deposits closed when the line was set. Nothing moves now until the closing price lands.
        </p>
      </>
    );
  }

  return (
    <>
      <p className={css.ticketTitle}>Place your bet</p>

      <div className={css.field}>
        <span className={css.fieldLabel}>Which side?</span>
        <div className={css.sides} role="group" aria-label="Pick a side">
          {(["up", "down"] as const).map((s) => {
            const m = quote(pot, pool.rakeBps, s).multiple;
            return (
              <button
                key={s}
                type="button"
                aria-pressed={side === s}
                onClick={() => setSide(s)}
                className={[css.side, side === s ? (s === "up" ? css.sideOnUp : css.sideOnDown) : ""]
                  .filter(Boolean)
                  .join(" ")}
              >
                <span className={css.sideName}>
                  {s === "up" ? "↑ Up" : "↓ Down"}
                </span>
                <span className={css.sideMult}>
                  {m === null ? "nothing to win yet" : `pays ${fmtMultiple(m)}`}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={css.field}>
        <label className={css.fieldLabel} htmlFor="amount">
          How much?
        </label>
        <div className={css.amount}>
          <input
            id="amount"
            className={css.input}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            autoComplete="off"
            aria-describedby="effect"
          />
          <span className={css.unit}>CKB</span>
        </div>
        <div className={css.chips}>
          {CHIPS.map((c) => (
            <button
              key={c}
              type="button"
              className={`${css.chip}${Number(amount) === c ? ` ${css.chipOn}` : ""}`}
              onClick={() => setAmount(String(c))}
            >
              {c >= 1000 ? `${c / 1000}k` : c}
            </button>
          ))}
        </div>
      </div>

      {/* The bar again, with your own money striped into it — so you can see
          which way your stake pushes the division before you commit. */}
      <div className={css.field}>
        <Bar pot={pot} size="md" ghost={add > 0n ? { side, add } : null} />
      </div>

      {!(noTakers || potEmpty) && (
      <div className={css.effect} id="effect" aria-live="polite">
        <p className={add > 0n ? css.dilution : `${css.dilution} ${css.dilutionIdle}`}>
          {add <= 0n ? (
            "Enter an amount and you'll see exactly what it pays — and what it does to the odds."
          ) : q.alone ? (
            <>
              You'd be the only money on <strong>{side === "up" ? "Up" : "Down"}</strong>. If it
              wins, the whole pot is yours at <strong className="num">{fmtMultiple(q.after)}</strong>.
            </>
          ) : (
            <>
              Your <strong className="num">{fmtAmount(add)}</strong> CKB takes{" "}
              <strong>{side === "up" ? "Up" : "Down"}</strong> from{" "}
              <strong className="num">{fmtMultiple(q.before)}</strong> to{" "}
              <strong className="num">{fmtMultiple(q.after)}</strong> — you dilute your own side.
            </>
          )}
        </p>

        {add > 0n && (
          <div className={css.figures}>
            <div className={css.figure}>
              <p className={css.figureLabel}>If {side === "up" ? "Up" : "Down"} wins</p>
              <p className={`${css.figureValue} num`}>{q.payoutCkb.toFixed(0)}</p>
            </div>
            <div className={`${css.figure} ${css.figureRight}`}>
              <p className={css.figureLabel}>Profit</p>
              <p className={`${css.figureValue} num`}>+{q.profitCkb.toFixed(0)}</p>
            </div>
            <div className={`${css.figure} ${css.figureRight}`}>
              <p className={css.figureLabel}>If it loses</p>
              <p className={`${css.figureValue} ${css.figureLoss} num`}>−{fmtAmount(add)}</p>
            </div>
          </div>
        )}
      </div>
      )}

      {/* THE warning, and this is the screen it belongs on. On a card you're
          only scanning it's noise that shoves the layout around; here you are
          about to hand over money, and it's the most important sentence on
          the page. */}
      {(noTakers || potEmpty) && (
        <p className={`note note-void ${css.warn}`}>
          {potEmpty ? (
            <>
              <strong>You'd be first into this pot.</strong> A round needs money on both sides to
              pay anyone — if one side is still empty when it locks, it's cancelled and every
              stake is refunded in full. Nobody loses, but nobody wins either.
            </>
          ) : (
            <>
              <strong>Nobody has taken the other side.</strong> If that's still true when it
              locks, the round is cancelled and everyone gets their stake back — nobody wins.
            </>
          )}
        </p>
      )}

      <button className={`btn btn-primary ${css.go}`} disabled={add <= 0n} onClick={place}>
        {signer && lock
          ? `Place ${fmtAmount(add)} CKB on ${side === "up" ? "Up" : "Down"}`
          : "Connect a wallet to place this bet"}
      </button>

      <p className={css.fine}>
        The odds keep moving until the round locks — more money on your side pays you less, more
        on the other side pays you more. You can take your stake back any time before it locks.
      </p>

      {status && <p className={`note ${css.status}`}>{status}</p>}
    </>
  );
}
