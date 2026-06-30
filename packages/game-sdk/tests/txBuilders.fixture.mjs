import test from "node:test";
import assert from "node:assert/strict";

import { ccc } from "@ckb-ccc/core";

import {
  decodePoolData,
  VARIANT_CKB,
  VARIANT_XUDT,
  STATUS_OPEN,
  SIDE_UP,
  SIDE_DOWN,
} from "../dist/index.js";
import { buildCreatePoolTx, buildDepositTx, buildWithdrawTx } from "../dist/tx/index.js";
import {
  computeTypeId,
  poolTypeScript,
  poolAdminLockScript,
  shareScript,
  treasuryLockScript,
  decodeAmount,
  encodeAmount,
} from "../dist/ckb/index.js";

const DEPLOY = {
  poolTypeCodeHash: "0x" + "a1".repeat(32),
  shareXudtCodeHash: "0x" + "b2".repeat(32),
  treasuryLockCodeHash: "0x" + "c3".repeat(32),
  poolAdminLockCodeHash: "0x" + "d4".repeat(32),
};
const dep = (b, idx = 0) => ({ outPoint: { txHash: "0x" + b.repeat(32), index: idx }, depType: "code" });
const DEPS = {
  poolType: dep("e1"),
  shareXudt: dep("e2"),
  treasuryLock: dep("e3"),
  poolAdminLock: dep("e4"),
};

const SEED = { previousOutput: { txHash: "0x" + "77".repeat(32), index: 0 }, since: 0n };
const CREATOR_LOCK = { codeHash: "0x" + "f0".repeat(32), hashType: "type", args: "0x" + "0a".repeat(20) };
const DEPOSITOR_LOCK = { codeHash: "0x" + "ee".repeat(32), hashType: "type", args: "0x" + "12".repeat(20) };
const ASSET_TYPE = { codeHash: "0x" + "99".repeat(32), hashType: "type", args: "0x" + "aa".repeat(32) };
const ASSET_DEP = dep("ad");

const FEED = "0x" + "fe".repeat(32);
const COMMIT = "0x" + "c0".repeat(32);

const lc = (s) => s.toLowerCase();
const creatorHash = lc(ccc.Script.from(CREATOR_LOCK).hash());
const depTxs = (tx) => tx.cellDeps.map((d) => lc(d.outPoint.txHash));

function findByType(tx, codeHash) {
  const out = [];
  tx.outputs.forEach((o, i) => {
    if (o.type && lc(o.type.codeHash) === lc(codeHash)) out.push({ o, i });
  });
  return out;
}

// ---------------- CREATE (CKB) ----------------

test("CREATE (CKB): single PoolCell output seeded by the typeID", () => {
  const tx = buildCreatePoolTx({
    deploy: DEPLOY, deps: DEPS, seedInput: SEED, creatorLock: CREATOR_LOCK,
    variant: VARIANT_CKB, feedId: FEED, oracleCommit: COMMIT,
    startTime: 1000n, closeTime: 2000n, rakeBps: 200,
  });

  assert.equal(tx.inputs.length, 1);
  assert.equal(lc(tx.inputs[0].previousOutput.txHash), lc(SEED.previousOutput.txHash));
  assert.equal(tx.outputs.length, 1);

  const expectedId = computeTypeId(SEED, 0);
  assert.equal(lc(tx.outputs[0].type.args), lc(expectedId));
  assert.equal(lc(tx.outputs[0].type.codeHash), lc(DEPLOY.poolTypeCodeHash));
  assert.equal(tx.outputs[0].type.hashType, "data2");
  assert.equal(lc(tx.outputs[0].lock.codeHash), lc(DEPLOY.poolAdminLockCodeHash));
  assert.equal(lc(tx.outputs[0].lock.args), creatorHash);

  const pd = decodePoolData(tx.outputsData[0]);
  assert.equal(pd.variant, VARIANT_CKB);
  assert.equal(pd.status, STATUS_OPEN);
  assert.equal(pd.upTotal, 0n);
  assert.equal(pd.downTotal, 0n);
  assert.equal(pd.startTime, 1000n);
  assert.equal(pd.closeTime, 2000n);
  assert.equal(pd.rakeBps, 200);
  assert.equal(lc(pd.feedId), lc(FEED));
  assert.equal(lc(pd.shareXudtCodeHash), lc(DEPLOY.shareXudtCodeHash));
  assert.equal(pd.assetTypeHash, undefined);

  assert.deepEqual(depTxs(tx), [lc(DEPS.poolType.outPoint.txHash)]);
});

