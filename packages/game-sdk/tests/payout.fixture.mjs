import test from "node:test";
import assert from "node:assert/strict";

import {
  redeemPayout,
  mulDivFloor,
  STATUS_FINALIZED,
  STATUS_VOID,
  SIDE_UP,
  SIDE_DOWN,
  WINNER_VOID,
} from "../dist/index.js";

test("mulDivFloor floors and guards div-by-zero", () => {
  assert.equal(mulDivFloor(100n, 95n, 200n), 47n); // 9500/200 = 47.5 -> 47
  assert.equal(mulDivFloor(7n, 7n, 3n), 16n); // 49/3 = 16.33 -> 16
  assert.equal(mulDivFloor(1n, 1n, 0n), null);
});

test("finalized winner payout matches the contract formula (rake 0)", () => {
  // The xudt_redeem_succeeds vector: winner UP, U=200, L=100, rake=0, burn 100 -> 150.
  const payout = redeemPayout({
    status: STATUS_FINALIZED,
    winner: SIDE_UP,
    upTotal: 200n,
    downTotal: 100n,
    rakeBps: 0,
    burnedUp: 100n,
    burnedDown: 0n,
  });
  assert.equal(payout, 150n);
});

test("finalized winner payout applies rake on the losing pool", () => {
  // winner UP, U=200, L=100, rake 5% -> rake=5, distributable=95, profit=floor(100*95/200)=47.
  const payout = redeemPayout({
    status: STATUS_FINALIZED,
    winner: SIDE_DOWN,
    upTotal: 100n, // loser
    downTotal: 200n, // winner
    rakeBps: 500,
    burnedUp: 0n,
    burnedDown: 100n,
  });
  assert.equal(payout, 147n);
});

test("partial winner burn pays out pro-rata", () => {
  // winner UP, U=200, L=100, rake=0, burn 50 -> profit=floor(50*100/200)=25 -> 75.
  const payout = redeemPayout({
    status: STATUS_FINALIZED,
    winner: SIDE_UP,
    upTotal: 200n,
    downTotal: 100n,
    rakeBps: 0,
    burnedUp: 50n,
    burnedDown: 0n,
  });
  assert.equal(payout, 75n);
});

test("VOID and finalized-tie refund 1:1 across both sides", () => {
  assert.equal(
    redeemPayout({
      status: STATUS_VOID,
      winner: WINNER_VOID,
      upTotal: 0n,
      downTotal: 0n,
      rakeBps: 100,
      burnedUp: 60n,
      burnedDown: 40n,
    }),
    100n,
  );
  assert.equal(
    redeemPayout({
      status: STATUS_FINALIZED,
      winner: WINNER_VOID,
      upTotal: 200n,
      downTotal: 200n,
      rakeBps: 100,
      burnedUp: 10n,
      burnedDown: 20n,
    }),
    30n,
  );
});

test("rejects minting on a refund and losing-side burns on a win", () => {
  assert.throws(
    () =>
      redeemPayout({
        status: STATUS_VOID,
        winner: WINNER_VOID,
        upTotal: 0n,
        downTotal: 0n,
        rakeBps: 0,
        burnedUp: -1n,
        burnedDown: 0n,
      }),
    /mint/,
  );
  assert.throws(
    () =>
      redeemPayout({
        status: STATUS_FINALIZED,
        winner: SIDE_UP,
        upTotal: 200n,
        downTotal: 100n,
        rakeBps: 0,
        burnedUp: 100n,
        burnedDown: 10n, // loser-side burn not allowed
      }),
    /winning shares/,
  );
});
