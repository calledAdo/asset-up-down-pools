import test from "node:test";
import assert from "node:assert/strict";

import {
  asPool,
  asShare,
  asTreasury,
  poolIdOf,
  encodePoolDataHex,
  SIDE_UP,
  SIDE_DOWN,
  STATUS_OPEN,
  SIDE_UNDECIDED,
  VARIANT_CKB,
} from "../dist/index.js";
import { encodeAmount, decodeAmount, computeTypeId } from "../dist/ckb/index.js";

const DEPLOY = {
  poolTypeCodeHash: "0x" + "a1".repeat(32),
  shareXudtCodeHash: "0x" + "b2".repeat(32),
  treasuryLockCodeHash: "0x" + "c3".repeat(32),
  poolAdminLockCodeHash: "0x" + "d4".repeat(32),
};
const POOL_TYPE_HASH = "0x" + "11".repeat(32);
const POOL_ID = "0x" + "22".repeat(32);
const SHARE_CODE_HASH = DEPLOY.shareXudtCodeHash;
const TREASURY_CODE_HASH = DEPLOY.treasuryLockCodeHash;

test("amount codec round-trips a large u128", () => {
  const a = 340282366920938463463374607431768211455n; // u128 max
  assert.equal(decodeAmount(encodeAmount(a)), a);
  assert.equal(decodeAmount(encodeAmount(0n)), 0n);
  assert.equal(encodeAmount(1n), "0x01000000000000000000000000000000");
});

test("decodeAmount rejects short data", () => {
  assert.equal(decodeAmount("0x0102"), null);
});

test("computeTypeId is deterministic and index-sensitive", () => {
  const input = { previousOutput: { txHash: "0x" + "ab".repeat(32), index: 0 } };
  const id0 = computeTypeId(input, 0);
  const id0b = computeTypeId(input, 0);
  const id1 = computeTypeId(input, 1);
  assert.equal(id0, id0b);
  assert.notEqual(id0, id1);
  assert.equal(id0.length, 66); // 0x + 32 bytes
});

function pool() {
  return {
    variant: VARIANT_CKB,
    shareXudtCodeHash: SHARE_CODE_HASH,
    feedId: "0x" + "11".repeat(32),
    oracleCommit: "0x" + "22".repeat(32),
    startTime: 100n,
    closeTime: 1000n,
    upTotal: 0n,
    downTotal: 0n,
    startPrice: 0n,
    settlePrice: 0n,
    usedPt: 0n,
    rakeBps: 100,
    status: STATUS_OPEN,
    winner: SIDE_UNDECIDED,
  };
}

test("asPool decodes a pool_type cell and ignores others", () => {
  const cell = {
    type: { codeHash: DEPLOY.poolTypeCodeHash, hashType: "data2", args: POOL_ID },
    lock: { codeHash: DEPLOY.poolAdminLockCodeHash, hashType: "data2", args: "0x" + "33".repeat(32) },
    data: encodePoolDataHex(pool()),
  };
  assert.equal(asPool(cell, DEPLOY)?.status, STATUS_OPEN);
  assert.equal(poolIdOf(cell, DEPLOY), POOL_ID);

  const notPool = { ...cell, type: { ...cell.type, codeHash: "0x" + "ee".repeat(32) } };
  assert.equal(asPool(notPool, DEPLOY), null);
  assert.equal(poolIdOf(notPool, DEPLOY), null);
});

test("asShare matches pool_type_hash ++ side and reads the amount", () => {
  const up = {
    type: { codeHash: DEPLOY.shareXudtCodeHash, hashType: "data2", args: POOL_TYPE_HASH + "01" },
    lock: { codeHash: "0x" + "ff".repeat(32), hashType: "data2", args: "0x" },
    data: encodeAmount(500n),
  };
  assert.deepEqual(asShare(up, POOL_TYPE_HASH, SHARE_CODE_HASH), { side: SIDE_UP, amount: 500n });

  const down = { ...up, type: { ...up.type, args: POOL_TYPE_HASH + "02" } };
  assert.deepEqual(asShare(down, POOL_TYPE_HASH, SHARE_CODE_HASH), { side: SIDE_DOWN, amount: 500n });

  // Wrong pool, and a non-share cell.
  assert.equal(asShare(up, "0x" + "99".repeat(32), SHARE_CODE_HASH), null);
  assert.equal(asShare({ ...up, type: null }, POOL_TYPE_HASH, SHARE_CODE_HASH), null);
  assert.equal(asShare(up, POOL_TYPE_HASH, "0x" + "99".repeat(32)), null);
});

test("asTreasury matches lock binding + asset type and reads the amount", () => {
  const ASSET_TYPE_HASH = "0x" + "bb".repeat(32);
  const t = {
    type: { codeHash: "0x" + "aa".repeat(32), hashType: "type", args: "0x" },
    typeHash: ASSET_TYPE_HASH,
    lock: { codeHash: TREASURY_CODE_HASH, hashType: "data2", args: POOL_TYPE_HASH },
    data: encodeAmount(777n),
  };
  assert.equal(asTreasury(t, POOL_TYPE_HASH, ASSET_TYPE_HASH, TREASURY_CODE_HASH), 777n);
  // Wrong pool binding, no type script, or unknown type hash.
  assert.equal(asTreasury(t, "0x" + "99".repeat(32), ASSET_TYPE_HASH, TREASURY_CODE_HASH), null);
  assert.equal(asTreasury({ ...t, type: null }, POOL_TYPE_HASH, ASSET_TYPE_HASH, TREASURY_CODE_HASH), null);
  assert.equal(asTreasury({ ...t, typeHash: null }, POOL_TYPE_HASH, ASSET_TYPE_HASH, TREASURY_CODE_HASH), null);
  // A wrong xUDT sent to the treasury lock must not be counted.
  assert.equal(asTreasury(t, POOL_TYPE_HASH, "0x" + "cc".repeat(32), TREASURY_CODE_HASH), null);
  assert.equal(asTreasury(t, POOL_TYPE_HASH, ASSET_TYPE_HASH, "0x" + "dd".repeat(32)), null);
});
