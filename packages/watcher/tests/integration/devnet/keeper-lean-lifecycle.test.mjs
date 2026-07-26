//! Mode-B scenario 10 — the REAL Lean Oracle, end-to-end.
//!
//! The only subsystem never exercised live: the watcher's real oracle integration.
//! No mock cell — instead the production `OracleWorker` (sole writer) advances a live
//! Lean Oracle cell by pulling real Pyth BTC/USD updates from Hermes on-chain (each a
//! Wormhole VAA verified against the guardian set), while the keeper reads that cell
//! through `createLeanReadOnlySource` and drives one pool CREATE→ACTIVATE→RESOLVE→
//! FINALIZE→REDEEM off real prices — exactly the production keeper+worker split.
//!
//! Setup mints our own cells (same identity ⇒ same `oracle_commit`): the lean_oracle
//! devnet deploy's guardian set (index 6) went stale when Wormhole rotated to 7, so we
//! reconstruct the current set from live VAA signatures (see guardianReconstruct.mjs),
//! deploy it + a personal oracle cell, and bind the pool to that identity.
//!
//! Run from packages/watcher with the deployer env loaded + a running devnet:
//!   node --env-file=../../deployment/.env tests/integration/devnet/keeper-lean-lifecycle.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  STATUS_LOCKED, STATUS_SETTLED, STATUS_FINALIZED,
  SIDE_UP, SIDE_DOWN, SIDE_UNDECIDED, redeemPayout,
} from "ckb-up-down-sdk";
import { computeTypeId } from "ckb-up-down-sdk/ckb";

import { createService, OracleWorker } from "../../../dist/index.js";
import {
  ENABLED, CKB, FEE_RATE,
  bootstrap, fundNewWallet, firstLiveCell, send, waitForPool, chainNow,
} from "./board.mjs";
import {
  LEAN_FEED, ORACLE_FEE_RATE, setupLeanOracle, buildLeanSources, leanLane, hermesSkipReason,
} from "./leanBoard.mjs";

