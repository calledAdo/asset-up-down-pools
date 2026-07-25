import {
  STATUS_CLOSED,
  STATUS_FINALIZED,
  STATUS_LOCKED,
  STATUS_OPEN,
  STATUS_SETTLED,
  STATUS_VOID,
  closeGrace,
  grace,
  type Hex,
  type PoolView,
} from "ckb-up-down-sdk";
import type { OracleTick, TransitionKind } from "ckb-up-down-sdk/tx";

import { laneKey, type LaneConfig } from "./config.js";

export type KeeperTransitionKind = TransitionKind;

export type KeeperAction =
  | {
      kind: KeeperTransitionKind;
      poolId: Hex;
      feedId: Hex;
      oracle: OracleTick;
    }
  | { kind: "close"; poolId: Hex };

export class Cadence {
  readonly label: string;
  readonly feedId: Hex;
  readonly durationSecs: bigint;
  readonly firstCreateAt: bigint;
  readonly createLeadSecs: bigint;
  readonly laneKey: string;
  readonly lane: LaneConfig;

  constructor(lane: LaneConfig) {
    this.lane = lane;
    this.label = lane.label;
    this.feedId = lane.feedId;
    this.durationSecs = lane.durationSecs;
    this.firstCreateAt = lane.firstCreateAt ?? 0n;
    this.createLeadSecs = lane.createLeadSecs;
    this.laneKey = laneKey(lane.feedId, lane.durationSecs);
  }

  boundaryAtOrAfter(t: bigint): bigint {
    if (t <= this.firstCreateAt) return this.firstCreateAt;
    const elapsed = t - this.firstCreateAt;
    const steps = (elapsed + this.durationSecs - 1n) / this.durationSecs;
    return this.firstCreateAt + steps * this.durationSecs;
  }

  boundaryAfter(t: bigint): bigint {
    if (t < this.firstCreateAt) return this.firstCreateAt;
    const steps = (t - this.firstCreateAt) / this.durationSecs + 1n;
    return this.firstCreateAt + steps * this.durationSecs;
  }

  /** Greatest grid boundary `≤ t` (floor). Clamped to the anchor before the grid starts. */
  boundaryAtOrBefore(t: bigint): bigint {
    if (t <= this.firstCreateAt) return this.firstCreateAt;
    const steps = (t - this.firstCreateAt) / this.durationSecs;
    return this.firstCreateAt + steps * this.durationSecs;
  }

  createFireTime(boundary: bigint): bigint {
    return boundary - this.createLeadSecs;
  }

  roundForCreateBoundary(boundary: bigint): { startTime: bigint; closeTime: bigint } {
    const startTime = boundary + this.durationSecs;
    return { startTime, closeTime: startTime + this.durationSecs };
  }
}

export function voidTimeOfPool(pool: Pick<PoolView, "data">): bigint {
  return pool.data.closeTime + grace(pool.data.closeTime - pool.data.startTime);
}

export function closeTimeOfPool(pool: Pick<PoolView, "data">): bigint {
  const duration = pool.data.closeTime - pool.data.startTime;
  return pool.data.closeTime + closeGrace(duration);
}

export function nextWakeTime(pool: PoolView, now: bigint): bigint | null {
  const boundary = nextBoundaryForStatus(pool);
  if (boundary === null) return null;
  return boundary <= now ? now : boundary;
}

function nextBoundaryForStatus(pool: PoolView): bigint | null {
  switch (pool.data.status) {
    case STATUS_OPEN:
      return pool.data.startTime;
    case STATUS_LOCKED:
      return pool.data.closeTime;
    case STATUS_SETTLED:
      return voidTimeOfPool(pool);
    case STATUS_VOID:
    case STATUS_FINALIZED:
      return closeTimeOfPool(pool);
    case STATUS_CLOSED:
      return null;
    default:
      return null;
  }
}

export function decide(pool: PoolView, now: bigint, tick: OracleTick | null): KeeperAction | null {
  if (pool.data.status === STATUS_VOID || pool.data.status === STATUS_FINALIZED) {
    return now > closeTimeOfPool(pool) ? { kind: "close", poolId: pool.poolId } : null;
  }
  if (pool.data.status === STATUS_CLOSED) return null;
  if (!tick) return null;
  if (tick.feedId.toLowerCase() !== pool.data.feedId.toLowerCase()) return null;

  const pt = tick.publishTimeUnix;
  switch (pool.data.status) {
    case STATUS_OPEN: {
      const oneSided = pool.data.upTotal === 0n || pool.data.downTotal === 0n;
      if (!oneSided && pt >= pool.data.startTime && pt < pool.data.closeTime) {
        return transition("activate", pool, tick);
      }
      if ((oneSided && pt >= pool.data.startTime) || pt >= pool.data.closeTime) {
        return transition("activate", pool, tick);
      }
      return null;
    }
    case STATUS_LOCKED: {
      if (now < pool.data.closeTime) {
        if (pt >= pool.data.startTime && pt < pool.data.usedPt) {
          return transition("correct-start", pool, tick);
        }
        return null;
      }
      const voidTime = voidTimeOfPool(pool);
      if (pt >= pool.data.closeTime && pt < voidTime) return transition("resolve", pool, tick);
      if (pt >= voidTime) return transition("resolve", pool, tick);
      return null;
    }
    case STATUS_SETTLED: {
      const voidTime = voidTimeOfPool(pool);
      if (now < voidTime && pt >= pool.data.closeTime && pt < pool.data.usedPt) {
        return transition("correct-settle", pool, tick);
      }
      if (pt >= voidTime) return transition("finalize", pool, tick);
      return null;
    }
    default:
      return null;
  }
}

