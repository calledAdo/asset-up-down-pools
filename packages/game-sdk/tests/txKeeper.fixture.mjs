import test from "node:test";
import assert from "node:assert/strict";

import { ccc } from "@ckb-ccc/core";

import {
  buildActivateTx,
  buildCorrectStartTx,
  buildResolveTx,
  buildCorrectSettleTx,
  buildFinalizeTx,
  buildTransitionBatch,
} from "../dist/tx/index.js";
import {
  computeTypeId,
  poolTypeScript,
  poolAdminLockScript,
  decodeAmount,
} from "../dist/ckb/index.js";
import {
  decodePoolData,
  STATUS_OPEN,
  STATUS_LOCKED,
  STATUS_SETTLED,
  STATUS_FINALIZED,
  STATUS_VOID,
  SIDE_UP,
  SIDE_DOWN,
  SIDE_UNDECIDED,
  WINNER_VOID,
  VARIANT_CKB,
  VARIANT_XUDT,
} from "../dist/index.js";

const DEPLOY = {
  poolTypeCodeHash: "0x" + "a1".repeat(32),
  shareXudtCodeHash: "0x" + "b2".repeat(32),
  treasuryLockCodeHash: "0x" + "c3".repeat(32),
  poolAdminLockCodeHash: "0x" + "d4".repeat(32),
};
const dep = (b) => ({ outPoint: { txHash: "0x" + b.repeat(32), index: 0 }, depType: "code" });
const DEPS = { poolType: dep("e1"), shareXudt: dep("e2"), treasuryLock: dep("e3"), poolAdminLock: dep("e4") };
const SEED = { previousOutput: { txHash: "0x" + "77".repeat(32), index: 0 }, since: 0n };
const CREATOR_LOCK = { codeHash: "0x" + "f0".repeat(32), hashType: "type", args: "0x" + "0a".repeat(20) };
const ASSET_TYPE = { codeHash: "0x" + "99".repeat(32), hashType: "type", args: "0x" + "aa".repeat(32) };
const ASSET_DEP = dep("ad");
const FEED = "0x" + "fe".repeat(32);
const COMMIT = "0x" + "c0".repeat(32);
const ORACLE_DEP = dep("0c");

const lc = (s) => s.toLowerCase();
const creatorHash = ccc.Script.from(CREATOR_LOCK).hash();
const depTxs = (tx) => tx.cellDeps.map((d) => lc(d.outPoint.txHash)).sort();
const want = (...d) => d.map((x) => lc(x.outPoint.txHash)).sort();
const tick = (price, pub) => ({ feedId: FEED, price, publishTimeUnix: pub, cellDep: ORACLE_DEP });

// duration = close - start = 1000; grace = clamp(100, 60, 600) = 100; void_time = 2100.
function pool({ variant = VARIANT_CKB, status, winner = SIDE_UNDECIDED, upTotal = 100n, downTotal = 100n, startPrice = 0n, settlePrice = 0n, usedPt = 0n }) {
  const poolId = computeTypeId(SEED, 0);
  const typeScript = poolTypeScript(DEPLOY, poolId);
  return {
    poolId,
    outPoint: { txHash: "0x" + "88".repeat(32), index: 0 },
    typeScript,
    lock: poolAdminLockScript(DEPLOY, creatorHash),
    capacity: 50_000_000_000n,
    data: {
      variant,
      assetTypeHash: variant === VARIANT_XUDT ? ccc.Script.from(ASSET_TYPE).hash() : undefined,
      shareXudtCodeHash: DEPLOY.shareXudtCodeHash,
      treasuryLockCodeHash: variant === VARIANT_XUDT ? DEPLOY.treasuryLockCodeHash : undefined,
      feedId: FEED, oracleCommit: COMMIT, startTime: 1000n, closeTime: 2000n,
      upTotal, downTotal, startPrice, settlePrice, usedPt, rakeBps: 200, status, winner,
    },
  };
}
const out0 = (tx) => decodePoolData(tx.outputsData[0]);

// ---------------- ACTIVATE ----------------

