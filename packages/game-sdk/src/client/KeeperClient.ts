//! Keeper-facing client: pool creation, the oracle-driven state transitions, and
//! terminal teardown — plus the inherited reads. The keeper owns its signer and
//! fee policy, so each draft returns a fee-less transaction.
//!
//! The oracle-driven drafts take a resolved `OracleTick`. The SDK core never
//! discovers oracle cells; resolve a tick with `ckb-up-down-sdk/oracle` (or build
//! one yourself) and pass it in.

import { ccc } from "@ckb-ccc/core";

import type { FirstInputLike } from "../ckb/typeId.js";
import type { Hex } from "../internal/bytes.js";
import { buildCreatePoolTx } from "../tx/create.js";
import { resolveCreateAsset, type PoolAsset } from "../tx/asset.js";
import {
  initiateActivate,
  initiateClose,
  initiateCorrectSettle,
  initiateCorrectStart,
  initiateFinalize,
  initiateResolve,
  initiateTransitionBatch,
  type InitiateCloseParams,
  type InitiateKeeperTransitionParams,
  type InitiateTransitionBatchItem,
} from "../tx/workflows.js";
import type { Script } from "../types.js";
import { PoolReaderClient } from "./PoolReaderClient.js";

type DraftArgs<T> = Omit<T, "client" | "deployment">;
type KeeperTxArgs = DraftArgs<InitiateKeeperTransitionParams>;

/** @public */
export interface DraftCreateParams {
  /** Cell consumed to seed the typeID; becomes `input[0]`. The pool's id is `computeTypeId(seedInput, 0)`. */
  seedInput: FirstInputLike;
  /** Lock that will own the PoolCell — the creator (sole CLOSE authority). Any CCC `ScriptLike`. */
  creatorLock: ccc.ScriptLike;
  /** What the pool stakes: `{ kind: "ckb" }` or `{ kind: "xudt", args }` (or an explicit type/dep). */
  asset: PoolAsset;
  feedId: Hex;
  oracleCommit: Hex;
  startTime: bigint;
  closeTime: bigint;
  rakeBps: number;
}

/** @public */
export class KeeperClient extends PoolReaderClient {
  /**
   * Draft a CREATE (mint a new PoolCell). The staked asset is given high-level via
   * `asset` (a standard xUDT needs only its `args`; type + dep are resolved from
   * the CCC client). CREATE no longer reads the header clock, so no tip-header
   * RPC is needed.
   */
  async draftCreate(params: DraftCreateParams): Promise<ccc.Transaction> {
    const { variant, assetType, assetTypeDep } = await resolveCreateAsset(this.client, params.asset);
    return buildCreatePoolTx({
      deploy: this.deploy,
      deps: this.deps,
      seedInput: params.seedInput,
      creatorLock: ccc.Script.from(params.creatorLock),
      variant,
      assetType,
      assetTypeDep,
      feedId: params.feedId,
      oracleCommit: params.oracleCommit,
      startTime: params.startTime,
      closeTime: params.closeTime,
      rakeBps: params.rakeBps,
    });
  }

  /** Draft an ACTIVATE (OPEN → LOCKED | VOID). */
  draftActivate(params: KeeperTxArgs): Promise<ccc.Transaction> {
    return initiateActivate(this.keeperParams(params));
  }

  /** Draft a CORRECT-START (LOCKED → LOCKED). */
  draftCorrectStart(params: KeeperTxArgs): Promise<ccc.Transaction> {
    return initiateCorrectStart(this.keeperParams(params));
  }

  /** Draft a RESOLVE (LOCKED → SETTLED | VOID). */
  draftResolve(params: KeeperTxArgs): Promise<ccc.Transaction> {
    return initiateResolve(this.keeperParams(params));
  }

  /** Draft a CORRECT-SETTLE (SETTLED → SETTLED). */
  draftCorrectSettle(params: KeeperTxArgs): Promise<ccc.Transaction> {
    return initiateCorrectSettle(this.keeperParams(params));
  }

  /** Draft a FINALIZE (SETTLED → FINALIZED). */
  draftFinalize(params: KeeperTxArgs): Promise<ccc.Transaction> {
    return initiateFinalize(this.keeperParams(params));
  }

  /**
   * Draft a BATCH of boundary-coincident transitions as ONE transaction. Each pool
   * is its own `pool_type` group, validated independently, so they cannot interfere;
   * the items share read-only deps (oracle cell, code) which de-duplicate. All items
   * of a given feed must resolve to the same oracle cell (the builder enforces this).
   */
  draftTransitionBatch(items: InitiateTransitionBatchItem[]): Promise<ccc.Transaction> {
    return initiateTransitionBatch({ client: this.client, deployment: this.config.deployment, items });
  }

  /** Draft a CLOSE (terminal teardown of a FINALIZED/VOID pool). */
  draftClose(params: DraftArgs<InitiateCloseParams>): Promise<ccc.Transaction> {
    return initiateClose({ client: this.client, deployment: this.config.deployment, ...params });
  }

  private keeperParams(params: KeeperTxArgs): InitiateKeeperTransitionParams {
    return { client: this.client, deployment: this.config.deployment, ...params };
  }
}
