import type { Hex, PoolView } from "ckb-up-down-sdk";

import type { CreateAction } from "./actions.js";
import type { ExecResult } from "./executor.js";
import {
  Cadence,
  decide,
  nextWakeTime,
  type KeeperAction,
  type WakeEntry,
} from "./keeperCore.js";

export interface KeeperTimeline {
  schedulePool(poolId: Hex, dueTime: bigint): void;
  scheduleCreate(cadence: Cadence, dueTime: bigint): void;
  removePool(poolId: Hex): void;
  cancelAll(): void;
}

export interface KeeperChain {
  now(): Promise<bigint>;
  listOwnPools(): Promise<PoolView[]>;
  readPool(poolId: Hex): Promise<PoolView | null>;
}

export interface KeeperOracle {
  readCurrentTick(feedId: Hex): Promise<import("ckb-up-down-sdk/tx").OracleTick | null>;
}

export interface KeeperExecutor {
  executeDecisions(actions: KeeperAction[]): Promise<ExecResult[]>;
  executeCreate(action: CreateAction): Promise<ExecResult>;
}

export interface KeeperDeps {
  cadences: Cadence[];
  timeline: KeeperTimeline;
  chain: KeeperChain;
  oracle: KeeperOracle;
  executor: KeeperExecutor;
  reconcile: () => Promise<void>;
  retryDelaySecs?: bigint;
  /**
   * Wall-clock source (unix seconds), the SAME clock the Timeline fires its timers
   * on — used to place retry slots so the backoff is real wall-clock time, not
   * chain-tip time (the tip lags real time, which would make a `tip + delay` retry
   * fire early). Defaults to `Date.now()`.
   */
  clock?: () => bigint;
  log?: (msg: string) => void;
}

