//! Lanes, rounds, and what state a round is actually in.
//!
//! A lane is one asset on one clock — `BTC/USD · 5 min`. The backend gives it
//! to us as a label and a duration, so this module is the one place that
//! label gets taken apart, and the one place a round's phase is decided.
//!
//! THE TIMING, because two fields are easy to read backwards:
//!
//!     startTime  the round LOCKS. Deposits close, the oracle stamps the line.
//!     closeTime  the round SETTLES. A second price decides the side.
//!
//! So an open round counts down to `startTime`, and a locked one counts down
//! to `closeTime`. Getting that pair the wrong way round would put "locks in"
//! on a pot that closed twenty minutes ago.
//!
//! And one state the mockups don't have. On chain a deposit stays valid past
//! `startTime` for as long as the pool is still OPEN — the lock happens when
//! the keeper's ACTIVATE lands, not when the wall clock passes the boundary.
//! So `locking` is a real phase: the lock is due, the pot is still taking
//! money, and anything you sign now is racing a transaction you can't see. We
//! draw it rather than rounding it to either neighbour.

import type { Lane, Pool } from "./api/types.js";

export type Phase = "open" | "locking" | "locked" | "settling" | "settled" | "void";

/** `BTC/USD · 5 min` → `BTC`. The ticker is the asset's whole identity on the
 *  board: no hue, because every hue is already spent on sides, live and void. */
export function assetOf(label: string): string {
  const pair = label.split("·")[0]?.trim() ?? label.trim();
  return pair.split("/")[0]?.trim().toUpperCase() || pair;
}

/** The full quote pair, for a header where there's room to be exact. */
export function pairOf(label: string): string {
  return label.split("·")[0]?.trim() ?? label.trim();
}

/** Seconds → the column head a tote board would letter: `5M`, `1H`, `1D`. */
export function durLabel(secs: string | number): string {
  const n = Number(secs);
  if (!n) return "—";
  if (n < 3600) return `${n / 60}M`;
  if (n < 86400) return `${Math.round(n / 3600)}H`;
  return `${Math.round(n / 86400)}D`;
}

/** How often the lane comes round, in words. A schedule, not a duration. */
export function cadenceOf(secs: string | number): string {
  const n = Number(secs);
  if (n === 60) return "opens every minute";
  if (n < 3600) return `opens every ${n / 60} minutes, on the ${n / 60}`;
  if (n === 3600) return "opens on the hour";
  if (n < 86400) return `opens every ${Math.round(n / 3600)} hours`;
  return "opens 00:00 UTC";
}

/** A stable key for one lane — asset and duration together. */
export function laneKey(label: string, durationSecs: string): string {
  return `${assetOf(label)}-${durationSecs}`;
}

/** A round's short name. Rounds have no human number on chain, so the pool id
 *  stands in — from the TAIL, not the head, because sequential ids share a
 *  long run of leading zeros and every round would be called `#000000`. */
export function roundId(poolId: string): string {
  return `#${poolId.slice(-6)}`;
}

export function phaseOf(pool: Pool, now = Date.now() / 1000): Phase {
  if (pool.status === "void") return "void";
  if (pool.status === "settled" || pool.status === "finalized") return "settled";

  const start = Number(pool.startTime);
  const close = Number(pool.closeTime);

  if (pool.status === "open") return now < start ? "open" : "locking";
  // locked / closed: the line is stamped, so the only question left is the
  // closing price.
  return now < close ? "locked" : "settling";
}

/** Can this round still take money? The chain's answer, not the clock's. */
export function acceptsDeposits(phase: Phase): boolean {
  return phase === "open" || phase === "locking";
}

/** The moment this round's clock is counting toward, and what to call it. */
export function clockOf(pool: Pool, phase: Phase): { to: string; note: string; quiet: boolean } {
  switch (phase) {
    case "open":
      return { to: pool.startTime, note: "to lock", quiet: false };
    case "locking":
      return { to: pool.startTime, note: "lock due", quiet: false };
    case "locked":
      return { to: pool.closeTime, note: "to settle", quiet: true };
    default:
      return { to: "0", note: phase === "settling" ? "oracle pending" : "closed", quiet: true };
  }
}

export const PHASE_BADGE: Record<Phase, string> = {
  open: "OPEN",
  locking: "LOCKING",
  locked: "LOCKED",
  settling: "SETTLING",
  settled: "SETTLED",
  void: "VOID",
};

