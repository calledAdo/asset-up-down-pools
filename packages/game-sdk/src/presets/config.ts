//! Network configuration: the deployment constants a client needs threaded into
//! every read and transaction. The SDK ships no baked-in testnet/mainnet values
//! (only devnet is live, and devnet is regenerated per operator) — callers build
//! a `PoolNetworkConfig` from their own deployment artifacts. This mirrors the
//! deployment toolbox's records *by shape*, never by import (the decoupling rule).

import type { DevnetSecpOverride, Network } from "../ckb/client.js";
import type { Hex } from "../internal/bytes.js";
import type { CellDepInfo, PoolCodeDeps, PoolDeployment } from "../types.js";

/** One deployed pool script: its `data2` code hash and the cell that carries the code. */
export interface PoolScriptRef {
  codeHash: Hex;
  codeDep: CellDepInfo;
}

/** The four pool scripts, plus an optional pool_type code-version history. */
export interface PoolDeploymentConfig {
  poolType: PoolScriptRef;
  shareXudt: PoolScriptRef;
  treasuryLock: PoolScriptRef;
  poolAdminLock: PoolScriptRef;
  /**
   * Optional history of `pool_type` code versions, keyed by version number
   * (mirrors `deployment/artifacts/<net>.pool-type.json#versions`). The active
   * entry equals {@link poolType}; discovery filters cells by that code hash, so
   * to operate on a pool created under an older code version, pin the config to
   * it with {@link configForPoolTypeVersion}.
   */
  poolTypeVersions?: Record<number, PoolScriptRef>;
}

/** All knobs for one environment. */
export interface PoolNetworkConfig {
  name: Network;
  ckbJsonRpcUrl: string;
  deployment: PoolDeploymentConfig;
  /** Required for devnet (offckb): the local secp256k1_blake160 KnownScript override. */
  devnetSecp?: DevnetSecpOverride;
  /**
   * Operator identity: the creator-lock **hashes** of pools we manage (a pool's
   * `pool_admin_lock` carries `args == creatorLockHash`). Caller-supplied
   * operational config — NOT part of the deployment. Set this to let
   * `listManagedPools()` fetch only our pools via a lock-scoped search instead of
   * scanning the whole permissionless deployment. A list so key rotation / multiple
   * keepers are covered (results are unioned).
   */
  operatorLockHashes?: Hex[];
}

/** Identity helper for authoring a config with type-checking. */
export function definePoolNetworkConfig(config: PoolNetworkConfig): PoolNetworkConfig {
  return config;
}

/** The code-hash view of a deployment (used for script derivation + discovery). */
export function toPoolDeployment(d: PoolDeploymentConfig): PoolDeployment {
  return {
    poolTypeCodeHash: d.poolType.codeHash,
    shareXudtCodeHash: d.shareXudt.codeHash,
    treasuryLockCodeHash: d.treasuryLock.codeHash,
    poolAdminLockCodeHash: d.poolAdminLock.codeHash,
  };
}

/** The cell-dep view of a deployment (used for transaction assembly). */
export function toPoolCodeDeps(d: PoolDeploymentConfig): PoolCodeDeps {
  return {
    poolType: d.poolType.codeDep,
    shareXudt: d.shareXudt.codeDep,
    treasuryLock: d.treasuryLock.codeDep,
    poolAdminLock: d.poolAdminLock.codeDep,
  };
}

/**
 * A copy of `config` whose active `pool_type` is pinned to a prior code version,
 * for reading/operating on pools created under that code hash. Throws if the
 * version is absent.
 */
export function configForPoolTypeVersion(config: PoolNetworkConfig, version: number): PoolNetworkConfig {
  const v = config.deployment.poolTypeVersions?.[version];
  if (!v) throw new Error(`pool_type code version ${version} not found in this config`);
  return { ...config, deployment: { ...config.deployment, poolType: v } };
}
