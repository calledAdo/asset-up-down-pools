import test from "node:test";
import assert from "node:assert/strict";

import { TESTNET_ORACLE_IDENTITY } from "../dist/index.js";
import { oracleCommit } from "../dist/ckb/index.js";

// Same inputs the Rust `oracle_commit` uses for the testnet defaults; the golden
// output is emitted by the Rust source of truth.
const GOLDEN_ORACLE_COMMIT =
  "0x2a9cf0d6898da34c85a433ab8ac67617d3f9c48a49112e34d3422bb9c19e327d";

test("oracleCommit matches the Rust blake2b_ckb commitment", () => {
  const got = oracleCommit(TESTNET_ORACLE_IDENTITY);
  assert.equal(got, GOLDEN_ORACLE_COMMIT);
});

test("oracleCommit changes if any field changes", () => {
  const base = oracleCommit(TESTNET_ORACLE_IDENTITY);
  const tweaked = oracleCommit({ ...TESTNET_ORACLE_IDENTITY, emitterChain: 27 });
  assert.notEqual(base, tweaked);
});

test("oracleCommit rejects a bad emitterChain", () => {
  assert.throws(
    () => oracleCommit({ ...TESTNET_ORACLE_IDENTITY, emitterChain: -1 }),
    /emitterChain/,
  );
});
