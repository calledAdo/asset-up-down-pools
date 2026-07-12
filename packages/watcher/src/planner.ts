//! The planner — the pure heart of the watcher. Given the current time, the live
//! pools, and the configured lanes, it decides what should happen next. No chain
//! access, no I/O: `(now, pools, lanes) -> Action[]`, so it is fully
//! unit-testable over the lifecycle×timing matrix.
//!
//! Lifecycle (from docs/timing-spec.md), all boundaries on the oracle clock:
//!   OPEN --activate(now>=start)--> LOCKED | VOID(one-sided/past-close)
//!   LOCKED --resolve(now>=close)--> SETTLED | VOID(past void_time)
//!   SETTLED --finalize(now>=void)--> FINALIZED
//!   FINALIZED|VOID --close(now>close+closeGrace(duration))--> gone
//! The contract picks LOCKED-vs-VOID and SETTLED-vs-VOID itself; the watcher just
//! fires the one transition for the phase. CLOSE fires at the (duration-
//! proportional) teardown grace — a use-it-or-lose-it window; winners who haven't
//! redeemed by then forfeit, recovering the creator's seed capital + rake.

import {
  STATUS_FINALIZED,
  STATUS_LOCKED,
  STATUS_OPEN,
  STATUS_SETTLED,
  STATUS_VOID,
  closeGrace,
  grace,
  type PoolView,
} from "ckb-up-down-sdk";

import type { Action } from "./actions.js";
import { laneKey, laneKeyOf, voidTimeOf, type LaneConfig } from "./config.js";

export interface PlanInput {
  /** Chain-tip time in seconds. */
  now: bigint;
  /** Live pools, already filtered to the configured lanes. */
  pools: PoolView[];
  /** The cadences to run. */
  lanes: LaneConfig[];
}

/** Decide the next set of actions. Order: transitions, then closes, then creates. */
export function plan(input: PlanInput): Action[] {
  const { now, pools, lanes } = input;
  const transitions: Action[] = [];
  const closes: Action[] = [];

  for (const pool of pools) {
    const a = transitionFor(now, pool);
    if (a) transitions.push(a);
    else if (closeable(now, pool)) {
      closes.push({ kind: "close", poolId: pool.poolId });
    }
  }

  const creates = planCreates(now, pools, lanes);
  return [...transitions, ...closes, ...creates];
}

/** The single due transition for a pool, if any (its phase is past its boundary). */
function transitionFor(now: bigint, pool: PoolView): Action | null {
  const { status, feedId, startTime, closeTime } = pool.data;
  if (status === STATUS_OPEN && now >= startTime) {
    return { kind: "activate", poolId: pool.poolId, feedId, minPublishTime: startTime };
  }
  if (status === STATUS_LOCKED && now >= closeTime) {
    // Past close → resolve (contract yields SETTLED, or VOID if past void_time).
    return { kind: "resolve", poolId: pool.poolId, feedId, minPublishTime: closeTime };
  }
  if (status === STATUS_SETTLED && now >= voidTimeOf(pool)) {
    return { kind: "finalize", poolId: pool.poolId, feedId, minPublishTime: voidTimeOf(pool) };
  }
  return null;
}

/** A terminal pool past its (duration-proportional) teardown grace. */
function closeable(now: bigint, pool: PoolView): boolean {
  const terminal = pool.data.status === STATUS_FINALIZED || pool.data.status === STATUS_VOID;
  if (!terminal) return false;
  const duration = pool.data.closeTime - pool.data.startTime;
  return now > pool.data.closeTime + closeGrace(duration);
}

/**
 * Continuous rolling on an absolute time grid: rounds tile time at multiples of a
 * lane's `duration` (a 5m lane runs at :00, :05, :10 …). At any moment the round
 * whose price window is the *current* grid interval is LOCKED, and the *next*
 * interval's round is OPEN for deposits — its deposit window is the current price
 * window. So a new pool is minted every `duration`, at each grid boundary, exactly
 * as the running round activates.
 *
 * The target round's `startTime = ((now + lead) / duration + 1) * duration` is a
 * pure function of `now`, so its `roundKey` is stable across ticks and the commit
 * gap — minting is idempotent by construction (we mint only if no pool already
 * carries that start). `createLeadSecs` pre-stages the next round slightly before
 * the boundary so the OPEN pool is ready with no gap.
 */
function planCreates(now: bigint, pools: PoolView[], lanes: LaneConfig[]): Action[] {
  const out: Action[] = [];
  for (const lane of lanes) {
    const d = lane.durationSecs;
    const key = laneKey(lane.feedId, d);
    // The round that must be OPEN now (next boundary after `now`) plus the
    // pre-staged one (next boundary after `now + lead`). Usually identical; near a
    // boundary they differ by one, so we mint both and never leave a gap.
    const targets = new Set<bigint>([nextBoundary(now, d), nextBoundary(now + lane.createLeadSecs, d)]);
    for (const targetStart of targets) {
      const exists = pools.some((p) => laneKeyOf(p) === key && p.data.startTime === targetStart);
      if (exists) continue;
      out.push({
        kind: "create",
        lane,
        laneKey: key,
        roundKey: `${key}@${targetStart.toString()}`,
        startTime: targetStart,
        closeTime: targetStart + d,
      });
    }
  }
  return out;
}

/** The first grid boundary strictly after `t` (rounds tile time at multiples of `d`). */
function nextBoundary(t: bigint, d: bigint): bigint {
  return (t / d + 1n) * d;
}

/**
 * The soonest future moment the keeper has **real** work — so it sleeps until then
 * rather than polling. Derived from each pool's ACTUAL state (not the grid), so every
 * wake lands on a due event; there are no "empty" finalize/resolve wakes for events
 * that no pool is actually waiting on. Per pool we take the next boundary `> now` it
 * will cross — `start` (activate), `close` (resolve), `close+grace` (finalize),
 * `close+closeGrace` (close/teardown) — projected past whatever this tick is firing
 * (the pool snapshot is pre-transition, so e.g. a LOCKED pool past `close` yields its
 * `close+grace` finalize, not the resolve we just sent). The one schedule not tied to
 * an existing pool is each lane's next-round CREATE (`boundary − createLeadSecs`).
 *
 * Returns the minimum `> now`, or `null` only with no lanes and no pools. This is
 * *when to look*; `plan()` decides *what to do* against fresh chain state at the wake.
 * The caller applies a long safety cap as a backstop, and a short retry when a tx this
 * tick skipped (oracle cell not advanced yet) or failed (e.g. a batch fell back).
 */
export function nextKeeperWake(now: bigint, pools: PoolView[], lanes: LaneConfig[]): bigint | null {
  let best: bigint | null = null;
  const consider = (t: bigint) => {
    if (t > now && (best === null || t < best)) best = t;
  };
  for (const pool of pools) {
    const { status, startTime, closeTime } = pool.data;
    const d = closeTime - startTime;
    if (status !== STATUS_FINALIZED && status !== STATUS_VOID) {
      consider(startTime); // activate
      consider(closeTime); // resolve
      consider(closeTime + grace(d)); // finalize
    }
    consider(closeTime + closeGrace(d)); // close / teardown (every pool's end of life)
  }
  for (const lane of lanes) {
    consider(nextBoundary(now, lane.durationSecs) - lane.createLeadSecs); // mint next round
  }
  return best;
}
