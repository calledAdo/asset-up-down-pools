import assert from "node:assert/strict";

import { assetKey, buildAssetChips, featuredLane, filterLanes } from "../src/pages/marketFilters.ts";

const lanes = [
  lane("BTC/USD · 1 min", "60", "0x01", "5500"),
  lane("ETH/USD · 5 min", "300", "0x02", "3750"),
  lane("BTC/USD · 5 min", "300", "0x03", "11700"),
  lane("CKB/USD · 1 h", "3600", "0x04"),
];

assert.equal(assetKey("BTC/USD · 5 min"), "BTC/USD");
assert.deepEqual(buildAssetChips(lanes), ["BTC/USD", "ETH/USD", "CKB/USD"]);
assert.deepEqual(
  filterLanes(lanes, { asset: "BTC/USD", durationSecs: "300" }).map((l) => l.label),
  ["BTC/USD · 5 min"],
);
assert.deepEqual(
  filterLanes(lanes, { asset: "all", durationSecs: "60" }).map((l) => l.label),
  ["BTC/USD · 1 min"],
);
assert.equal(featuredLane(lanes)?.label, "BTC/USD · 5 min");

function lane(label, durationSecs, suffix, total = "0") {
  return {
    label,
    feedId: `0x${suffix.padStart(64, "0")}`,
    durationSecs,
    rakeBps: 200,
    createLeadSecs: "60",
    currentOpenPool: total === "0" ? null : {
      odds: { total },
      closeTime: "100",
    },
    livePoolCount: 0,
  };
}
