//! Pool detail — a Polymarket-style event view. Left: the candlestick chart with
//! the "price to beat" line, the outcomes split, and the round's rules/details.
//! Right: a sticky trade panel (pick UP/DOWN, stake, see the estimated payout).
//! Deposit while OPEN; redeem once FINALIZED/VOID; burn anytime to reclaim a cell.

import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import { usePool } from "../api/hooks.js";
import type { Hex, Pool } from "../api/types.js";
import { burnShares, deposit, redeem, type TxContext } from "../tx/actions.js";
import { useWallet } from "../wallet/useWallet.js";
import { EmptyState, ErrorState, Skeleton } from "../ui/states.js";
import { TugBar } from "../ui/TugBar.js";
import { PriceChart } from "../ui/PriceChart.js";
import { Countdown } from "../ui/Countdown.js";
import { ckbToShannons, fmtTime, shortId } from "../format.js";

type Side = "up" | "down";
type TxState = { status: "idle" } | { status: "pending" } | { status: "ok"; hash: Hex } | { status: "err"; msg: string };

export function PoolDetailPage() {
  const { poolId } = useParams<{ poolId: Hex }>();
  const [params] = useSearchParams();
  const initialSide: Side = params.get("side") === "down" ? "down" : "up";
  const { data: pool, isLoading, error } = usePool(poolId);

  if (isLoading) return <Skeleton rows={2} />;
  if (error) return <ErrorState error={error} what="this pool" />;
  if (!pool) return <EmptyState title="Pool not found" hint="It may have been closed, or the ID is wrong." action={<Link className="btn" to="/">Back to markets</Link>} />;

  return (
    <div className="detail">
      <Link className="back" to="/">← Markets</Link>
      <header className="detail-head">
        <h2>{pool.lane.label}</h2>
        <span className={`status status-${pool.status}`}>{pool.status}</span>
        {pool.status === "open" && <span className="detail-clock"><Countdown to={pool.closeTime} /></span>}
      </header>

      <div className="event-grid">
        <div className="event-main">
          <div className="market-panel">
            <ChartHead pool={pool} />
            {pool.priceSeries?.length ? (
              <PriceChart candles={pool.priceSeries} priceToBeat={Number(pool.prices.start) || 0} />
            ) : null}
            <ChartNote pool={pool} />
            <TugBar odds={pool.odds} scale="row" />
          </div>
          <RoundDetails pool={pool} />
        </div>

        <TradePanel pool={pool} initialSide={initialSide} />
      </div>
    </div>
  );
}

function ChartHead({ pool }: { pool: Pool }) {
  const ptb = Number(pool.prices.start) || 0;
  const settle = Number(pool.prices.settle) || 0;
  const series = pool.priceSeries ?? [];
  const hasBeat = ptb > 0; // false while OPEN — the beat is captured at lock
  const last = settle || (series.length ? Number(series[series.length - 1].c) : ptb);
  const dir = last >= ptb ? "up" : "down";
  const deltaPct = hasBeat ? ((last - ptb) / ptb) * 100 : 0;
  return (
    <div className="chart-head">
      <div className="ch-last">
        <span className="ch-label">{!hasBeat ? "Spot price" : settle ? "Settle price" : "Last price"}</span>
        <span className="ch-price num">{fmtPrice(last)}</span>
        {hasBeat && <span className={`ch-delta ${dir}`}>{deltaPct >= 0 ? "+" : ""}{deltaPct.toFixed(2)}% vs beat</span>}
      </div>
      {hasBeat ? (
        <div className="ch-ptb">
          <span className="ch-label">Price to beat</span>
          <span className="num">{fmtPrice(ptb)}</span>
        </div>
      ) : (
        <div className="ch-ptb">
          <span className="ch-label">Locks in</span>
          <span className="num"><Countdown to={pool.closeTime} /></span>
        </div>
      )}
    </div>
  );
}

function ChartNote({ pool }: { pool: Pool }) {
  const asset = pool.lane.label.split("·")[0].trim();
  const text =
    pool.status === "open"
      ? `Recent ${asset} price, for context — the price to beat is captured when this round locks.`
      : pool.status === "locked"
        ? "Live since lock. UP wins if the settle price finishes above the price to beat."
        : pool.winner === "void"
          ? "Round voided — no valid settle price; stakes are refundable."
          : `Settled: ${pool.winner.toUpperCase()} won.`;
  return <p className="chart-note">{text}</p>;
}

function RoundDetails({ pool }: { pool: Pool }) {
  const asset = pool.lane.label.split("·")[0].trim();
  return (
    <section className="rules">
      <h3 className="rules-title">Round details</h3>
      <dl className="facts">
        <div><dt>Rake</dt><dd className="num">{(pool.rakeBps / 100).toFixed(2)}%</dd></div>
        <div><dt>Winner</dt><dd>{pool.winner === "undecided" ? "—" : pool.winner.toUpperCase()}</dd></div>
        <div><dt>Start price</dt><dd className="num">{Number(pool.prices.start) ? fmtPrice(Number(pool.prices.start)) : "—"}</dd></div>
        <div><dt>Settle price</dt><dd className="num">{Number(pool.prices.settle) ? fmtPrice(Number(pool.prices.settle)) : "—"}</dd></div>
        <div><dt>Opens</dt><dd className="num">{fmtTime(pool.startTime)}</dd></div>
        <div><dt>Locks</dt><dd className="num">{fmtTime(pool.closeTime)}</dd></div>
        <div><dt>Voids after</dt><dd className="num">{fmtTime(pool.voidTime)}</dd></div>
        <div><dt>Pool ID</dt><dd className="num" title={pool.poolId}>{shortId(pool.poolId)}</dd></div>
      </dl>
      <h3 className="rules-title">How it resolves</h3>
      <p className="rules-text">
        Settled from the <strong>Pyth {asset} price feed</strong>. The start price is the feed value
        when the round locks; the settle price is the value at close. <strong>UP</strong> wins if
        settle &gt; start, <strong>DOWN</strong> if settle &lt; start — winners split the whole pot
        minus the {(pool.rakeBps / 100).toFixed(2)}% rake. Every price is authenticated on-chain by
        the oracle’s <code>publish_time</code>; if no valid update lands in the window the round
        voids and all stakes are refundable.
      </p>
    </section>
  );
}

