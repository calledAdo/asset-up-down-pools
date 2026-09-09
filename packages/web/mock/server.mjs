//! Zero-dependency stub of the watcher REST API, so the frontend can be demoed
//! with live-feeling data before the real backend is stood up. It mirrors the
//! contract in packages/web/src/api/types.ts: every on-chain integer is a decimal
//! STRING (shannons / unix seconds), and round timings are computed relative to
//! NOW on each request so the countdowns actually tick and rounds roll over.
//!
//!   node mock/server.mjs   (or: npm run mock)   → http://127.0.0.1:8080
//!
//! NOT for production — it builds no real transactions; POST /tx/* is stubbed.

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8080);
const SH = 100_000_000n; // shannons per CKB
const RAKE_BPS = 200;

const ckb = (n) => (BigInt(Math.round(n)) * SH).toString();
const now = () => Math.floor(Date.now() / 1000);

// 32-byte hex ids, deterministic per lane so links stay stable across polls.
const feedId = (name) => "0x" + Buffer.from(name).toString("hex").padEnd(64, "0");
const poolId = (i) => "0x" + i.toString(16).padStart(64, "0");

// Lane catalogue. `up`/`down` are the staked CKB on each side; odds are derived.
//
// Deliberately NOT all healthy. Two of these are empty and two are one-sided,
// because that is what a board actually looks like on a quiet Tuesday once you
// split the same players across a dozen lanes — and those are exactly the
// states the UI has to draw honestly (a hatched, uncut track; a seam pinned at
// the end inside a claret ring). A fixture where every pot is comfortably
// two-sided hides the cases worth designing for.
const LANES = [
  { label: "BTC/USD · 1 min", feed: "btc", dur: 60, up: 3200, down: 2286 },
  { label: "BTC/USD · 5 min", feed: "btc", dur: 300, up: 7420, down: 4280 },
  { label: "BTC/USD · 15 min", feed: "btc", dur: 900, up: 96400, down: 12500 },
  { label: "BTC/USD · 1 hour", feed: "btc", dur: 3600, up: 214500, down: 188200 },
  { label: "BTC/USD · 4 hour", feed: "btc", dur: 14400, up: 5400, down: 6900 },
  { label: "BTC/USD · 1 day", feed: "btc", dur: 86400, up: 1284000, down: 961500 },
  { label: "ETH/USD · 1 min", feed: "eth", dur: 60, up: 620, down: 0 }, // one-sided → voids
  { label: "ETH/USD · 5 min", feed: "eth", dur: 300, up: 1450, down: 1980 },
  { label: "ETH/USD · 15 min", feed: "eth", dur: 900, up: 0, down: 0 }, // empty → no seam
  { label: "ETH/USD · 1 hour", feed: "eth", dur: 3600, up: 88000, down: 64000 },
  { label: "SOL/USD · 5 min", feed: "sol", dur: 300, up: 620, down: 0 }, // one-sided
  { label: "SOL/USD · 15 min", feed: "sol", dur: 900, up: 14200, down: 9800 },
  { label: "SOL/USD · 1 hour", feed: "sol", dur: 3600, up: 51000, down: 47500 },
  { label: "CKB/USD · 15 min", feed: "ckb", dur: 900, up: 8800, down: 12400 },
  { label: "CKB/USD · 1 hour", feed: "ckb", dur: 3600, up: 61000, down: 22000 },
  { label: "CKB/USD · 1 day", feed: "ckb", dur: 86400, up: 780000, down: 690000 },
  // No SOL 1d and no CKB 5m: not every cell in the matrix is a lane, and the
  // board says "lane not enabled" rather than drawing a zero.
];

// `start_time` is when the round LOCKS — deposits close and the oracle stamps
// the line — and `close_time` is when it SETTLES, a full duration later. An
// OPEN round therefore has its start in the FUTURE; getting this backwards is
// what makes every open round render as "lock overdue".
function timing(dur) {
  const t = now();
  let start = Math.ceil(t / dur) * dur; // next boundary
  if (start - t < 4) start += dur; // keep a little time on the clock
  return { start, close: start + dur, void: start + dur + 7 * 86400 };
}

function sideOdds(pool, total) {
  return {
    pool: ckb(pool),
    impliedProb: total === 0 ? 0 : pool / total,
    payoutMultiple: pool === 0 ? null : (total * (1 - RAKE_BPS / 10000)) / pool,
  };
}

function odds(up, down) {
  const total = up + down;
  return {
    up: sideOdds(up, total),
    down: sideOdds(down, total),
    total: ckb(total),
    rakeIfUpWins: ckb(total * (RAKE_BPS / 10000)),
    rakeIfDownWins: ckb(total * (RAKE_BPS / 10000)),
  };
}

