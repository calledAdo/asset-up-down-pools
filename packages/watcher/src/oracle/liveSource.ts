//! `LiveOracleSource` — the real {@link OracleSource}, backed by a Lean Oracle
//! cell (Pyth-via-Wormhole) on CKB. It implements the settler read+advance path:
//! read the feed's live oracle cell; if it isn't yet at/after the requested
//! boundary, **advance** it (fetch the first post-boundary tick from Hermes and
//! pull it on-chain), then read again. Advancement is monotonic-forward only —
//! a late transition whose boundary the cell has already passed simply finds no
//! in-band tick and the round VOIDs (fail-safe), exactly as the contract intends.
//!
//! The class itself is pure orchestration over two injected effects (`readCell`,
//! `advance`) so it unit-tests with no chain or network. {@link createLeanOracleSource}
//! wires those effects to `lean-oracle-sdk`; nothing else in the watcher imports it,
//! keeping the oracle integration behind this one seam.

import type { Hex } from "ckb-up-down-sdk";
import type { OracleTick } from "ckb-up-down-sdk/tx";

import type { OracleSource } from "./source.js";

/** The minimal live-oracle-cell view the source maps into an {@link OracleTick}. */
export interface OracleCellRead {
  outPoint: { txHash: string; index: number | bigint };
  data: { price: bigint; publishTimeUnix: bigint };
}

/** The two side effects {@link LiveOracleSource} orchestrates (injected for testability). */
export interface LiveOracleEffects {
  /**
   * The latest live oracle cell for `feedId` whose `publish_time >= minPublishTime`,
   * or `undefined` when none satisfies the floor (cell missing or still behind).
   */
  readCell(feedId: Hex, minPublishTime: bigint): Promise<OracleCellRead | undefined>;
  /**
   * Advance the feed's oracle cell forward to hold the first tick at/after
   * `minPublishTime` (fetch from Hermes, pull on-chain, await commit). Throws on
   * failure (no funds, Hermes/network error) — the caller treats that as "no tick".
   */
  advance(feedId: Hex, minPublishTime: bigint): Promise<void>;
  log?: (msg: string) => void;
}

export class LiveOracleSource implements OracleSource {
  constructor(private readonly effects: LiveOracleEffects) {}

  async getTickAtOrAfter(feedId: Hex, minPublishTime: bigint): Promise<OracleTick | null> {
    const log = this.effects.log ?? (() => {});
    let cell = await this.effects.readCell(feedId, minPublishTime);
    if (!cell) {
      // Cell missing or behind the boundary — advance it forward and re-read.
      try {
        await this.effects.advance(feedId, minPublishTime);
      } catch (err) {
        log(`oracle advance ${feedId} >= ${minPublishTime} failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
      cell = await this.effects.readCell(feedId, minPublishTime);
    }
    if (!cell) return null;
    return tickFromCell(feedId, cell);
  }
}

/** Map a live oracle-cell read into the {@link OracleTick} a transition builder consumes. */
export function tickFromCell(feedId: Hex, cell: OracleCellRead): OracleTick {
  return {
    feedId,
    price: cell.data.price,
    publishTimeUnix: cell.data.publishTimeUnix,
    cellDep: {
      outPoint: { txHash: cell.outPoint.txHash as Hex, index: Number(cell.outPoint.index) },
      depType: "code",
    },
  };
}

/**
 * Read-only {@link OracleSource} for the **keeper**: read the feed's oracle cell;
 * return the tick if it already satisfies the boundary, else `null` — it never
 * advances the cell. Advancing is the oracle worker's job (sole writer); the keeper
 * is a pure reader, so it just skips + retries until the worker has advanced.
 */
export class ReadOnlyOracleSource implements OracleSource {
  constructor(
    private readonly readCell: (feedId: Hex, minPublishTime: bigint) => Promise<OracleCellRead | undefined>,
    private readonly log?: (msg: string) => void,
  ) {}

  async getTickAtOrAfter(feedId: Hex, minPublishTime: bigint): Promise<OracleTick | null> {
    const cell = await this.readCell(feedId, minPublishTime);
    if (!cell) {
      this.log?.(`oracle cell ${feedId} not yet >= ${minPublishTime} (awaiting oracle worker)`);
      return null;
    }
    return tickFromCell(feedId, cell);
  }
}
