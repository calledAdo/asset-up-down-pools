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

test("pool wake with a lagging oracle tick re-arms on the retry grid, not a 0ms spin", async () => {
  const timeline = fakeTimeline();
  // OPEN, wall-clock past start, but the oracle cell hasn't advanced past start yet
  // (pt < startTime) — decide returns null. The pool must NOT be re-armed at `now`
  // (which would busy-poll the node), but at the next wall-clock retry-grid slot.
  const openPool = poolView({ status: 0, startTime: 1600n, closeTime: 1900n });
  const executed = [];
  const keeper = new Keeper({
    cadences: [new Cadence(lane)],
    timeline,
    retryDelaySecs: 5n,
    clock: () => 1600n, // wall clock; slot = (1600/5 + 1)*5 = 1605
    reconcile: async () => {},
    chain: {
      now: async () => 1600n,
      listOwnPools: async () => [],
      readPool: async () => openPool, // still OPEN on the post-read (tick behind)
    },
    oracle: { readCurrentTick: async () => tick(1500n) }, // pt < startTime -> decide null
    executor: {
      executeDecisions: async (a) => { executed.push(...a); return []; },
      executeCreate: async () => ({ action: "create", skipped: false }),
    },
  });

  await keeper.start();
  timeline.calls.length = 0;
  await keeper.onWake(1600n, [{ kind: "pool", poolId: POOL }]);

  assert.deepEqual(executed, [], "nothing to execute while the tick lags");
  assert.deepEqual(timeline.calls, [["pool", POOL, 1605n]], "re-armed on the next retry-grid slot");
});

test("lagging-tick retries from separate wakes snap to the same grid slot (coalesce)", async () => {
  const timeline = fakeTimeline();
  const openPool = poolView({ status: 0, startTime: 1600n, closeTime: 1900n });
  let wall = 1601n; // mutable wall clock
  const keeper = new Keeper({
    cadences: [new Cadence(lane)],
    timeline,
    retryDelaySecs: 5n,
    clock: () => wall,
    reconcile: async () => {},
    chain: { now: async () => 1600n, listOwnPools: async () => [], readPool: async () => openPool },
    oracle: { readCurrentTick: async () => tick(1500n) }, // always behind -> decide null
    executor: { executeDecisions: async () => [], executeCreate: async () => ({ action: "create", skipped: false }) },
  });

  await keeper.start();
  timeline.calls.length = 0;

  await keeper.onWake(1600n, [{ kind: "pool", poolId: POOL }]); // wall 1601 -> slot 1605
  wall = 1603n;
  await keeper.onWake(1600n, [{ kind: "pool", poolId: POOL }]); // wall 1603 -> slot 1605 (same window)

  // Both retries target the SAME 5s grid bucket despite different wall-clock reads —
  // in the real Timeline they'd merge into one slot and fire in one batched wake.
  assert.deepEqual(timeline.calls, [
    ["pool", POOL, 1605n],
    ["pool", POOL, 1605n],
  ]);
});

test("onSweep re-arms every live pool and re-seeds one create wake per cadence", async () => {
  const timeline = fakeTimeline();
  const locked = poolView({ status: 1, startTime: 1600n, closeTime: 1900n, startPrice: 100n, usedPt: 1600n });
  const keeper = new Keeper({
    cadences: [new Cadence(lane)],
    timeline,
    reconcile: async () => {},
    chain: {
      now: async () => 1700n,
      listOwnPools: async () => [locked],
      readPool: async () => locked,
    },
    oracle: { readCurrentTick: async () => null },
    executor: { executeDecisions: async () => [], executeCreate: async () => ({ action: "create", skipped: false }) },
  });

  await keeper.start();
  timeline.calls.length = 0;
  await keeper.onSweep();

  // LOCKED -> next boundary is closeTime (1900, future); create re-seeded at
  // boundaryAtOrAfter(1700) = 1900 (firstCreateAt 1300 + 2*300).
  assert.deepEqual(timeline.calls, [
    ["pool", POOL, 1900n],
    ["create", "BTC-5m", 1900n],
  ]);
});

test("a create wake while winding down neither mints nor re-arms the next create", async () => {
  const timeline = fakeTimeline();
  const creates = [];
  const keeper = new Keeper({
    cadences: [new Cadence(lane)],
    timeline,
    reconcile: async () => {},
    chain: { now: async () => 1500n, listOwnPools: async () => [], readPool: async () => null },
    oracle: { readCurrentTick: async () => null },
    executor: {
      executeDecisions: async () => [],
      executeCreate: async (a) => { creates.push(a); return { action: "create", skipped: false }; },
    },
  });

  await keeper.start(); // seeds a create wake (not winding down yet)
  keeper.setWindingDown(true);
  timeline.calls.length = 0;
  await keeper.onWake(1585n, [{ kind: "create", cadence: new Cadence(lane), boundary: 1600n }]);

  assert.deepEqual(creates, [], "no pool minted while winding down");
  assert.deepEqual(timeline.calls, [], "next create not re-armed while winding down");
});

test("onSweep does not re-seed creates while winding down", async () => {
  const timeline = fakeTimeline();
  const locked = poolView({ status: 1, startTime: 1600n, closeTime: 1900n, startPrice: 100n, usedPt: 1600n });
  const keeper = new Keeper({
    cadences: [new Cadence(lane)],
    timeline,
    reconcile: async () => {},
    chain: { now: async () => 1700n, listOwnPools: async () => [locked], readPool: async () => locked },
    oracle: { readCurrentTick: async () => null },
    executor: { executeDecisions: async () => [], executeCreate: async () => ({ action: "create", skipped: false }) },
  });
  keeper.setWindingDown(true);

  await keeper.start();
  timeline.calls.length = 0;
  await keeper.onSweep();

  assert.deepEqual(timeline.calls, [["pool", POOL, 1900n]], "existing pool re-armed, no new create");
});
