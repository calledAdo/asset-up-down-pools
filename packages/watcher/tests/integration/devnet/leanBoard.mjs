//! Mode-B devnet harness — the REAL Lean Oracle path (Pyth-via-Wormhole), the one
//! subsystem never exercised live end-to-end. Unlike Mode-A's manual mock, here the
//! watcher's own `createLeanReadOnlySource` (keeper reader) + `createLeanOracleSource`
//! (worker advancer) talk to a live Lean Oracle cell on devnet: each advance fetches
//! a real BTC/USD price update from Hermes and pulls it on-chain (Wormhole VAA
//! verified against the deployed guardian set).
//!
//! Deployment: the lean_oracle repo's v4 devnet deploy (session 017: oracle-type +
//! guardian-set-type v3 code, and a LIVE guardian-set state cell initialized to the
//! canonical Wormhole set 7 / quorum 13) is live on the persistent offckb chain. We
//! read its artifacts and reuse the real guardian cell directly — no reconstruction.
//! The canonical oracle cell is held under an owner-bind lock we don't hold the key
//! for, so we mint our OWN permissionless personal cell for the same feed via
//! `initiateOracleDeployTx({ oracleLockScript: <our lock> })`. `oracle_commit` is
//! identity-only (oracle-type code hash ‖ guardian-set type hash ‖ emitter) — it does
//! NOT depend on the cell instance or its lock — so pools bind the SAME commit the
//! canonical deployment would produce, and `find_oracle` accepts our cell. The advancer
//! verifies live Hermes set-7 VAAs against the deployed set-7 guardian cell.
//!
//! We consume the lean_oracle deployment ARTIFACTS (JSON outputs, not source) from
//! LEAN_DEVNET_ARTIFACTS_DIR; the SDK itself is the npm `lean-oracle-sdk` the watcher
//! already depends on. Opt-in via the same DEVNET_DEPLOYER_PRIVATE_KEY gate as Mode-A.

import fs from "node:fs";
import path from "node:path";

import { oracleCommit } from "ckb-up-down-sdk/ckb";

import { LeanOracleClient } from "lean-oracle-sdk";
import { initiateOracleDeployTx, initiateOracleBurnTx } from "lean-oracle-sdk/tx";
import { rebalanceFuel } from "lean-oracle-sdk/fuel";

import {
  createLeanOracleSource,
  createLeanReadOnlySource,
  oracleIdentityOf,
} from "../../../dist/index.js";

import { RPC } from "./board.mjs";

/** Pyth BTC/USD — the canonical feed the devnet deploy committed to. */
export const LEAN_FEED = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
/** Public Hermes endpoint (mainnet Pyth); overridable. */
export const HERMES_BASE_URL = process.env.HERMES_BASE_URL ?? "https://hermes.pyth.network";
/** lean_oracle deployment artifacts (JSON outputs) — the sibling repo's `deployment/artifacts`. */
export const LEAN_ARTIFACTS_DIR =
  process.env.LEAN_DEVNET_ARTIFACTS_DIR ?? "/home/destiny/ckb/lean_oracle/deployment/artifacts";
/** Devnet fee-rate override — offckb's `get_fee_rate_statistics` returns null so CCC's getFeeRate throws. */
export const ORACLE_FEE_RATE = 2000n;
/** Capacity for a personal oracle cell (152-byte data + scripts fit in 300 CKB). */
const ORACLE_CELL_CAPACITY = 30_000_000_000n;

