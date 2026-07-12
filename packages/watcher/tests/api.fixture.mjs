//! Phase 5 fixture: the Fastify API over a seeded in-memory DB via inject().

import test from "node:test";
import assert from "node:assert/strict";

import { buildServer, openDb, poolToRow, poolOdds } from "../dist/index.js";

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

function poolView({ id, status, up = 0n, down = 0n }) {
  return {
    poolId: "0x" + id.repeat(32),
    outPoint: { txHash: "0x" + "0a".repeat(32), index: 0 },
    typeScript: { codeHash: "0x" + "00".repeat(32), hashType: "data2", args: "0x" + id.repeat(32) },
    lock: { codeHash: "0x" + "00".repeat(32), hashType: "data2", args: "0x" },
    capacity: 9_000_000_000n,
    data: {
      variant: 0, feedId: FEED, oracleCommit: "0x" + "c0".repeat(32),
      startTime: 1000n, closeTime: 1900n, upTotal: up, downTotal: down,
      startPrice: 0n, settlePrice: 0n, usedPt: 0n, rakeBps: 200, status, winner: status === 5 ? 1 : 0,
    },
  };
}

function seeded() {
  const db = openDb(":memory:");
  db.upsertPool(poolToRow(poolView({ id: "01", status: 0, up: 600n, down: 400n }), [LANE]), Date.now());
  db.upsertPool(poolToRow(poolView({ id: "02", status: 5, up: 600n, down: 400n }), [LANE]), Date.now());
  db.setMeta("lastIndexedAt", "123");
  return db;
}

/** Stub on-demand positions reader (the real one queries chain). */
const fakePositions = async (address, poolId) => {
  if (address !== "ckt1qexampleholder") return [];
  const all = [{ poolId: "0x" + "01".repeat(32), side: 1, amount: 600n }];
  return poolId ? all.filter((p) => p.poolId === poolId) : all;
};

test("GET /health returns ok + lastIndexedAt", async () => {
  const app = buildServer({ db: seeded(), lanes: [LANE] });
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, lastIndexedAt: "123" });
  await app.close();
});

test("GET /lanes lists the lane + its current OPEN pool", async () => {
  const app = buildServer({ db: seeded(), lanes: [LANE] });
  const lanes = (await app.inject({ method: "GET", url: "/lanes" })).json();
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].label, "BTC-15m");
  assert.equal(lanes[0].currentOpenPool.statusCode, 0);
  assert.equal(lanes[0].livePoolCount, 2);
  await app.close();
});

test("GET /pools lists all; ?status filters", async () => {
  const app = buildServer({ db: seeded(), lanes: [LANE] });
  assert.equal((await app.inject({ url: "/pools" })).json().length, 2);
  const finalized = (await app.inject({ url: "/pools?status=5" })).json();
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].status, "finalized");
  await app.close();
});

test("GET /pools/:id returns detail with odds; 404 for unknown", async () => {
  const app = buildServer({ db: seeded(), lanes: [LANE] });
  const detail = (await app.inject({ url: "/pools/0x" + "01".repeat(32) })).json();
  assert.equal(detail.status, "open");
  // odds match the pure helper (up=600, down=400, rake 2%)
  const expect = poolOdds({ upTotal: 600n, downTotal: 400n, rakeBps: 200 });
  assert.equal(detail.odds.up.pool, "600");
  assert.equal(detail.odds.total, expect.total);
  assert.ok(Math.abs(detail.odds.up.impliedProb - 0.6) < 1e-9);

  const missing = await app.inject({ url: "/pools/0x" + "ff".repeat(32) });
  assert.equal(missing.statusCode, 404);
  await app.close();
});

test("GET /positions?address= reads on-demand; 400 without address; 501 without reader", async () => {
  // No positions reader configured → 501.
  const noReader = buildServer({ db: seeded(), lanes: [LANE] });
  assert.equal((await noReader.inject({ url: "/positions?address=ckt1qexampleholder" })).statusCode, 501);
  await noReader.close();

  const app = buildServer({ db: seeded(), lanes: [LANE], positions: fakePositions });
  assert.equal((await app.inject({ url: "/positions" })).statusCode, 400); // missing address
  const pos = (await app.inject({ url: "/positions?address=ckt1qexampleholder" })).json();
  assert.equal(pos.length, 1);
  assert.equal(pos[0].side, "up");
  assert.equal(pos[0].amount, "600");
  // per-pool variant
  const perPool = (await app.inject({ url: "/pools/0x" + "01".repeat(32) + "/positions?address=ckt1qexampleholder" })).json();
  assert.equal(perPool.length, 1);
  await app.close();
});

test("GET /history returns finalized/void rounds", async () => {
  const app = buildServer({ db: seeded(), lanes: [LANE] });
  const hist = (await app.inject({ url: "/history" })).json();
  assert.equal(hist.length, 1);
  assert.equal(hist[0].status, "finalized");
  await app.close();
});

