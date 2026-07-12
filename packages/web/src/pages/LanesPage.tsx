//! Markets overview. Like SportsPredict/Polymarket, the top hero is a PROMOTIONAL
//! banner carousel (new listings, events, how-it-works), not market data — see
//! `PromoSlider`. Below it the real markets:
//!   • asset + cadence filters,
//!   • "Open markets" — actionable cards (UP chance, split bar, Buy UP/Buy DOWN),
//!   • "In play" — locked rounds, frozen split + settle countdown, no deposits.
//! Settled rounds live on History. The % is the pool's implied split, not a forecast.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useLanes, usePools } from "../api/hooks.js";
import type { Lane, Pool } from "../api/types.js";
import { EmptyState, ErrorState, Skeleton } from "../ui/states.js";
import { Countdown } from "../ui/Countdown.js";
import { PromoSlider } from "../ui/PromoSlider.js";
import { fmtCkb, fmtMultiple, fmtPct } from "../format.js";
import { assetKey, buildAssetChips, filterLanes } from "./marketFilters.js";

export function LanesPage() {
  const { data: lanes, isLoading, error } = useLanes();
  const { data: locked } = usePools({ status: "locked" });
  const [asset, setAsset] = useState("all");
  const [dur, setDur] = useState("all");

  const assetChips = useMemo(() => buildAssetChips(lanes ?? []), [lanes]);
  const durChips = useMemo(() => {
    const seen = new Map<string, string>();
    for (const l of lanes ?? []) if (!seen.has(l.durationSecs)) seen.set(l.durationSecs, durLabel(l.durationSecs));
    return [...seen.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
  }, [lanes]);

  const open = useMemo(
    () => filterLanes(lanes ?? [], { asset, durationSecs: dur }).filter((l) => l.currentOpenPool).sort((a, b) => closeOf(a) - closeOf(b)),
    [lanes, asset, dur],
  );
  const liquidity = useMemo(
    () => open.reduce((s, l) => s + BigInt(l.currentOpenPool!.odds.total), 0n).toString(),
    [open],
  );
  const inPlay = useMemo(
    () => (locked ?? [])
      .filter((p) => (asset === "all" || assetKey(p.lane.label) === asset) && (dur === "all" || p.lane.durationSecs === dur))
      .sort((a, b) => Number(a.closeTime) - Number(b.closeTime)),
    [locked, asset, dur],
  );

  if (isLoading) return <Skeleton rows={6} />;
  if (error) return <ErrorState error={error} what="markets" />;
  if (!lanes?.length) return <EmptyState title="No markets yet" hint="No lanes are configured on the backend." />;

  return (
    <>
      <PromoSlider />

      <div className="filter-stack">
        <div className="filter-row" role="tablist" aria-label="Asset">
          <Chip label="All assets" active={asset === "all"} onClick={() => setAsset("all")} />
          {assetChips.map((a) => <Chip key={a} label={a} active={asset === a} onClick={() => setAsset(a)} />)}
        </div>
        <div className="filter-row duration-rail" role="tablist" aria-label="Round length">
          <Chip label="All rounds" active={dur === "all"} onClick={() => setDur("all")} />
          {durChips.map(([secs, label]) => <Chip key={secs} label={label} active={dur === secs} onClick={() => setDur(secs)} />)}
        </div>
      </div>

      <div className="section-head">
        <h2>Open markets</h2>
        <span className="count">{open.length}</span>
        <span className="legend">{fmtCkb(liquidity)} CKB liquidity · % = pool split</span>
      </div>
      {open.length ? (
        <div className="market-grid">
          {open.map((lane) => <MarketCard key={`${lane.feedId}:${lane.durationSecs}`} lane={lane} />)}
        </div>
      ) : (
        <EmptyState title="No open markets" hint="Try another asset or round length." />
      )}

      {inPlay.length > 0 && (
        <>
          <div className="section-head">
            <h2>In play</h2>
            <span className="count">{inPlay.length}</span>
            <span className="legend">locked · settling soon</span>
          </div>
          <div className="market-grid">
            {inPlay.map((p) => <InPlayCard key={p.poolId} pool={p} />)}
          </div>
        </>
      )}
    </>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`chip${active ? " chip-active" : ""}`} onClick={onClick} role="tab" aria-selected={active}>
      {label}
    </button>
  );
}

