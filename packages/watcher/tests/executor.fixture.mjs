//! Phase 4 fixture: the executor against a fake keeper/signer/client and an
//! in-memory DB — idempotency guard, no-tick skip, success + failure paths.

import test from "node:test";
import assert from "node:assert/strict";

import { execute, executeDecisions, openDb, StubOracleSource } from "../dist/index.js";

const FEED = "0x" + "fe".repeat(32);
const POOL = "0x" + "01".repeat(32);
const TXH = "0x" + "ab".repeat(32);
const CREATOR = { codeHash: "0x" + "00".repeat(32), hashType: "data2", args: "0xcreator" };

function fakeKeeper(overrides = {}) {
  const calls = [];
  const rec = (name) => async (p) => {
    calls.push({ name, p });
    return { name };
  };
  return {
    calls,
    draftCreate: overrides.draftCreate ?? rec("create"),
    draftActivate: overrides.draftActivate ?? rec("activate"),
    draftResolve: overrides.draftResolve ?? rec("resolve"),
    draftFinalize: overrides.draftFinalize ?? rec("finalize"),
    draftClose: overrides.draftClose ?? rec("close"),
    draftTransitionBatch: overrides.draftTransitionBatch ?? (async (items) => {
      calls.push({ name: "batch", items });
      return { name: "batch", items };
    }),
    complete: async (tx) => tx,
  };
}

const fakeSigner = { sendTransaction: async () => TXH };

function fakeClient(hasCell = true) {
  return {
    async *findCells() {
      if (hasCell) yield { outPoint: { txHash: "0x" + "0a".repeat(32), index: 0 } };
    },
    waitTransaction: async () => ({}),
  };
}

const tickOracle = {
  getTickAtOrAfter: async (feedId, min) => ({
    feedId,
    price: 12345n,
    publishTimeUnix: min + 1n,
    cellDep: { outPoint: { txHash: "0x" + "cd".repeat(32), index: 0 }, depType: "code" },
  }),
};

const oracleTick = (feedId, publishTimeUnix, txHash = "0x" + "cd".repeat(32)) => ({
  feedId,
  price: 12345n,
  publishTimeUnix,
  cellDep: { outPoint: { txHash, index: 0 }, depType: "code" },
});

function ctx(over = {}) {
  return {
    keeper: over.keeper ?? fakeKeeper(),
    signer: fakeSigner,
    client: over.client ?? fakeClient(),
    creatorLock: CREATOR,
    oracle: over.oracle ?? new StubOracleSource(),
    db: over.db ?? openDb(":memory:"),
    refresh: over.refresh,
    log: () => {},
  };
}

const FEED_B = "0x" + "ed".repeat(32);
const POOL2 = "0x" + "02".repeat(32);

const createAction = {
  kind: "create",
  lane: { label: "BTC-15m", feedId: FEED, durationSecs: 900n, rakeBps: 200, asset: { kind: "ckb" }, oracleIdentity: { oracleTypeCodeHash: "0x" + "11".repeat(32), guardianSetTypeHash: "0x" + "22".repeat(32), emitterChain: 26, emitterAddress: "0x" + "33".repeat(32) }, createLeadSecs: 300n },
  laneKey: `${FEED}:900`,
  roundKey: `${FEED}:900@1900`,
  startTime: 1900n,
  closeTime: 2800n,
};

test("CREATE: builds via keeper, broadcasts, logs committed", async () => {
  const c = ctx();
  const r = await execute(createAction, c);
  assert.equal(r.skipped, false);
  assert.equal(r.txHash, TXH);
  assert.equal(c.keeper.calls[0].name, "create");
  // oracleCommit was derived (32-byte hex), seed input wired
  assert.match(c.keeper.calls[0].p.oracleCommit, /^0x[0-9a-f]{64}$/);
  assert.equal(c.keeper.calls[0].p.startTime, 1900n);
  assert.equal(c.db.hasOpenCreate(createAction.roundKey), true); // committed rows still "open"
});

test("CREATE: idempotency guard skips a second fire for the same round", async () => {
  const c = ctx();
  await execute(createAction, c);
  const r2 = await execute(createAction, c);
  assert.equal(r2.skipped, true);
  assert.match(r2.reason, /in-flight/);
  assert.equal(c.keeper.calls.length, 1);
});

test("CREATE: missing creator cell -> failure recorded, guard cleared", async () => {
  const c = ctx({ client: fakeClient(false) });
  const r = await execute(createAction, c);
  assert.equal(r.skipped, false);
  assert.match(r.reason, /no live cell/);
  assert.equal(c.db.hasOpenCreate(createAction.roundKey), false); // failed -> not open
});

const activateAction = { kind: "activate", poolId: POOL, feedId: FEED, minPublishTime: 1900n };

test("ACTIVATE: no tick (stub) -> skipped, nothing logged", async () => {
  const c = ctx();
  const r = await execute(activateAction, c);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, "no tick");
  assert.equal(c.db.hasOpenAction(POOL, "activate"), false);
});

test("ACTIVATE: with a tick -> drafts with the resolved tick, committed", async () => {
  const c = ctx({ oracle: tickOracle });
  const r = await execute(activateAction, c);
  assert.equal(r.skipped, false);
  assert.equal(r.txHash, TXH);
  assert.equal(c.keeper.calls[0].name, "activate");
  assert.equal(c.keeper.calls[0].p.poolId, POOL);
  assert.equal(c.keeper.calls[0].p.oracle.publishTimeUnix, 1901n);
});

