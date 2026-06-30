//! The `OracleTick`: a fully-resolved oracle observation the keeper transition
//! builders (ACTIVATE / CORRECT-START / RESOLVE / CORRECT-SETTLE / FINALIZE)
//! consume. The core SDK is oracle-agnostic — it never discovers or decodes an
//! oracle cell itself. A caller (typically the watcher, via the optional
//! `ckb-up-down-sdk/oracle` adapter) resolves a feed to one of these and hands it
//! in. See the project decoupling rule: the core never imports `lean-oracle-sdk`.

import type { Hex } from "../internal/bytes.js";
import type { CellDepInfo, PoolData } from "../types.js";

/**
 * A resolved oracle observation for one feed at one tick.
 *
 * `cellDep` points at the live oracle cell the transition will attach as a read
 * `CellDep`; the on-chain `pool_type` re-derives the oracle commitment from that
 * cell and requires it to equal the pool's stored `oracle_commit` (see
 * `find_oracle` in `pool_type/src/main.rs`). `price` / `publishTimeUnix` are the
 * fields the contract reads from that cell — the builders use them to compute the
 * next `PoolData` (`start_price` / `settle_price` / `used_pt` / `winner`).
 */
export interface OracleTick {
  /** 32-byte Pyth feed id; must equal the pool's `feedId`. */
  feedId: Hex;
  /** Signed i64 spot price at this tick. */
  price: bigint;
  /** Oracle-authenticated publish time, unix seconds (u64). */
  publishTimeUnix: bigint;
  /** The oracle cell to attach as a read `CellDep` (`depType: "code"`). */
  cellDep: CellDepInfo;
}

/**
 * Guard that a tick belongs to a pool's configured feed. The contract would
 * reject a mismatched oracle cell-dep anyway (its commitment wouldn't match), but
 * failing here gives a clear off-chain error before a transaction is ever built.
 */
export function assertTickForPool(tick: OracleTick, pool: PoolData): void {
  if (tick.feedId.toLowerCase() !== pool.feedId.toLowerCase()) {
    throw new Error(
      `oracle tick feedId ${tick.feedId} does not match pool feedId ${pool.feedId}`,
    );
  }
}
