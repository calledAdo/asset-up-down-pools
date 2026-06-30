import test from "node:test";
import assert from "node:assert/strict";

import { KeeperClient, PlayerClient, PoolReaderClient, VARIANT_CKB } from "../dist/index.js";
import {
  toPoolDeployment,
  toPoolCodeDeps,
  configForPoolTypeVersion,
  definePoolNetworkConfig,
} from "../dist/presets/index.js";
import { computeTypeId } from "../dist/ckb/index.js";

const dep = (b) => ({ outPoint: { txHash: "0x" + b.repeat(32), index: 0 }, depType: "code" });
const ref = (h, d) => ({ codeHash: "0x" + h.repeat(32), codeDep: dep(d) });

const CONFIG = definePoolNetworkConfig({
  name: "devnet",
  ckbJsonRpcUrl: "http://127.0.0.1:8114",
  deployment: {
    poolType: ref("a1", "e1"),
    shareXudt: ref("b2", "e2"),
    treasuryLock: ref("c3", "e3"),
    poolAdminLock: ref("d4", "e4"),
    poolTypeVersions: { 1: ref("a1", "e1"), 2: ref("aa", "ee") },
  },
});

const lc = (s) => s.toLowerCase();
const SEED = { previousOutput: { txHash: "0x" + "77".repeat(32), index: 0 }, since: 0n };
const CREATOR_LOCK = { codeHash: "0x" + "f0".repeat(32), hashType: "type", args: "0x" + "0a".repeat(20) };
const FEED = "0x" + "fe".repeat(32);
const COMMIT = "0x" + "c0".repeat(32);
// draftCreate is synchronous and never touches the client; a stub is enough.
const stubClient = {};

test("toPoolDeployment maps refs to code hashes", () => {
  const d = toPoolDeployment(CONFIG.deployment);
  assert.equal(lc(d.poolTypeCodeHash), "0x" + "a1".repeat(32));
  assert.equal(lc(d.shareXudtCodeHash), "0x" + "b2".repeat(32));
  assert.equal(lc(d.treasuryLockCodeHash), "0x" + "c3".repeat(32));
  assert.equal(lc(d.poolAdminLockCodeHash), "0x" + "d4".repeat(32));
});

test("toPoolCodeDeps maps refs to cell deps", () => {
  const deps = toPoolCodeDeps(CONFIG.deployment);
  assert.equal(lc(deps.poolType.outPoint.txHash), "0x" + "e1".repeat(32));
  assert.equal(lc(deps.shareXudt.outPoint.txHash), "0x" + "e2".repeat(32));
});

test("configForPoolTypeVersion pins pool_type, or throws on a missing version", () => {
  const v2 = configForPoolTypeVersion(CONFIG, 2);
  assert.equal(lc(v2.deployment.poolType.codeHash), "0x" + "aa".repeat(32));
  // other scripts untouched
  assert.equal(lc(v2.deployment.shareXudt.codeHash), "0x" + "b2".repeat(32));
  assert.throws(() => configForPoolTypeVersion(CONFIG, 9), /version 9 not found/);
});

test("clients derive deploy + deps from the config", () => {
  const keeper = new KeeperClient({ config: CONFIG, cccClient: stubClient });
  assert.equal(lc(keeper.deploy.poolTypeCodeHash), "0x" + "a1".repeat(32));
  assert.equal(lc(keeper.deps.poolAdminLock.outPoint.txHash), "0x" + "e4".repeat(32));
  assert.ok(keeper instanceof PoolReaderClient);
});

test("KeeperClient.draftCreate builds a CREATE tx with the config's deps and no header dep", async () => {
  const keeper = new KeeperClient({ config: CONFIG, cccClient: stubClient });
  const tx = await keeper.draftCreate({
    seedInput: SEED, creatorLock: CREATOR_LOCK, asset: { kind: "ckb" },
    feedId: FEED, oracleCommit: COMMIT, startTime: 1000n, closeTime: 2000n, rakeBps: 100,
  });
  assert.equal(lc(tx.outputs[0].type.args), lc(computeTypeId(SEED, 0)));
  assert.equal(lc(tx.outputs[0].type.codeHash), "0x" + "a1".repeat(32));
  assert.deepEqual(tx.cellDeps.map((d) => lc(d.outPoint.txHash)), ["0x" + "e1".repeat(32)]);
  assert.deepEqual(tx.headerDeps, []);
});

test("listManagedPools requires operatorLockHashes, then queries by pool_admin_lock", async () => {
  // No operatorLockHashes configured -> throws.
  const reader0 = new PoolReaderClient({ config: CONFIG, cccClient: {} });
  await assert.rejects(() => reader0.listManagedPools(), /operatorLockHashes/);

  // Configured -> one lock-scoped query per hash, against pool_admin_lock(hash).
  const H1 = "0x" + "11".repeat(32);
  const H2 = "0x" + "22".repeat(32);
  const calls = [];
  const fake = { async *findCells(q) { calls.push(q); /* yield no cells */ } };
  const cfg = definePoolNetworkConfig({ ...CONFIG, operatorLockHashes: [H1, H2] });
  const reader = new PoolReaderClient({ config: cfg, cccClient: fake });

  assert.deepEqual(await reader.listManagedPools(), []);
  assert.equal(calls.length, 2);
  for (const q of calls) {
    assert.equal(q.scriptType, "lock");
    assert.equal(q.scriptSearchMode, "exact");
    assert.equal(lc(q.script.codeHash), "0x" + "d4".repeat(32)); // poolAdminLock code hash
  }
  assert.deepEqual(calls.map((q) => lc(q.script.args)).sort(), [lc(H1), lc(H2)].sort());
});

test("PlayerClient exposes drafts + inherited reads", () => {
  const player = new PlayerClient({ config: CONFIG, cccClient: stubClient });
  assert.equal(typeof player.draftDeposit, "function");
  assert.equal(typeof player.draftRedeem, "function");
  assert.equal(typeof player.getPool, "function");
  assert.equal(typeof player.listPools, "function");
  assert.ok(player instanceof PoolReaderClient);
});
