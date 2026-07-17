//! Entrypoint: load env, build the config + clients, and run the combined service
//! until a shutdown signal. Designed for `node --env-file=.env dist/bin/server.js`
//! (or the Docker image). Oracle wiring is deferred — oracle-free actions (CREATE,
//! CLOSE) fire live; transitions are skipped (logged) until a source is wired.

import { LeanOracleClient } from "lean-oracle-sdk";

import { KeeperClient } from "ckb-up-down-sdk";
import { createPrivateKeySigner } from "ckb-up-down-sdk/ckb";
import { devnetConfig, type Network } from "ckb-up-down-sdk/presets";
import type { OracleIdentity } from "ckb-up-down-sdk/ckb";

import type { LaneConfig, WatcherConfig, WatcherRole } from "../config.js";
import { BTC_USD_FEED, defaultBtcLanes } from "../presets/lanes.js";
import { createService } from "../service.js";
import type { OracleSource } from "../oracle/source.js";
import {
  createLeanOracleSource,
  createLeanReadOnlySource,
  type LeanCccClient,
  type LeanScriptLike,
} from "../oracle/leanSource.js";
import { loadLeanNetwork, oracleIdentityOf } from "../oracle/leanNetwork.js";

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`missing required env: ${key}`);
  return v;
}

/** Pick the lanes this process runs: WATCHER_LANES is a comma-list of labels. */
function selectLanes(all: LaneConfig[]): LaneConfig[] {
  const want = (process.env.WATCHER_LANES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (want.length === 0) return all;
  const lanes = all.filter((l) => want.includes(l.label));
  if (lanes.length === 0) throw new Error(`WATCHER_LANES matched no lanes; known: ${all.map((l) => l.label).join(", ")}`);
  return lanes;
}

async function main() {
  const network = (process.env.WATCHER_NETWORK ?? "devnet") as Network;
  if (network !== "devnet") {
    // Only the bundled devnet preset ships baked-in scripts; other nets must
    // supply a PoolNetworkConfig (see presets/config in the SDK).
    throw new Error(`WATCHER_NETWORK=${network} not supported by the bundled entrypoint; build a config in code`);
  }

  const rpc = env("WATCHER_CKB_RPC_URL", "http://127.0.0.1:8114");
  const config = devnetConfig({
    ckbJsonRpcUrl: rpc,
    devnetSecp: {
      codeHash: env("DEVNET_SECP256K1_BLAKE160_CODE_HASH") as `0x${string}`,
      hashType: env("DEVNET_SECP256K1_BLAKE160_HASH_TYPE") as "type",
      depTxHash: env("DEVNET_SECP256K1_BLAKE160_DEP_TX_HASH") as `0x${string}`,
      depIndex: Number(process.env.DEVNET_SECP256K1_BLAKE160_DEP_INDEX ?? 0),
      depType: env("DEVNET_SECP256K1_BLAKE160_DEP_TYPE") as "depGroup",
    },
  });

  const role = (process.env.WATCHER_ROLE ?? "all") as WatcherRole;
  if (!["all", "keeper", "indexer", "oracle"].includes(role)) {
    throw new Error(`WATCHER_ROLE=${role} invalid; use all | keeper | indexer | oracle`);
  }

  const keeper = new KeeperClient({ config });
  // The indexer never signs, but the SDK signer derivation is cheap and keeps the
  // wiring uniform; a keeper/all process must own a funded wallet per cadence.
  const signer = createPrivateKeySigner(keeper.client, env("WATCHER_CREATOR_PRIVATE_KEY") as `0x${string}`);
  const { script: creatorLock } = await signer.getRecommendedAddressObj();

  // Oracle wiring: WATCHER_ORACLE=live wires a real Lean Oracle cell (WATCHER_ORACLE_CONFIG
  // points at its LeanOracleNetworkConfig JSON); otherwise the service uses the no-op stub.
  // We build BOTH a read-only source (the keeper, a pure reader) and an advancing source
  // (the oracle worker, the sole writer) — the service uses whichever its role needs. The
  // lane oracle identity is DERIVED from the deployed oracle so pool `oracle_commit` matches
  // `find_oracle` on-chain.
  let oracle: OracleSource | undefined; // keeper reader
  let oracleAdvancer: OracleSource | undefined; // oracle worker (sole writer)
  let oracleIdentity: OracleIdentity | undefined;
  if ((process.env.WATCHER_ORACLE ?? "stub") === "live") {
    const network = loadLeanNetwork(env("WATCHER_ORACLE_CONFIG"));
    oracleIdentity = oracleIdentityOf(network);
    // keeper.client / creatorLock are the watcher's @ckb-ccc/core copy; the SDK has its
    // own (runtime-compatible) copy, so cast across the type boundary (see leanSource.ts).
    const cccClient = keeper.client as unknown as LeanCccClient;
    const oracleLockId = network.deployment.defaultPublicOracleLock.script;
    const oracleLock = { ...oracleLockId, args: oracleLockId.args ?? "0x" } as unknown as LeanScriptLike;
    const oracleClient = new LeanOracleClient({ network, cccClient });
    oracle = createLeanReadOnlySource({ client: oracleClient, oracleLock, log: (m) => console.log(`[watcher] ${m}`) });
    oracleAdvancer = createLeanOracleSource({
      client: oracleClient,
      network,
      cccClient,
      signer,
      fuelLock: creatorLock as unknown as LeanScriptLike,
      oracleLock,
      feeRateShannonsPerKbOverride: BigInt(process.env.WATCHER_ORACLE_FEE_RATE ?? 5000),
      fuelLimit: 32,
      log: (m) => console.log(`[watcher] ${m}`),
    });
  }

  const feedId = (process.env.WATCHER_FEED_ID as `0x${string}`) ?? BTC_USD_FEED;
  // Shared grid anchor (unix seconds) for the whole board; 0 = epoch-aligned rounds
  // (:00/:05/… UTC). Set WATCHER_FIRST_CREATE_AT to pin the grid to a chosen instant.
  const firstCreateAt = BigInt(process.env.WATCHER_FIRST_CREATE_AT ?? 0);
  const lanes = defaultBtcLanes(feedId, oracleIdentity, firstCreateAt);

  // For a split deployment, the single indexer aggregates pools across all keeper
  // creator locks — set WATCHER_OPERATOR_LOCK_HASHES to the comma-list of their hashes.
  const operatorLockHashes = (process.env.WATCHER_OPERATOR_LOCK_HASHES ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean) as `0x${string}`[];

  const watcherConfig: WatcherConfig = {
    role,
    config,
    creatorLock,
    ...(operatorLockHashes.length ? { operatorLockHashes } : {}),
    lanes: selectLanes(lanes),
    // Safety backstop only — the keeper sleeps to the next pool-state event and
    // retries failures/skips on a short delay, so this is a long net (discovery,
    // restart, anything it didn't drive), not the primary cadence.
    pollIntervalSecs: Number(process.env.WATCHER_POLL_SECS ?? 60),
    indexIntervalSecs: Number(process.env.WATCHER_INDEX_SECS ?? 10),
    dbPath: process.env.WATCHER_DB_PATH ?? "./data/watcher.db",
    apiPort: Number(process.env.WATCHER_API_PORT ?? 8080),
  };

  const service = createService({ config: watcherConfig, keeper, signer, creatorLock, oracle, oracleAdvancer });

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[watcher] ${sig} received, shutting down`);
    await service.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Operator wind-down control (keeper/all roles): SIGUSR1 stops minting new rounds
  // so existing pools drain to a terminal state before a redeploy; SIGUSR2 resumes.
  // e.g. `docker kill -s USR1 keeper-5m`. Registering a SIGUSR1 handler overrides
  // Node's default (start the inspector) — fine for a headless service; attach a
  // debugger with --inspect at launch instead.
  process.on("SIGUSR1", () => service.setWindingDown(true));
  process.on("SIGUSR2", () => service.setWindingDown(false));

  await service.start();
}

main().catch((err) => {
  console.error("[watcher] fatal:", err);
  process.exit(1);
});
