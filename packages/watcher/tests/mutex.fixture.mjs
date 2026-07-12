//! Mutex fixture: serialization (no overlap) + ordering + error isolation.

import test from "node:test";
import assert from "node:assert/strict";

import { Mutex } from "../dist/index.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("runs queued work one at a time (never overlapping)", async () => {
  const m = new Mutex();
  let active = 0, maxActive = 0;
  const order = [];
  const job = (id) => m.run(async () => {
    active++; maxActive = Math.max(maxActive, active);
    await tick();
    order.push(id);
    active--;
  });
  await Promise.all([job(1), job(2), job(3)]);
  assert.equal(maxActive, 1, "only one job runs at a time");
  assert.deepEqual(order, [1, 2, 3], "FIFO order preserved");
});

test("a rejecting job does not wedge the queue; later jobs still run", async () => {
  const m = new Mutex();
  const ran = [];
  const p1 = m.run(async () => { throw new Error("boom"); });
  const p2 = m.run(async () => { await tick(); ran.push("after"); });
  await assert.rejects(p1, /boom/);
  await p2;
  assert.deepEqual(ran, ["after"]);
});

test("returns the job's resolved value", async () => {
  const m = new Mutex();
  assert.equal(await m.run(async () => 42), 42);
});