/** The one-line state of a round, in the plain voice.
 *
 *  Terminal states are answered first: a round that has already resolved must
 *  never wear a pending warning, however one-sided its pot happens to look. */
export function noteOf(pool: Pool, phase: Phase): { text: string; tone: "quiet" | "void" | "live" | "up" | "down" } {
  const up = BigInt(pool.odds.up.pool);
  const down = BigInt(pool.odds.down.pool);
  const total = up + down;
  const oneSided = total > 0n && (up === 0n || down === 0n);

  if (phase === "void") return { text: "voided · every stake refunded", tone: "void" };
  if (phase === "settled") {
    if (pool.winner === "void") return { text: "voided · every stake refunded", tone: "void" };
    return { text: `${pool.winner.toUpperCase()} took the pot`, tone: pool.winner === "up" ? "up" : "down" };
  }
  if (phase === "settling") return { text: "awaiting the close price", tone: "live" };
  if (phase === "locking") return { text: "lock is due · activation pending", tone: "live" };
  if (total === 0n) {
    return phase === "locked"
      ? { text: "locked empty · voids", tone: "void" }
      : { text: "empty · be first in", tone: "quiet" };
  }
  if (oneSided) {
    return phase === "locked"
      ? { text: "one side empty at lock · voids", tone: "void" }
      : { text: "voids as it stands", tone: "void" };
  }
  if (phase === "locked") return { text: "deposits closed · payout fixed", tone: "quiet" };
  const lean = Number(up > down ? up : down) / Number(total);
  if (lean > 0.8) return { text: "heavily one way", tone: "quiet" };
  return { text: "open · take either side", tone: "quiet" };
}

/* ── the matrix ─────────────────────────────────────────────────────────────
   Assets down, clocks across, and every cell is that lane's next round.
   Reading down a column answers "every 5-minute round right now"; reading
   across a row answers "every clock on ETH". The margins carry totals,
   because that is what a tote board does.

   A pair that isn't configured is NOT a zero. It is a lane that does not
   exist, and the cell says so — better one lane with a real pot than four
   that void.
   ───────────────────────────────────────────────────────────────────────── */

export interface GridCell {
  key: string;
  lane: Lane | null;
  pool: Pool | null;
}

export interface GridRow {
  asset: string;
  pair: string;
  cells: GridCell[];
  /** Money in play across this asset's open rounds. */
  total: bigint;
  live: number;
}

export interface Grid {
  durations: { secs: string; label: string; total: bigint; lanes: number }[];
  rows: GridRow[];
  liveLanes: number;
}

export function buildGrid(lanes: Lane[]): Grid {
  const durSecs = [...new Set(lanes.map((l) => l.durationSecs))].sort((a, b) => Number(a) - Number(b));
  const assets: string[] = [];
  const pairs = new Map<string, string>();
  for (const l of lanes) {
    const a = assetOf(l.label);
    if (!pairs.has(a)) {
      pairs.set(a, pairOf(l.label));
      assets.push(a);
    }
  }

  const byKey = new Map(lanes.map((l) => [laneKey(l.label, l.durationSecs), l]));
  const colTotal = new Map(durSecs.map((d) => [d, 0n]));
  const colLanes = new Map(durSecs.map((d) => [d, 0]));

  const rows: GridRow[] = assets.map((asset) => {
    let rowTotal = 0n;
    let live = 0;
    const cells = durSecs.map((secs) => {
      const lane = byKey.get(`${asset}-${secs}`) ?? null;
      const pool = lane?.currentOpenPool ?? null;
      if (lane) {
        const t = BigInt(pool?.odds.total ?? "0");
        rowTotal += t;
        live += 1;
        colTotal.set(secs, (colTotal.get(secs) ?? 0n) + t);
        colLanes.set(secs, (colLanes.get(secs) ?? 0) + 1);
      }
      return { key: `${asset}-${secs}`, lane, pool };
    });
    return { asset, pair: pairs.get(asset) ?? asset, cells, total: rowTotal, live };
  });

  return {
    durations: durSecs.map((secs) => ({
      secs,
      label: durLabel(secs),
      total: colTotal.get(secs) ?? 0n,
      lanes: colLanes.get(secs) ?? 0,
    })),
    rows,
    liveLanes: lanes.length,
  };
}
