//! Mode-A scenario 7 — crash / restart recovery.
//!
//! Edge-triggered scheduling lives in memory, so a keeper that dies mid-lifecycle
//! must rebuild its schedule from CHAIN state on restart — including catching up a
//! transition that fell due while it was down. We activate a pool, stop the service
//! (a "crash": its in-memory tx_log is gone), advance the oracle + let the close
//! boundary pass while nothing is running, then start a FRESH service (new empty DB,
//! same wallets/oracle). It must discover the now-overdue LOCKED pool, derive the
//! right action from its status (RESOLVE, not re-ACTIVATE), and drive it to terminal.
//!
//! Run from packages/watcher with the deployer env loaded + a running devnet:
//!   node --env-file=../../deployment/.env tests/integration/devnet/keeper-restart.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { STATUS_LOCKED, STATUS_SETTLED, STATUS_FINALIZED, SIDE_UP } from "ckb-up-down-sdk";
import { computeTypeId } from "ckb-up-down-sdk/ckb";

import { createService } from "../../../dist/index.js";
import {
  ENABLED, CKB, FEE_RATE, BTC_FEED,
  bootstrap, fundNewWallet, firstLiveCell, lane, send, waitForPool, waitChainTime, mockOracleCommit,
} from "./board.mjs";
import { MockOracle } from "./mockOracle.mjs";

test("a restarted keeper recovers an overdue pool from chain state (no double-fire)", async (t) => {
  if (!ENABLED) return t.skip("devnet env not loaded (DEVNET_DEPLOYER_PRIVATE_KEY unset)");

  const { client, funder, config, keeper, player } = await bootstrap();
  const { signer: keeperSigner, lock: creatorLock } = await fundNewWallet(client, funder, 20000n);
  const { signer: oracleSigner } = await fundNewWallet(client, funder, 5000n);
  const { signer: playerSigner, lock: playerLock } = await fundNewWallet(client, funder, 5000n);

  const s30 = lane("S-30s");
  const now = (await client.getTipHeader()).timestamp / 1000n;
  const startTime = now + 30n;
  const closeTime = startTime + s30.durationSecs;
  const voidTime = closeTime + 60n;

  // CREATE + two-sided DEPOSIT.
  const seedInput = await firstLiveCell(client, creatorLock);
  let tx = await keeper.draftCreate({
    seedInput, creatorLock, asset: { kind: "ckb" },
    feedId: BTC_FEED, oracleCommit: mockOracleCommit(), startTime, closeTime, rakeBps: s30.rakeBps,
  });
  await keeper.complete(tx, keeperSigner, { feeRate: FEE_RATE });
  await send(client, keeperSigner, tx);
  const poolId = computeTypeId(seedInput, 0);
  tx = await player.draftDeposit({ poolId, depositorLock: playerLock, upAmount: 300n * CKB, downAmount: 200n * CKB });
  await player.complete(tx, playerSigner, { feeRate: FEE_RATE });
  await send(client, playerSigner, tx);
  t.diagnostic(`CREATE + DEPOSIT ok — pool ${poolId}`);

  // The oracle keeps running across the keeper's downtime; the keeper does not.
  const oracle = new MockOracle({ client, signer: oracleSigner, log: (m) => t.diagnostic(`[oracle] ${m}`) });

  const mkService = (tag) => {
    const logs = [];
    const svc = createService({
      config: {
        role: "keeper", config, creatorLock, lanes: [s30],
        indexIntervalSecs: 5, dbPath: ":memory:", apiPort: 0, feeRate: FEE_RATE,
      },
      keeper, signer: keeperSigner, creatorLock, oracle,
      log: (m) => { logs.push(m); t.diagnostic(`[${tag}] ${m}`); },
    });
    svc.setWindingDown(true);
    return { svc, logs };
  };

  // ---- run #1: activate, then "crash" while LOCKED ----
  const first = mkService("svc1");
  await first.svc.start();
  await oracle.publish(BTC_FEED, startTime);
  await waitForPool(keeper, poolId, (p) => p.data.status === STATUS_LOCKED, { timeoutMs: 90000, label: "ACTIVATE" });
  t.diagnostic("svc1 activated the pool");
  await first.svc.stop(); // crash: process ends; in-memory tx_log is gone
  assert.ok(!first.logs.some((l) => /sent resolve/.test(l)), "svc1 did NOT resolve (it was down)");

  // ---- the world moves on while nothing runs: publish the resolve tick + let close pass ----
  await oracle.publish(BTC_FEED, closeTime);
  await waitChainTime(client, closeTime + 2n); // the pool is now OVERDUE for RESOLVE
  assert.equal((await keeper.getPool(poolId)).data.status, STATUS_LOCKED, "still LOCKED — nobody resolved it");
  t.diagnostic("close boundary passed with no keeper running — pool is overdue");

  // ---- run #2: a FRESH service must recover it from chain state ----
  const second = mkService("svc2");
  await second.svc.start(); // reconcile(empty) + listOwnPools finds the overdue LOCKED pool
  try {
    let pool = await waitForPool(keeper, poolId, (p) => p.data.status === STATUS_SETTLED, { timeoutMs: 90000, label: "RECOVER→RESOLVE" });
    assert.equal(pool.data.settlePrice, closeTime, "resolved on the tick published during downtime");
    assert.equal(pool.data.winner, SIDE_UP);
    assert.ok(second.logs.some((l) => /sent resolve/.test(l)), "svc2 performed the recovery RESOLVE");
    t.diagnostic("svc2 recovered the overdue pool → RESOLVE");

    // ...and keeps driving it: FINALIZE too.
    await oracle.publish(BTC_FEED, voidTime + 2n);
    pool = await waitForPool(keeper, poolId, (p) => p.data.status === STATUS_FINALIZED, { timeoutMs: 120000, label: "FINALIZE" });
    assert.ok(second.logs.some((l) => /sent finalize/.test(l)), "svc2 finalized");
    t.diagnostic("svc2 drove the recovered pool to FINALIZED — restart recovery verified");
  } finally {
    await second.svc.stop().catch(() => {});
  }
});
