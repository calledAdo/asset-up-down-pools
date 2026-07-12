//! Phase 2 fixture: the pure planner over the lifecycle×timing matrix. Builds
//! synthetic PoolViews and asserts the emitted Action set. No chain.

import test from "node:test";
import assert from "node:assert/strict";

import { plan, nextKeeperWake } from "../dist/index.js";

const FEED = "0x" + "fe".repeat(32);
const DUR = 900n; // price window; rounds tile time at multiples of 900
const LEAD = 0n; // grid model: lead is a small pre-stage; 0 keeps the math clean

const LANE = {
  label: "BTC-15m",
  feedId: FEED,
  durationSecs: DUR,
  rakeBps: 200,
  asset: { kind: "ckb" },
  oracleIdentity: {
    oracleTypeCodeHash: "0x" + "11".repeat(32),
    guardianSetTypeHash: "0x" + "22".repeat(32),
    emitterChain: 26,
    emitterAddress: "0x" + "33".repeat(32),
  },
  createLeadSecs: LEAD,
};
const onlyTransitions = (actions) =>
  actions.filter((a) => a.kind === "activate" || a.kind === "resolve" || a.kind === "finalize");

// STATUS_*: OPEN=0 LOCKED=1 SETTLED=2 VOID=4 FINALIZED=5
function poolView({ id = "01", status, startTime, closeTime, winner = 0 }) {
  return {
    poolId: "0x" + id.repeat(32),
    outPoint: { txHash: "0x" + "0a".repeat(32), index: 0 },
    typeScript: { codeHash: "0x" + "00".repeat(32), hashType: "data2", args: "0x" + id.repeat(32) },
    lock: { codeHash: "0x" + "00".repeat(32), hashType: "data2", args: "0x" },
    capacity: 9_000_000_000n,
    data: {
      variant: 0,
      feedId: FEED,
      startTime: BigInt(startTime),
      closeTime: BigInt(closeTime),
      status,
      winner,
      upTotal: 0n,
      downTotal: 0n,
    },
  };
}


test("empty lane bootstraps a CREATE at the next grid boundary", () => {
  const now = 1000n; // next 900-grid boundary is 1800
  const actions = plan({ now, pools: [], lanes: [LANE] });
  assert.equal(actions.length, 1);
  const c = actions[0];
  assert.equal(c.kind, "create");
  assert.equal(c.startTime, 1800n);
  assert.equal(c.closeTime, 2700n);
  assert.equal(c.roundKey, `${FEED}:${DUR}@1800`);
});

test("the current OPEN target already exists -> no duplicate CREATE", () => {
  const now = 1000n; // target 1800
  const pool = poolView({ status: 0, startTime: 1800, closeTime: 2700 });
  const actions = plan({ now, pools: [pool], lanes: [LANE] });
  assert.deepEqual(actions, []); // exists -> no create; now<start -> no transition
});

test("OPEN past start -> ACTIVATE with minPublishTime=startTime", () => {
  const now = 1800n;
  const pool = poolView({ status: 0, startTime: 1800, closeTime: 2700 });
  const actions = plan({ now, pools: [pool], lanes: [LANE] });
  const t = onlyTransitions(actions);
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, "activate");
  assert.equal(t[0].poolId, pool.poolId);
  assert.equal(t[0].minPublishTime, 1800n);
});

test("LOCKED past close -> RESOLVE with minPublishTime=closeTime", () => {
  const now = 2700n;
  const pool = poolView({ status: 1, startTime: 1800, closeTime: 2700 });
  const t = onlyTransitions(plan({ now, pools: [pool], lanes: [LANE] }));
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, "resolve");
  assert.equal(t[0].minPublishTime, 2700n);
});

test("LOCKED before close -> no transition", () => {
  const now = 2400n;
  const pool = poolView({ status: 1, startTime: 1800, closeTime: 2700 });
  assert.deepEqual(onlyTransitions(plan({ now, pools: [pool], lanes: [LANE] })), []);
});

test("SETTLED past void_time -> FINALIZE (void=close+grace, 15m grace=90)", () => {
  const now = 2700n + 90n;
  const pool = poolView({ status: 2, startTime: 1800, closeTime: 2700 });
  const t = onlyTransitions(plan({ now, pools: [pool], lanes: [LANE] }));
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, "finalize");
  assert.equal(t[0].minPublishTime, 2700n + 90n);
});

test("SETTLED before void_time -> no transition", () => {
  const now = 2700n + 89n;
  const pool = poolView({ status: 2, startTime: 1800, closeTime: 2700 });
  assert.deepEqual(onlyTransitions(plan({ now, pools: [pool], lanes: [LANE] })), []);
});

// duration = 2700-1800 = 900, so closeGrace = clamp(900*8, 1h, 7d) = 7200s.
const CLOSE_GRACE = 7200n;

test("FINALIZED at the teardown-grace boundary -> no CLOSE (not strictly past)", () => {
  const close = 2700n;
  const now = close + CLOSE_GRACE; // exactly the boundary
  const pool = poolView({ status: 5, startTime: 1800, closeTime: Number(close), winner: 1 });
  const actions = plan({ now, pools: [pool], lanes: [LANE] });
  assert.deepEqual(actions.filter((a) => a.kind === "close"), []);
});

test("FINALIZED past teardown grace -> CLOSE", () => {
  const close = 2700n;
  const now = close + CLOSE_GRACE + 1n;
  const pool = poolView({ status: 5, startTime: 1800, closeTime: Number(close), winner: 1 });
  const actions = plan({ now, pools: [pool], lanes: [LANE] });
  assert.ok(actions.some((a) => a.kind === "close" && a.poolId === pool.poolId));
});

