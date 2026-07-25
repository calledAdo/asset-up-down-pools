//! Shared Mode-A devnet harness for the keeper-runtime integration tests.
//!
//! A small NESTING board (30s / 60s / 120s on one `firstCreateAt`) so boundaries
//! coincide periodically — the precondition for batching — while the 60s grace
//! floor keeps several pools alive at once. All CKB-staked, 2% rake, bound to the
//! test-only mock oracle identity so `find_oracle` accepts the mock cells.
//!
//! Bootstrap mirrors the game-sdk lifecycle test: fresh always-success-locked dep
//! cells (repeatable across runs), the offckb genesis funder, and separate funded
//! wallets per role (keeper / oracle / player) so their txs never contend on cells.
//!
//! Opt-in: skips unless DEVNET_DEPLOYER_PRIVATE_KEY is set (signals a wired devnet).

import { ccc } from "@ckb-ccc/core";
import crypto from "node:crypto";

import { KeeperClient, PlayerClient } from "ckb-up-down-sdk";
import { createClient, createPrivateKeySigner } from "ckb-up-down-sdk/ckb";
import { definePoolNetworkConfig } from "ckb-up-down-sdk/presets";

// Cross-package TEST helpers (not source — the decoupling rule is about src imports):
// reuse the game-sdk devnet harness so we deploy the same binaries and mint the same
// mock oracle cells rather than duplicating the 152-byte layout + deploy logic.
import { deployDeps } from "../../../../game-sdk/tests/integration/devnet/deployDeps.mjs";
import { MOCK_ORACLE_IDENTITY, mockOracleCommit } from "../../../../game-sdk/tests/integration/devnet/mockOracle.mjs";

export { MOCK_ORACLE_IDENTITY, mockOracleCommit };

export const RPC = process.env.DEVNET_CKB_RPC_URL ?? process.env.WATCHER_CKB_RPC_URL ?? "http://127.0.0.1:8114";
/** Opt-in gate: the deployer key signals the devnet is wired + funded. */
export const ENABLED = Boolean(process.env.DEVNET_DEPLOYER_PRIVATE_KEY);
/** offckb genesis account #0 — funds the bootstrap and every role wallet. */
export const GENESIS_KEY = "0x6109170b275a09ad54877b82f7d9930f88cab5717d484fb4741ae9d1dd078cd6";
export const CKB = 100000000n;
// 2000 shannons/KB (2× the devnet min). `completeFeeBy` under-sizes SMALL txs (the
// signature witness is a big fraction of a tiny tx), so a 1000 rate can fall below
// the node minimum on the harness's little funding txs; the margin clears it.
export const FEE_RATE = 2000n;
/** Pyth BTC/USD feed id (arbitrary here — the mock oracle keys on it). */
export const BTC_FEED = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

const MIN_CADENCE = { "S-30s": 30n, "M-60s": 60n, "L-120s": 120n };

export function devnetSecpFromEnv() {
  return {
    codeHash: process.env.DEVNET_SECP256K1_BLAKE160_CODE_HASH,
    hashType: process.env.DEVNET_SECP256K1_BLAKE160_HASH_TYPE,
    depTxHash: process.env.DEVNET_SECP256K1_BLAKE160_DEP_TX_HASH,
    depIndex: Number(process.env.DEVNET_SECP256K1_BLAKE160_DEP_INDEX ?? 0),
    depType: process.env.DEVNET_SECP256K1_BLAKE160_DEP_TYPE,
  };
}

/** The fast nesting board, anchored at `firstCreateAt` (0 = epoch-aligned). */
export function board(feedId = BTC_FEED, firstCreateAt = 0n) {
  const base = { feedId, rakeBps: 200, asset: { kind: "ckb" }, oracleIdentity: MOCK_ORACLE_IDENTITY, firstCreateAt };
  return [
    { ...base, label: "S-30s", durationSecs: 30n, createLeadSecs: 5n },
    { ...base, label: "M-60s", durationSecs: 60n, createLeadSecs: 5n },
    { ...base, label: "L-120s", durationSecs: 120n, createLeadSecs: 10n },
  ];
}

/** One lane by label, e.g. `lane("S-30s")`. */
export function lane(label, feedId = BTC_FEED, firstCreateAt = 0n) {
  const found = board(feedId, firstCreateAt).find((l) => l.label === label);
  if (!found) throw new Error(`unknown lane ${label}; known: ${Object.keys(MIN_CADENCE).join(", ")}`);
  return found;
}

/** Send + wait for a tx (offckb confirms fast; generous timeout for CI). */
export async function send(client, signer, tx, feeRate = FEE_RATE) {
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, feeRate);
  const hash = await signer.sendTransaction(tx);
  await client.waitTransaction(hash, 0, 120000);
  return hash;
}

/** Mint a fresh, funded wallet from the genesis funder (own key → no cell contention). */
export async function fundNewWallet(client, funder, ckbAmount) {
  const priv = "0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const signer = createPrivateKeySigner(client, priv);
  const { script: lock } = await signer.getRecommendedAddressObj();
  const tx = ccc.Transaction.from({
    version: 0n, cellDeps: [], headerDeps: [], inputs: [],
    outputs: [{ lock, capacity: BigInt(ckbAmount) * CKB }], outputsData: ["0x"], witnesses: [],
  });
  await tx.completeInputsByCapacity(funder);
  await tx.completeFeeBy(funder, FEE_RATE);
  const hash = await funder.sendTransaction(tx);
  await client.waitTransaction(hash, 0, 120000);
  return { signer, lock };
}

/** The funder's first live cell — a seed input for a manual CREATE's typeID. */
export async function firstLiveCell(client, lock) {
  for await (const cell of client.findCells({ script: ccc.Script.from(lock), scriptType: "lock", scriptSearchMode: "exact" })) {
    return { previousOutput: { txHash: cell.outPoint.txHash, index: Number(cell.outPoint.index) }, since: 0n };
  }
  return undefined;
}

/**
 * Stand up client + config + clients + the genesis funder for a Mode-A run.
 * The funder doubles as the keeper/creator wallet; oracle + player get their own
 * funded wallets via {@link fundNewWallet}.
 */
export async function bootstrap() {
  const devnetSecp = devnetSecpFromEnv();
  const client = createClient("devnet", RPC, devnetSecp);
  const funder = createPrivateKeySigner(client, GENESIS_KEY);
  const { script: creatorLock } = await funder.getRecommendedAddressObj();
  const deployment = await deployDeps(client, funder);
  const config = definePoolNetworkConfig({ name: "devnet", ckbJsonRpcUrl: RPC, deployment, devnetSecp });
  const keeper = new KeeperClient({ config, cccClient: client });
  const player = new PlayerClient({ config, cccClient: client });
  return { client, funder, creatorLock, config, keeper, player, devnetSecp };
}

/** Poll `getPool(poolId)` until `pred(pool)` or timeout; returns the pool or throws. */
export async function waitForPool(keeper, poolId, pred, { timeoutMs = 60000, everyMs = 2000, label = "" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await keeper.getPool(poolId);
    if (last && pred(last)) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`waitForPool timed out ${label} (last status=${last?.data.status ?? "none"})`);
}
