//! Mode-B devnet harness — the REAL Lean Oracle path (Pyth-via-Wormhole), the one
//! subsystem never exercised live end-to-end. Unlike Mode-A's manual mock, here the
//! watcher's own `createLeanReadOnlySource` (keeper reader) + `createLeanOracleSource`
//! (worker advancer) talk to a live Lean Oracle cell on devnet: each advance fetches
//! a real BTC/USD price update from Hermes and pulls it on-chain (Wormhole VAA
//! verified against the deployed guardian set).
//!
//! Deployment reuse: the lean_oracle repo's 2026-06-25 devnet deploy (oracle code +
//! guardian set) is still live on the persistent offckb chain. We DON'T redeploy it.
//! But its canonical oracle cell is held under an owner-bind lock we don't hold the
//! key for, so instead we mint our OWN permissionless personal cell for the same feed
//! via `initiateOracleDeployTx({ oracleLockScript: <our lock> })`. `oracle_commit` is
//! identity-only (oracle-type code hash ‖ guardian-set type hash ‖ emitter) — it does
//! NOT depend on the cell instance or its lock — so pools bind the SAME commit the
//! canonical deployment would produce, and `find_oracle` accepts our cell.
//!
//! We consume the lean_oracle deployment ARTIFACTS (JSON outputs, not source) from
//! LEAN_DEVNET_ARTIFACTS_DIR; the SDK itself is the npm `lean-oracle-sdk` the watcher
//! already depends on. Opt-in via the same DEVNET_DEPLOYER_PRIVATE_KEY gate as Mode-A.

import fs from "node:fs";
import path from "node:path";

import { ccc } from "@ckb-ccc/core";

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
import { reconstructGuardianSet } from "./guardianReconstruct.mjs";

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
  const gsTypeArt = readArtifact("devnet.guardian-set-type.json");
  const oTypeArt = readArtifact("devnet.oracle-type.json");
  const bindArt = readArtifact("devnet.owned-type-bind-lock.json");
  const gsDeploy = readArtifact("devnet.deploy-guardian-set.json").deployment;
  const oDeploy = readArtifact("devnet.deploy-oracle.json").deployment;

  const gsTypeVer = latestVersion(gsTypeArt);
  const oTypeVer = latestVersion(oTypeArt);
  const bindVer = latestVersion(bindArt);

  const gsTypeArgs = gsDeploy.deployed.typeIdArgs;
  const guardianSetTypeHash = ccc.hashCkb(
    ccc.Script.from({
      codeHash: gsDeploy.guardianSetType.codeHash,
      hashType: gsDeploy.guardianSetType.hashType,
      args: gsTypeArgs,
    }).toBytes(),
  );

  const defaultPublicOracleLock = {
    script: { codeHash: bindVer.codeHash, hashType: bindVer.hashType, args: oDeploy.ownedTypeBindLock.ownerLockHash },
    codeDep: codeDepOf(bindVer),
  };

  return {
    name: "devnet",
    hermesBaseUrl: hermes,
    ckbJsonRpcUrl: rpc,
    deployment: {
      defaultPublicOracleLock,
      oracleType: { codeHash: oTypeVer.codeHash, hashType: oTypeVer.hashType, codeDep: codeDepOf(oTypeVer) },
      oracleTypeVersions: Object.fromEntries(
        Object.entries(oTypeArt.deployment.versions).map(([k, v]) => [
          Number(k),
          { codeHash: v.codeHash, hashType: v.hashType, codeDep: codeDepOf(v) },
        ]),
      ),
      guardianSetType: {
        codeHash: gsTypeVer.codeHash,
        hashType: gsTypeVer.hashType,
        args: gsTypeArgs,
        typeHash: guardianSetTypeHash,
        codeDep: codeDepOf(gsTypeVer),
      },
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

/** Encode a guardian-set cell body: setIndex(4 LE) ‖ quorum(4 LE) ‖ n(4 LE) ‖ n×addr(20). */
function encodeGuardianSetData({ setIndex, quorum, guardianAddresses }) {
  const n = guardianAddresses.length;
  const out = new Uint8Array(12 + n * 20);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, setIndex >>> 0, true);
  dv.setUint32(4, quorum >>> 0, true);
  dv.setUint32(8, n >>> 0, true);
  let c = 12;
  for (const a of guardianAddresses) {
    const h = a.slice(2);
    for (let i = 0; i < 20; i++) out[c + i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    c += 20;
  }
  return out;
}

/**
 * Deploy a personal guardian-set cell (a fresh type-id) holding `guardianSet`, reusing
 * the live `guardian_set_type` CODE from `network`. Returns a `deployment.guardianSetType`
 * override (its own type-id + type hash) to splice into a network config so a personal
 * oracle cell + `oracle_commit` bind to THIS guardian set.
 */
export async function deployGuardianSet({ client, signer, lock, network, guardianSet, log = () => {} }) {
  const gsType = network.deployment.guardianSetType; // reuse the live guardian_set_type code
  const data = encodeGuardianSetData(guardianSet);
  const tx = ccc.Transaction.from({
    outputs: [{ lock: ccc.Script.from(lock), type: { codeHash: gsType.codeHash, hashType: gsType.hashType, args: "0x" + "00".repeat(32) }, capacity: 0 }],
    outputsData: [ccc.hexFrom(data)],
    cellDeps: [gsType.codeDep],
  });
  await tx.completeInputsByCapacity(signer);
  tx.outputs[0].type.args = ccc.hashTypeId(tx.inputs[0], 0);
  tx.outputs[0].capacity += ccc.fixedPointFrom(8);
  await tx.completeFeeBy(signer, ORACLE_FEE_RATE);
  const txHash = await signer.sendTransaction(tx);
  await client.waitTransaction(txHash, 0, 120000);
  const typeArgs = tx.outputs[0].type.args;
  const typeHash = ccc.hashCkb(
    ccc.Script.from({ codeHash: gsType.codeHash, hashType: gsType.hashType, args: typeArgs }).toBytes(),
  );
  log(`guardian set ${guardianSet.setIndex} deployed ${txHash.slice(0, 12)} (typeHash ${typeHash.slice(0, 12)})`);
  return { codeHash: gsType.codeHash, hashType: gsType.hashType, args: typeArgs, typeHash, codeDep: gsType.codeDep };
}

/**
 * Full Mode-B oracle setup: reconstruct the live guardian set, deploy it + a personal
 * oracle cell under `oracleLock`, and return the network config bound to them plus the
 * derived `oracle_commit`. `find_oracle` will accept this oracle cell, and the advancer
 * verifies real Hermes VAAs against the reconstructed set.
 */
export async function setupLeanOracle({ client, signer, oracleLock, samples = 20, log = () => {} }) {
  const guardianSet = await reconstructGuardianSet({ hermesBaseUrl: HERMES_BASE_URL, feedId: LEAN_FEED, samples, log });
  const network = buildLeanNetwork();
  network.deployment.guardianSetType = await deployGuardianSet({ client, signer, lock: oracleLock, network, guardianSet, log });
  const { leanClient } = await deployPersonalOracle({ client, signer, oracleLock, network, log });
  const identity = leanIdentity(network);
  return { network, leanClient, identity, commit: oracleCommit(identity), guardianSet };
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