test("CREATE rejects start >= close and unknown variant", () => {
  const base = {
    deploy: DEPLOY, deps: DEPS, seedInput: SEED, creatorLock: CREATOR_LOCK,
    feedId: FEED, oracleCommit: COMMIT, rakeBps: 0,
  };
  assert.throws(() => buildCreatePoolTx({ ...base, variant: VARIANT_CKB, startTime: 2000n, closeTime: 2000n }), /closeTime/);
  assert.throws(() => buildCreatePoolTx({ ...base, variant: 7, startTime: 1n, closeTime: 2n }), /variant/);
});

// ---------------- CREATE (xUDT) ----------------

test("CREATE (xUDT): PoolCell + zero TreasuryCell", () => {
  const tx = buildCreatePoolTx({
    deploy: DEPLOY, deps: DEPS, seedInput: SEED, creatorLock: CREATOR_LOCK,
    variant: VARIANT_XUDT, assetType: ASSET_TYPE, assetTypeDep: ASSET_DEP,
    feedId: FEED, oracleCommit: COMMIT, startTime: 1000n, closeTime: 2000n, rakeBps: 50,
  });

  assert.equal(tx.outputs.length, 2);
  const poolId = computeTypeId(SEED, 0);
  const poolTypeHash = lc(ccc.Script.from(poolTypeScript(DEPLOY, poolId)).hash());

  // Treasury at output[1]: treasury_lock(args=poolTypeHash), asset type, balance 0.
  const tre = tx.outputs[1];
  assert.equal(lc(tre.lock.codeHash), lc(DEPLOY.treasuryLockCodeHash));
  assert.equal(lc(tre.lock.args), poolTypeHash);
  assert.equal(lc(tre.type.codeHash), lc(ASSET_TYPE.codeHash));
  assert.equal(decodeAmount(tx.outputsData[1]), 0n);

  const pd = decodePoolData(tx.outputsData[0]);
  assert.equal(pd.variant, VARIANT_XUDT);
  assert.equal(lc(pd.assetTypeHash), lc(ccc.Script.from(ASSET_TYPE).hash()));
  assert.equal(lc(pd.treasuryLockCodeHash), lc(DEPLOY.treasuryLockCodeHash));

  assert.deepEqual(
    depTxs(tx).sort(),
    [lc(DEPS.poolType.outPoint.txHash), lc(ASSET_DEP.outPoint.txHash)].sort(),
  );
});

test("CREATE (xUDT) requires assetType and assetTypeDep", () => {
  assert.throws(
    () => buildCreatePoolTx({
      deploy: DEPLOY, deps: DEPS, seedInput: SEED, creatorLock: CREATOR_LOCK,
      variant: VARIANT_XUDT, feedId: FEED, oracleCommit: COMMIT,
      startTime: 1n, closeTime: 2n, rakeBps: 0,
    }),
    /assetType/,
  );
});

// ---------------- DEPOSIT (CKB) ----------------

function ckbPool() {
  const poolId = computeTypeId(SEED, 0);
  const typeScript = poolTypeScript(DEPLOY, poolId);
  return {
    poolId,
    outPoint: { txHash: "0x" + "88".repeat(32), index: 0 },
    typeScript,
    lock: poolAdminLockScript(DEPLOY, ccc.Script.from(CREATOR_LOCK).hash()),
    capacity: 20_000_000_000n,
    data: {
      variant: VARIANT_CKB, shareXudtCodeHash: DEPLOY.shareXudtCodeHash,
      feedId: FEED, oracleCommit: COMMIT, startTime: 1000n, closeTime: 2000n,
      upTotal: 0n, downTotal: 0n, startPrice: 0n, settlePrice: 0n, usedPt: 0n,
      rakeBps: 200, status: STATUS_OPEN, winner: 0,
    },
  };
}

