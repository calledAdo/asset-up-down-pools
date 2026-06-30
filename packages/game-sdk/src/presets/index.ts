//! `ckb-up-down-sdk/presets` — network configuration: the authoring helpers
//! (`definePoolNetworkConfig`, version pinning) and whatever deployments ship
//! bundled. Only the **devnet** snapshot is bundled (`devnetConfig`), and only as a
//! local-dev convenience — devnet hashes are ephemeral and per-operator. For
//! testnet/mainnet, build a `PoolNetworkConfig` from your own deployment artifacts
//! (the decoupling rule: shapes are mirrored here, never imported from the
//! deployment toolbox). Bundled testnet/mainnet presets land here once deployed.

export {
  definePoolNetworkConfig,
  toPoolDeployment,
  toPoolCodeDeps,
  configForPoolTypeVersion,
  type PoolScriptRef,
  type PoolDeploymentConfig,
  type PoolNetworkConfig,
} from "./config.js";
// The network-name type lives with the CCC client (where it is defined) but is
// part of the config surface, so it is re-exported here too.
export type { Network } from "../ckb/client.js";
export {
  devnetConfig,
  DEVNET_POOL_SCRIPTS,
  DEVNET_POOL_TYPE_V1,
  DEVNET_DEFAULT_RPC,
  type DevnetConfigOptions,
} from "./devnet.js";
