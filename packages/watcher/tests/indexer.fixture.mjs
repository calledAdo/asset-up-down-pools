//! Phase 3 fixture: pure projection (poolToRow) and an in-memory DB round-trip
//! (upsert pool + listPools filter). Positions are no longer stored/indexed.

import test from "node:test";
import assert from "node:assert/strict";

import { poolToRow, openDb } from "../dist/index.js";

const FEED = "0x" + "fe".repeat(32);
const LANE = {
  label: "BTC-15m",
  feedId: FEED,
  durationSecs: 900n,
  rakeBps: 200,
  asset: { kind: "ckb" },
  oracleIdentity: {},
  createLeadSecs: 300n,
};

function poolView() {
  return {
    poolId: "0x" + "01".repeat(32),
    outPoint: { txHash: "0x" + "0a".repeat(32), index: 2 },
    typeScript: { codeHash: "0x" + "00".repeat(32), hashType: "data2", args: "0x" + "01".repeat(32) },
    lock: { codeHash: "0x" + "00".repeat(32), hashType: "data2", args: "0x" },
    capacity: 9_000_000_000n,
    data: {
      variant: 0,
      assetTypeHash: undefined,
      shareXudtCodeHash: "0x" + "55".repeat(32),
      treasuryLockCodeHash: undefined,
      feedId: FEED,
      oracleCommit: "0x" + "c0".repeat(32),
      startTime: 1000n,
      closeTime: 1900n, // 15m
      upTotal: 500n,
      downTotal: 300n,
      startPrice: 0n,
      settlePrice: 0n,
      usedPt: 0n,
      rakeBps: 200,
      status: 1,
      winner: 0,
    },
  };
}

test("poolToRow derives duration, voidTime, and resolves the lane label", () => {
  const row = poolToRow(poolView(), [LANE]);
  assert.equal(row.durationSecs, 900n);
  assert.equal(row.voidTime, 1900n + 90n); // grace(900)=90
  assert.equal(row.laneLabel, "BTC-15m");
  assert.equal(row.upTotal, 500n);
  assert.equal(row.txHash, "0x" + "0a".repeat(32));
  assert.equal(row.outIndex, 2);
});

test("poolToRow leaves label null for a pool outside the configured lanes", () => {
  const row = poolToRow(poolView(), []);
  assert.equal(row.laneLabel, null);
});

test("DB: upsert pool then refresh updates in place", () => {
  const db = openDb(":memory:");
  const row = poolToRow(poolView(), [LANE]);
  db.upsertPool(row, Date.now());
  // simulate a transition: status SETTLED, winner UP
  const updated = { ...row, status: 2, winner: 1, settlePrice: 42n };
  db.upsertPool(updated, Date.now());
  const got = db.getPool(row.poolId);
  assert.equal(got.status, 2);
  assert.equal(got.winner, 1);
  assert.equal(got.settlePrice, 42n);
  assert.equal(db.listPools({ status: 2 }).length, 1);
  assert.equal(db.listPools({ status: 0 }).length, 0);
  db.raw.close();
});

test("DB: tx_log idempotency guards (open create / open action)", () => {
  const db = openDb(":memory:");
  const poolId = "0x" + "01".repeat(32);
  const roundKey = `${FEED}:900@1900`;

  assert.equal(db.hasOpenCreate(roundKey), false);
  const id = db.insertTxLog({ roundKey, laneKey: `${FEED}:900`, action: "create", status: "sent" });
  assert.equal(db.hasOpenCreate(roundKey), true);

  // failure clears the guard
  db.updateTxLog(id, { status: "failed", detail: "boom" });
  assert.equal(db.hasOpenCreate(roundKey), false);

  assert.equal(db.hasOpenAction(poolId, "activate"), false);
  db.insertTxLog({ poolId, action: "activate", status: "sent" });
  assert.equal(db.hasOpenAction(poolId, "activate"), true);
  assert.equal(db.hasOpenAction(poolId, "resolve"), false);
  db.raw.close();
});