test("DEPOSIT (CKB): grows PoolCell capacity by total and mints both sides", () => {
  const pool = ckbPool();
  const tx = buildDepositTx({
    deploy: DEPLOY, deps: DEPS, pool, depositorLock: DEPOSITOR_LOCK,
    upAmount: 100n, downAmount: 50n,
  });

  assert.equal(lc(tx.inputs[0].previousOutput.txHash), lc(pool.outPoint.txHash));
  assert.equal(tx.outputs[0].capacity, pool.capacity + 150n);

  const pd = decodePoolData(tx.outputsData[0]);
  assert.equal(pd.upTotal, 100n);
  assert.equal(pd.downTotal, 50n);

  const poolTypeHash = ccc.Script.from(pool.typeScript).hash();
  const shares = findByType(tx, DEPLOY.shareXudtCodeHash);
  assert.equal(shares.length, 2);
  const up = shares.find(({ o }) => lc(o.type.args) === lc(shareScript(DEPLOY, poolTypeHash, SIDE_UP).args));
  const down = shares.find(({ o }) => lc(o.type.args) === lc(shareScript(DEPLOY, poolTypeHash, SIDE_DOWN).args));
  assert.equal(decodeAmount(tx.outputsData[up.i]), 100n);
  assert.equal(decodeAmount(tx.outputsData[down.i]), 50n);
  assert.equal(lc(up.o.lock.codeHash), lc(DEPOSITOR_LOCK.codeHash));

  assert.deepEqual(
    depTxs(tx).sort(),
    [DEPS.poolType, DEPS.poolAdminLock, DEPS.shareXudt].map((d) => lc(d.outPoint.txHash)).sort(),
  );
});

test("DEPOSIT (CKB): one-sided deposit mints only that side", () => {
  const tx = buildDepositTx({ deploy: DEPLOY, deps: DEPS, pool: ckbPool(), depositorLock: DEPOSITOR_LOCK, upAmount: 0n, downAmount: 70n });
  assert.equal(findByType(tx, DEPLOY.shareXudtCodeHash).length, 1);
  assert.equal(tx.outputs[0].capacity, ckbPool().capacity + 70n);
});

test("DEPOSIT rejects a zero-total deposit and a non-OPEN pool", () => {
  assert.throws(
    () => buildDepositTx({ deploy: DEPLOY, deps: DEPS, pool: ckbPool(), depositorLock: DEPOSITOR_LOCK, upAmount: 0n, downAmount: 0n }),
    /positive/,
  );
  const locked = ckbPool();
  locked.data.status = 1; // STATUS_LOCKED
  assert.throws(
    () => buildDepositTx({ deploy: DEPLOY, deps: DEPS, pool: locked, depositorLock: DEPOSITOR_LOCK, upAmount: 1n, downAmount: 0n }),
    /OPEN pool/,
  );
});

// ---------------- DEPOSIT (xUDT) ----------------

function xudtPool() {
  const poolId = computeTypeId(SEED, 0);
  const typeScript = poolTypeScript(DEPLOY, poolId);
  return {
    poolId,
    outPoint: { txHash: "0x" + "88".repeat(32), index: 0 },
    typeScript,
    lock: poolAdminLockScript(DEPLOY, ccc.Script.from(CREATOR_LOCK).hash()),
    capacity: 18_000_000_000n,
    data: {
      variant: VARIANT_XUDT, assetTypeHash: ccc.Script.from(ASSET_TYPE).hash(),
      shareXudtCodeHash: DEPLOY.shareXudtCodeHash, treasuryLockCodeHash: DEPLOY.treasuryLockCodeHash,
      feedId: FEED, oracleCommit: COMMIT, startTime: 1000n, closeTime: 2000n,
      upTotal: 0n, downTotal: 0n, startPrice: 0n, settlePrice: 0n, usedPt: 0n,
      rakeBps: 200, status: STATUS_OPEN, winner: 0,
    },
  };
}

