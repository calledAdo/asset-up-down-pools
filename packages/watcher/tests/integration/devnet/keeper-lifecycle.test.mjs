//! Mode-A scenario 1 — the redesigned keeper drives a full lifecycle unattended.
//!
//! We pre-create + fund a single S-30s pool, then start the real service (role
//! "keeper", winding down so it mints nothing new) pointed at a MANUAL MockOracle.
//! The keeper — on its own timers, reading the mock cell — must ACTIVATE at start,
//! RESOLVE at close, and FINALIZE at void_time, each off the tick we publish for
//! that step. Then the player REDEEMs (winner) and BURNs (loser). This exercises
//! the production Keeper + Timeline + executor + reconciler, not the SDK builders
//! directly (that path is covered by game-sdk/.../lifecycle.test.mjs).
//!
//! Run from packages/watcher with the deployer env loaded + a running devnet:
//!   node --env-file=../../deployment/.env tests/integration/devnet/keeper-lifecycle.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  STATUS_LOCKED,
  STATUS_SETTLED,
  STATUS_FINALIZED,
  SIDE_UP,
  SIDE_DOWN,
  SIDE_UNDECIDED,
  redeemPayout,
} from "ckb-up-down-sdk";
import { computeTypeId } from "ckb-up-down-sdk/ckb";

import { createService } from "../../../dist/index.js";
import {
  ENABLED, CKB, FEE_RATE, BTC_FEED,
  bootstrap, fundNewWallet, firstLiveCell, lane, send, waitForPool, mockOracleCommit,
} from "./board.mjs";
import { MockOracle } from "./mockOracle.mjs";