test("ACTIVATE: two-sided pool, tick in (start, close) → LOCKED with start tick", () => {
  const tx = buildActivateTx({ deploy: DEPLOY, deps: DEPS, pool: pool({ status: STATUS_OPEN }), oracle: tick(105n, 1500n) });
  const pd = out0(tx);
  assert.equal(pd.status, STATUS_LOCKED);
  assert.equal(pd.startPrice, 105n);
  assert.equal(pd.usedPt, 1500n);
  assert.equal(pd.settlePrice, 0n);
  assert.equal(pd.winner, SIDE_UNDECIDED);
  assert.equal(tx.outputs[0].capacity, 50_000_000_000n); // capacity frozen
  assert.deepEqual(depTxs(tx), want(DEPS.poolType, DEPS.poolAdminLock, ORACLE_DEP));
});

test("ACTIVATE: one-sided pool proven past start → VOID", () => {
  const tx = buildActivateTx({ deploy: DEPLOY, deps: DEPS, pool: pool({ status: STATUS_OPEN, downTotal: 0n }), oracle: tick(105n, 1500n) });
  const pd = out0(tx);
  assert.equal(pd.status, STATUS_VOID);
  assert.equal(pd.winner, WINNER_VOID);
  assert.equal(pd.startPrice, 0n);
  assert.equal(pd.usedPt, 0n);
});

test("ACTIVATE: tick at/after close → VOID", () => {
  const tx = buildActivateTx({ deploy: DEPLOY, deps: DEPS, pool: pool({ status: STATUS_OPEN }), oracle: tick(105n, 2000n) });
  assert.equal(out0(tx).status, STATUS_VOID);
});

test("ACTIVATE: two-sided pool, tick at start (inclusive lower bound) → LOCKED", () => {
  const tx = buildActivateTx({ deploy: DEPLOY, deps: DEPS, pool: pool({ status: STATUS_OPEN }), oracle: tick(105n, 1000n) });
  const pd = out0(tx);
  assert.equal(pd.status, STATUS_LOCKED);
  assert.equal(pd.startPrice, 105n);
  assert.equal(pd.usedPt, 1000n);
});

test("ACTIVATE: tick before start → throws", () => {
  assert.throws(() => buildActivateTx({ deploy: DEPLOY, deps: DEPS, pool: pool({ status: STATUS_OPEN }), oracle: tick(105n, 999n) }), /not in an activatable band/);
});

// ---------------- CORRECT-START ----------------

test("CORRECT-START: earlier in-band tick replaces start price", () => {
  const tx = buildCorrectStartTx({ deploy: DEPLOY, deps: DEPS, pool: pool({ status: STATUS_LOCKED, startPrice: 105n, usedPt: 1500n }), oracle: tick(101n, 1200n) });
  const pd = out0(tx);
  assert.equal(pd.status, STATUS_LOCKED);
  assert.equal(pd.startPrice, 101n);
  assert.equal(pd.usedPt, 1200n);
});

test("CORRECT-START: tick not strictly before used_pt → throws", () => {
  assert.throws(() => buildCorrectStartTx({ deploy: DEPLOY, deps: DEPS, pool: pool({ status: STATUS_LOCKED, startPrice: 105n, usedPt: 1500n }), oracle: tick(101n, 1600n) }), /\[start, used_pt\)/);
});

// ---------------- RESOLVE ----------------

test("RESOLVE: tick in (close, void_time) → SETTLED with winner", () => {
  const tx = buildResolveTx({ deploy: DEPLOY, deps: DEPS, pool: pool({ status: STATUS_LOCKED, startPrice: 100n, usedPt: 1500n }), oracle: tick(110n, 2050n) });
  const pd = out0(tx);
  assert.equal(pd.status, STATUS_SETTLED);
  assert.equal(pd.settlePrice, 110n);
  assert.equal(pd.usedPt, 2050n);
  assert.equal(pd.winner, SIDE_UP); // 110 > 100
  assert.equal(pd.startPrice, 100n); // frozen
});

test("RESOLVE: settle below start → DOWN winner", () => {
  const tx = buildResolveTx({ deploy: DEPLOY, deps: DEPS, pool: pool({ status: STATUS_LOCKED, startPrice: 100n, usedPt: 1500n }), oracle: tick(90n, 2050n) });
  assert.equal(out0(tx).winner, SIDE_DOWN);
});

