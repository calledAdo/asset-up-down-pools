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
const LANES = [
  { label: "BTC/USD · 1 min", feed: "btc", dur: 60, up: 3200, down: 2300 },
  { label: "BTC/USD · 5 min", feed: "btc", dur: 300, up: 7420, down: 4280 },
  { label: "BTC/USD · 15 min", feed: "btc", dur: 900, up: 3100, down: 3350 },
  { label: "BTC/USD · 1 hour", feed: "btc", dur: 3600, up: 9800, down: 2270 },
  { label: "BTC/USD · 4 hour", feed: "btc", dur: 14400, up: 5400, down: 6900 },
  { label: "BTC/USD · 1 day", feed: "btc", dur: 86400, up: 12100, down: 10700 },
  { label: "ETH/USD · 5 min", feed: "eth", dur: 300, up: 2600, down: 1150 },
  { label: "ETH/USD · 1 hour", feed: "eth", dur: 3600, up: 4100, down: 4100 },
];

function timing(dur) {
  const t = now();
  let close = Math.ceil(t / dur) * dur; // next boundary
  if (close - t < 4) close += dur; // keep a little time on the clock
  return { start: close - dur, close, void: close + 7 * 86400 };
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
  { lane: "BTC/USD · 5 min", feed: "btc", dur: 300, up: 5200, down: 3100, settleIn: 95, start: 64180.2 },
  { lane: "BTC/USD · 1 hour", feed: "btc", dur: 3600, up: 8800, down: 11200, settleIn: 540, start: 64320.0 },
  { lane: "ETH/USD · 5 min", feed: "eth", dur: 300, up: 1900, down: 2400, settleIn: 150, start: 3402.5 },
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
  { lane: "BTC/USD · 5 min", feed: "btc", dur: 300, up: 6100, down: 9400, winner: "down", ago: 360 },
  { lane: "BTC/USD · 1 hour", feed: "btc", dur: 3600, up: 14200, down: 8800, winner: "up", ago: 4200 },
  { lane: "ETH/USD · 5 min", feed: "eth", dur: 300, up: 2200, down: 2050, winner: "up", ago: 700 },
  { lane: "BTC/USD · 15 min", feed: "btc", dur: 900, up: 0, down: 5300, winner: "void", ago: 1300 },
  { lane: "BTC/USD · 1 day", feed: "btc", dur: 86400, up: 18900, down: 16400, winner: "down", ago: 90000 },
  { lane: "ETH/USD · 1 hour", feed: "eth", dur: 3600, up: 7700, down: 9100, winner: "up", ago: 8000 },
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
      prices: { start: "64210.50", settle: h.winner === "up" ? "64880.25" : "63540.10", usedPt: String(close) },
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
  return [mk(2, "up", 500, 1), mk(4, "up", 1200, 1), mk(3, "down", 300, 2), mk(101, "up", 800, 1)];
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
const basePrice = (feedHex) => (feedHex.startsWith("0x657468") ? 3400 : 64000); // 'eth' vs 'btc'

// Returns { base, candles } — `base` is the price-to-beat (round open).
function makeSeries(pool) {
  const rnd = mulberry32(seedOf(pool.poolId));
  const base = pool.prices.start !== "0" ? Number(pool.prices.start) : basePrice(pool.feedId);
  const n = 32;
  const dur = Math.max(60, Number(pool.lane.durationSecs));
  const start = Number(pool.closeTime) - dur;
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