test("keeper drives a pool CREATE→ACTIVATE→RESOLVE→FINALIZE→REDEEM/BURN unattended", async (t) => {
  if (!ENABLED) return t.skip("devnet env not loaded (DEVNET_DEPLOYER_PRIVATE_KEY unset)");

  const { client, funder, config, keeper, player } = await bootstrap();
  t.diagnostic("bootstrapped: fresh deps + config");

  // A FRESH creator wallet per run isolates this run's pools: `deployDeps` reuses the
  // same content-addressed code hash every run, so a shared creator lock would let the
  // keeper discover leftover pools from prior runs. Separate oracle + player wallets so
  // their txs never contend on cells with the keeper's.
  const { signer: keeperSigner, lock: creatorLock } = await fundNewWallet(client, funder, 20000n);
  const { signer: oracleSigner } = await fundNewWallet(client, funder, 5000n);
  const { signer: playerSigner, lock: playerLock } = await fundNewWallet(client, funder, 5000n);
  t.diagnostic("funded keeper + oracle + player wallets");

  // ---- manual CREATE of one S-30s pool (duration 30 ⇒ maps to the S-30s lane) ----
  const s30 = lane("S-30s");
  const now = (await client.getTipHeader()).timestamp / 1000n;
  const startTime = now + 45n; // ample headroom for deposit + service start
  const closeTime = startTime + s30.durationSecs; // 30s round
  const voidTime = closeTime + 60n; // grace(30s) = clamp(3,60,600) = 60
  const oracleCommit = mockOracleCommit();

  const seedInput = await firstLiveCell(client, creatorLock);
  assert.ok(seedInput, "funder has no live cell to seed the pool");
  let tx = await keeper.draftCreate({
    seedInput, creatorLock, asset: { kind: "ckb" },
    feedId: BTC_FEED, oracleCommit, startTime, closeTime, rakeBps: s30.rakeBps,
  });
  await keeper.complete(tx, keeperSigner, { feeRate: FEE_RATE });
  await send(client, keeperSigner, tx);
  const poolId = computeTypeId(seedInput, 0);
  t.diagnostic(`CREATE ok — pool ${poolId}`);

  // ---- two-sided DEPOSIT (before the keeper runs) — UP will win (settle>start) ----
  const upStake = 300n * CKB;
  const downStake = 200n * CKB;
  tx = await player.draftDeposit({ poolId, depositorLock: playerLock, upAmount: upStake, downAmount: downStake });
  await player.complete(tx, playerSigner, { feeRate: FEE_RATE });
  await send(client, playerSigner, tx);
  {
    const pool = await keeper.getPool(poolId);
    assert.equal(pool.data.upTotal, upStake);
    assert.equal(pool.data.downTotal, downStake);
  }
  t.diagnostic("DEPOSIT ok (300 UP / 200 DOWN)");

  // ---- start the real keeper runtime, winding down so it only drives existing pools ----
  const logs = [];
  const log = (m) => { logs.push(m); t.diagnostic(`[svc] ${m}`); };
  const oracle = new MockOracle({ client, signer: oracleSigner, log }); // manual mode
  const service = createService({
    config: {
      role: "keeper", config, creatorLock, lanes: [s30],
      indexIntervalSecs: 5, dbPath: ":memory:", apiPort: 0, feeRate: FEE_RATE,
    },
    keeper, signer: keeperSigner, creatorLock, oracle, log,
  });
  service.setWindingDown(true); // no new rounds — we drive the one pool we made
  await service.start();
  t.diagnostic("service started (keeper, winding down)");

  try {
    // ---- ACTIVATE: publish the start-boundary tick; keeper wakes at startTime ----
    await oracle.publish(BTC_FEED, startTime); // price = startTime (monotone ⇒ UP wins)
    let pool = await waitForPool(keeper, poolId, (p) => p.data.status === STATUS_LOCKED, { timeoutMs: 90000, label: "ACTIVATE" });
    assert.equal(pool.data.startPrice, startTime, "startPrice stamped from the activate tick");
    assert.equal(pool.data.usedPt, startTime, "usedPt = activate publish_time");
    assert.equal(pool.data.winner, SIDE_UNDECIDED);
    t.diagnostic(`ACTIVATE ok — startPrice=${pool.data.startPrice}`);

    // ---- RESOLVE: publish the close-boundary tick; keeper wakes at closeTime ----
    await oracle.publish(BTC_FEED, closeTime);
    pool = await waitForPool(keeper, poolId, (p) => p.data.status === STATUS_SETTLED, { timeoutMs: 90000, label: "RESOLVE" });
    assert.equal(pool.data.settlePrice, closeTime, "settlePrice stamped from the resolve tick");
    assert.equal(pool.data.winner, SIDE_UP, "UP wins (settle > start)");
    t.diagnostic(`RESOLVE ok — settlePrice=${pool.data.settlePrice} winner=UP`);

    // ---- FINALIZE: publish a tick >= void_time; keeper wakes at void_time ----
    await oracle.publish(BTC_FEED, voidTime + 2n);
    pool = await waitForPool(keeper, poolId, (p) => p.data.status === STATUS_FINALIZED, { timeoutMs: 120000, label: "FINALIZE" });
    t.diagnostic("FINALIZE ok");

    // ---- stop the keeper; its work on this pool is done (CLOSE is >=1h away) ----
    await service.stop();

    // ---- REDEEM (winner UP) — payout math + shares burned ----
    const expectedPayout = redeemPayout({
      status: pool.data.status, winner: pool.data.winner,
      upTotal: pool.data.upTotal, downTotal: pool.data.downTotal,
      rakeBps: pool.data.rakeBps, burnedUp: upStake, burnedDown: 0n,
    });
    const capBefore = pool.capacity;
    tx = await player.draftRedeem({ poolId, redeemerLock: playerLock });
    await player.complete(tx, playerSigner, { feeRate: FEE_RATE });
    await send(client, playerSigner, tx);
    pool = await keeper.getPool(poolId);
    assert.equal(pool.capacity, capBefore - expectedPayout, "PoolCell capacity dropped by the payout");
    let shares = await player.getShareBalances(poolId, playerLock);
    assert.equal(shares.up, 0n, "winning UP shares burned");
    t.diagnostic(`REDEEM ok — payout=${expectedPayout}`);

    // ---- BURN (loser DOWN) — reclaim the share cells' CKB ----
    assert.equal(shares.down, downStake, "losing DOWN shares still held before burn");
    tx = await player.draftBurnShares({ poolId, holderLock: playerLock, sides: [SIDE_DOWN] });
    await player.complete(tx, playerSigner, { feeRate: FEE_RATE });
    await send(client, playerSigner, tx);
    shares = await player.getShareBalances(poolId, playerLock);
    assert.equal(shares.down, 0n, "losing DOWN shares burned");
    t.diagnostic("BURN ok — full keeper-driven lifecycle verified");
  } finally {
    await service.stop().catch(() => {});
  }
});
