//! The indexer: project live on-chain pools into SQLite so the API serves fast
//! reads. The chain stays the source of truth; this is a refreshable projection.
//! `poolToRow` is pure and unit-tested; `indexOnce` is the I/O shell. Positions are
//! NOT indexed — a holder's shares are read on-demand from chain (see `db/schema.ts`).

import {
  listPools,
  type Hex,
  type PoolDeployment,
  type PoolView,
} from "ckb-up-down-sdk";

import { laneKey, voidTimeOf, type LaneConfig } from "./config.js";
import type { PoolRow, WatcherDb } from "./db/db.js";

/** Pure: decode a live pool into a DB row (label resolved from the lanes). */
export function poolToRow(pool: PoolView, lanes: LaneConfig[]): Omit<PoolRow, "createdAt" | "indexedAt"> {
  const durationSecs = pool.data.closeTime - pool.data.startTime;
  const key = laneKey(pool.data.feedId, durationSecs);
  const lane = lanes.find((l) => laneKey(l.feedId, l.durationSecs) === key);
  return {
    poolId: pool.poolId,
    feedId: pool.data.feedId,
    durationSecs,
    laneLabel: lane?.label ?? null,
    status: pool.data.status,
    winner: pool.data.winner,
    variant: pool.data.variant,
    startTime: pool.data.startTime,
    closeTime: pool.data.closeTime,
    voidTime: voidTimeOf(pool),
    upTotal: pool.data.upTotal,
    downTotal: pool.data.downTotal,
    startPrice: pool.data.startPrice,
    settlePrice: pool.data.settlePrice,
    usedPt: pool.data.usedPt,
    rakeBps: pool.data.rakeBps,
    oracleCommit: pool.data.oracleCommit,
    capacity: pool.capacity,
    txHash: pool.outPoint.txHash,
    outIndex: pool.outPoint.index,
  };
}

export interface IndexContext {
  client: import("@ckb-ccc/core").ccc.Client;
  deploy: PoolDeployment;
  /**
   * Creator lock hashes whose pools to index (lock-scoped searches). One per keeper
   * wallet — with per-feed/cadence keepers the single indexer aggregates them all.
   */
  creatorLockHashes: Hex[];
  lanes: LaneConfig[];
  db: WatcherDb;
}

/**
 * One indexing pass: refresh the pools WE operate — a lock-scoped search per creator
 * lock (union, de-duped by poolId), narrowed to the configured lane feeds. Idempotent.
 * Pools created by others on the same contracts are never indexed (we can't manage
 * them or earn their rake). Positions are not indexed — read on-demand from chain.
 */
export async function indexOnce(ctx: IndexContext): Promise<{ pools: number }> {
  const feeds = new Set(ctx.lanes.map((l) => l.feedId.toLowerCase()));
  const now = Date.now();
  const seen = new Set<string>();
  let poolCount = 0;

  for (const creator of ctx.creatorLockHashes) {
    const pools = await listPools(ctx.client, ctx.deploy, { creator });
    for (const pool of pools) {
      if (!feeds.has(pool.data.feedId.toLowerCase())) continue;
      if (seen.has(pool.poolId)) continue; // de-dup across creator locks
      seen.add(pool.poolId);
      ctx.db.upsertPool(poolToRow(pool, ctx.lanes), now);
      poolCount++;
    }
  }

  ctx.db.setMeta("lastIndexedAt", String(now));
  return { pools: poolCount };
}