function TradePanel({ pool, initialSide }: { pool: Pool; initialSide: Side }) {
  const { signer, lock, connected, open } = useWallet();
  const qc = useQueryClient();
  const [tx, setTx] = useState<TxState>({ status: "idle" });
  const [side, setSide] = useState<Side>(initialSide);
  const [amount, setAmount] = useState("");

  const settled = pool.status === "finalized" || pool.status === "void";
  const pending = tx.status === "pending";

  const run = async (fn: () => Promise<Hex>) => {
    setTx({ status: "pending" });
    try {
      const hash = await fn();
      setTx({ status: "ok", hash });
      await qc.invalidateQueries();
    } catch (e) {
      setTx({ status: "err", msg: e instanceof Error ? e.message : String(e) });
    }
  };

  if (!connected || !signer || !lock) {
    return (
      <aside className="trade">
        <h3>Trade</h3>
        <p className="muted small">Connect a wallet to stake, redeem, or reclaim CKB on this round.</p>
        <button className="btn btn-primary" onClick={open}>Connect wallet</button>
      </aside>
    );
  }
  const ctx: TxContext = { signer, lock };
  const amt = Number(amount) || 0;
  const est = estimatePayout(pool, side, amt);

  return (
    <aside className="trade">
      <h3>Trade</h3>

      {pool.status === "open" ? (
        <>
          <div className="side-toggle">
            <button className={`st up${side === "up" ? " active" : ""}`} onClick={() => setSide("up")}>
              <span>UP</span><b className="num">{(pool.odds.up.impliedProb * 100).toFixed(0)}%</b>
            </button>
            <button className={`st down${side === "down" ? " active" : ""}`} onClick={() => setSide("down")}>
              <span>DOWN</span><b className="num">{(pool.odds.down.impliedProb * 100).toFixed(0)}%</b>
            </button>
          </div>

          <label className="amt">Amount (CKB)
            <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" inputMode="decimal" />
          </label>

          <div className="payout">
            <div><span>Payout if {side.toUpperCase()} wins</span><span className="num">{est.multiple.toFixed(2)}×</span></div>
            <div className="win"><span>Est. payout</span><span className="num">{est.payout.toFixed(2)} CKB</span></div>
            <div className="profit"><span>Est. profit</span><span className="num">+{est.profit.toFixed(2)} CKB</span></div>
          </div>

          <button
            className={`btn ${side === "up" ? "btn-up" : "btn-down"}`}
            disabled={pending || amt <= 0}
            onClick={() => run(() => deposit(ctx, {
              poolId: pool.poolId,
              upAmount: side === "up" ? ckbToShannons(amount) : 0n,
              downAmount: side === "down" ? ckbToShannons(amount) : 0n,
            }))}
          >
            {pending ? "Submitting…" : `Buy ${side.toUpperCase()}`}
          </button>
        </>
      ) : settled ? (
        <button className="btn btn-primary" disabled={pending} onClick={() => run(() => redeem(ctx, { poolId: pool.poolId }))}>
          {pool.winner === "void" ? "Claim refund" : "Redeem winnings"}
        </button>
      ) : (
        <p className="muted small">This round is locked — deposits are closed until it settles.</p>
      )}

      <div className="burn">
        <button className="btn small" disabled={pending} onClick={() => run(() => burnShares(ctx, { poolId: pool.poolId }))}>
          Burn shares → reclaim CKB
        </button>
        <p className="muted small">Destroy shares you hold to recover their cell capacity — e.g. a losing position.</p>
      </div>

      {tx.status === "ok" && <p className="tx-note ok">Sent · tx {shortId(tx.hash)}</p>}
      {tx.status === "err" && <p className="tx-note error">{tx.msg}</p>}
    </aside>
  );
}

/** Parimutuel estimate: stake `amt` on `side`; if it wins, you take a pro-rata
 *  share of the (post-stake) pot minus rake. Display-only (uses Number). */
function estimatePayout(pool: Pool, side: Side, amt: number) {
  const up = Number(pool.odds.up.pool) / 1e8;
  const down = Number(pool.odds.down.pool) / 1e8;
  const rake = pool.rakeBps / 10000;
  const sidePool = side === "up" ? up : down;
  const total = up + down + amt;
  const winners = sidePool + amt;
  if (winners <= 0 || amt <= 0) return { payout: 0, profit: 0, multiple: 0 };
  const payout = (amt / winners) * total * (1 - rake);
  return { payout, profit: payout - amt, multiple: payout / amt };
}

function fmtPrice(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
