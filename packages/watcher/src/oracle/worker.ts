//! `OracleWorker` — the SOLE writer of every feed's oracle cell, decoupled from the
//! keepers (which are pure readers). It advances each feed's cell at exactly the
//! times some lane needs a fresh tick, all derivable from the lane config + the
//! absolute grid (no pool reads, no IPC):
//!
//!   - **grid boundaries** `k·duration` — the first-post-boundary tick that
//!     activate/resolve read (the canonical price);
//!   - **boundaries + grace** `k·duration + grace(duration)` — a tick `≥ void_time`
//!     so finalize/VOID can fire promptly.
//!
//! It self-schedules to the next such moment (across all lanes), waking just after
//! it (so Hermes has published the tick), and advances the feeds due then. Advancing
//! reuses `LiveOracleSource.getTickAtOrAfter(feed, dueTime)`, which pulls the first
//! tick `≥ dueTime` on-chain. All wallet ops go through the shared `lock`.

import { grace, type Hex } from "ckb-up-down-sdk";

import type { LaneConfig } from "../config.js";
import { Cadence } from "../keeperCore.js";
import type { OracleSource } from "./source.js";

export interface OracleWorkerDeps {
  /** An advancing source (a `LiveOracleSource`); `getTickAtOrAfter` pulls on-chain. */
  source: OracleSource;
  /** All lanes whose feeds this worker keeps fresh. */
  lanes: LaneConfig[];
  /** Serializes wallet ops (shared with the keeper in single-process / `all` mode). */
  lock?: { run<T>(fn: () => Promise<T>): Promise<T> };
  /** Unix-seconds clock; defaults to wall time. */
  now?: () => bigint;
  /** Delay after a due time before advancing, so Hermes has the tick ≥ it. Default 2s. */
  postDueDelayMs?: number;
  log?: (msg: string) => void;
}

export class OracleWorker {
  private timer?: NodeJS.Timeout;
  private firing = false;
  private stopped = true;
  // Same anchored grid the keeper's Cadence uses, so the worker's boundaries land
  // exactly where activate/resolve read. Sharing `Cadence` (not re-deriving epoch
  // boundaries here) is what keeps a non-zero `firstCreateAt` coherent across the
  // two processes — otherwise the worker would advance a cell on the epoch grid
  // while the keeper waits on the anchored grid, and ticks would never line up.
  private readonly cadences: Cadence[];

  constructor(private readonly deps: OracleWorkerDeps) {
    this.cadences = deps.lanes.map((l) => new Cadence(l));
  }

  private nowSecs(): bigint {
    return (this.deps.now ?? (() => BigInt(Math.floor(Date.now() / 1000))))();
  }

  /** The next moment some lane needs a tick (min over boundaries ∪ boundaries+grace), and which feeds are due then. */
  nextDue(): { time: bigint; feeds: Hex[] } {
    const now = this.nowSecs();
    const cands: { time: bigint; feedId: Hex }[] = [];
    for (const c of this.cadences) {
      const g = grace(c.durationSecs);
      const nb = c.boundaryAfter(now); // next anchored boundary strictly after now
      const prevB = c.boundaryAtOrBefore(now); // anchored boundary at/just-before now
      const nextGrace = prevB + g > now ? prevB + g : nb + g; // next boundary+grace after now
      cands.push({ time: nb, feedId: c.feedId }, { time: nextGrace, feedId: c.feedId });
    }
    const time = cands.reduce((m, c) => (c.time < m ? c.time : m), cands[0].time);
    const feeds = [
      ...new Map(cands.filter((c) => c.time === time).map((c) => [c.feedId.toLowerCase(), c.feedId])).values(),
    ];
    return { time, feeds };
  }

  /** Latest passed boundary per feed — for warming the cells on start. */
  private warmItems(): { feedId: Hex; time: bigint }[] {
    const now = this.nowSecs();
    const byFeed = new Map<string, { feedId: Hex; time: bigint }>();
    for (const c of this.cadences) {
      const mark = c.boundaryAtOrBefore(now); // floor boundary ≤ now (anchored)
      const k = c.feedId.toLowerCase();
      const cur = byFeed.get(k);
      if (!cur || mark > cur.time) byFeed.set(k, { feedId: c.feedId, time: mark });
    }
    return [...byFeed.values()];
  }

  /** Advance each (feed → minPublishTime), serialized; never overlap a prior run. */
  async advance(items: { feedId: Hex; time: bigint }[]): Promise<void> {
    if (this.firing) return;
    this.firing = true;
    const run = this.deps.lock
      ? this.deps.lock.run.bind(this.deps.lock)
      : <T>(fn: () => Promise<T>): Promise<T> => fn();
    try {
      for (const { feedId, time } of items) {
        try {
          await run(() => this.deps.source.getTickAtOrAfter(feedId, time));
        } catch (err) {
          this.deps.log?.(`oracle worker ${feedId} @ ${time} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.firing = false;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const { time, feeds } = this.nextDue();
    const delayMs = Number(time - this.nowSecs()) * 1000 + (this.deps.postDueDelayMs ?? 2000);
    this.timer = setTimeout(
      () => void this.advance(feeds.map((feedId) => ({ feedId, time }))).finally(() => this.scheduleNext()),
      Math.max(0, delayMs),
    );
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.advance(this.warmItems()).finally(() => this.scheduleNext());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