test("ACTIVATE: in-flight guard skips while a prior activate is open", async () => {
  const c = ctx({ oracle: tickOracle });
  await execute(activateAction, c);
  const r2 = await execute(activateAction, c);
  assert.equal(r2.skipped, true);
  assert.match(r2.reason, /in-flight/);
});

test("CLOSE: oracle-free, drafts close with creator lock", async () => {
  const c = ctx();
  const r = await execute({ kind: "close", poolId: POOL }, c);
  assert.equal(r.skipped, false);
  assert.equal(c.keeper.calls[0].name, "close");
  assert.equal(c.keeper.calls[0].p.creatorLock.args, "0xcreator");
});

test("failure path: keeper throws -> failed logged and returned", async () => {
  const keeper = fakeKeeper({
    draftFinalize: async () => {
      throw new Error("vm rejected");
    },
  });
  const c = ctx({ keeper, oracle: tickOracle });
  const r = await execute({ kind: "finalize", poolId: POOL, feedId: FEED, minPublishTime: 2000n }, c);
  assert.equal(r.skipped, false);
  assert.match(r.reason, /vm rejected/);
  assert.equal(c.db.hasOpenAction(POOL, "finalize"), false);
});

// ---- executeDecisions: fold coincident transitions, group by oracle cell ----
// Transition actions carry the exact tick decide() chose, so there is no oracle
// lookup; grouping/fallback/refresh live in the shared runBatchGroup.

const resolveDec = (txHash) => ({ kind: "resolve", poolId: POOL, feedId: FEED, oracle: oracleTick(FEED, 2701n, txHash) });
const activateDec = (poolId, feedId, txHash) => ({ kind: "activate", poolId, feedId, oracle: oracleTick(feedId, 2701n, txHash) });

test("decisions: coincident transitions on one cell -> a single tx", async () => {
  const c = ctx(); // both actions default to the same oracle cell
  const rs = await executeDecisions([resolveDec(), activateDec(POOL2, FEED)], c);
  assert.equal(rs.length, 2);
  assert.ok(rs.every((r) => !r.skipped && r.txHash === TXH));
  const batches = c.keeper.calls.filter((k) => k.name === "batch");
  assert.equal(batches.length, 1, "one merged tx");
  assert.equal(batches[0].items.length, 2);
  assert.equal(c.db.hasOpenAction(POOL, "resolve"), true);
  assert.equal(c.db.hasOpenAction(POOL2, "activate"), true);
});

test("decisions: groups by oracle cell (different cells -> separate txs)", async () => {
  const c = ctx();
  const rs = await executeDecisions(
    [resolveDec("0x" + "c1".repeat(32)), activateDec(POOL2, FEED_B, "0x" + "c2".repeat(32))],
    c,
  );
  assert.equal(rs.length, 2);
  const batches = c.keeper.calls.filter((k) => k.name === "batch");
  assert.equal(batches.length, 2, "one tx per oracle cell");
  assert.ok(batches.every((b) => b.items.length === 1));
});

test("decisions: an in-flight action is reported skipped and not re-sent", async () => {
  const c = ctx();
  c.db.insertTxLog({ poolId: POOL, action: "resolve", status: "sent" }); // already open
  const rs = await executeDecisions([resolveDec()], c);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].skipped, true);
  assert.match(rs[0].reason, /in-flight/);
  assert.equal(c.keeper.calls.filter((k) => k.name === "batch").length, 0);
});

test("decisions: a failing batch falls back to per-pool txs (good ones still land)", async () => {
  const keeper = fakeKeeper({
    draftTransitionBatch: async (items) => {
      keeper.calls.push({ name: "batch", items });
      if (items.length > 1) throw new Error("stale PoolCell in batch");
      return { name: "batch", items };
    },
  });
  const c = ctx({ keeper });
  const rs = await executeDecisions([resolveDec(), activateDec(POOL2, FEED)], c);
  const batches = keeper.calls.filter((k) => k.name === "batch");
  assert.equal(batches.length, 3, "1 failed merged attempt + 2 singleton fallbacks");
  assert.equal(batches[0].items.length, 2);
  assert.ok(batches.slice(1).every((b) => b.items.length === 1));
  // Both pools committed via the fallback singletons.
  assert.equal(c.db.hasOpenAction(POOL, "resolve"), true);
  assert.equal(c.db.hasOpenAction(POOL2, "activate"), true);
  assert.ok(rs.every((r) => r.txHash === TXH));
});

test("decisions: refresh (cache clear) runs before each build", async () => {
  let refreshes = 0;
  const c = ctx({ refresh: async () => { refreshes += 1; } });
  await executeDecisions([resolveDec(), activateDec(POOL2, FEED)], c);
  assert.equal(refreshes, 1, "one build for the one group");
});

test("decisions: pre-resolved correction actions batch without oracle lookup", async () => {
  let oracleReads = 0;
  const c = ctx({
    oracle: {
      getTickAtOrAfter: async () => {
        oracleReads++;
        return null;
      },
    },
  });
  const rs = await executeDecisions(
    [
      { kind: "correct-start", poolId: POOL, feedId: FEED, oracle: oracleTick(FEED, 1600n) },
      { kind: "correct-settle", poolId: POOL2, feedId: FEED, oracle: oracleTick(FEED, 1900n) },
    ],
    c,
  );
  assert.equal(oracleReads, 0, "decision execution uses the tick chosen by decide()");
  assert.equal(rs.length, 2);
  assert.ok(rs.every((r) => !r.skipped && r.txHash === TXH));
  const batches = c.keeper.calls.filter((k) => k.name === "batch");
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].items.map((it) => it.kind), ["correct-start", "correct-settle"]);
});
