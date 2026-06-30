//! Test-only mock oracle for live devnet lifecycle tests.
//!
//! The pool's `pool_type` reads an oracle observation from a CellDep: it accepts
//! ANY dep cell whose type-`args == feedId`, whose data is the 152-byte oracle
//! layout, and whose `blake2b(type.code_hash ‖ guardian ‖ chain ‖ emitter)` equals
//! the pool's stored `oracle_commit` (see `find_oracle` in pool_type/src/main.rs).
//! It does NOT re-verify guardian signatures — the pool trusts the commitment.
//!
//! So we mint a cell we fully control (price + publish_time of our choosing) with a
//! test-only `always_success` type script, and bind the pool's `oracle_commit` to
//! it. This faithfully stands in for a real Lean Oracle cell for the no-oracle-auth
//! checks the pool performs, WITHOUT touching the Lean Oracle. Test infrastructure
//! only — no production / Lean Oracle code is involved.

import { ccc } from "@ckb-ccc/core";

import { oracleCommit } from "../../../dist/index.js";

// offckb devnet genesis `always_success` cell (from `ckb list-hashes`).
export const ALWAYS_SUCCESS = {
  dataHash: "0xd483925160e4232b2cb29f012e8380b7b612d71cf4e79991476b6bcf610735f6",
  cellDep: {
    outPoint: { txHash: "0x1bb87da347a776a927ab6593e1e10304ca195f8e24279f039008d5e3115b1bf7", index: 9 },
    depType: "code",
  },
};

// A fixed, arbitrary oracle trust root. The mock cell's type code_hash is the
// always_success data hash, so the on-chain commitment recompute matches.
export const MOCK_ORACLE_IDENTITY = {
  oracleTypeCodeHash: ALWAYS_SUCCESS.dataHash,
  guardianSetTypeHash: "0x" + "22".repeat(32),
  emitterChain: 26,
  emitterAddress: "0x" + "33".repeat(32),
};

/** The `oracle_commit` a pool must carry to trust this mock oracle. */
export function mockOracleCommit() {
  return oracleCommit(MOCK_ORACLE_IDENTITY);
}

const ORACLE_STATE_LEN = 152;
const OFF_FEED_ID = 0;
const OFF_GUARDIAN = 32;
const OFF_PRICE = 64; // i64 LE
const OFF_PUBLISH = 84; // u64 LE
const OFF_EMITTER_CHAIN = 116; // u32 LE
const OFF_EMITTER_ADDR = 120;

function hexToBytes(hex) {
  return Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));
}

/** Encode the 152-byte oracle layout `pool_type`'s `OracleRead::from_bytes` reads. */
export function encodeMockOracleData({ feedId, price, publishTime }) {
  const d = new Uint8Array(ORACLE_STATE_LEN);
  d.set(hexToBytes(feedId), OFF_FEED_ID);
  d.set(hexToBytes(MOCK_ORACLE_IDENTITY.guardianSetTypeHash), OFF_GUARDIAN);
  new DataView(d.buffer).setBigInt64(OFF_PRICE, BigInt(price), true);
  new DataView(d.buffer).setBigUint64(OFF_PUBLISH, BigInt(publishTime), true);
  new DataView(d.buffer).setUint32(OFF_EMITTER_CHAIN, MOCK_ORACLE_IDENTITY.emitterChain, true);
  d.set(hexToBytes(MOCK_ORACLE_IDENTITY.emitterAddress), OFF_EMITTER_ADDR);
  return "0x" + Buffer.from(d).toString("hex");
}

/** The type script the mock oracle cell carries (always_success, args = feedId). */
export function mockOracleType(feedId) {
  return ccc.Script.from({ codeHash: ALWAYS_SUCCESS.dataHash, hashType: "data1", args: feedId });
}

/**
 * Lock the oracle cells under always_success (NOT the keeper's lock). The keeper's
 * `complete()` fee-funding scans cells under its own lock, so this guarantees it
 * can never accidentally consume a still-needed oracle cell as a fee input.
 */
export function mockOracleLock() {
  return ccc.Script.from({ codeHash: ALWAYS_SUCCESS.dataHash, hashType: "data1", args: "0x" });
}

/**
 * Mint one or more mock oracle cells in a single tx and return their resolved
 * {@link OracleTick}s (one per `tick` spec), ready to hand to the keeper builders.
 * Each spec is `{ feedId, price, publishTime }`.
 */
export async function mintMockOracleCells(client, signer, ticks) {
  const lock = mockOracleLock();
  const outputs = [];
  const outputsData = [];
  for (const t of ticks) {
    const type = mockOracleType(t.feedId);
    const data = encodeMockOracleData(t);
    // ~278 bytes occupied; 320 CKB leaves comfortable headroom.
    outputs.push({ lock, type, capacity: 320n * 100000000n });
    outputsData.push(data);
  }

  const tx = ccc.Transaction.from({
    version: 0n,
    cellDeps: [ALWAYS_SUCCESS.cellDep],
    headerDeps: [],
    inputs: [],
    outputs,
    outputsData,
    witnesses: [],
  });
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, 1000n);
  const txHash = await signer.sendTransaction(tx);
  await client.waitTransaction(txHash, 0, 120000);

  return ticks.map((t, i) => ({
    feedId: t.feedId,
    price: BigInt(t.price),
    publishTimeUnix: BigInt(t.publishTime),
    cellDep: { outPoint: { txHash, index: i }, depType: "code" },
  }));
}