test("DEPOSIT (xUDT): grows treasury, returns asset change, keeps PoolCell capacity", () => {
  const pool = xudtPool();
  const treasury = { outPoint: { txHash: "0x" + "99".repeat(32), index: 0 }, capacity: 14_200_000_000n, balance: 500n };
  const assetInputs = [{ outPoint: { txHash: "0x" + "55".repeat(32), index: 0 }, amount: 1000n }];

  const tx = buildDepositTx({
    deploy: DEPLOY, deps: DEPS, pool, depositorLock: DEPOSITOR_LOCK,
    upAmount: 100n, downAmount: 50n,
    assetType: ASSET_TYPE, assetTypeDep: ASSET_DEP, treasury, assetInputs,
  });

  assert.equal(tx.outputs[0].capacity, pool.capacity); // PoolCell capacity unchanged

  const poolTypeHash = lc(ccc.Script.from(pool.typeScript).hash());
  const tre = tx.outputs.find((o) => lc(o.lock.codeHash) === lc(DEPLOY.treasuryLockCodeHash) && lc(o.lock.args) === poolTypeHash);
  const treIdx = tx.outputs.indexOf(tre);
  assert.equal(decodeAmount(tx.outputsData[treIdx]), 650n); // 500 + 150

  // change = 1000 - 150 = 850, to depositor, of the asset type
  const change = tx.outputs.find((o, i) => lc(o.lock.codeHash) === lc(DEPOSITOR_LOCK.codeHash) && o.type && lc(o.type.codeHash) === lc(ASSET_TYPE.codeHash));
  const changeIdx = tx.outputs.indexOf(change);
  assert.equal(decodeAmount(tx.outputsData[changeIdx]), 850n);

  const want = [DEPS.poolType, DEPS.poolAdminLock, DEPS.shareXudt, DEPS.treasuryLock, ASSET_DEP];
  assert.deepEqual(depTxs(tx).sort(), want.map((d) => lc(d.outPoint.txHash)).sort());
});

test("DEPOSIT (xUDT): exact funding produces no change cell", () => {
  const pool = xudtPool();
  const tx = buildDepositTx({
    deploy: DEPLOY, deps: DEPS, pool, depositorLock: DEPOSITOR_LOCK,
    upAmount: 100n, downAmount: 50n, assetType: ASSET_TYPE, assetTypeDep: ASSET_DEP,
    treasury: { outPoint: { txHash: "0x" + "99".repeat(32), index: 0 }, capacity: 14_200_000_000n, balance: 0n },
    assetInputs: [{ outPoint: { txHash: "0x" + "55".repeat(32), index: 0 }, amount: 150n }],
  });
  // outputs: pool, up share, down share, treasury — no change cell
  const changeCells = tx.outputs.filter((o) => lc(o.lock.codeHash) === lc(DEPOSITOR_LOCK.codeHash) && o.type && lc(o.type.codeHash) === lc(ASSET_TYPE.codeHash));
  assert.equal(changeCells.length, 0);
});

test("DEPOSIT (xUDT) rejects underfunded asset inputs and missing pieces", () => {
  const pool = xudtPool();
  const treasury = { outPoint: { txHash: "0x" + "99".repeat(32), index: 0 }, capacity: 14_200_000_000n, balance: 0n };
  assert.throws(
    () => buildDepositTx({ deploy: DEPLOY, deps: DEPS, pool, depositorLock: DEPOSITOR_LOCK, upAmount: 100n, downAmount: 50n, assetType: ASSET_TYPE, assetTypeDep: ASSET_DEP, treasury, assetInputs: [{ outPoint: { txHash: "0x" + "55".repeat(32), index: 0 }, amount: 10n }] }),
    /do not cover/,
  );
  assert.throws(
    () => buildDepositTx({ deploy: DEPLOY, deps: DEPS, pool, depositorLock: DEPOSITOR_LOCK, upAmount: 100n, downAmount: 50n }),
    /xUDT deposit requires/,
  );
});

// ---------------- WITHDRAW (CKB) ----------------

