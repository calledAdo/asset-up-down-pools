//! Pure keeper-core fixture: cadence anchoring, lifecycle decisions, wake timing,
//! and the in-memory timeline scheduler. No chain, DB, wallet, or timers.

import test from "node:test";
import assert from "node:assert/strict";

import {
  Cadence,
  Timeline,
  decide,
  nextWakeTime,
} from "../dist/index.js";

const FEED = "0x" + "fe".repeat(32);
const POOL = "0x" + "01".repeat(32);

const lane = {
  label: "BTC-5m",
  feedId: FEED,
  durationSecs: 300n,
  firstCreateAt: 1300n,
  rakeBps: 200,
  asset: { kind: "ckb" },
  oracleIdentity: {},
  createLeadSecs: 15n,
};

function cadence(overrides = {}) {
  return new Cadence({ ...lane, ...overrides });
}

function poolView(overrides = {}) {
  const startTime = overrides.startTime ?? 1600n;
  const closeTime = overrides.closeTime ?? 1900n;
  return {
    poolId: overrides.poolId ?? POOL,
    outPoint: { txHash: "0x" + "0a".repeat(32), index: 0 },
    typeScript: { codeHash: "0x" + "00".repeat(32), hashType: "data2", args: POOL },
    lock: { codeHash: "0x" + "00".repeat(32), hashType: "data2", args: "0x" },
    capacity: 9_000_000_000n,
    data: {
      variant: 0,
      feedId: FEED,
      oracleCommit: "0x" + "c0".repeat(32),
      startTime,
      closeTime,
      upTotal: overrides.upTotal ?? 100n,
      downTotal: overrides.downTotal ?? 100n,
      startPrice: overrides.startPrice ?? 0n,
      settlePrice: overrides.settlePrice ?? 0n,
      usedPt: overrides.usedPt ?? 0n,
      rakeBps: 200,
      status: overrides.status ?? 0,
      winner: overrides.winner ?? 0,
    },
  };
}

const tick = (publishTimeUnix, price = 100n) => ({
  feedId: FEED,
  price,
  publishTimeUnix,
  cellDep: { outPoint: { txHash: "0x" + "cd".repeat(32), index: 0 }, depType: "code" },
});

test("Cadence uses operator-supplied firstCreateAt instead of epoch alignment", () => {
  const c = cadence();

  assert.equal(c.boundaryAtOrAfter(1299n), 1300n);
  assert.equal(c.boundaryAtOrAfter(1300n), 1300n);
  assert.equal(c.boundaryAfter(1300n), 1600n);
  assert.equal(c.createFireTime(1300n), 1285n);
  assert.deepEqual(c.roundForCreateBoundary(1300n), { startTime: 1600n, closeTime: 1900n });
});

test("nextWakeTime returns the lifecycle boundary in the future or now when overdue", () => {
  const open = poolView({ status: 0, startTime: 1600n, closeTime: 1900n });
  assert.equal(nextWakeTime(open, 1500n), 1600n);
  assert.equal(nextWakeTime(open, 1601n), 1601n);

  const locked = poolView({ status: 1, startTime: 1600n, closeTime: 1900n });
  assert.equal(nextWakeTime(locked, 1800n), 1900n);

  const settled = poolView({ status: 2, startTime: 1600n, closeTime: 1900n });
  assert.equal(nextWakeTime(settled, 1901n), 1960n); // grace(300s) floors to 60s

  const finalized = poolView({ status: 5, startTime: 1600n, closeTime: 1900n });
  assert.equal(nextWakeTime(finalized, 2000n), 5500n); // closeGrace(300s) floors to 1h
});

test("decide emits keeper transition kinds from fresh state and the current oracle tick", () => {
  assert.deepEqual(
    decide(poolView({ status: 0, startTime: 1600n, closeTime: 1900n }), 1600n, tick(1600n)),
    { kind: "activate", poolId: POOL, feedId: FEED, oracle: tick(1600n) },
  );

  assert.deepEqual(
    decide(poolView({ status: 1, startTime: 1600n, closeTime: 1900n, usedPt: 1700n }), 1700n, tick(1600n)),
    { kind: "correct-start", poolId: POOL, feedId: FEED, oracle: tick(1600n) },
  );

  assert.deepEqual(
    decide(poolView({ status: 1, startTime: 1600n, closeTime: 1900n, startPrice: 100n }), 1900n, tick(1900n, 101n)),
    { kind: "resolve", poolId: POOL, feedId: FEED, oracle: tick(1900n, 101n) },
  );

  assert.deepEqual(
    decide(poolView({ status: 2, startTime: 1600n, closeTime: 1900n, startPrice: 100n, usedPt: 1950n }), 1950n, tick(1900n, 99n)),
    { kind: "correct-settle", poolId: POOL, feedId: FEED, oracle: tick(1900n, 99n) },
  );

  assert.deepEqual(
    decide(poolView({ status: 2, startTime: 1600n, closeTime: 1900n, usedPt: 1900n }), 1960n, tick(1960n)),
    { kind: "finalize", poolId: POOL, feedId: FEED, oracle: tick(1960n) },
  );
});

test("decide skips when the current oracle cell is behind the required boundary", () => {
  assert.equal(decide(poolView({ status: 0, startTime: 1600n, closeTime: 1900n }), 1600n, tick(1599n)), null);
  assert.equal(decide(poolView({ status: 1, startTime: 1600n, closeTime: 1900n }), 1900n, tick(1899n)), null);
});

test("Timeline keeps one outstanding wake per pool or cadence and buckets same-time entries", () => {
  let nextTimer = 1;
  const timers = new Map();
  const clearCalls = [];
  const fired = [];
  const timeline = new Timeline({
    now: () => 1000n,
    setTimer: (ms, fn) => {
      const id = nextTimer++;
      timers.set(id, { ms, fn });
      return id;
    },
    clearTimer: (id) => {
      clearCalls.push(id);
      timers.delete(id);
    },
    onWake: async (dueTime, entries) => {
      fired.push({ dueTime, entries });
    },
  });

  timeline.schedulePool("0x" + "01".repeat(32), 1200n);
  timeline.schedulePool("0x" + "02".repeat(32), 1200n);
  assert.equal(timeline.snapshot().slots.length, 1);
  assert.equal(timeline.snapshot().slots[0].entries.length, 2);
  assert.equal(timers.size, 1);

  timeline.schedulePool("0x" + "01".repeat(32), 1500n);
  assert.equal(timeline.snapshot().slots.length, 2);
  assert.deepEqual(timeline.snapshot().slots.map((s) => s.dueTime).sort(), [1200n, 1500n]);

  timeline.removePool("0x" + "02".repeat(32));
  assert.equal(timeline.snapshot().slots.length, 1);
  assert.equal(clearCalls.length, 1, "empty slot timer is cleared");

  timeline.scheduleCreate(cadence(), 1600n);
  const createSlot = timeline.snapshot().slots.find((s) => s.dueTime === 1600n);
  assert.equal(createSlot.entries[0].kind, "create");

  timers.get(createSlot.timerId).fn();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].dueTime, 1600n);
  assert.equal(fired[0].entries[0].kind, "create");
});
