//! Shared read base for the role-split clients. Holds a CCC client and the
//! deployment (code hashes + cell deps) derived from a `PoolNetworkConfig`, and
//! exposes the read queries. `PlayerClient` and `KeeperClient` extend it with the
//! transaction drafts each role needs.

import { ccc } from "@ckb-ccc/core";

import { createClient } from "../ckb/client.js";
import type { Hex } from "../internal/bytes.js";
import {
  getPool,
  getShareBalances,
  getTreasuryBalance,
  listPools,
  type PoolFilter,
  type PoolView,
} from "../query/pools.js";
import {
  toPoolCodeDeps,
  toPoolDeployment,
  type PoolNetworkConfig,
} from "../presets/config.js";
import { completeFeeAndChange, type CompleteFeeOptions } from "../tx/fees.js";
import type { PoolCodeDeps, PoolDeployment, Script } from "../types.js";

/** @public */
export interface PoolClientOptions {
  config: PoolNetworkConfig;
  /**
   * Optional preconfigured CCC client. When omitted, one is built from the
   * config (`createClient(name, ckbJsonRpcUrl, devnetSecp)`). Pass your own to
   * share a client across services, target a private endpoint, or inject a fake.
   */
  cccClient?: ccc.Client;
}

/** @public */
export class PoolReaderClient {
  readonly config: PoolNetworkConfig;
  readonly client: ccc.Client;
  readonly deploy: PoolDeployment;
  readonly deps: PoolCodeDeps;

  constructor(options: PoolClientOptions) {
    this.config = options.config;
    this.client =
      options.cccClient ??
      createClient(options.config.name, options.config.ckbJsonRpcUrl, options.config.devnetSecp);
    this.deploy = toPoolDeployment(options.config.deployment);
    this.deps = toPoolCodeDeps(options.config.deployment);
  }

  /** Fetch and decode a single pool by its `pool_id` (typeID). */
  getPool(poolId: Hex): Promise<PoolView | null> {
    return getPool(this.client, this.deploy, poolId);
  }

  /**
   * Enumerate live pools, optionally filtered (`{ creator, status, feedId }`). With
   * no `creator` this scans every pool on the (permissionless) deployment; pass
   * `creator` for an efficient lock-scoped search of only your pools.
   */
  listPools(filter?: PoolFilter): Promise<PoolView[]> {
    return listPools(this.client, this.deploy, filter);
  }

  /**
   * Live pools we operate — the union over `config.operatorLockHashes` (de-duped by
   * `poolId`). Throws if no operator lock hashes are configured. This is the
   * efficient, correct way for our own indexer/keeper to list pools: it skips the
   * whole-deployment scan and never returns a pool we can't manage.
   */
  async listManagedPools(): Promise<PoolView[]> {
    const hashes = this.config.operatorLockHashes ?? [];
    if (hashes.length === 0) {
      throw new Error("listManagedPools requires config.operatorLockHashes to be set");
    }
    const byId = new Map<Hex, PoolView>();
    for (const hash of hashes) {
      for (const pool of await listPools(this.client, this.deploy, { creator: hash })) {
        byId.set(pool.poolId, pool);
      }
    }
    return [...byId.values()];
  }

  /**
   * A holder's UP/DOWN share balances for a pool (by id). Fetches the pool so the
   * share code is read from the pool's own data. Throws if the pool is not found.
   */
  async getShareBalances(poolId: Hex, holderLock: ccc.ScriptLike): Promise<{ up: bigint; down: bigint }> {
    const pool = await this.requirePool(poolId);
    return getShareBalances(this.client, pool, holderLock);
  }

  /** Total xUDT treasury balance held for a pool (by id). Throws if not found / not xUDT. */
  async getTreasuryBalance(poolId: Hex): Promise<bigint> {
    const pool = await this.requirePool(poolId);
    return getTreasuryBalance(this.client, pool);
  }

  private async requirePool(poolId: Hex): Promise<PoolView> {
    const pool = await getPool(this.client, this.deploy, poolId);
    if (!pool) throw new Error(`pool not found: ${poolId}`);
    return pool;
  }

  /**
   * Add fee inputs + change to a draft and return it ready to sign/broadcast.
   * Convenience wrapper over the free `completeFeeAndChange`.
   */
  complete(tx: ccc.Transaction, signer: ccc.Signer, options?: CompleteFeeOptions): Promise<ccc.Transaction> {
    return completeFeeAndChange(tx, signer, options);
  }
}
