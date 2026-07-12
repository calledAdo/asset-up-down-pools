//! The oracle-integration seam. Oracle wiring is deferred (the user will pick the
//! source later), so the watcher depends only on this interface; v1 ships the
//! `StubOracleSource`. The real implementation will resolve a tick over
//! `ckb-up-down-sdk/oracle` (Lean Oracle) and advance the per-lane oracle cell.

import type { Hex } from "ckb-up-down-sdk";
import type { OracleTick } from "ckb-up-down-sdk/tx";

/**
 * Supplies the authenticated oracle observation a keeper transition needs. The
 * returned tick must carry a live `cellDep` (the oracle cell the contract reads)
 * and a `publishTimeUnix` at or after `minPublishTime`.
 */
export interface OracleSource {
  /**
   * The first available tick for `feedId` whose `publish_time >= minPublishTime`,
   * or `null` when none is available yet (the keeper then skips the transition and
   * retries next tick).
   */
  getTickAtOrAfter(feedId: Hex, minPublishTime: bigint): Promise<OracleTick | null>;
}

/**
 * No-op source: always returns `null`. With it, oracle-free actions (CREATE,
 * CLOSE) still fire, while activate/resolve/finalize are planned but skipped
 * (logged) until a real source is wired.
 */
export class StubOracleSource implements OracleSource {
  async getTickAtOrAfter(_feedId: Hex, _minPublishTime: bigint): Promise<OracleTick | null> {
    return null;
  }
}