function openPool(lane, i) {
  const tm = timing(lane.dur);
  return {
    poolId: poolId(i + 1),
    feedId: feedId(lane.feed),
    lane: { label: lane.label, durationSecs: String(lane.dur) },
    status: "open",
    statusCode: 1,
    winner: "undecided",
    variant: "ckb",
    startTime: String(tm.start),
    closeTime: String(tm.close),
    voidTime: String(tm.void),
    rakeBps: RAKE_BPS,
    prices: { start: "0", settle: "0", usedPt: "0" },
    odds: odds(lane.up, lane.down),
    outPoint: { txHash: poolId(i + 1), index: 0 },
    indexedAt: String(now()),
  };
}

const lanes = () =>
  LANES.map((lane, i) => ({
    label: lane.label,
    feedId: feedId(lane.feed),
    durationSecs: String(lane.dur),
    rakeBps: RAKE_BPS,
    createLeadSecs: "60",
    currentOpenPool: openPool(lane, i),
    livePoolCount: (i % 3) + 1,
  }));

const openPools = () => LANES.map((lane, i) => openPool(lane, i));

// Rounds that have locked and are running toward settle — the "In play" section.
const LOCKED = [
  { lane: "BTC/USD · 5 min", feed: "btc", dur: 300, up: 8140, down: 11902, settleIn: 95, start: 113610.0 },
  { lane: "BTC/USD · 1 hour", feed: "btc", dur: 3600, up: 301000, down: 96500, settleIn: 540, start: 113120.0 },
  { lane: "ETH/USD · 1 hour", feed: "eth", dur: 3600, up: 88000, down: 64000, settleIn: 1180, start: 4201.8 },
  // Locked with one side empty: it will void, and the board says so now
  // rather than after the fact.
  { lane: "SOL/USD · 15 min", feed: "sol", dur: 900, up: 4300, down: 0, settleIn: 320, start: 214.2 },
];

function lockedPools() {
  return LOCKED.map((h, i) => {
    const close = now() + h.settleIn;
    return {
      poolId: poolId(50 + i),
      feedId: feedId(h.feed),
      lane: { label: h.lane, durationSecs: String(h.dur) },
      status: "locked",
      statusCode: 2,
      winner: "undecided",
      variant: "ckb",
      startTime: String(close - h.dur),
      closeTime: String(close),
      voidTime: String(close + 7 * 86400),
      rakeBps: RAKE_BPS,
      prices: { start: h.start.toFixed(2), settle: "0", usedPt: "0" },
      odds: odds(h.up, h.down),
      outPoint: { txHash: poolId(50 + i), index: 0 },
      indexedAt: String(now()),
    };
  });
}

// A few finished rounds for the History page.
const HISTORY = [
  { lane: "BTC/USD · 5 min", feed: "btc", dur: 300, up: 9350, down: 6120, winner: "up", ago: 360 },
  { lane: "BTC/USD · 1 hour", feed: "btc", dur: 3600, up: 14200, down: 8800, winner: "up", ago: 4200 },
  { lane: "ETH/USD · 5 min", feed: "eth", dur: 300, up: 2200, down: 2050, winner: "down", ago: 700 },
  // Voided on an exact tie: the split was fine, the two prices were identical.
  { lane: "BTC/USD · 15 min", feed: "btc", dur: 900, up: 22000, down: 22000, winner: "void", ago: 1300, tie: true },
  { lane: "BTC/USD · 1 day", feed: "btc", dur: 86400, up: 1980000, down: 2410000, winner: "down", ago: 90000 },
  // Voided the other way: nothing on DOWN at lock, so there was nobody to pay.
  { lane: "SOL/USD · 5 min", feed: "sol", dur: 300, up: 9100, down: 0, winner: "void", ago: 1900 },
  { lane: "CKB/USD · 1 hour", feed: "ckb", dur: 3600, up: 61000, down: 22000, winner: "up", ago: 8000 },
];

function history() {
  return HISTORY.map((h, i) => {
    const close = now() - h.ago;
    return {
      poolId: poolId(100 + i),
      feedId: feedId(h.feed),
      lane: { label: h.lane, durationSecs: String(h.dur) },
      status: h.winner === "void" ? "void" : "finalized",
      statusCode: h.winner === "void" ? 5 : 6,
      winner: h.winner,
      variant: "ckb",
      startTime: String(close - h.dur),
      closeTime: String(close),
      voidTime: String(close + 7 * 86400),
      rakeBps: RAKE_BPS,
      prices: (() => {
        const base = basePrice(feedId(h.feed));
        const start = base.toFixed(base < 1 ? 6 : 2);
        const settle = h.tie
          ? start
          : h.winner === "up"
            ? (base * 1.004).toFixed(base < 1 ? 6 : 2)
            : h.winner === "down"
              ? (base * 0.996).toFixed(base < 1 ? 6 : 2)
              : "0";
        return { start, settle, usedPt: String(close) };
      })(),
      odds: odds(h.up, h.down),
      outPoint: { txHash: poolId(100 + i), index: 0 },
      indexedAt: String(now()),
    };
  });
}

