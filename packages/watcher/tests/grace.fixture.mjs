//! Phase 1 fixture: timing + lane helpers. voidTimeOf mirrors the contract's
//! `void_time = close_time + grace(duration)`, grace = clamp(duration/10, 60, 600).

import test from "node:test";
import assert from "node:assert/strict";

import { voidTimeOf, laneKey, laneKeyOf, laneKeySet, laneOracleCommit, openDb } from "../dist/index.js";

const pool = (startTime, closeTime, feedId = "0x" + "fe".repeat(32)) => ({
  data: { feedId, startTime: BigInt(startTime), closeTime: BigInt(closeTime) },
});

test("voidTimeOf: 5m clamps grace to the 60s floor", () => {
  // duration 300 -> 300/10=30 -> floor 60 -> void = close + 60
  assert.equal(voidTimeOf(pool(0, 300)), 360n);
});

test("voidTimeOf: 15m uses duration/10 (90s)", () => {
  assert.equal(voidTimeOf(pool(1000, 1900)), 1900n + 90n);
});

test("voidTimeOf: 1h uses duration/10 (360s)", () => {
  assert.equal(voidTimeOf(pool(0, 3600)), 3600n + 360n);
});

test("voidTimeOf: 1d clamps grace to the 600s cap", () => {
  // duration 86400 -> 8640 -> cap 600 -> void = close + 600
  assert.equal(voidTimeOf(pool(0, 86400)), 86400n + 600n);
});

test("laneKey is feed+duration and laneKeyOf agrees", () => {
  const feed = "0x" + "ab".repeat(32);
  assert.equal(laneKeyOf(pool(100, 1000, feed)), laneKey(feed, 900n));
});

test("laneKey lowercases the feed id", () => {
  const upper = "0x" + "AB".repeat(32);
  assert.equal(laneKey(upper, 900n), `0x${"ab".repeat(32)}:900`);
});

test("laneKeySet scopes a per-feed keeper by feed AND duration", () => {
  const btc = "0x" + "b7".repeat(32);
  const eth = "0x" + "e7".repeat(32);
  // A BTC keeper configured for 5m + 15m only.
  const keys = laneKeySet([
    { feedId: btc, durationSecs: 300n },
    { feedId: btc, durationSecs: 900n },
  ]);
  // Configured durations on the feed are in scope.
  assert.ok(keys.has(laneKeyOf(pool(0, 300, btc))), "BTC-5m is owned");
  assert.ok(keys.has(laneKeyOf(pool(0, 900, btc))), "BTC-15m is owned");
  // Same feed, a duration NOT configured (a stray/retired BTC-30m) is rejected —
  // this is the whole point of scoping on the pair, not the feed alone.
  assert.ok(!keys.has(laneKeyOf(pool(0, 1800, btc))), "unconfigured BTC-30m is NOT owned");
  // A different feed at a configured duration is rejected too.
  assert.ok(!keys.has(laneKeyOf(pool(0, 300, eth))), "another feed is NOT owned");
});

test("laneOracleCommit is deterministic for an identity", () => {
  const identity = {
    oracleTypeCodeHash: "0x" + "11".repeat(32),
    guardianSetTypeHash: "0x" + "22".repeat(32),
    emitterChain: 26,
    emitterAddress: "0x" + "33".repeat(32),
  };
  const lane = { oracleIdentity: identity };
  const a = laneOracleCommit(lane);
  const b = laneOracleCommit(lane);
  assert.equal(a, b);
  assert.match(a, /^0x[0-9a-f]{64}$/);
});

test("openDb (:memory:) applies the schema and round-trips a pool", () => {
  const db = openDb(":memory:");
  const row = {
    poolId: "0x" + "01".repeat(32),
    feedId: "0x" + "fe".repeat(32),
    durationSecs: 900n,
    laneLabel: "BTC-15m",
    status: 0,
    winner: 0,
    variant: 0,
    startTime: 1000n,
    closeTime: 1900n,
    voidTime: 1990n,
    upTotal: 0n,
    downTotal: 0n,
    startPrice: 0n,
    settlePrice: 0n,
    usedPt: 0n,
    rakeBps: 200,
    oracleCommit: "0x" + "c0".repeat(32),
    capacity: 9_000_000_000n,
    txHash: "0x" + "0a".repeat(32),
    outIndex: 0,
  };
  db.upsertPool(row, Date.now());
  const got = db.getPool(row.poolId);
  assert.ok(got);
  assert.equal(got.upTotal, 0n);
  assert.equal(got.closeTime, 1900n);
  assert.equal(got.laneLabel, "BTC-15m");
  assert.equal(db.latestPoolForLane(row.feedId, 900n)?.poolId, row.poolId);
  db.raw.close();
});
