import test from "node:test";
import assert from "node:assert/strict";

import {
  poolTypeScript,
  shareScript,
  treasuryLockScript,
  poolAdminLockScript,
  SIDE_UP,
  SIDE_DOWN,
} from "../dist/index.js";

const DEPLOY = {
  poolTypeCodeHash: "0x" + "a1".repeat(32),
  shareXudtCodeHash: "0x" + "b2".repeat(32),
  treasuryLockCodeHash: "0x" + "c3".repeat(32),
  poolAdminLockCodeHash: "0x" + "d4".repeat(32),
};
const POOL_TYPE_HASH = "0x" + "11".repeat(32);
const POOL_ID = "0x" + "22".repeat(32);
const CREATOR = "0x" + "33".repeat(32);

test("poolTypeScript uses the pool_id as args under data2", () => {
  const s = poolTypeScript(DEPLOY, POOL_ID);
  assert.equal(s.codeHash, DEPLOY.poolTypeCodeHash);
  assert.equal(s.hashType, "data2");
  assert.equal(s.args, POOL_ID);
});

test("shareScript args = pool_type_hash ++ side byte", () => {
  const up = shareScript(DEPLOY, POOL_TYPE_HASH, SIDE_UP);
  assert.equal(up.codeHash, DEPLOY.shareXudtCodeHash);
  assert.equal(up.hashType, "data2");
  assert.equal(up.args, POOL_TYPE_HASH + "01");

  const down = shareScript(DEPLOY, POOL_TYPE_HASH, SIDE_DOWN);
  assert.equal(down.args, POOL_TYPE_HASH + "02");
});

test("shareScript rejects a non UP/DOWN side", () => {
  assert.throws(() => shareScript(DEPLOY, POOL_TYPE_HASH, 0), /side/);
  assert.throws(() => shareScript(DEPLOY, POOL_TYPE_HASH, 3), /side/);
});

test("treasuryLockScript args = pool_type_hash", () => {
  const s = treasuryLockScript(DEPLOY, POOL_TYPE_HASH);
  assert.equal(s.codeHash, DEPLOY.treasuryLockCodeHash);
  assert.equal(s.hashType, "data2");
  assert.equal(s.args, POOL_TYPE_HASH);
});

test("poolAdminLockScript args = creator_lock_hash", () => {
  const s = poolAdminLockScript(DEPLOY, CREATOR);
  assert.equal(s.codeHash, DEPLOY.poolAdminLockCodeHash);
  assert.equal(s.hashType, "data2");
  assert.equal(s.args, CREATOR);
});

test("derivation rejects mis-sized inputs", () => {
  assert.throws(() => poolTypeScript(DEPLOY, "0x1234"), /poolId/);
  assert.throws(() => treasuryLockScript(DEPLOY, "0x1234"), /poolTypeHash/);
});