// Sample holdings — returned for any lock so "Positions" shows something.
function positions() {
  const mk = (id, side, amt, sideCode) => ({
    poolId: poolId(id),
    side,
    sideCode,
    amount: ckb(amt),
    holderLockHash: "0x" + "ab".repeat(32),
    outPoint: { txHash: poolId(id), index: 0 },
  });
  // One of each, so the stakes page's sort order is actually visible:
  // redeem (a win), refund (a void), withdraw (still open), wait (locked).
  return [
    mk(2, "up", 2000, 1),      // BTC 5m, open      → withdraw
    mk(9, "up", 5000, 1),      // ETH 15m, empty    → withdraw, voids as it stands
    mk(50, "up", 3000, 1),     // BTC 5m, locked    → wait
    mk(52, "down", 8000, 2),   // ETH 1h, locked    → wait
    mk(100, "up", 4000, 1),    // BTC 5m, UP won    → redeem
    mk(103, "down", 12000, 2), // BTC 15m, void tie → refund
  ];
}

// ── synthetic price series for the detail chart ─────────────────────────────
// Deterministic per pool (seeded by poolId) so the chart is stable across polls.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedOf(hex) {
  let h = 2166136261 >>> 0;
  for (let i = 2; i < hex.length; i++) { h ^= hex.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const BASE = { btc: 113842, eth: 4218.4, sol: 214.6, ckb: 0.008124 };
const basePrice = (feedHex) => {
  for (const [name, px] of Object.entries(BASE)) {
    if (feedHex.startsWith("0x" + Buffer.from(name).toString("hex"))) return px;
  }
  return 100;
};

// Returns { base, candles } — `base` is the price-to-beat (round open).
function makeSeries(pool) {
  const rnd = mulberry32(seedOf(pool.poolId));
  const base = pool.prices.start !== "0" ? Number(pool.prices.start) : basePrice(pool.feedId);
  const n = 32;
  const dur = Math.max(60, Number(pool.lane.durationSecs));
  // An open round's line has not been stamped, so its series is recent context
  // running up to NOW. A locked or settled round's series covers its own window.
  const end = Math.min(now(), Number(pool.closeTime));
  const start = end - dur;
  const step = dur / n;
  const vol = base * 0.0011;
  let price = base;
  const candles = [];
  for (let i = 0; i < n; i++) {
    const o = price;
    price = Math.max(base * 0.96, o + (rnd() - 0.5) * 2 * vol);
    const c = price;
    candles.push({
      t: String(Math.round(start + step * i)),
      o: o.toFixed(2), c: c.toFixed(2),
      h: (Math.max(o, c) + rnd() * vol * 0.8).toFixed(2),
      l: (Math.min(o, c) - rnd() * vol * 0.8).toFixed(2),
    });
  }
  return { base, candles };
}

function withSeries(pool) {
  if (!pool) return pool;
  // OPEN rounds have no price-to-beat yet (it's captured at lock), so we leave
  // prices.start = "0" and the series reads as recent/spot context. LOCKED and
  // settled rounds already carry a start price, which becomes the beat line.
  pool.priceSeries = makeSeries(pool).candles;
  return pool;
}

function route(req) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  if (p === "/health") return { ok: true, lastIndexedAt: String(now()) };
  if (p === "/lanes") return lanes();
  if (p === "/pools") {
    const status = url.searchParams.get("status");
    const all = openPools().concat(lockedPools());
    return status ? all.filter((x) => x.status === status || String(x.statusCode) === status) : all;
  }
  if (p === "/positions") return positions();
  if (p === "/history") return history();
  const detail = p.match(/^\/pools\/(0x[0-9a-f]+)$/);
  if (detail) return withSeries(openPools().concat(lockedPools()).concat(history()).find((x) => x.poolId === detail[1])) ?? null;
  const poolPos = p.match(/^\/pools\/(0x[0-9a-f]+)\/positions$/);
  if (poolPos) return positions().filter((x) => x.poolId === poolPos[1]);
  if (p.startsWith("/tx/")) return { tx: "0x" }; // stub: no real tx building here
  return undefined; // → 404
}

createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  const body = route(req);
  if (body === undefined) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "not found" }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}).listen(PORT, () => console.log(`mock watcher API on http://127.0.0.1:${PORT}`));
