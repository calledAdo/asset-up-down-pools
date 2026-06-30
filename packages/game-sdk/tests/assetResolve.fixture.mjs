import test from "node:test";
import assert from "node:assert/strict";

import { VARIANT_CKB, VARIANT_XUDT } from "../dist/index.js";
import { resolveCreateAsset, resolveAssetDep } from "../dist/tx/index.js";

const XUDT_CODE = "0x" + "99".repeat(32);
const XUDT_DEP_TX = "0x" + "ad".repeat(32);

// Fake CCC client: getKnownScript returns the standard xUDT ScriptInfo shape.
function clientWithXudt(codeHash = XUDT_CODE) {
  return {
    async getKnownScript() {
      return {
        codeHash,
        hashType: "type",
        cellDeps: [{ cellDep: { outPoint: { txHash: XUDT_DEP_TX, index: 2n }, depType: "code" } }],
      };
    },
  };
}
const clientNoKnownScript = {
  async getKnownScript() {
    throw new Error("unknown script");
  },
};

const lc = (s) => s.toLowerCase();

test("resolveCreateAsset(ckb) → CKB variant, no asset", async () => {
  const r = await resolveCreateAsset(clientWithXudt(), { kind: "ckb" });
  assert.equal(r.variant, VARIANT_CKB);
  assert.equal(r.assetType, undefined);
  assert.equal(r.assetTypeDep, undefined);
});

test("resolveCreateAsset(xudt by args) auto-resolves type + dep from the client", async () => {
  const args = "0x" + "12".repeat(32);
  const r = await resolveCreateAsset(clientWithXudt(), { kind: "xudt", args });
  assert.equal(r.variant, VARIANT_XUDT);
  assert.equal(lc(r.assetType.codeHash), lc(XUDT_CODE));
  assert.equal(r.assetType.hashType, "type");
  assert.equal(r.assetType.args, args);
  assert.equal(lc(r.assetTypeDep.outPoint.txHash), lc(XUDT_DEP_TX));
  assert.equal(r.assetTypeDep.outPoint.index, 2); // bigint → number
  assert.equal(r.assetTypeDep.depType, "code");
});

test("resolveCreateAsset(xudt with explicit type + codeDep) uses them as-is", async () => {
  const type = { codeHash: "0x" + "ab".repeat(32), hashType: "data1", args: "0x" + "cd".repeat(32) };
  const codeDep = { outPoint: { txHash: "0x" + "ef".repeat(32), index: 0 }, depType: "depGroup" };
  // clientNoKnownScript proves the override path never queries the client.
  const r = await resolveCreateAsset(clientNoKnownScript, { kind: "xudt", type, codeDep });
  assert.equal(r.variant, VARIANT_XUDT);
  assert.deepEqual(r.assetType, type);
  assert.deepEqual(r.assetTypeDep, codeDep);
});

test("resolveCreateAsset(xudt) with neither args nor type throws", async () => {
  await assert.rejects(() => resolveCreateAsset(clientWithXudt(), { kind: "xudt" }), /requires either/);
});

test("resolveAssetDep returns an explicit override without querying", async () => {
  const override = { outPoint: { txHash: "0x" + "11".repeat(32), index: 1 }, depType: "code" };
  const r = await resolveAssetDep(clientNoKnownScript, { codeHash: XUDT_CODE, hashType: "type", args: "0x" }, override);
  assert.deepEqual(r, override);
});

test("resolveAssetDep throws when the asset is not the known xUDT and no override", async () => {
  // client's known xUDT codeHash differs from the asset's → cannot auto-resolve.
  await assert.rejects(
    () => resolveAssetDep(clientWithXudt("0x" + "00".repeat(32)), { codeHash: XUDT_CODE, hashType: "type", args: "0x" }),
    /could not auto-resolve/,
  );
});
