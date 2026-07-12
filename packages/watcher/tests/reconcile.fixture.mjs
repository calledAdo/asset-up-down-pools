//! Startup reconciliation: dangling `sent` tx_log rows resolved against a fake
//! chain. Confirms the idempotency guard is corrected after a crash.

import test from "node:test";
import assert from "node:assert/strict";

import { openDb, reconcile } from "../dist/index.js";

const POOL = "0x" + "01".repeat(32);
const TX = (n) => "0x" + n.repeat(32);

function clientWith(statuses) {
  return { getTransaction: async (hash) => (hash in statuses ? { status: statuses[hash] } : undefined) };
}

test("committed tx -> row committed (guard stays closed correctly)", async () => {
  const db = openDb(":memory:");
  const id = db.insertTxLog({ poolId: POOL, action: "activate", status: "sent" });
  db.updateTxLog(id, { txHash: TX("aa") });
  const r = await reconcile(db, clientWith({ [TX("aa")]: "committed" }));
  assert.deepEqual(r, { committed: 1, failed: 0, pending: 0 });
  assert.equal(db.hasOpenAction(POOL, "activate"), true); // committed is still "open"
  db.raw.close();
});

test("rejected / not-found tx -> row failed (guard clears, planner re-proposes)", async () => {
  const db = openDb(":memory:");
  const id = db.insertTxLog({ poolId: POOL, action: "resolve", status: "sent" });
  db.updateTxLog(id, { txHash: TX("bb") });
  assert.equal(db.hasOpenAction(POOL, "resolve"), true);
  const r = await reconcile(db, clientWith({})); // unknown hash
  assert.equal(r.failed, 1);
  assert.equal(db.hasOpenAction(POOL, "resolve"), false);
  db.raw.close();
});

test("no tx hash (pre-send crash) -> failed", async () => {
  const db = openDb(":memory:");
  const roundKey = "0xfeed:900@1800";
  db.insertTxLog({ roundKey, laneKey: "0xfeed:900", action: "create", status: "sent" });
  assert.equal(db.hasOpenCreate(roundKey), true);
  const r = await reconcile(db, clientWith({}));
  assert.equal(r.failed, 1);
  assert.equal(db.hasOpenCreate(roundKey), false);
  db.raw.close();
});

test("still-pending tx -> left as sent (genuinely in flight)", async () => {
  const db = openDb(":memory:");
  const id = db.insertTxLog({ poolId: POOL, action: "finalize", status: "sent" });
  db.updateTxLog(id, { txHash: TX("cc") });
  const r = await reconcile(db, clientWith({ [TX("cc")]: "pending" }));
  assert.deepEqual(r, { committed: 0, failed: 0, pending: 1 });
  assert.equal(db.hasOpenAction(POOL, "finalize"), true);
  db.raw.close();
});

test("committed tx_log rows are untouched (only 'sent' is reconciled)", async () => {
  const db = openDb(":memory:");
  const id = db.insertTxLog({ poolId: POOL, action: "close", status: "sent" });
  db.updateTxLog(id, { txHash: TX("dd"), status: "committed" });
  const r = await reconcile(db, clientWith({ [TX("dd")]: "rejected" }));
  assert.deepEqual(r, { committed: 0, failed: 0, pending: 0 }); // not revisited
  db.raw.close();
});