test("keeper drives a full lifecycle off a live Lean Oracle (real Hermes BTC/USD)", { timeout: 600_000 }, async (t) => {
  if (!ENABLED) return t.skip("devnet env not loaded (DEVNET_DEPLOYER_PRIVATE_KEY unset)");
  const hermesDown = await hermesSkipReason();
  if (hermesDown) return t.skip(hermesDown);

  const { client, funder, config, keeper, player } = await bootstrap();
  const { signer: keeperSigner, lock: creatorLock } = await fundNewWallet(client, funder, 20000n);
  const { signer: oracleSigner, lock: oracleLock } = await fundNewWallet(client, funder, 8000n);
  const { signer: playerSigner, lock: playerLock } = await fundNewWallet(client, funder, 5000n);
  t.diagnostic("funded keeper + oracle + player wallets");

  // ---- reconstruct the live guardian set + deploy our own guardian-set & oracle cells ----
  const log = (m) => t.diagnostic(`[svc] ${m}`);
  const { network, leanClient, identity, commit } = await setupLeanOracle({
    client, signer: oracleSigner, oracleLock, samples: 20, log: (m) => t.diagnostic(`[oracle] ${m}`),
  });
  t.diagnostic(`oracle ready — commit ${commit}`);

  // ---- one 60s pool anchored so start/close land on the keeper+worker shared grid ----
  const duration = 60n;
  const startTime = (await chainNow(client)) + 30n; // headroom for create+deposit+start
  const closeTime = startTime + duration;
  const voidTime = closeTime + 60n; // grace(60s) = clamp(6,60,600) = 60
  const lane = leanLane({ identity, startTime, durationSecs: duration });

  const seedInput = await firstLiveCell(client, creatorLock);
  assert.ok(seedInput, "creator has no live cell to seed the pool");
  let tx = await keeper.draftCreate({
    seedInput, creatorLock, asset: { kind: "ckb" },
    feedId: LEAN_FEED, oracleCommit: commit, startTime, closeTime, rakeBps: lane.rakeBps,
  });
  await keeper.complete(tx, keeperSigner, { feeRate: FEE_RATE });
  await send(client, keeperSigner, tx);
  const poolId = computeTypeId(seedInput, 0);
  t.diagnostic(`CREATE ok — pool ${poolId} [${startTime}..${closeTime}]`);

  // ---- two-sided deposit; the real BTC move over the round decides the winner ----
  const upStake = 300n * CKB;
  const downStake = 200n * CKB;
  tx = await player.draftDeposit({ poolId, depositorLock: playerLock, upAmount: upStake, downAmount: downStake });
  await player.complete(tx, playerSigner, { feeRate: FEE_RATE });
  await send(client, playerSigner, tx);
  t.diagnostic("DEPOSIT ok (300 UP / 200 DOWN)");

  // ---- wire the REAL split: keeper reads the cell, the worker (sole writer) advances it ----
  const { reader, advancer } = buildLeanSources({ client, network, oracleSigner, oracleLock, leanClient, log: (m) => t.diagnostic(`[src] ${m}`) });
  const worker = new OracleWorker({ source: advancer, lanes: [lane], log: (m) => t.diagnostic(`[worker] ${m}`) });
  const service = createService({
    config: {
      role: "keeper", config, creatorLock, lanes: [lane],
      indexIntervalSecs: 5, dbPath: ":memory:", apiPort: 0, feeRate: FEE_RATE,
    },
    keeper, signer: keeperSigner, creatorLock, oracle: reader, log,
  });
  service.setWindingDown(true); // drive only the pool we made
  await service.start();
  worker.start();
  t.diagnostic("keeper + oracle worker started");

  try {
    // ---- ACTIVATE: worker pulls the first Hermes tick >= startTime; keeper locks it ----
    let pool = await waitForPool(keeper, poolId, (p) => p.data.status === STATUS_LOCKED, { timeoutMs: 150000, label: "ACTIVATE" });
    assert.ok(pool.data.startPrice > 1_000_000_000_000n, `startPrice looks like a real BTC/USD mantissa: ${pool.data.startPrice}`);
    assert.ok(pool.data.usedPt >= startTime && pool.data.usedPt < closeTime, `activate pt in-band: ${pool.data.usedPt}`);
    assert.equal(pool.data.winner, SIDE_UNDECIDED);
    t.diagnostic(`ACTIVATE ok — startPrice=${pool.data.startPrice} (pt=${pool.data.usedPt})`);

    // ---- RESOLVE: worker advances to the first tick >= closeTime; keeper settles ----
    pool = await waitForPool(keeper, poolId, (p) => p.data.status === STATUS_SETTLED, { timeoutMs: 150000, label: "RESOLVE" });
    assert.ok(pool.data.settlePrice > 1_000_000_000_000n, `settlePrice looks like a real BTC/USD mantissa: ${pool.data.settlePrice}`);
    assert.notEqual(pool.data.winner, SIDE_UNDECIDED, "winner decided from the real price move");
    assert.ok(pool.data.winner === SIDE_UP || pool.data.winner === SIDE_DOWN, `winner is a real side: ${pool.data.winner}`);
    const wentUp = pool.data.settlePrice > pool.data.startPrice;
    assert.equal(pool.data.winner, wentUp ? SIDE_UP : SIDE_DOWN, "winner matches the price direction");
    t.diagnostic(`RESOLVE ok — settlePrice=${pool.data.settlePrice} winner=${pool.data.winner === SIDE_UP ? "UP" : "DOWN"}`);

    // ---- FINALIZE: worker advances to a tick >= void_time; keeper finalizes ----
    pool = await waitForPool(keeper, poolId, (p) => p.data.status === STATUS_FINALIZED, { timeoutMs: 180000, label: "FINALIZE" });
    t.diagnostic("FINALIZE ok — round settled entirely off live oracle reads");

    await service.stop();
    worker.stop();

    // ---- REDEEM the winner + BURN the loser, off the real-oracle outcome ----
    const winner = pool.data.winner;
    const winStake = winner === SIDE_UP ? upStake : downStake;
    const loseSide = winner === SIDE_UP ? SIDE_DOWN : SIDE_UP;
    const expectedPayout = redeemPayout({
      status: pool.data.status, winner,
      upTotal: pool.data.upTotal, downTotal: pool.data.downTotal, rakeBps: pool.data.rakeBps,
      burnedUp: winner === SIDE_UP ? upStake : 0n,
      burnedDown: winner === SIDE_DOWN ? downStake : 0n,
    });
    const capBefore = pool.capacity;
    tx = await player.draftRedeem({ poolId, redeemerLock: playerLock });
    await player.complete(tx, playerSigner, { feeRate: FEE_RATE });
    await send(client, playerSigner, tx);
    pool = await keeper.getPool(poolId);
    assert.equal(pool.capacity, capBefore - expectedPayout, "PoolCell capacity dropped by the payout");
    let shares = await player.getShareBalances(poolId, playerLock);
    assert.equal(winner === SIDE_UP ? shares.up : shares.down, 0n, "winning shares burned on redeem");
    t.diagnostic(`REDEEM ok — payout=${expectedPayout} (winner ${winner === SIDE_UP ? "UP" : "DOWN"})`);

    tx = await player.draftBurnShares({ poolId, holderLock: playerLock, sides: [loseSide] });
    await player.complete(tx, playerSigner, { feeRate: FEE_RATE });
    await send(client, playerSigner, tx);
    shares = await player.getShareBalances(poolId, playerLock);
    assert.equal(loseSide === SIDE_UP ? shares.up : shares.down, 0n, "losing shares burned");
    t.diagnostic("BURN ok — full live-oracle lifecycle verified");
  } finally {
    await service.stop().catch(() => {});
    worker.stop();
  }
});
