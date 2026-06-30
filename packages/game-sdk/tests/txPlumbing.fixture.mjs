import test from "node:test";
import assert from "node:assert/strict";

import { ccc } from "@ckb-ccc/core";

import {
  assertTickForPool,
  attachCodeDep,
  attachPoolTypeDep,
  attachShareDep,
  attachTreasuryDep,
  attachPoolAdminDep,
  attachOracleTick,
} from "../dist/tx/index.js";

const POOL_TYPE_DEP = {
  outPoint: { txHash: "0x" + "a1".repeat(32), index: 0 },
  depType: "code",
};
const SHARE_DEP = {
  outPoint: { txHash: "0x" + "b2".repeat(32), index: 1 },
  depType: "code",
};
const DEPS = { poolType: POOL_TYPE_DEP, shareXudt: SHARE_DEP };

const TICK = {
  feedId: "0x" + "cc".repeat(32),
  price: 123n,
  publishTimeUnix: 1_700_000_000n,
  cellDep: { outPoint: { txHash: "0x" + "ee".repeat(32), index: 0 }, depType: "code" },
};

function emptyTx() {
  return ccc.Transaction.from({
    version: 0n,
    cellDeps: [],
    headerDeps: [],
    inputs: [],
    outputs: [],
    outputsData: [],
    witnesses: [],
  });
}

test("assertTickForPool accepts a matching feed (case-insensitive)", () => {
  assert.doesNotThrow(() =>
    assertTickForPool(TICK, { feedId: TICK.feedId.toUpperCase() }),
  );
});

test("assertTickForPool rejects a feed mismatch", () => {
  assert.throws(
    () => assertTickForPool(TICK, { feedId: "0x" + "dd".repeat(32) }),
    /does not match pool feedId/,
  );
});

test("attachCodeDep adds the dep once and de-duplicates", () => {
  const tx = emptyTx();
  attachCodeDep(tx, POOL_TYPE_DEP);
  attachCodeDep(tx, POOL_TYPE_DEP);
  assert.equal(tx.cellDeps.length, 1);
  assert.equal(tx.cellDeps[0].outPoint.txHash, POOL_TYPE_DEP.outPoint.txHash);
  assert.equal(tx.cellDeps[0].depType, "code");
});

test("pool-type and share deps attach distinctly", () => {
  const tx = emptyTx();
  attachPoolTypeDep(tx, DEPS);
  attachShareDep(tx, DEPS);
  assert.equal(tx.cellDeps.length, 2);
});

test("treasury / pool-admin deps throw when the deployment omits them", () => {
  const tx = emptyTx();
  assert.throws(() => attachTreasuryDep(tx, DEPS), /treasuryLock/);
  assert.throws(() => attachPoolAdminDep(tx, DEPS), /poolAdminLock/);
});

test("treasury / pool-admin deps attach when present", () => {
  const tx = emptyTx();
  const full = {
    ...DEPS,
    treasuryLock: { outPoint: { txHash: "0x" + "c3".repeat(32), index: 0 }, depType: "code" },
    poolAdminLock: { outPoint: { txHash: "0x" + "d4".repeat(32), index: 0 }, depType: "code" },
  };
  attachTreasuryDep(tx, full);
  attachPoolAdminDep(tx, full);
  assert.equal(tx.cellDeps.length, 2);
});

test("attachOracleTick attaches the oracle cell as a read dep", () => {
  const tx = emptyTx();
  attachOracleTick(tx, TICK);
  assert.equal(tx.cellDeps.length, 1);
  assert.equal(tx.cellDeps[0].outPoint.txHash, TICK.cellDep.outPoint.txHash);
});
