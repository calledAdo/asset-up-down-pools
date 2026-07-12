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
  log?: (msg: string) => void;
}

export class Keeper {
  private stopped = true;
  private windingDown = false;
  private readonly retryDelaySecs: bigint;

  constructor(private readonly deps: KeeperDeps) {
    this.retryDelaySecs = deps.retryDelaySecs ?? 5n;
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
  }

  setWindingDown(on: boolean): void {
    this.windingDown = on;
  }

  async onWake(dueTime: bigint, entries: WakeEntry[]): Promise<void> {
    if (this.stopped) return;
    const now = await this.deps.chain.now();
    const poolEntries = entries.filter((e): e is Extract<WakeEntry, { kind: "pool" }> => e.kind === "pool");
    const createEntries = entries.filter((e): e is Extract<WakeEntry, { kind: "create" }> => e.kind === "create");

    await this.handlePoolEntries(poolEntries, now);
    for (const entry of createEntries) await this.handleCreateEntry(entry.cadence, dueTime, now);
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
      else this.scheduleRetryOrNext(pool, now);
    }

    if (actions.length > 0) await this.deps.executor.executeDecisions(actions);

    for (const poolId of seenPools) {
      const post = await this.deps.chain.readPool(poolId);
      if (!post) this.deps.timeline.removePool(poolId);
      else this.schedulePoolFromState(post, now);
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
      this.deps.timeline.schedulePool(pool.poolId, now + this.retryDelaySecs);
    } else {
      this.deps.timeline.schedulePool(pool.poolId, next);
    }
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