test("FINALIZED just before teardown grace -> no CLOSE", () => {
  const close = 2700n;
  const now = close + CLOSE_GRACE - 1n;
  const pool = poolView({ status: 5, startTime: 1800, closeTime: Number(close), winner: 1 });
  const actions = plan({ now, pools: [pool], lanes: [LANE] });
  assert.deepEqual(actions.filter((a) => a.kind === "close"), []);
});

test("VOID past teardown grace -> CLOSE (refund pools tear down too)", () => {
  const close = 2700n;
  const now = close + CLOSE_GRACE + 1n;
  const pool = poolView({ status: 4, startTime: 1800, closeTime: Number(close), winner: 3 });
  const actions = plan({ now, pools: [pool], lanes: [LANE] });
  assert.ok(actions.some((a) => a.kind === "close"));
});

test("rolling: as the running round locks, the next grid round is created", () => {
  // current round [1800,2700] LOCKED; deposits for the next round [2700,3600] open now
  const now = 2400n; // inside [1800,2700]; next boundary is 2700
  const pool = poolView({ status: 1, startTime: 1800, closeTime: 2700 });
  const actions = plan({ now, pools: [pool], lanes: [LANE] });
  const create = actions.find((a) => a.kind === "create");
  assert.ok(create, "expected a next-round create");
  assert.equal(create.startTime, 2700n);
  assert.equal(create.closeTime, 3600n);
});

test("rolling: both current-open and next round present -> no CREATE (idempotent)", () => {
  const now = 2400n; // target boundary 2700 already exists
  const locked = poolView({ id: "01", status: 1, startTime: 1800, closeTime: 2700 });
  const open = poolView({ id: "02", status: 0, startTime: 2700, closeTime: 3600 });
  const actions = plan({ now, pools: [locked, open], lanes: [LANE] });
  assert.equal(actions.find((a) => a.kind === "create"), undefined);
});

test("near a boundary with a lead: both the open round and the pre-staged next are ensured", () => {
  const lane = { ...LANE, createLeadSecs: 60n };
  const now = 2660n; // 40s before boundary 2700; now+lead=2720 -> also targets 3600
  const actions = plan({ now, pools: [], lanes: [lane] });
  const starts = actions.filter((a) => a.kind === "create").map((c) => c.startTime).sort();
  assert.deepEqual(starts, [2700n, 3600n]);
});

test("pools outside configured lanes are ignored for CREATE but still transition", () => {
  const now = 1800n;
  const otherFeedPool = { ...poolView({ status: 0, startTime: 1800, closeTime: 2700 }) };
  otherFeedPool.data = { ...otherFeedPool.data, feedId: "0x" + "ee".repeat(32) };
  const actions = plan({ now, pools: [otherFeedPool], lanes: [LANE] });
  assert.ok(actions.some((a) => a.kind === "activate")); // off-lane pool still transitions
  assert.ok(actions.some((a) => a.kind === "create")); // configured lane bootstraps
});

test("multiple lanes each get independent grid CREATE accounting", () => {
  const laneB = { ...LANE, label: "BTC-1h", durationSecs: 3600n, feedId: FEED };
  const now = 1000n;
  const actions = plan({ now, pools: [], lanes: [LANE, laneB] });
  const creates = actions.filter((a) => a.kind === "create");
  assert.equal(creates.length, 2);
  // 900-grid: next boundary 1800 -> close 2700; 3600-grid: next boundary 3600 -> close 7200
  assert.deepEqual(creates.map((c) => c.closeTime).sort((a, b) => Number(a - b)), [2700n, 7200n]);
});

// ---- nextKeeperWake: sleep-to-next-event, POOL-STATE driven (no empty wakes) ----

test("nextKeeperWake with no pools wakes at the lane's next CREATE boundary", () => {
  // DUR=900, now=1000 → next round boundary 1800 (lead 0). The only pending work.
  assert.equal(nextKeeperWake(1000n, [], [LANE]), 1800n);
});

test("nextKeeperWake: a LOCKED pool wakes at its resolve (close)", () => {
  const pool = poolView({ status: 1, startTime: 900, closeTime: 1800 });
  assert.equal(nextKeeperWake(1000n, [pool], [LANE]), 1800n);
});

test("nextKeeperWake: a SETTLED pool drives the finalize wake (close+grace)", () => {
  // close 1800 + grace(900)=90 = 1890. now past close, before void.
  const pool = poolView({ status: 2, startTime: 900, closeTime: 1800 });
  assert.equal(nextKeeperWake(1850n, [pool], [LANE]), 1890n);
});

test("nextKeeperWake: NO finalize wake without a SETTLED pool (not grid-invented)", () => {
  // Regression guard: the old grid model returned 1890 here from boundary+grace.
  // Now finalize is pool-driven, so with no pool the soonest is the create boundary.
  assert.equal(nextKeeperWake(1850n, [], [LANE]), 2700n);
});

test("nextKeeperWake: a FINALIZED pool wakes at teardown (close+closeGrace)", () => {
  // closeGrace(900) = clamp(7200, 1h, 7d) = 7200; 1800 + 7200 = 9000. No lane → isolate.
  const pool = poolView({ status: 5, startTime: 900, closeTime: 1800, winner: 1 });
  assert.equal(nextKeeperWake(5000n, [pool], []), 9000n);
});

test("nextKeeperWake takes the minimum across pools (coincident events fold to one wake)", () => {
  const locked = poolView({ id: "01", status: 1, startTime: 900, closeTime: 1800 }); // resolve 1800
  const settled = poolView({ id: "02", status: 2, startTime: 0, closeTime: 900 }); // finalize 990
  assert.equal(nextKeeperWake(950n, [locked, settled], [LANE]), 990n);
});

test("nextKeeperWake is null when there are no lanes and no pools", () => {
  assert.equal(nextKeeperWake(1000n, [], []), null);
});