// A CKB pool already holding funded totals, so stake can be pulled back out.
function ckbFundedPool(up = 100n, down = 50n) {
  const p = ckbPool();
  p.data.upTotal = up;
  p.data.downTotal = down;
  // PoolCell capacity carries an occupied base plus the staked total.
  p.capacity = 20_000_000_000n + up + down;
  return p;
}

const sIn = (b, side, amount, idx = 0) => ({ outPoint: { txHash: "0x" + b.repeat(32), index: idx }, side, amount });

test("WITHDRAW (CKB): exact burn shrinks PoolCell capacity by total, no share change", () => {
  const pool = ckbFundedPool(100n, 50n);
  const tx = buildWithdrawTx({
    deploy: DEPLOY, deps: DEPS, pool, withdrawerLock: DEPOSITOR_LOCK,
    upAmount: 100n, downAmount: 50n,
    shareInputs: [sIn("a1", SIDE_UP, 100n), sIn("a2", SIDE_DOWN, 50n)],
  });

  assert.equal(lc(tx.inputs[0].previousOutput.txHash), lc(pool.outPoint.txHash));
  assert.equal(tx.inputs.length, 3); // pool + 2 burned share cells
  assert.equal(tx.outputs[0].capacity, pool.capacity - 150n);

  const pd = decodePoolData(tx.outputsData[0]);
  assert.equal(pd.upTotal, 0n);
  assert.equal(pd.downTotal, 0n);

  // exact burn => no share-change output
  assert.equal(findByType(tx, DEPLOY.shareXudtCodeHash).length, 0);

  assert.deepEqual(
    depTxs(tx).sort(),
    [DEPS.poolType, DEPS.poolAdminLock, DEPS.shareXudt].map((d) => lc(d.outPoint.txHash)).sort(),
  );
});

test("WITHDRAW (CKB): partial burn returns a per-side share-change cell", () => {
  const pool = ckbFundedPool(100n, 50n);
  const tx = buildWithdrawTx({
    deploy: DEPLOY, deps: DEPS, pool, withdrawerLock: DEPOSITOR_LOCK,
    upAmount: 30n, downAmount: 0n,
    shareInputs: [sIn("a1", SIDE_UP, 100n)],
  });

  assert.equal(tx.outputs[0].capacity, pool.capacity - 30n);
  const pd = decodePoolData(tx.outputsData[0]);
  assert.equal(pd.upTotal, 70n);
  assert.equal(pd.downTotal, 50n);

  const poolTypeHash = ccc.Script.from(pool.typeScript).hash();
  const shares = findByType(tx, DEPLOY.shareXudtCodeHash);
  assert.equal(shares.length, 1); // one UP change cell of 100 - 30 = 70
  const up = shares.find(({ o }) => lc(o.type.args) === lc(shareScript(DEPLOY, poolTypeHash, SIDE_UP).args));
  assert.equal(decodeAmount(tx.outputsData[up.i]), 70n);
  assert.equal(lc(up.o.lock.codeHash), lc(DEPOSITOR_LOCK.codeHash));
});

test("WITHDRAW rejects pulling more than a side's total", () => {
  assert.throws(
    () => buildWithdrawTx({ deploy: DEPLOY, deps: DEPS, pool: ckbFundedPool(100n, 50n), withdrawerLock: DEPOSITOR_LOCK, upAmount: 200n, downAmount: 0n, shareInputs: [sIn("a1", SIDE_UP, 200n)] }),
    /exceeds side totals/,
  );
});

test("WITHDRAW rejects share inputs that don't cover the amount", () => {
  assert.throws(
    () => buildWithdrawTx({ deploy: DEPLOY, deps: DEPS, pool: ckbFundedPool(100n, 50n), withdrawerLock: DEPOSITOR_LOCK, upAmount: 80n, downAmount: 0n, shareInputs: [sIn("a1", SIDE_UP, 50n)] }),
    /do not cover/,
  );
});

