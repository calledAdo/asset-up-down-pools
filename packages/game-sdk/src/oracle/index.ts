//! Optional oracle adapter (`ckb-up-down-sdk/oracle`). Turns a feed id into a
//! resolved {@link OracleTick} by reading the latest live oracle cell — the input
//! the keeper transitions (ACTIVATE / CORRECT-START / RESOLVE / CORRECT-SETTLE /
//! FINALIZE) consume.
//!
//! This is the SDK's single oracle-integration point, and it is defined
//! **structurally**: `OracleStateReader` is the minimal shape the adapter needs,
//! which `lean-oracle-sdk`'s `LeanOracleClient.getOracleCellState` satisfies as-is.
//! So there is no hard dependency on `lean-oracle-sdk` — pass any reader of this
//! shape (a `LeanOracleClient`, a wrapper, or a test fake). The SDK core stays
//! oracle-agnostic; nothing outside this module knows how an oracle is read.

import type { Hex } from "../internal/bytes.js";
import type { OracleTick } from "../tx/oracleTick.js";

/**
 * The minimal oracle reader the adapter needs. `lean-oracle-sdk`'s
 * `LeanOracleClient` satisfies this structurally:
 * `getOracleCellState({ feedId })` → `{ outPoint, data: { price, publishTimeUnix } }`.
 *
 * @public
 */
export interface OracleStateReader {
  getOracleCellState(params: {
    feedId: Hex;
    minPublishTimeUnix?: bigint;
  }): Promise<
    | {
        outPoint: { txHash: string; index: bigint | number };
        data: { price: bigint; publishTimeUnix: bigint };
      }
    | undefined
  >;
}

/** @public */
export interface ResolveOracleTickOptions {
  /** Reject ticks older than this publish_time (forwarded to the reader). */
  minPublishTimeUnix?: bigint;
}

/**
 * Resolve a feed id to an {@link OracleTick} from the latest live oracle cell.
 * Throws if no matching cell exists (or none satisfies `minPublishTimeUnix`). The
 * tick's `cellDep` references that oracle cell as a read dep (`depType: "code"`),
 * which `pool_type`'s `find_oracle` matches by feed and commitment.
 */
export async function resolveOracleTick(
  reader: OracleStateReader,
  feedId: Hex,
  options?: ResolveOracleTickOptions,
): Promise<OracleTick> {
  const state = await reader.getOracleCellState({
    feedId,
    minPublishTimeUnix: options?.minPublishTimeUnix,
  });
  if (!state) {
    throw new Error(`no live oracle cell found for feed ${feedId}`);
  }
  return {
    feedId,
    price: state.data.price,
    publishTimeUnix: state.data.publishTimeUnix,
    cellDep: {
      outPoint: { txHash: state.outPoint.txHash as Hex, index: Number(state.outPoint.index) },
      depType: "code",
    },
  };
}