function readArtifact(file) {
  const full = path.join(LEAN_ARTIFACTS_DIR, file);
  if (!fs.existsSync(full)) {
    throw new Error(`missing lean-oracle devnet artifact ${full} — set LEAN_DEVNET_ARTIFACTS_DIR`);
  }
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

function latestVersion(artifact) {
  const versions = artifact.deployment.versions;
  const key = Object.keys(versions).map(Number).filter(Number.isFinite).sort((a, b) => b - a)[0];
  return versions[String(key)];
}

function codeDepOf(version) {
  return { outPoint: { txHash: version.txHash, index: BigInt(version.index) }, depType: version.depType };
}

/**
 * Assemble the SDK's `LeanOracleNetworkConfig` for devnet from the deployment
 * artifacts — mirrors lean_oracle's own `loadDevnetDeploymentFixture`, kept inline so
 * this harness stays independent of the sibling repo's test helpers.
 */
export function buildLeanNetwork({ rpc = RPC, hermes = HERMES_BASE_URL } = {}) {
  const oTypeArt = readArtifact("devnet.oracle-type.json");
  const bindArt = readArtifact("devnet.owned-type-bind-lock.json");
  const gsDeploy = readArtifact("devnet.deploy-guardian-set.json").deployment;
  const oDeploy = readArtifact("devnet.deploy-oracle.json").deployment;

  const oTypeVer = latestVersion(oTypeArt);
  const bindVer = latestVersion(bindArt);

  // The live guardian-set state cell (canonical Wormhole set 7) — read its identity
  // straight from the deploy-guardian-set artifact; no reconstruction needed.
  const gs = gsDeploy.guardianSetType;
  const guardianSetType = {
    codeHash: gs.codeHash,
    hashType: gs.hashType,
    args: gs.args,
    identityVersion: gsDeploy.identityVersion,
    codeVersion: gs.codeVersion,
    codeDep: { outPoint: { txHash: gs.outPoint.txHash, index: BigInt(gs.outPoint.index) }, depType: gs.depType },
  };

  const canonicalPublicOracleLock = {
    script: { codeHash: bindVer.codeHash, hashType: bindVer.hashType, args: oDeploy.ownedTypeBindLock.ownerLockHash },
    codeDep: codeDepOf(bindVer),
  };

  return {
    name: "devnet",
    hermesBaseUrl: hermes,
    ckbJsonRpcUrl: rpc,
    deploymentStatus: "available",
    deployment: {
      canonicalPublicOracleLock,
      oracleType: { codeHash: oTypeVer.codeHash, hashType: oTypeVer.hashType, codeDep: codeDepOf(oTypeVer) },
      oracleTypeVersions: Object.fromEntries(
        Object.entries(oTypeArt.deployment.versions).map(([k, v]) => [
          Number(k),
          { codeHash: v.codeHash, hashType: v.hashType, codeDep: codeDepOf(v) },
        ]),
      ),
      guardianSetType,
      pythEmitter: { chain: oDeploy.oracleConfig.emitterChain, address: oDeploy.oracleConfig.emitterAddress },
    },
  };
}

/** The oracle identity the deployment commits to (used to derive `oracle_commit`). */
export function leanIdentity(network) {
  return oracleIdentityOf(network);
}

/** `oracle_commit` pools must bind so `find_oracle` accepts a cell of this identity. */
export function leanCommit(network) {
  return oracleCommit(oracleIdentityOf(network));
}

/**
 * Deploy a fresh, permissionless personal oracle cell for `feedId` under `oracleLock`
 * (the signer's own lock), reusing the live oracle code + guardian set. Burns any
 * stale cell from a prior run first. The freshly-deployed cell holds a zeroed price;
 * the first advance pulls a real Hermes tick.
 */
export async function deployPersonalOracle({ client, signer, oracleLock, network, feedId = LEAN_FEED, log = () => {} }) {
  const leanClient = new LeanOracleClient({ network, cccClient: client });

  const stale = await leanClient.getOracleCellState({ feedId, oracleLockScript: oracleLock });
  if (stale) {
    log(`burning stale personal oracle cell ${stale.outPoint.txHash.slice(0, 12)}:${stale.outPoint.index}`);
    const burnTx = await initiateOracleBurnTx({ network, cccClient: client, feedId, oracleLockScript: oracleLock });
    await sendOracleTx(client, signer, oracleLock, burnTx);
  }

  const deployTx = await initiateOracleDeployTx({
    network,
    cccClient: client,
    feedId,
    oracleLockScript: oracleLock,
    capacity: ORACLE_CELL_CAPACITY,
  });
  const txHash = await sendOracleTx(client, signer, oracleLock, deployTx);
  log(`deployed personal oracle cell for ${feedId.slice(0, 12)} -> ${txHash.slice(0, 12)}`);
  return { leanClient, txHash };
}

/** Fund + broadcast a draft (no-input) oracle tx from `lock`'s cells, wait for commit. */
async function sendOracleTx(client, signer, lock, tx) {
  const rebalanced = await rebalanceFuel(tx, {
    cccClient: client,
    lockScript: lock,
    feeRateShannonsPerKbOverride: ORACLE_FEE_RATE,
    fuelLimit: 32,
  });
  if (rebalanced.status !== "ok") {
    throw new Error(`oracle tx fuel insufficient: need ${rebalanced.extraCapacityNeededShannons} more shannons`);
  }
  const txHash = await signer.sendTransaction(rebalanced.mutated);
  await client.waitTransaction(txHash, 0, 120000);
  return txHash;
}

/**
 * Build the two REAL Lean sources the production split uses:
 *   - `reader`   — the keeper's read-only source (never advances).
 *   - `advancer` — the oracle worker's source (reads, and on a miss pulls the first
 *     Hermes tick ≥ boundary on-chain, funded + signed by the oracle wallet).
 * Both target the personal cell held under `oracleLock`.
 */
export function buildLeanSources({ client, network, oracleSigner, oracleLock, leanClient, log = () => {} }) {
  const lo = leanClient ?? new LeanOracleClient({ network, cccClient: client });
  const reader = createLeanReadOnlySource({ client: lo, oracleLock, log });
  const advancer = createLeanOracleSource({
    client: lo,
    network,
    cccClient: client,
    signer: oracleSigner,
    fuelLock: oracleLock,
    oracleLock,
    feeRateShannonsPerKbOverride: ORACLE_FEE_RATE,
    fuelLimit: 32,
    log,
  });
  return { reader, advancer, leanClient: lo };
}

/**
 * Full Mode-B oracle setup: read the live v4 devnet deployment (oracle-type code +
 * the canonical set-7 guardian-set state cell), mint a personal oracle cell under
 * `oracleLock` bound to that guardian identity, and return the network config + the
 * derived `oracle_commit`. `find_oracle` accepts this oracle cell, and the advancer
 * verifies real Hermes set-7 VAAs against the deployed set-7 guardian cell.
 */
export async function setupLeanOracle({ client, signer, oracleLock, log = () => {} }) {
  const network = buildLeanNetwork();
  const { leanClient } = await deployPersonalOracle({ client, signer, oracleLock, network, log });
  const identity = leanIdentity(network);
  return { network, leanClient, identity, commit: oracleCommit(identity) };
}

/**
 * A single Mode-B lane on the real feed, anchored so the pool's start/close land on
 * the grid the keeper Cadence + oracle worker share. `firstCreateAt = startTime` and
 * `durationSecs = duration` make `startTime` boundary 0 and `closeTime` boundary 1.
 */
export function leanLane({ identity, startTime, durationSecs = 60n, rakeBps = 200, label = "LEAN-60s" }) {
  return {
    label,
    feedId: LEAN_FEED,
    durationSecs: BigInt(durationSecs),
    rakeBps,
    asset: { kind: "ckb" },
    oracleIdentity: identity,
    firstCreateAt: BigInt(startTime),
    createLeadSecs: 5n,
  };
}

/** Probe Hermes reachability for the feed; returns a skip reason string or undefined. */
export async function hermesSkipReason(feedId = LEAN_FEED) {
  const t = Math.floor(Date.now() / 1000) - 30;
  const url = `${HERMES_BASE_URL}/v2/updates/price/${t}?ids[]=${feedId}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return `Hermes returned HTTP ${res.status}`;
    const body = await res.json();
    if (!body.parsed?.[0] || !body.binary?.data?.[0]) return "Hermes returned no price update";
    return undefined;
  } catch (err) {
    return `Hermes unreachable: ${err instanceof Error ? err.message : String(err)}`;
  }
}
