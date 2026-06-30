//! Opt-in devnet integration test: build a CKB pool via the SDK, broadcast it to
//! a live offckb devnet, and read it back. This VM-verifies CREATE (typeID seed,
//! capacity, pool_type cell-dep) and the read layer end-to-end against
//! the real on-chain scripts — the no-oracle path that needs no Lean Oracle.
//!
//! Run from packages/game-sdk with the deployer env loaded:
//!   node --env-file=../../deployment/.env tests/integration/devnet/create-readback.test.mjs
//!
//! Requires: a running offckb devnet with the four scripts deployed (artifacts in
//! deployment/artifacts/devnet.*.json) and a funded DEVNET_DEPLOYER_PRIVATE_KEY.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ccc } from "@ckb-ccc/core";

import {
  KeeperClient,
  createClient,
  createPrivateKeySigner,
  computeTypeId,
  definePoolNetworkConfig,
  STATUS_OPEN,
  SIDE_UNDECIDED,
  VARIANT_CKB,
} from "../../../dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.resolve(here, "../../../../../deployment/artifacts");

function loadScriptRef(family) {
  const j = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, `devnet.${family}.json`), "utf8"));
  const versions = j.deployment.versions;
  const latest = Math.max(...Object.keys(versions).map(Number));
  const v = versions[latest];
  return {
    codeHash: v.codeHash,
    codeDep: { outPoint: { txHash: v.txHash, index: v.index }, depType: v.depType },
  };
}

const RPC = process.env.DEVNET_CKB_RPC_URL ?? "http://127.0.0.1:8114";
const KEY = process.env.DEVNET_DEPLOYER_PRIVATE_KEY;

const config = definePoolNetworkConfig({
  name: "devnet",
  ckbJsonRpcUrl: RPC,
  deployment: {
    poolType: loadScriptRef("pool-type"),
    shareXudt: loadScriptRef("share-xudt"),
    treasuryLock: loadScriptRef("treasury-lock"),
    poolAdminLock: loadScriptRef("pool-admin-lock"),
  },
  devnetSecp: {
    codeHash: process.env.DEVNET_SECP256K1_BLAKE160_CODE_HASH,
    hashType: process.env.DEVNET_SECP256K1_BLAKE160_HASH_TYPE,
    depTxHash: process.env.DEVNET_SECP256K1_BLAKE160_DEP_TX_HASH,
    depIndex: Number(process.env.DEVNET_SECP256K1_BLAKE160_DEP_INDEX ?? 0),
    depType: process.env.DEVNET_SECP256K1_BLAKE160_DEP_TYPE,
  },
});

test("CREATE a CKB pool on devnet and read it back", async (t) => {
  if (!KEY) return t.skip("DEVNET_DEPLOYER_PRIVATE_KEY not set");

  const client = createClient("devnet", RPC, config.devnetSecp);
  const signer = createPrivateKeySigner(client, KEY);
  const { script: lock } = await signer.getRecommendedAddressObj();

  // Pick a seed input — the deployer's first live cell — to seed the typeID.
  let seedOutPoint;
  for await (const cell of client.findCells({ script: ccc.Script.from(lock), scriptType: "lock", scriptSearchMode: "exact" })) {
    seedOutPoint = cell.outPoint;
    break;
  }
  assert.ok(seedOutPoint, "deployer has no live cells to seed the pool");
  const seedInput = { previousOutput: { txHash: seedOutPoint.txHash, index: Number(seedOutPoint.index) }, since: 0n };

  // Future boundaries relative to the chain's clock.
  const nowSec = (await client.getTipHeader()).timestamp / 1000n;
  const startTime = nowSec + 3600n;
  const closeTime = nowSec + 7200n;

  const keeper = new KeeperClient({ config, cccClient: client });
  const feedId = "0x" + "fe".repeat(32);
  const oracleCommit = "0x" + "c0".repeat(32);

  const tx = await keeper.draftCreate({
    seedInput,
    creatorLock: lock,
    asset: { kind: "ckb" },
    feedId,
    oracleCommit,
    startTime,
    closeTime,
    rakeBps: 200,
  });

  await keeper.complete(tx, signer, { feeRate: 1000n });
  const txHash = await signer.sendTransaction(tx);
  await client.waitTransaction(txHash, 0, 120000);

  // Read it back through the SDK and verify the decoded PoolData.
  const poolId = computeTypeId(seedInput, 0);
  const pool = await keeper.getPool(poolId);
  assert.ok(pool, "created pool not found by getPool");
  assert.equal(pool.data.variant, VARIANT_CKB);
  assert.equal(pool.data.status, STATUS_OPEN);
  assert.equal(pool.data.winner, SIDE_UNDECIDED);
  assert.equal(pool.data.upTotal, 0n);
  assert.equal(pool.data.downTotal, 0n);
  assert.equal(pool.data.startTime, startTime);
  assert.equal(pool.data.closeTime, closeTime);
  assert.equal(pool.data.feedId.toLowerCase(), feedId);
  assert.equal(pool.data.rakeBps, 200);

  console.log(`created + read back pool ${poolId} (tx ${txHash})`);
});
