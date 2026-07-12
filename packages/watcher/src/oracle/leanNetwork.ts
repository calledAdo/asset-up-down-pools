//! Load a `lean-oracle-sdk` network config from an operator-supplied JSON file
//! and derive the {@link OracleIdentity} our pools must bind (`oracle_commit`).
//!
//! The JSON is the SDK's `LeanOracleNetworkConfig` (the oracle deployment + RPC +
//! Hermes base url). Generate it from the Lean Oracle deployment artifacts. Keeping
//! it a file the operator points at — rather than importing the sibling repo —
//! preserves the decoupling rule: the watcher consumes the deployment, it doesn't
//! reach into the oracle project's source/artifacts.

import fs from "node:fs";

import { ccc } from "@ckb-ccc/core";
import type { LeanOracleNetworkConfig } from "lean-oracle-sdk";
import type { OracleIdentity } from "ckb-up-down-sdk/ckb";
import type { Hex } from "ckb-up-down-sdk";

/** Read + minimally validate a `LeanOracleNetworkConfig` JSON file. */
export function loadLeanNetwork(path: string): LeanOracleNetworkConfig {
  const raw = JSON.parse(fs.readFileSync(path, "utf8")) as Partial<LeanOracleNetworkConfig>;
  const d = raw.deployment;
  if (!raw.ckbJsonRpcUrl || !raw.hermesBaseUrl || !d?.oracleType?.codeHash || !d?.guardianSetType?.codeHash) {
    throw new Error(`invalid lean-oracle network config at ${path}: missing rpc/hermes/deployment fields`);
  }
  return raw as LeanOracleNetworkConfig;
}

/**
 * The {@link OracleIdentity} the deployed oracle commits to. `guardianSetTypeHash`
 * is the hash of the guardian-set **type script** (its type-id), recomputed from the
 * config so pool `oracle_commit` matches `find_oracle`'s on-chain re-derivation.
 */
export function oracleIdentityOf(network: LeanOracleNetworkConfig): OracleIdentity {
  const gs = network.deployment.guardianSetType;
  const guardianSetTypeHash = ccc.hashCkb(
    ccc.Script.from({ codeHash: gs.codeHash, hashType: gs.hashType, args: gs.args ?? "0x" }).toBytes(),
  ) as Hex;
  return {
    oracleTypeCodeHash: network.deployment.oracleType.codeHash as Hex,
    guardianSetTypeHash,
    emitterChain: network.deployment.pythEmitter.chain,
    emitterAddress: network.deployment.pythEmitter.address as Hex,
  };
}