test("WITHDRAW rejects a zero-total withdrawal and a non-OPEN pool", () => {
  assert.throws(
    () => buildWithdrawTx({ deploy: DEPLOY, deps: DEPS, pool: ckbFundedPool(100n, 50n), withdrawerLock: DEPOSITOR_LOCK, upAmount: 0n, downAmount: 0n, shareInputs: [] }),
    /positive/,
  );
  const locked = ckbFundedPool(100n, 50n);
  locked.data.status = 1; // STATUS_LOCKED
  assert.throws(
    () => buildWithdrawTx({ deploy: DEPLOY, deps: DEPS, pool: locked, withdrawerLock: DEPOSITOR_LOCK, upAmount: 10n, downAmount: 0n, shareInputs: [sIn("a1", SIDE_UP, 10n)] }),
    /OPEN pool/,
  );
});

// ---------------- WITHDRAW (xUDT) ----------------

function xudtFundedPool(up = 100n, down = 50n) {
  const p = xudtPool();
  p.data.upTotal = up;
  p.data.downTotal = down;
  return p;
}

test("WITHDRAW (xUDT): shrinks treasury by total, pays the asset out, keeps PoolCell capacity", () => {
  const pool = xudtFundedPool(100n, 50n);
  const treasury = { outPoint: { txHash: "0x" + "99".repeat(32), index: 0 }, capacity: 14_200_000_000n, balance: 150n };

  const tx = buildWithdrawTx({
    deploy: DEPLOY, deps: DEPS, pool, withdrawerLock: DEPOSITOR_LOCK,
    upAmount: 100n, downAmount: 50n,
    shareInputs: [sIn("a1", SIDE_UP, 100n), sIn("a2", SIDE_DOWN, 50n)],
    assetType: ASSET_TYPE, assetTypeDep: ASSET_DEP, treasury,
  });

  assert.equal(tx.outputs[0].capacity, pool.capacity); // PoolCell capacity unchanged

  const poolTypeHash = lc(ccc.Script.from(pool.typeScript).hash());
  const tre = tx.outputs.find((o) => lc(o.lock.codeHash) === lc(DEPLOY.treasuryLockCodeHash) && lc(o.lock.args) === poolTypeHash);
  const treIdx = tx.outputs.indexOf(tre);
  assert.equal(decodeAmount(tx.outputsData[treIdx]), 0n); // 150 - 150

  // payout = 150 to the withdrawer, of the asset type
  const payout = tx.outputs.find((o) => lc(o.lock.codeHash) === lc(DEPOSITOR_LOCK.codeHash) && o.type && lc(o.type.codeHash) === lc(ASSET_TYPE.codeHash));
  const payoutIdx = tx.outputs.indexOf(payout);
  assert.equal(decodeAmount(tx.outputsData[payoutIdx]), 150n);

  const want = [DEPS.poolType, DEPS.poolAdminLock, DEPS.shareXudt, DEPS.treasuryLock, ASSET_DEP];
  assert.deepEqual(depTxs(tx).sort(), want.map((d) => lc(d.outPoint.txHash)).sort());
});

test("WITHDRAW (xUDT) rejects a treasury too small and missing pieces", () => {
  const pool = xudtFundedPool(100n, 50n);
  assert.throws(
    () => buildWithdrawTx({ deploy: DEPLOY, deps: DEPS, pool, withdrawerLock: DEPOSITOR_LOCK, upAmount: 100n, downAmount: 50n, shareInputs: [sIn("a1", SIDE_UP, 100n), sIn("a2", SIDE_DOWN, 50n)], assetType: ASSET_TYPE, assetTypeDep: ASSET_DEP, treasury: { outPoint: { txHash: "0x" + "99".repeat(32), index: 0 }, capacity: 14_200_000_000n, balance: 10n } }),
    /cannot cover/,
  );
  assert.throws(
    () => buildWithdrawTx({ deploy: DEPLOY, deps: DEPS, pool, withdrawerLock: DEPOSITOR_LOCK, upAmount: 100n, downAmount: 50n, shareInputs: [sIn("a1", SIDE_UP, 100n), sIn("a2", SIDE_DOWN, 50n)] }),
    /xUDT withdraw requires/,
  );
});
