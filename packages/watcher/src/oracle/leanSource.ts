//! Wires {@link LiveOracleSource}'s two effects to `lean-oracle-sdk`. This is the
//! only watcher module that imports the Lean Oracle SDK — the rest of the watcher
//! depends solely on the {@link OracleSource} interface, so the oracle backend is
//! swappable behind this seam.
//!
//! `readCell` discovers the feed's latest live oracle cell (≥ the boundary floor);
//! `advance` runs the on-chain settler step — fetch the first post-boundary tick
//! from Hermes, draft the pull-update tx, fund it (`rebalanceFuel`), sign, and await
//! commit. On devnet, `feeRateOverride` is required because offckb's
//! `get_fee_rate_statistics` returns null and CCC's `getFeeRate` then throws.

import { LeanOracleClient, type LeanOracleNetworkConfig } from "lean-oracle-sdk";
import { fetchHermesPriceUpdatesAtPublishTime } from "lean-oracle-sdk/hermes";
import { rebalanceFuel } from "lean-oracle-sdk/fuel";

import type { Hex } from "ckb-up-down-sdk";

import { LiveOracleSource, ReadOnlyOracleSource, type OracleCellRead } from "./liveSource.js";

// The watcher and lean-oracle-sdk resolve separate (but runtime-compatible) copies
// of @ckb-ccc/core, so the SDK's CCC types are nominally distinct from the watcher's.
// We pin to the SDK's own types (derived from the functions we call) and let the
// entrypoint cast its runtime-identical client/lock across the boundary.
/** @public */ export type LeanCccClient = Parameters<typeof rebalanceFuel>[1]["cccClient"];
/** @public */ export type LeanScriptLike = NonNullable<
  Parameters<LeanOracleClient["getOracleCellState"]>[0]["oracleLockScript"]
>;
type LeanTx = Awaited<ReturnType<LeanOracleClient["draftOracleUpdateTx"]>>;

export interface LeanOracleSourceConfig {
  /** Lean Oracle client (built with the devnet network config). */
  client: LeanOracleClient;
  /** Same network config the client uses — needed for the Hermes fetch. */
  network: LeanOracleNetworkConfig;
  /** CCC client (fuel collection, fee, commit wait). */
  cccClient: LeanCccClient;
  /** Signer that funds + signs oracle-update txs (the keeper wallet); structural to span CCC copies. */
  signer: { sendTransaction(tx: LeanTx): Promise<string> };
  /** Lock whose cells fund the update + receive change (the signer's own lock). */
  fuelLock: LeanScriptLike;
  /** Lock under which our oracle cell is held (discovery + update); omit for the network default. */
  oracleLock?: LeanScriptLike;
  /** Explicit fee rate (shannons/KB) — set on devnet where fee-rate stats are null. */
  feeRateShannonsPerKbOverride?: bigint;
  /** Max fuel cells to gather per update tx. */
  fuelLimit?: number;
  log?: (msg: string) => void;
}

/** The read effect both sources share: the feed's live oracle cell ≥ the floor, or undefined. */
function leanReadCell(client: LeanOracleClient, oracleLock?: LeanScriptLike) {
  return async (feedId: Hex, minPublishTime: bigint): Promise<OracleCellRead | undefined> => {
    const state = await client.getOracleCellState({
      feedId,
      oracleLockScript: oracleLock,
      minPublishTimeUnix: minPublishTime,
    });
    if (!state) return undefined;
    return {
      outPoint: state.outPoint,
      data: { price: state.data.price, publishTimeUnix: state.data.publishTimeUnix },
    };
  };
}

/**
 * Read-only source for the **keeper** — reads the feed's cell, never advances. Needs
 * only a client (+ optional oracle lock); no wallet. Pairs with an oracle worker that
 * does the advancing.
 */
export function createLeanReadOnlySource(cfg: {
  client: LeanOracleClient;
  oracleLock?: LeanScriptLike;
  log?: (msg: string) => void;
}): ReadOnlyOracleSource {
  return new ReadOnlyOracleSource(leanReadCell(cfg.client, cfg.oracleLock), cfg.log);
}

/**
 * Build a {@link LiveOracleSource} (read + advance) backed by a Lean Oracle cell.
 * Used by the **oracle worker** (the sole writer) — its scheduler calls
 * `getTickAtOrAfter(feed, dueTime)` to advance each cell to the times lanes need.
 */
export function createLeanOracleSource(cfg: LeanOracleSourceConfig): LiveOracleSource {
  const { client, network, cccClient, signer, fuelLock, oracleLock, feeRateShannonsPerKbOverride, fuelLimit, log } = cfg;
  return new LiveOracleSource({
    log,
    readCell: leanReadCell(client, oracleLock),
    async advance(feedId: Hex, minPublishTime: bigint) {
      // First Hermes update at/after the boundary — the earliest in-band tick.
      const hermesEnvelope = await fetchHermesPriceUpdatesAtPublishTime(network, [feedId], minPublishTime);
      const tx = await client.draftOracleUpdateTx({ feedId, oracleLockScript: oracleLock, hermesEnvelope });
      const rebalanced = await rebalanceFuel(tx, {
        cccClient,
        lockScript: fuelLock,
        fuelLimit,
        feeRateShannonsPerKbOverride,
      });
      if (rebalanced.status !== "ok") {
        throw new Error(`insufficient fuel for oracle update (need ${rebalanced.extraCapacityNeededShannons} shannons)`);
      }
      const txHash = await signer.sendTransaction(rebalanced.mutated);
      log?.(`oracle advance ${feedId} -> ${txHash}`);
      await cccClient.waitTransaction(txHash);
    },
  });
}
