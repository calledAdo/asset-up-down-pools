import test from "node:test";
import assert from "node:assert/strict";

import { resolveOracleTick } from "../dist/oracle/index.js";

const FEED = "0x" + "fe".repeat(32);

function fakeReader(state, capture) {
  return {
    async getOracleCellState(params) {
      if (capture) capture.params = params;
      return state;
    },
  };
}

test("resolveOracleTick maps a live oracle cell to a tick (index coerced to number)", async () => {
  const reader = fakeReader({
    outPoint: { txHash: "0x" + "ab".repeat(32), index: 3n },
    data: { price: 12345n, publishTimeUnix: 1_700_000_000n },
  });
  const tick = await resolveOracleTick(reader, FEED);
  assert.equal(tick.feedId, FEED);
  assert.equal(tick.price, 12345n);
  assert.equal(tick.publishTimeUnix, 1_700_000_000n);
  assert.equal(tick.cellDep.depType, "code");
  assert.equal(tick.cellDep.outPoint.txHash, "0x" + "ab".repeat(32));
  assert.equal(tick.cellDep.outPoint.index, 3); // bigint → number
});

test("resolveOracleTick throws when no oracle cell is found", async () => {
  await assert.rejects(() => resolveOracleTick(fakeReader(undefined), FEED), /no live oracle cell/);
});

test("resolveOracleTick forwards minPublishTimeUnix to the reader", async () => {
  const capture = {};
  const reader = fakeReader(
    { outPoint: { txHash: "0x" + "ab".repeat(32), index: 0 }, data: { price: 1n, publishTimeUnix: 9n } },
    capture,
  );
  await resolveOracleTick(reader, FEED, { minPublishTimeUnix: 42n });
  assert.equal(capture.params.feedId, FEED);
  assert.equal(capture.params.minPublishTimeUnix, 42n);
});