test("RESOLVE: tick at/after void_time → VOID, settle state frozen", () => {
  const tx = buildResolveTx({ deploy: DEPLOY, deps: DEPS, pool: pool({ status: STATUS_LOCKED, startPrice: 100n, settlePrice: 0n, usedPt: 1500n }), oracle: tick(90n, 2100n) });
  const pd = out0(tx);
  assert.equal(pd.status, STATUS_VOID);
  assert.equal(pd.winner, WINNER_VOID);
  assert.equal(pd.startPrice, 100n);
  assert.equal(pd.usedPt, 1500n);
});

test("RESOLVE: tick at close (inclusive lower bound) → SETTLED", () => {
  const tx = buildResolveTx({ deploy: DEPLOY, deps: DEPS, pool: pool({ status: STATUS_LOCKED, startPrice: 100n, usedPt: 1500n }), oracle: tick(90n, 2000n) });
  const pd = out0(tx);
  assert.equal(pd.status, STATUS_SETTLED);
  assert.equal(pd.settlePrice, 90n);
  assert.equal(pd.usedPt, 2000n);
  assert.equal(pd.winner, SIDE_DOWN); // 90 < 100
});

test("RESOLVE: tick before close → throws", () => {
  assert.throws(() => buildResolveTx({ deploy: DEPLOY, deps: DEPS, pool: pool({ status: STATUS_LOCKED, startPrice: 100n, usedPt: 1500n }), oracle: tick(90n, 1999n) }), /cannot resolve yet/);
});

// ---------------- CORRECT-SETTLE ----------------

test("CORRECT-SETTLE: earlier in-band tick replaces settle price + winner", () => {
  const tx = buildCorrectSettleTx({ deploy: DEPLOY, deps: DEPS, pool: pool({ status: STATUS_SETTLED, startPrice: 100n, settlePrice: 110n, usedPt: 2050n, winner: SIDE_UP }), oracle: tick(90n, 2010n) });
  const pd = out0(tx);
  assert.equal(pd.settlePrice, 90n);
  assert.equal(pd.usedPt, 2010n);
  assert.equal(pd.winner, SIDE_DOWN); // 90 < 100
});

test("CORRECT-SETTLE: tick not before used_pt → throws", () => {
  assert.throws(() => buildCorrectSettleTx({ deploy: DEPLOY, deps: DEPS, pool: pool({ status: STATUS_SETTLED, startPrice: 100n, usedPt: 2050n }), oracle: tick(90n, 2050n) }), /\[close, used_pt\)/);
});

// ---------------- FINALIZE ----------------

test("FINALIZE: tick at/after void_time latches FINALIZED, nothing else moves", () => {
  const prev = pool({ status: STATUS_SETTLED, startPrice: 100n, settlePrice: 110n, usedPt: 2050n, winner: SIDE_UP });
  const tx = buildFinalizeTx({ deploy: DEPLOY, deps: DEPS, pool: prev, oracle: tick(0n, 2100n) });
  const pd = out0(tx);
  assert.equal(pd.status, STATUS_FINALIZED);
  assert.equal(pd.startPrice, 100n);
  assert.equal(pd.settlePrice, 110n);
  assert.equal(pd.usedPt, 2050n);
  assert.equal(pd.winner, SIDE_UP);
});

test("FINALIZE: tick before void_time → throws", () => {
  assert.throws(() => buildFinalizeTx({ deploy: DEPLOY, deps: DEPS, pool: pool({ status: STATUS_SETTLED, startPrice: 100n, usedPt: 2050n }), oracle: tick(0n, 2099n) }), /has not reached void_time/);
});

// ---------------- xUDT + oracle feed guard ----------------

test("keeper transition (xUDT): treasury stays OUT of the tx; no treasury/asset deps", () => {
  const p = pool({ variant: VARIANT_XUDT, status: STATUS_OPEN });
  // No asset/treasury args at all — a transition moves no staked asset.
  const tx = buildActivateTx({ deploy: DEPLOY, deps: DEPS, pool: p, oracle: tick(105n, 1500n) });
  assert.equal(tx.inputs.length, 1); // just the PoolCell
  assert.ok(!tx.outputs.some((o) => lc(o.lock.codeHash) === lc(DEPLOY.treasuryLockCodeHash)));
  assert.deepEqual(depTxs(tx), want(DEPS.poolType, DEPS.poolAdminLock, ORACLE_DEP));
  assert.equal(out0(tx).status, STATUS_LOCKED); // transition still advances normally
});

