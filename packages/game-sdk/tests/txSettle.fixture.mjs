import test from "node:test";
import assert from "node:assert/strict";

import { ccc } from "@ckb-ccc/core";

import { buildRedeemTx, buildCloseTx } from "../dist/tx/index.js";
import {
  computeTypeId,
  poolTypeScript,
  poolAdminLockScript,
  decodeAmount,
} from "../dist/ckb/index.js";
import {
  decodePoolData,
  encodePoolDataHex,
  VARIANT_CKB,
  VARIANT_XUDT,
  STATUS_FINALIZED,
  STATUS_VOID,
  STATUS_OPEN,
  SIDE_UP,
  SIDE_DOWN,
  WINNER_VOID,
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
const REDEEMER_LOCK = { codeHash: "0x" + "ee".repeat(32), hashType: "type", args: "0x" + "12".repeat(20) };
const ASSET_TYPE = { codeHash: "0x" + "99".repeat(32), hashType: "type", args: "0x" + "aa".repeat(32) };
const ASSET_DEP = dep("ad");
const FEED = "0x" + "fe".repeat(32);
const COMMIT = "0x" + "c0".repeat(32);

const lc = (s) => s.toLowerCase();
const creatorHash = ccc.Script.from(CREATOR_LOCK).hash();
const depTxs = (tx) => tx.cellDeps.map((d) => lc(d.outPoint.txHash)).sort();
const want = (...d) => d.map((x) => lc(x.outPoint.txHash)).sort();

function pool({ variant, status, winner, upTotal, downTotal, rakeBps, capacity }) {
  const poolId = computeTypeId(SEED, 0);
  const typeScript = poolTypeScript(DEPLOY, poolId);
  return {
    poolId,
    outPoint: { txHash: "0x" + "88".repeat(32), index: 0 },
    typeScript,
    lock: poolAdminLockScript(DEPLOY, creatorHash),
    capacity,
    data: {
      variant,
      assetTypeHash: variant === VARIANT_XUDT ? ccc.Script.from(ASSET_TYPE).hash() : undefined,
      shareXudtCodeHash: DEPLOY.shareXudtCodeHash,
      treasuryLockCodeHash: variant === VARIANT_XUDT ? DEPLOY.treasuryLockCodeHash : undefined,
      feedId: FEED, oracleCommit: COMMIT, startTime: 1000n, closeTime: 2000n,
      upTotal, downTotal, startPrice: 100n, settlePrice: 110n, usedPt: 1500n,
      rakeBps, status, winner,
    },
  };
}

// ---------------- REDEEM ----------------

test("REDEEM (CKB, finalized UP winner): payout x + profit, PoolData unchanged", () => {
  const p = pool({ variant: VARIANT_CKB, status: STATUS_FINALIZED, winner: SIDE_UP, upTotal: 100n, downTotal: 100n, rakeBps: 0, capacity: 100_000_000_000n });
  const tx = buildRedeemTx({
    deploy: DEPLOY, deps: DEPS, pool: p, redeemerLock: REDEEMER_LOCK,
    shareInputs: [{ outPoint: { txHash: "0x" + "11".repeat(32), index: 0 }, side: SIDE_UP, amount: 100n }],
  });

  // x=100, profit=floor(100*(100-0)/100)=100, payout=200.
  assert.equal(tx.outputs[0].capacity, p.capacity - 200n);
  assert.equal(tx.outputsData[0], encodePoolDataHex(p.data)); // unchanged
  assert.equal(tx.inputs.length, 2); // pool + 1 burned share
  assert.deepEqual(depTxs(tx), want(DEPS.poolType, DEPS.poolAdminLock, DEPS.shareXudt));
});

test("REDEEM (CKB, VOID): 1:1 refund of both burned sides", () => {
  const p = pool({ variant: VARIANT_CKB, status: STATUS_VOID, winner: WINNER_VOID, upTotal: 100n, downTotal: 100n, rakeBps: 300, capacity: 50_000_000_000n });
  const tx = buildRedeemTx({
    deploy: DEPLOY, deps: DEPS, pool: p, redeemerLock: REDEEMER_LOCK,
    shareInputs: [
      { outPoint: { txHash: "0x" + "11".repeat(32), index: 0 }, side: SIDE_UP, amount: 30n },
      { outPoint: { txHash: "0x" + "22".repeat(32), index: 0 }, side: SIDE_DOWN, amount: 20n },
    ],
  });
  assert.equal(tx.outputs[0].capacity, p.capacity - 50n); // 1:1 refund of 30+20
  assert.equal(tx.inputs.length, 3); // pool + 2 burned shares
});

test("REDEEM (xUDT, finalized winner): treasury shrinks, redeemer paid the asset", () => {
  const p = pool({ variant: VARIANT_XUDT, status: STATUS_FINALIZED, winner: SIDE_DOWN, upTotal: 100n, downTotal: 100n, rakeBps: 0, capacity: 18_000_000_000n });
  const treasury = { outPoint: { txHash: "0x" + "99".repeat(32), index: 0 }, capacity: 14_200_000_000n, balance: 200n };
  const tx = buildRedeemTx({
    deploy: DEPLOY, deps: DEPS, pool: p, redeemerLock: REDEEMER_LOCK,
    shareInputs: [{ outPoint: { txHash: "0x" + "11".repeat(32), index: 0 }, side: SIDE_DOWN, amount: 100n }],
    assetType: ASSET_TYPE, assetTypeDep: ASSET_DEP, treasury,
  });
  // winner DOWN: x=100, loser=up=100, payout=200.
  assert.equal(tx.outputs[0].capacity, p.capacity); // PoolCell capacity fixed
  const treOut = tx.outputs.find((o) => lc(o.lock.codeHash) === lc(DEPLOY.treasuryLockCodeHash));
  assert.equal(decodeAmount(tx.outputsData[tx.outputs.indexOf(treOut)]), 0n); // 200 - 200
  const payOut = tx.outputs.find((o) => lc(o.lock.codeHash) === lc(REDEEMER_LOCK.codeHash) && o.type && lc(o.type.codeHash) === lc(ASSET_TYPE.codeHash));
  assert.equal(decodeAmount(tx.outputsData[tx.outputs.indexOf(payOut)]), 200n);
  assert.deepEqual(depTxs(tx), want(DEPS.poolType, DEPS.poolAdminLock, DEPS.shareXudt, DEPS.treasuryLock, ASSET_DEP));
});

test("REDEEM (xUDT) rejects an asset type that does not match the pool", () => {
  const p = pool({ variant: VARIANT_XUDT, status: STATUS_FINALIZED, winner: SIDE_DOWN, upTotal: 100n, downTotal: 100n, rakeBps: 0, capacity: 18_000_000_000n });
  const wrongAsset = { ...ASSET_TYPE, args: "0x" + "bb".repeat(32) };
  assert.throws(
    () => buildRedeemTx({
      deploy: DEPLOY, deps: DEPS, pool: p, redeemerLock: REDEEMER_LOCK,
      shareInputs: [{ outPoint: { txHash: "0x" + "11".repeat(32), index: 0 }, side: SIDE_DOWN, amount: 100n }],
      assetType: wrongAsset, assetTypeDep: ASSET_DEP,
      treasury: { outPoint: { txHash: "0x" + "99".repeat(32), index: 0 }, capacity: 14_200_000_000n, balance: 200n },
    }),
    /assetType hash/,
  );
});

test("REDEEM rejects burning loser shares in a finalized win", () => {
  const p = pool({ variant: VARIANT_CKB, status: STATUS_FINALIZED, winner: SIDE_UP, upTotal: 100n, downTotal: 100n, rakeBps: 0, capacity: 100_000_000_000n });
  assert.throws(
    () => buildRedeemTx({ deploy: DEPLOY, deps: DEPS, pool: p, redeemerLock: REDEEMER_LOCK, shareInputs: [{ outPoint: { txHash: "0x" + "22".repeat(32), index: 0 }, side: SIDE_DOWN, amount: 10n }] }),
    /only winning shares/,
  );
});

test("REDEEM rejects payout exceeding PoolCell capacity (CKB)", () => {
  const p = pool({ variant: VARIANT_CKB, status: STATUS_FINALIZED, winner: SIDE_UP, upTotal: 100n, downTotal: 100n, rakeBps: 0, capacity: 100n });
  assert.throws(
    () => buildRedeemTx({ deploy: DEPLOY, deps: DEPS, pool: p, redeemerLock: REDEEMER_LOCK, shareInputs: [{ outPoint: { txHash: "0x" + "11".repeat(32), index: 0 }, side: SIDE_UP, amount: 100n }] }),
    /exceeds PoolCell capacity/,
  );
});

// ---------------- CLOSE ----------------

const CREATOR_INPUT = { outPoint: { txHash: "0x" + "cc".repeat(32), index: 0 } };

test("CLOSE (CKB): consumes PoolCell + creator input, no PoolCell output", () => {
  const p = pool({ variant: VARIANT_CKB, status: STATUS_FINALIZED, winner: SIDE_UP, upTotal: 100n, downTotal: 100n, rakeBps: 0, capacity: 50_000_000_000n });
  const tx = buildCloseTx({ deploy: DEPLOY, deps: DEPS, pool: p, creatorLock: CREATOR_LOCK, creatorInput: CREATOR_INPUT });

  assert.equal(tx.inputs.length, 2);
  assert.equal(tx.outputs.length, 0);
  // no PoolCell output → typeID consumed
  assert.deepEqual(depTxs(tx), want(DEPS.poolType, DEPS.poolAdminLock));
});

test("CLOSE (xUDT): also sweeps the treasury to the creator", () => {
  const p = pool({ variant: VARIANT_XUDT, status: STATUS_VOID, winner: WINNER_VOID, upTotal: 0n, downTotal: 0n, rakeBps: 0, capacity: 18_000_000_000n });
  const treasury = { outPoint: { txHash: "0x" + "99".repeat(32), index: 0 }, capacity: 14_200_000_000n, balance: 75n };
  const tx = buildCloseTx({ deploy: DEPLOY, deps: DEPS, pool: p, creatorLock: CREATOR_LOCK, creatorInput: CREATOR_INPUT, assetType: ASSET_TYPE, assetTypeDep: ASSET_DEP, treasury });

  assert.equal(tx.inputs.length, 3); // pool + creator + treasury
  const swept = tx.outputs.find((o) => lc(o.lock.codeHash) === lc(CREATOR_LOCK.codeHash) && o.type && lc(o.type.codeHash) === lc(ASSET_TYPE.codeHash));
  assert.equal(decodeAmount(tx.outputsData[tx.outputs.indexOf(swept)]), 75n);
  assert.deepEqual(depTxs(tx), want(DEPS.poolType, DEPS.poolAdminLock, DEPS.treasuryLock, ASSET_DEP));
});

test("CLOSE (xUDT) rejects an asset type that does not match the pool", () => {
  const p = pool({ variant: VARIANT_XUDT, status: STATUS_VOID, winner: WINNER_VOID, upTotal: 0n, downTotal: 0n, rakeBps: 0, capacity: 18_000_000_000n });
  const wrongAsset = { ...ASSET_TYPE, args: "0x" + "bb".repeat(32) };
  assert.throws(
    () => buildCloseTx({
      deploy: DEPLOY, deps: DEPS, pool: p, creatorLock: CREATOR_LOCK, creatorInput: CREATOR_INPUT,
      assetType: wrongAsset, assetTypeDep: ASSET_DEP,
      treasury: { outPoint: { txHash: "0x" + "99".repeat(32), index: 0 }, capacity: 14_200_000_000n, balance: 75n },
    }),
    /assetType hash/,
  );
});

test("CLOSE rejects an unsettled pool and a creatorLock mismatch", () => {
  const open = pool({ variant: VARIANT_CKB, status: STATUS_OPEN, winner: 0, upTotal: 0n, downTotal: 0n, rakeBps: 0, capacity: 50_000_000_000n });
  assert.throws(() => buildCloseTx({ deploy: DEPLOY, deps: DEPS, pool: open, creatorLock: CREATOR_LOCK, creatorInput: CREATOR_INPUT }), /FINALIZED or VOID/);

  const fin = pool({ variant: VARIANT_CKB, status: STATUS_FINALIZED, winner: SIDE_UP, upTotal: 100n, downTotal: 100n, rakeBps: 0, capacity: 50_000_000_000n });
  assert.throws(() => buildCloseTx({ deploy: DEPLOY, deps: DEPS, pool: fin, creatorLock: REDEEMER_LOCK, creatorInput: CREATOR_INPUT }), /does not match PoolCell lock args/);
});
