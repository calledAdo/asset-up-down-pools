//! LiveOracleSource fixture: the pure read→advance-on-miss→read orchestration,
//! exercised with stubbed effects (no chain, no Hermes).

import test from "node:test";
import assert from "node:assert/strict";

import { LiveOracleSource, ReadOnlyOracleSource, OracleWorker } from "../dist/index.js";

const FEED = "0x" + "e6".repeat(32);
const TXH = "0x" + "ab".repeat(32);

const cell = (pt, price = 100n) => ({ outPoint: { txHash: TXH, index: 0 }, data: { price, publishTimeUnix: pt } });

test("returns a tick directly when the cell already satisfies the floor (no advance)", async () => {
  let advances = 0;
  const src = new LiveOracleSource({
    readCell: async (_f, min) => (min <= 1000n ? cell(1000n, 555n) : undefined),
    advance: async () => { advances++; },
  });
  const tick = await src.getTickAtOrAfter(FEED, 1000n);
  assert.equal(advances, 0, "must not advance when the cell is already in-band");
  assert.deepEqual(tick, {
    feedId: FEED,
    price: 555n,
    publishTimeUnix: 1000n,
    cellDep: { outPoint: { txHash: TXH, index: 0 }, depType: "code" },
  });
});

test("advances once then re-reads when the cell is behind the boundary", async () => {
  let advances = 0;
  let advanced = false;
  const src = new LiveOracleSource({
    // Behind the floor until advance() runs, then a fresh in-band cell appears.
    readCell: async () => (advanced ? cell(1500n, 777n) : undefined),
    advance: async (_f, min) => { advances++; advanced = true; assert.equal(min, 1500n); },
  });
  const tick = await src.getTickAtOrAfter(FEED, 1500n);
  assert.equal(advances, 1, "advances exactly once on a miss");
  assert.equal(tick?.publishTimeUnix, 1500n);
  assert.equal(tick?.price, 777n);
});

test("returns null when advance fails (no tick — keeper skips, round can VOID)", async () => {
  const src = new LiveOracleSource({
    readCell: async () => undefined,
    advance: async () => { throw new Error("hermes/network down"); },
    log: () => {},
  });
  assert.equal(await src.getTickAtOrAfter(FEED, 2000n), null);
});

test("returns null when the cell is still missing after a successful advance", async () => {
  let advances = 0;
  const src = new LiveOracleSource({
    readCell: async () => undefined, // never satisfies the floor
    advance: async () => { advances++; },
  });
  assert.equal(await src.getTickAtOrAfter(FEED, 3000n), null);
  assert.equal(advances, 1, "tries one advance, then gives up");
});

const FEED2 = "0x" + "f2".repeat(32);

// ---------- ReadOnlyOracleSource (the keeper's read-only path) ----------

test("ReadOnlyOracleSource returns a tick when the cell satisfies the floor", async () => {
  const src = new ReadOnlyOracleSource(async (_f, min) => (min <= 1000n ? cell(1000n, 555n) : undefined));
  const tick = await src.getTickAtOrAfter(FEED, 1000n);
  assert.equal(tick?.publishTimeUnix, 1000n);
  assert.equal(tick?.price, 555n);
  assert.deepEqual(tick?.cellDep, { outPoint: { txHash: TXH, index: 0 }, depType: "code" });
});

test("ReadOnlyOracleSource returns null when the cell is behind — never advances", async () => {
  let reads = 0;
  const src = new ReadOnlyOracleSource(async () => { reads++; return undefined; }, () => {});
  assert.equal(await src.getTickAtOrAfter(FEED, 2000n), null);
  assert.equal(reads, 1, "reads once, no advance, no retry");
});

// ---------- OracleWorker scheduling ----------

const lane = (feedId, durationSecs) => ({ label: "L", feedId, durationSecs, rakeBps: 0, asset: { kind: "ckb" }, oracleIdentity: {}, createLeadSecs: 0n });
const noSource = { getTickAtOrAfter: async () => null };

test("OracleWorker.nextDue picks the next grid boundary across feeds", () => {
  // BTC 5m (300s) feed=FEED, ETH 15m (900s) feed=FEED2. now=1000.
  // BTC next boundary = 1200; ETH = 1800 → min boundary = 1200 (FEED).
  const w = new OracleWorker({ source: noSource, lanes: [lane(FEED, 300n), lane(FEED2, 900n)], now: () => 1000n });
  const due = w.nextDue();
  assert.equal(due.time, 1200n);
  assert.deepEqual(due.feeds, [FEED]);
});

test("OracleWorker.nextDue includes boundary+grace (for finalize/VOID)", () => {
  // now=910: BTC 5m grace=clamp(30,60,600)=60 → prevB=900, 900+60=960 > 910 → grace time 960
  // beats the next boundary (1200). So the next due is the grace time.
  const w = new OracleWorker({ source: noSource, lanes: [lane(FEED, 300n)], now: () => 910n });
  const due = w.nextDue();
  assert.equal(due.time, 960n, "boundary+grace is in the schedule, not just boundaries");
  assert.deepEqual(due.feeds, [FEED]);
});

test("OracleWorker.nextDue honours a non-zero firstCreateAt (anchored grid, not epoch)", () => {
  // duration 300, anchor 1000 → boundaries at …1000, 1300, 1600. now=1100 → next is 1300.
  // Epoch alignment (now/d+1)*d would give 1200; the anchor MUST shift it, so the
  // worker advances the same cell moment the keeper's anchored Cadence waits on.
  const anchored = { ...lane(FEED, 300n), firstCreateAt: 1000n };
  const w = new OracleWorker({ source: noSource, lanes: [anchored], now: () => 1100n });
  assert.equal(w.nextDue().time, 1300n, "boundary is anchored at firstCreateAt + k·duration");
});

test("OracleWorker.advance never overlaps and isolates feed errors", async () => {
  let inFlight = 0, maxConcurrent = 0, release;
  const gate = new Promise((r) => { release = r; });
  const seen = [];
  const source = {
    getTickAtOrAfter: async (f) => {
      seen.push(f);
      if (f === FEED2) throw new Error("boom");
      inFlight++; maxConcurrent = Math.max(maxConcurrent, inFlight); await gate; inFlight--; return null;
    },
  };
  const w = new OracleWorker({ source, lanes: [lane(FEED, 300n)], log: () => {} });
  const first = w.advance([{ feedId: FEED, time: 100n }]);
  const second = w.advance([{ feedId: FEED, time: 100n }]); // no-op while first in flight
  release();
  await Promise.all([first, second]);
  assert.equal(maxConcurrent, 1, "advances never overlap");
  // error isolation: an erroring feed doesn't abort the batch
  await w.advance([{ feedId: FEED2, time: 1n }, { feedId: FEED, time: 1n }]);
  assert.ok(seen.includes(FEED2) && seen.filter((f) => f === FEED).length >= 1, "erroring feed doesn't block the rest");
});