test("keeper transition rejects an oracle tick for the wrong feed", () => {
  assert.throws(
    () => buildActivateTx({ deploy: DEPLOY, deps: DEPS, pool: pool({ status: STATUS_OPEN }), oracle: { feedId: "0x" + "11".repeat(32), price: 105n, publishTimeUnix: 1500n, cellDep: ORACLE_DEP } }),
    /does not match pool feedId/,
  );
});

// ---------------- BATCH (fold coincident transitions into one tx) ----------------

// Distinct pools (distinct typeID + outpoint), same creator lock — like one keeper's
// boundary work. computeTypeId(SEED, idx) gives a unique pool_id per index.
function poolAt(idx, opts) {
  const poolId = computeTypeId(SEED, idx);
  const base = pool(opts);
  const data = { ...base.data };
  if (opts.startTime !== undefined) data.startTime = opts.startTime;
  if (opts.closeTime !== undefined) data.closeTime = opts.closeTime;
  return {
    ...base,
    poolId,
    data,
    typeScript: poolTypeScript(DEPLOY, poolId),
    outPoint: { txHash: "0x" + "88".repeat(32), index: idx },
  };
}

test("BATCH: folds coincident RESOLVE+ACTIVATE into one tx, deps de-duplicated", () => {
  // Real boundary: resolve the round closing at 2000, activate the NEXT round
  // [2000,3000) — both read the same boundary tick (close price = next open price).
  const closing = poolAt(0, { status: STATUS_LOCKED, startPrice: 100n, usedPt: 1500n });
  const starting = poolAt(1, { status: STATUS_OPEN, startTime: 2000n, closeTime: 3000n });
  const tx = buildTransitionBatch([
    { deploy: DEPLOY, deps: DEPS, pool: closing, oracle: tick(110n, 2050n), kind: "resolve" },
    { deploy: DEPLOY, deps: DEPS, pool: starting, oracle: tick(110n, 2050n), kind: "activate" },
  ]);
  assert.equal(tx.inputs.length, 2);
  assert.equal(tx.outputs.length, 2);
  assert.equal(tx.outputsData.length, 2);
  // Two distinct PoolCells consumed.
  assert.notEqual(tx.inputs[0].previousOutput.index, tx.inputs[1].previousOutput.index);
  // Shared read-only deps collapse to: pool_type + pool_admin_lock + one oracle cell.
  assert.deepEqual(depTxs(tx), want(DEPS.poolType, DEPS.poolAdminLock, ORACLE_DEP));
  assert.equal(decodePoolData(tx.outputsData[0]).status, STATUS_SETTLED);
  assert.equal(decodePoolData(tx.outputsData[1]).status, STATUS_LOCKED);
});

test("BATCH: a one-item batch equals the single transition", () => {
  const tx = buildTransitionBatch([
    { deploy: DEPLOY, deps: DEPS, pool: poolAt(0, { status: STATUS_OPEN }), oracle: tick(105n, 1500n), kind: "activate" },
  ]);
  assert.equal(tx.inputs.length, 1);
  assert.equal(decodePoolData(tx.outputsData[0]).status, STATUS_LOCKED);
  assert.deepEqual(depTxs(tx), want(DEPS.poolType, DEPS.poolAdminLock, ORACLE_DEP));
});

test("BATCH: same feed via two different oracle cells → rejected (find_oracle ambiguity)", () => {
  assert.throws(
    () =>
      buildTransitionBatch([
        { deploy: DEPLOY, deps: DEPS, pool: poolAt(0, { status: STATUS_LOCKED, startPrice: 100n, usedPt: 1500n }), oracle: tick(110n, 2050n), kind: "resolve" },
        { deploy: DEPLOY, deps: DEPS, pool: poolAt(1, { status: STATUS_OPEN }), oracle: { feedId: FEED, price: 110n, publishTimeUnix: 2050n, cellDep: dep("0d") }, kind: "activate" },
      ]),
    /ambiguous/,
  );
});

test("BATCH: empty batch throws", () => {
  assert.throws(() => buildTransitionBatch([]), /empty batch/);
});