export class Keeper {
  private stopped = true;
  private windingDown = false;
  private readonly retryDelaySecs: bigint;
  private readonly clock: () => bigint;
  // Wakes/sweeps in flight. A timer's handler can be mid-await (RPC, a broadcast)
  // when stop() is called; the `stopped` guard only blocks NEW ones, so stop() must
  // also await the ones already running before the caller tears down the DB/wallet —
  // otherwise a lingering handler hits a closed DB (or leaks a half-sent tx).
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly deps: KeeperDeps) {
    this.retryDelaySecs = deps.retryDelaySecs ?? 5n;
    this.clock = deps.clock ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  }

  /** Register a handler promise so stop() can drain it. Never rejects the tracker. */
  private track<T>(p: Promise<T>): Promise<T> {
    this.inFlight.add(p);
    p.then(() => this.inFlight.delete(p), () => this.inFlight.delete(p));
    return p;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.deps.reconcile();
    const now = await this.deps.chain.now();
    const pools = await this.deps.chain.listOwnPools();
    for (const pool of pools) this.schedulePoolFromState(pool, now);
    if (!this.windingDown) {
      for (const cadence of this.deps.cadences) {
        this.deps.timeline.scheduleCreate(cadence, cadence.boundaryAtOrAfter(now));
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.deps.timeline.cancelAll();
    // Let any handler already running finish (its DB writes + broadcast) before the
    // caller closes the DB. New wakes are blocked by `stopped`, so this drains, not grows.
    await Promise.allSettled([...this.inFlight]);
  }

  setWindingDown(on: boolean): void {
    this.windingDown = on;
  }

  async onWake(dueTime: bigint, entries: WakeEntry[]): Promise<void> {
    if (this.stopped) return;
    await this.track(this.runWake(entries));
  }

  private async runWake(entries: WakeEntry[]): Promise<void> {
    const now = await this.deps.chain.now();
    const poolEntries = entries.filter((e): e is Extract<WakeEntry, { kind: "pool" }> => e.kind === "pool");
    const createEntries = entries.filter((e): e is Extract<WakeEntry, { kind: "create" }> => e.kind === "create");

    await this.handlePoolEntries(poolEntries, now);
    for (const entry of createEntries) await this.handleCreateEntry(entry.cadence, entry.boundary, now);
  }

  /**
   * Low-frequency safety backstop. Edge-triggered scheduling is only as reliable as
   * its timers: a swallowed wake error, a process pause, clock skew, or a pool
   * created out-of-band can leave an entity with no live timer. The sweep re-derives
   * the schedule from chain truth — it lists every own pool and re-arms it (healing a
   * missing or stale timer), and re-seeds each cadence's create wake unless winding
   * down. It never sends a tx itself: `scheduleRetryOrNext` arms an overdue pool at
   * `now + retryDelaySecs`, so the pool's own wake performs the action. Re-arming is
   * idempotent — `poolIndex`/`cadenceIndex` keep one wake per entity — so a sweep that
   * finds everything already scheduled is a no-op beyond re-reading chain state.
   */
  async onSweep(): Promise<void> {
    if (this.stopped) return;
    await this.track(this.runSweep());
  }

  private async runSweep(): Promise<void> {
    const now = await this.deps.chain.now();
    const pools = await this.deps.chain.listOwnPools();
    for (const pool of pools) this.scheduleRetryOrNext(pool, now);
    if (!this.windingDown) {
      for (const cadence of this.deps.cadences) {
        this.deps.timeline.scheduleCreate(cadence, cadence.boundaryAtOrAfter(now));
      }
    }
  }

  private async handlePoolEntries(
    entries: Extract<WakeEntry, { kind: "pool" }>[],
    now: bigint,
  ): Promise<void> {
    const tickCache = new Map<string, Awaited<ReturnType<KeeperOracle["readCurrentTick"]>>>();
    const actions: KeeperAction[] = [];
    const seenPools: Hex[] = [];

    for (const entry of entries) {
      const pool = await this.deps.chain.readPool(entry.poolId);
      if (!pool) {
        this.deps.timeline.removePool(entry.poolId);
        continue;
      }
      seenPools.push(entry.poolId);
      const feed = pool.data.feedId.toLowerCase();
      if (!tickCache.has(feed)) {
        tickCache.set(feed, await this.deps.oracle.readCurrentTick(pool.data.feedId));
      }
      const action = decide(pool, now, tickCache.get(feed) ?? null);
      if (action) actions.push(action);
      // No re-arm here: every seen pool is re-armed below from its POST-execute
      // state via scheduleRetryOrNext, which backs off (now + retryDelaySecs) when
      // the pool is still overdue — e.g. decide returned null because the oracle
      // cell hasn't advanced past the boundary yet, or a transition tx failed.
      // Re-arming from post-state uses the freshest read and, crucially, applies
      // the backoff, so a lagging tick can't spin the pool at ~0ms.
    }

    if (actions.length > 0) await this.deps.executor.executeDecisions(actions);

    for (const poolId of seenPools) {
      const post = await this.deps.chain.readPool(poolId);
      if (!post) this.deps.timeline.removePool(poolId);
      else this.scheduleRetryOrNext(post, now);
    }
  }

  private async handleCreateEntry(cadence: Cadence, boundary: bigint, now: bigint): Promise<void> {
    if (this.windingDown) return;
    const round = cadence.roundForCreateBoundary(boundary);
    let pools = await this.deps.chain.listOwnPools();
    let pool = pools.find((p) => this.poolMatchesCadenceRound(p, cadence, round.startTime));

    if (!pool) {
      await this.deps.executor.executeCreate({
        kind: "create",
        lane: cadence.lane,
        laneKey: cadence.laneKey,
        roundKey: `${cadence.laneKey}@${round.startTime.toString()}`,
        startTime: round.startTime,
        closeTime: round.closeTime,
      });
      pools = await this.deps.chain.listOwnPools();
      pool = pools.find((p) => this.poolMatchesCadenceRound(p, cadence, round.startTime));
    }

    if (pool) this.deps.timeline.schedulePool(pool.poolId, nextWakeTime(pool, now) ?? round.startTime);
    this.deps.timeline.scheduleCreate(cadence, cadence.boundaryAfter(boundary));
  }

  private scheduleRetryOrNext(pool: PoolView, now: bigint): void {
    const next = nextWakeTime(pool, now);
    if (next === null) {
      this.deps.timeline.removePool(pool.poolId);
    } else if (next <= now) {
      // Overdue but not actionable yet (oracle cell behind, or a failed tx). Retry on a
      // SHARED wall-clock grid rather than `now + retryDelaySecs`: every pool waiting on
      // the same lagging feed snaps to the same slot, so they land in one Timeline bucket
      // -> one wake -> one oracle read + a batched tx, instead of a scatter of near-
      // simultaneous single-pool wakes. Wall clock (not chain-tip `now`) because the
      // Timeline fires timers on wall clock; a `tip + delay` slot fires early whenever the
      // tip lags real time, which would spin the retry. Overdue *detection* stays on chain
      // `now` above (it must, to match the contract's header-time semantics).
      this.deps.timeline.schedulePool(pool.poolId, this.nextRetrySlot());
    } else {
      this.deps.timeline.schedulePool(pool.poolId, next);
    }
  }

  /** Next wall-clock grid tick strictly after now, aligned to `retryDelaySecs`. */
  private nextRetrySlot(): bigint {
    const g = this.retryDelaySecs;
    return (this.clock() / g + 1n) * g;
  }

  private schedulePoolFromState(pool: PoolView, now: bigint): void {
    const next = nextWakeTime(pool, now);
    if (next === null) this.deps.timeline.removePool(pool.poolId);
    else this.deps.timeline.schedulePool(pool.poolId, next);
  }

  private poolMatchesCadenceRound(pool: PoolView, cadence: Cadence, startTime: bigint): boolean {
    return (
      pool.data.feedId.toLowerCase() === cadence.feedId.toLowerCase() &&
      pool.data.closeTime - pool.data.startTime === cadence.durationSecs &&
      pool.data.startTime === startTime
    );
  }
}
