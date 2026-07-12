//! Keeper runtime fixture: startup scheduling and pool wake execution using fakes.
//! No chain node, wallet, DB, or real timers.

import test from "node:test";
import assert from "node:assert/strict";

import { Cadence, Keeper } from "../dist/index.js";

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

function poolView(overrides = {}) {
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
      startTime: overrides.startTime ?? 1600n,
      closeTime: overrides.closeTime ?? 1900n,
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

function fakeTimeline() {
  const calls = [];
  return {
    calls,
    schedulePool: (poolId, dueTime) => calls.push(["pool", poolId, dueTime]),
    scheduleCreate: (cadence, dueTime) => calls.push(["create", cadence.label, dueTime]),
    removePool: (poolId) => calls.push(["remove", poolId]),
    cancelAll: () => calls.push(["cancel"]),
  };
}

test("start reconciles, schedules every live pool, and seeds one create wake per cadence", async () => {
  const timeline = fakeTimeline();
  let reconciled = 0;
  const keeper = new Keeper({
    cadences: [new Cadence(lane)],
    timeline,
    reconcile: async () => { reconciled++; },
    chain: {
      now: async () => 1500n,
      listOwnPools: async () => [poolView()],
      readPool: async () => null,
    },
    oracle: { readCurrentTick: async () => null },
    executor: { executeDecisions: async () => [], executeCreate: async () => ({ action: "create", skipped: false }) },
  });

  await keeper.start();

  assert.equal(reconciled, 1);
  assert.deepEqual(timeline.calls, [
    ["pool", POOL, 1600n],
    ["create", "BTC-5m", 1600n],
  ]);
});

test("pool wake reads fresh state, executes the decided action, then re-arms from post-state", async () => {
  const timeline = fakeTimeline();
  const before = poolView({ status: 0, startTime: 1600n, closeTime: 1900n });
  const after = poolView({ status: 1, startTime: 1600n, closeTime: 1900n, startPrice: 100n, usedPt: 1600n });
  let reads = 0;
  const executed = [];
  const keeper = new Keeper({
    cadences: [new Cadence(lane)],
    timeline,
    reconcile: async () => {},
    chain: {
      now: async () => 1600n,
      listOwnPools: async () => [],
      readPool: async () => (++reads === 1 ? before : after),
    },
    oracle: { readCurrentTick: async (feedId) => (feedId === FEED ? tick(1600n) : null) },
    executor: {
      executeDecisions: async (actions) => {
        executed.push(...actions);
        return actions.map((a) => ({ action: a.kind, skipped: false, txHash: "0x" + "ab".repeat(32) }));
      },
      executeCreate: async () => ({ action: "create", skipped: false }),
    },
  });

  await keeper.start();
  timeline.calls.length = 0;
  reads = 0;
  await keeper.onWake(1600n, [{ kind: "pool", poolId: POOL }]);

  assert.deepEqual(executed, [{ kind: "activate", poolId: POOL, feedId: FEED, oracle: tick(1600n) }]);
  assert.deepEqual(timeline.calls, [["pool", POOL, 1900n]]);
});