function MarketCard({ lane }: { lane: Lane }) {
  const pool = lane.currentOpenPool;
  const [asset, round] = splitLabel(lane.label);

  if (!pool) {
    return (
      <div className="market-card is-idle">
        <div className="mc-body">
          <div className="mc-top">
            <span className={`mc-icon ${iconClass(asset)}`}>{icon(asset)}</span>
            <div className="mc-title-wrap"><span className="mc-title">{asset}</span><span className="mc-dur">{round}</span></div>
          </div>
          <p className="mc-idle">No open round right now</p>
        </div>
      </div>
    );
  }

  const { up, down } = pool.odds;
  const upPct = up.impliedProb * 100;
  const to = `/pools/${pool.poolId}`;
  return (
    <div className="market-card">
      <Link className="mc-body" to={to}>
        <div className="mc-top">
          <span className={`mc-icon ${iconClass(asset)}`}>{icon(asset)}</span>
          <div className="mc-title-wrap">
            <span className="mc-title">{asset}</span>
            <span className="mc-dur">{round} round</span>
          </div>
          <span className="mc-cd-chip"><Countdown to={pool.closeTime} /></span>
        </div>

        <div className="mc-chance">
          <span className="mc-chance-num">{fmtPct(up.impliedProb)}</span>
          <span className="mc-chance-label">UP</span>
        </div>

        <div className="mc-bar">
          <div className="tug-track">
            <div className="tug-fill up" style={{ width: `${upPct}%` }} />
            <div className="tug-fill down" style={{ width: `${100 - upPct}%` }} />
            <span className="tug-fulcrum" style={{ left: `${upPct}%` }} />
          </div>
        </div>
      </Link>

      <div className="mc-buys">
        <Link className="buy up" to={`${to}?side=up`}>
          <span className="buy-side">UP</span>
          <span className="buy-mult">{fmtMultiple(up.payoutMultiple)}</span>
        </Link>
        <Link className="buy down" to={`${to}?side=down`}>
          <span className="buy-side">DOWN</span>
          <span className="buy-mult">{fmtMultiple(down.payoutMultiple)}</span>
        </Link>
      </div>

      <div className="mc-foot">
        <span className="num">{fmtCkb(pool.odds.total)} CKB</span>
        <span>{lane.livePoolCount} live</span>
      </div>
    </div>
  );
}

function InPlayCard({ pool }: { pool: Pool }) {
  const [asset, round] = splitLabel(pool.lane.label);
  const upPct = pool.odds.up.impliedProb * 100;
  return (
    <Link className="market-card in-play" to={`/pools/${pool.poolId}`}>
      <div className="mc-body">
        <div className="mc-top">
          <span className={`mc-icon ${iconClass(asset)}`}>{icon(asset)}</span>
          <div className="mc-title-wrap">
            <span className="mc-title">{asset}</span>
            <span className="mc-dur">{round} round</span>
          </div>
          <span className="mc-cd-chip">settles <Countdown to={pool.closeTime} /></span>
        </div>

        <div className="mc-chance">
          <span className="mc-chance-num">{fmtPct(pool.odds.up.impliedProb)}</span>
          <span className="mc-chance-label">UP</span>
        </div>

        <div className="mc-bar">
          <div className="tug-track">
            <div className="tug-fill up" style={{ width: `${upPct}%` }} />
            <div className="tug-fill down" style={{ width: `${100 - upPct}%` }} />
            <span className="tug-fulcrum" style={{ left: `${upPct}%` }} />
          </div>
        </div>
      </div>
      <div className="mc-foot">
        <span className="pill locked">In play</span>
        <span className="num">{fmtCkb(pool.odds.total)} CKB</span>
      </div>
    </Link>
  );
}

// "BTC/USD · 5 min" → ["BTC/USD", "5 min"]
function splitLabel(label: string): [string, string] {
  const [asset, round] = label.split("·").map((s) => s.trim());
  return [asset || label, round || ""];
}
function durLabel(secs: string): string {
  const n = Number(secs);
  if (n < 3600) return `${n / 60}m`;
  if (n < 86400) return `${n / 3600}h`;
  return `${n / 86400}d`;
}
function closeOf(l: Lane): number {
  return l.currentOpenPool ? Number(l.currentOpenPool.closeTime) : Number.MAX_SAFE_INTEGER;
}
function icon(asset: string): string {
  if (asset.startsWith("BTC")) return "₿";
  if (asset.startsWith("ETH")) return "Ξ";
  return "◆";
}
function iconClass(asset: string): string {
  return asset.startsWith("BTC") ? "btc" : asset.startsWith("ETH") ? "eth" : "";
}