function transition(kind: KeeperTransitionKind, pool: PoolView, oracle: OracleTick): KeeperAction {
  return { kind, poolId: pool.poolId, feedId: pool.data.feedId, oracle };
}

export type WakeEntry =
  | { kind: "create"; cadence: Cadence; boundary: bigint }
  | { kind: "pool"; poolId: Hex };

export interface TimelineDeps<TimerId = NodeJS.Timeout> {
  now?: () => bigint;
  setTimer?: (ms: number, fn: () => void) => TimerId;
  clearTimer?: (id: TimerId) => void;
  onWake: (dueTime: bigint, entries: WakeEntry[]) => Promise<void> | void;
}

interface Slot<TimerId> {
  timerId: TimerId;
  entries: WakeEntry[];
}

export class Timeline<TimerId = NodeJS.Timeout> {
  private readonly slots = new Map<bigint, Slot<TimerId>>();
  private readonly poolIndex = new Map<Hex, bigint>();
  private readonly cadenceIndex = new Map<string, bigint>();

  constructor(private readonly deps: TimelineDeps<TimerId>) {}

  schedulePool(poolId: Hex, dueTime: bigint): void {
    this.removePool(poolId);
    this.insert(dueTime, { kind: "pool", poolId });
    this.poolIndex.set(poolId, dueTime);
  }

  scheduleCreate(cadence: Cadence, boundary: bigint): void {
    this.removeCreate(cadence.laneKey);
    const fireTime = cadence.createFireTime(boundary);
    this.insert(fireTime, { kind: "create", cadence, boundary });
    this.cadenceIndex.set(cadence.laneKey, fireTime);
  }

  removePool(poolId: Hex): void {
    const dueTime = this.poolIndex.get(poolId);
    if (dueTime === undefined) return;
    this.poolIndex.delete(poolId);
    this.removeEntry(dueTime, (e) => e.kind === "pool" && e.poolId.toLowerCase() === poolId.toLowerCase());
  }

  cancelAll(): void {
    for (const slot of this.slots.values()) this.clear(slot.timerId);
    this.slots.clear();
    this.poolIndex.clear();
    this.cadenceIndex.clear();
  }

  snapshot(): { slots: { dueTime: bigint; timerId: TimerId; entries: WakeEntry[] }[] } {
    const slots = [...this.slots.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([dueTime, slot]) => ({ dueTime, timerId: slot.timerId, entries: [...slot.entries] }));
    return { slots };
  }

  private removeCreate(key: string): void {
    const dueTime = this.cadenceIndex.get(key);
    if (dueTime === undefined) return;
    this.cadenceIndex.delete(key);
    this.removeEntry(dueTime, (e) => e.kind === "create" && e.cadence.laneKey === key);
  }

  private insert(dueTime: bigint, entry: WakeEntry): void {
    const existing = this.slots.get(dueTime);
    if (existing) {
      existing.entries.push(entry);
      return;
    }
    const timerId = this.setTimer(dueTime, () => {
      const slot = this.slots.get(dueTime);
      if (!slot) return;
      this.slots.delete(dueTime);
      for (const e of slot.entries) {
        if (e.kind === "pool") this.poolIndex.delete(e.poolId);
        else this.cadenceIndex.delete(e.cadence.laneKey);
      }
      void this.deps.onWake(dueTime, [...slot.entries]);
    });
    this.slots.set(dueTime, { timerId, entries: [entry] });
  }

  private removeEntry(dueTime: bigint, pred: (entry: WakeEntry) => boolean): void {
    const slot = this.slots.get(dueTime);
    if (!slot) return;
    slot.entries = slot.entries.filter((entry) => !pred(entry));
    if (slot.entries.length === 0) {
      this.clear(slot.timerId);
      this.slots.delete(dueTime);
    }
  }

  private setTimer(dueTime: bigint, fn: () => void): TimerId {
    const delayMs = Math.max(0, Number(dueTime - this.now()) * 1000);
    const set = this.deps.setTimer ?? ((ms, cb) => setTimeout(cb, ms) as TimerId);
    return set(delayMs, fn);
  }

  private clear(timerId: TimerId): void {
    const clear = this.deps.clearTimer ?? ((id) => clearTimeout(id as NodeJS.Timeout));
    clear(timerId);
  }

  private now(): bigint {
    return (this.deps.now ?? (() => BigInt(Math.floor(Date.now() / 1000))))();
  }
}
