//! Bundled devnet preset. These constants are **copied** from the deployment
//! toolbox's records (`deployment/artifacts/devnet.*.json`) — never imported (the
//! decoupling rule, see the module note in `presets/config.ts`). They are a
//! point-in-time snapshot of the live offckb devnet deployment; if an operator
//! redeploys and the artifacts change, re-copy the values here.
//!
//! `pool_type` is pinned to its active version (v5); the prior version (v1) is
//! kept in `poolTypeVersions` so `configForPoolTypeVersion` can read pools created
//! under the old code hash. (Snapshot refreshed 2026-06-25 after a full devnet
//! redeploy of all four pool scripts.)
//!
//! offckb's local secp256k1_blake160 cell differs per machine, so `devnetConfig`
//! takes the `devnetSecp` override (and optional RPC URL) at call time rather than
//! baking it in.

import type { DevnetSecpOverride } from "../ckb/client.js";
import type { Hex } from "../internal/bytes.js";
import { definePoolNetworkConfig, type PoolNetworkConfig, type PoolScriptRef } from "./config.js";

/** Snapshot of the deployed pool scripts on the live offckb devnet. */
export const DEVNET_POOL_SCRIPTS = {
  poolType: {
    codeHash: "0xa6d78c37fa97bfe172f34bf252252da7978a51c9d8e5743310970e178ee3e9df",
    codeDep: {
      outPoint: { txHash: "0x1d62f2bd5552e28294be091061fb6426b09cf4f94d939780333931970e0239e5", index: 0 },
      depType: "code",
    },
  },
  shareXudt: {
    codeHash: "0x2101f97c483cf64a384105d2c2310121380cff910c8b57b880ffc7bb4551cd46",
    codeDep: {
      outPoint: { txHash: "0x0c2b4a9924e1a052a50733ef52583e9688f6f3e6708a7a3e0484cf00f63e6601", index: 0 },
      depType: "code",
    },
  },
  treasuryLock: {
    codeHash: "0x57762cd0c6db917e78c1c3affaf4de20a1e169c2f69f93cee798911fe5615d2d",
    codeDep: {
      outPoint: { txHash: "0x86101c1b0808e8b5c622acc1f17cd649f99ae6c04007f1115ab78fed477f4245", index: 0 },
      depType: "code",
    },
  },
  poolAdminLock: {
    codeHash: "0x1522f6db1bc4c9665c82eb81fa9eccbb427cdc1c26668692ec801b457050afe4",
    codeDep: {
      outPoint: { txHash: "0x929e0ddcd951b4f967b5c3b803a3ee32f52ab5b7498832c3914a6498f7085827", index: 0 },
      depType: "code",
    },
  },
} as const satisfies Record<string, PoolScriptRef>;

/** Prior `pool_type` code version (v1), for reading pools created under it. */
export const DEVNET_POOL_TYPE_V1: PoolScriptRef = {
  codeHash: "0x157938d481848d93a45397c9d58522612b4083bc503a9b0dbc9899114aabfb85",
  codeDep: {
    outPoint: { txHash: "0x62f37030a49fc8af7e40df7237513a44de0d54b84152ea348918834c411b9e24", index: 0 },
    depType: "code",
  },
};

/** Default offckb JSON-RPC endpoint. */
export const DEVNET_DEFAULT_RPC = "http://127.0.0.1:8114";

/** Options for {@link devnetConfig}. */
export interface DevnetConfigOptions {
  /** offckb's local secp256k1_blake160 KnownScript override (varies per machine). */
  devnetSecp: DevnetSecpOverride;
  /** JSON-RPC endpoint (default {@link DEVNET_DEFAULT_RPC}). */
  ckbJsonRpcUrl?: string;
  /**
   * Operator identity: creator-lock hashes of pools we manage, for
   * `listManagedPools()`. Devnet locks are per-machine (derived from the operator
   * key), so unlike a stable network this can't be bundled — pass it in. For
   * testnet/mainnet preset builders, this is bundled per network instead.
   */
  operatorLockHashes?: Hex[];
}

/**
 * Build a ready-to-use devnet {@link PoolNetworkConfig} from the bundled script
 * snapshot. Supply the machine-specific `devnetSecp` override (and optional RPC
 * URL + operator lock hashes); everything else is filled from
 * {@link DEVNET_POOL_SCRIPTS}.
 */
export function devnetConfig(options: DevnetConfigOptions): PoolNetworkConfig {
  return definePoolNetworkConfig({
    name: "devnet",
    ckbJsonRpcUrl: options.ckbJsonRpcUrl ?? DEVNET_DEFAULT_RPC,
    deployment: {
      poolType: DEVNET_POOL_SCRIPTS.poolType,
      shareXudt: DEVNET_POOL_SCRIPTS.shareXudt,
      treasuryLock: DEVNET_POOL_SCRIPTS.treasuryLock,
      poolAdminLock: DEVNET_POOL_SCRIPTS.poolAdminLock,
      poolTypeVersions: {
        1: DEVNET_POOL_TYPE_V1,
        5: DEVNET_POOL_SCRIPTS.poolType,
      },
    },
    devnetSecp: options.devnetSecp,
    operatorLockHashes: options.operatorLockHashes,
  });
}
