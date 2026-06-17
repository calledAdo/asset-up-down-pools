import test from "node:test";
import assert from "node:assert/strict";

import {
  encodePoolDataHex,
  decodePoolData,
  hexToBytes,
  VARIANT_CKB,
  VARIANT_XUDT,
  STATUS_LOCKED,
  SIDE_UNDECIDED,
  POOL_LEN_CKB,
  POOL_LEN_XUDT,
} from "../dist/index.js";

// Golden vectors emitted by the Rust source of truth (the `sample()` PoolData in
// crates/up_down/tests/src/pool_data_tests.rs). These are byte-exact: matching
// them proves the TS codec agrees with the on-chain layout.
const GOLDEN_ORACLE_COMMIT =
  "0x2a9cf0d6898da34c85a433ab8ac67617d3f9c48a49112e34d3422bb9c19e327d";
const GOLDEN_CKB =
  "0x0011111111111111111111111111111111111111111111111111111111111111112a9cf0d6898da34c85a433ab8ac67617d3f9c48a49112e34d3422bb9c19e327d00f153650000000084f4536500000000081a99be1c0000000000000000000000b168de3a000000000000000000000000d6ffffffffffffff803299f50e0000007bf153650000000096000100";
const GOLDEN_XUDT =
  "0x01abababababababababababababababababababababababababababababababab11111111111111111111111111111111111111111111111111111111111111112a9cf0d6898da34c85a433ab8ac67617d3f9c48a49112e34d3422bb9c19e327d00f153650000000084f4536500000000081a99be1c0000000000000000000000b168de3a000000000000000000000000d6ffffffffffffff803299f50e0000007bf153650000000096000100";

function sample(variant) {
  return {
    variant,
    assetTypeHash: variant === VARIANT_XUDT ? "0x" + "ab".repeat(32) : undefined,
    feedId: "0x" + "11".repeat(32),
    oracleCommit: GOLDEN_ORACLE_COMMIT,
    startTime: 1_700_000_000n,
    closeTime: 1_700_000_900n,
    upTotal: 123_456_789_000n,
    downTotal: 987_654_321n,
    startPrice: -42n, // signed round-trip
    settlePrice: 64_250_000_000n,
    usedPt: 1_700_000_123n,
    rakeBps: 150,
    status: STATUS_LOCKED,
    winner: SIDE_UNDECIDED,
  };
}

test("CKB encoding matches the Rust golden vector byte-for-byte", () => {
  const hex = encodePoolDataHex(sample(VARIANT_CKB));
  assert.equal(hex, GOLDEN_CKB);
  assert.equal(hexToBytes(hex).length, POOL_LEN_CKB);
});

test("xUDT encoding matches the Rust golden vector byte-for-byte", () => {
  const hex = encodePoolDataHex(sample(VARIANT_XUDT));
  assert.equal(hex, GOLDEN_XUDT);
  assert.equal(hexToBytes(hex).length, POOL_LEN_XUDT);
});

test("decode(encode(x)) === x for both variants", () => {
  for (const variant of [VARIANT_CKB, VARIANT_XUDT]) {
    const pd = sample(variant);
    const back = decodePoolData(hexToBytes(encodePoolDataHex(pd)));
    assert.deepEqual(back, pd);
  }
});

test("decode of the golden CKB vector recovers the sample", () => {
  const back = decodePoolData(GOLDEN_CKB);
  assert.deepEqual(back, sample(VARIANT_CKB));
});

test("rejects wrong length and unknown variant", () => {
  const good = hexToBytes(GOLDEN_CKB);
  assert.equal(decodePoolData(good.subarray(0, good.length - 1)), null);
  const wrongVariant = good.slice();
  wrongVariant[0] = 9;
  assert.equal(decodePoolData(wrongVariant), null);
});

test("encode rejects an out-of-range rakeBps", () => {
  const bad = { ...sample(VARIANT_CKB), rakeBps: 10_001 };
  assert.throws(() => encodePoolDataHex(bad), /rakeBps/);
});