test("CORS header present on responses", async () => {
  const app = buildServer({ db: seeded(), lanes: [LANE] });
  const res = await app.inject({ url: "/health" });
  assert.equal(res.headers["access-control-allow-origin"], "*");
  assert.ok(res.headers["access-control-allow-methods"].includes("POST"));
  await app.close();
});

// A fake builder records calls + returns a sentinel hex — proves the POST routes
// validate input and forward the parsed intent (no chain / SDK needed).
function fakeBuilder(calls) {
  const rec = (name) => async (i) => {
    calls.push([name, i]);
    return "0xdeadbeef";
  };
  return { deposit: rec("deposit"), withdraw: rec("withdraw"), redeem: rec("redeem"), burn: rec("burn") };
}
const LOCK = { codeHash: "0x" + "aa".repeat(32), hashType: "data2", args: "0x1234" };
const POOL = "0x" + "01".repeat(32);

test("POST /tx/deposit forwards intent + amounts, returns { tx }", async () => {
  const calls = [];
  const app = buildServer({ db: seeded(), lanes: [LANE], txBuilder: fakeBuilder(calls) });
  const res = await app.inject({ method: "POST", url: "/tx/deposit", payload: { poolId: POOL, lock: LOCK, up: "300", down: "200" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { tx: "0xdeadbeef" });
  assert.equal(calls[0][0], "deposit");
  assert.equal(calls[0][1].upAmount, 300n);
  assert.equal(calls[0][1].downAmount, 200n);
  assert.equal(calls[0][1].poolId, POOL);
  await app.close();
});

test("POST /tx/withdraw forwards intent + amounts, returns { tx }", async () => {
  const calls = [];
  const app = buildServer({ db: seeded(), lanes: [LANE], txBuilder: fakeBuilder(calls) });
  const res = await app.inject({ method: "POST", url: "/tx/withdraw", payload: { poolId: POOL, lock: LOCK, up: "120", down: "0" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { tx: "0xdeadbeef" });
  assert.equal(calls[0][0], "withdraw");
  assert.equal(calls[0][1].upAmount, 120n);
  assert.equal(calls[0][1].downAmount, 0n);
  assert.equal(calls[0][1].poolId, POOL);
  await app.close();
});

test("POST /tx/withdraw rejects zero stake + missing fields", async () => {
  const app = buildServer({ db: seeded(), lanes: [LANE], txBuilder: fakeBuilder([]) });
  assert.equal((await app.inject({ method: "POST", url: "/tx/withdraw", payload: { poolId: POOL, lock: LOCK } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/tx/withdraw", payload: { lock: LOCK, up: "1" } })).statusCode, 400);
  await app.close();
});

test("POST /tx/deposit rejects zero stake + missing fields", async () => {
  const app = buildServer({ db: seeded(), lanes: [LANE], txBuilder: fakeBuilder([]) });
  assert.equal((await app.inject({ method: "POST", url: "/tx/deposit", payload: { poolId: POOL, lock: LOCK } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/tx/deposit", payload: { lock: LOCK, up: "1" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/tx/deposit", payload: { poolId: POOL, up: "1" } })).statusCode, 400);
  await app.close();
});

test("POST /tx/redeem + /tx/burn forward; burn passes sides", async () => {
  const calls = [];
  const app = buildServer({ db: seeded(), lanes: [LANE], txBuilder: fakeBuilder(calls) });
  assert.equal((await app.inject({ method: "POST", url: "/tx/redeem", payload: { poolId: POOL, lock: LOCK } })).statusCode, 200);
  await app.inject({ method: "POST", url: "/tx/burn", payload: { poolId: POOL, lock: LOCK, sides: [2] } });
  assert.equal(calls[0][0], "redeem");
  assert.equal(calls[1][0], "burn");
  assert.deepEqual(calls[1][1].sides, [2]);
  await app.close();
});

test("POST /tx/* surfaces builder failure as 422", async () => {
  const app = buildServer({
    db: seeded(),
    lanes: [LANE],
    txBuilder: { deposit: async () => { throw new Error("no shares to burn"); }, redeem: async () => "0x", burn: async () => "0x" },
  });
  const res = await app.inject({ method: "POST", url: "/tx/deposit", payload: { poolId: POOL, lock: LOCK, up: "1" } });
  assert.equal(res.statusCode, 422);
  assert.match(res.json().error, /no shares/);
  await app.close();
});

test("POST /tx/* is absent (404) when no txBuilder is configured", async () => {
  const app = buildServer({ db: seeded(), lanes: [LANE] });
  const res = await app.inject({ method: "POST", url: "/tx/deposit", payload: { poolId: POOL, lock: LOCK, up: "1" } });
  assert.equal(res.statusCode, 404);
  await app.close();
});
