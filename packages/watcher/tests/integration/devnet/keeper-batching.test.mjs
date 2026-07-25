//! Mode-A scenario 2 — cross-cadence batching, the payoff of the per-feed keeper.
//!
//! We construct a COINCIDENT boundary: pool A (30s) closes exactly when pool B (60s)
//! opens (A.closeTime == B.startTime == T). At T the keeper must RESOLVE A and
//! ACTIVATE B in the SAME wake — and, because both read the one per-feed oracle cell,
//! the executor folds them into ONE transaction (`sent batch[2]`). This is what a
//! per-cadence split could never do (separate processes/wallets/executors), and the
//! reason lane ownership is per-feed. One published tick at T drives both.
//!
//! Run from packages/watcher with the deployer env loaded + a running devnet:
//!   node --env-file=../../deployment/.env tests/integration/devnet/keeper-batching.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { STATUS_OPEN, STATUS_LOCKED, STATUS_SETTLED, SIDE_UP } from "ckb-up-down-sdk";
import { computeTypeId } from "ckb-up-down-sdk/ckb";

import { createService } from "../../../dist/index.js";
import {
  ENABLED, CKB, FEE_RATE, BTC_FEED,
  bootstrap, fundNewWallet, firstLiveCell, lane, send, waitForPool, mockOracleCommit,
} from "./board.mjs";
import { MockOracle } from "./mockOracle.mjs";

/** Manually CREATE a grid-free pool of `durationSecs` and fund both sides. Returns its poolId. */
async function createFundedPool(ctx, { startTime, closeTime, rakeBps, up, down }) {
  const { client, keeper, player, keeperSigner, creatorLock, playerSigner, playerLock } = ctx;
  const seedInput = await firstLiveCell(client, creatorLock);
  assert.ok(seedInput, "keeper wallet has no live cell to seed the pool");
  let tx = await keeper.draftCreate({
    seedInput, creatorLock, asset: { kind: "ckb" },
    feedId: BTC_FEED, oracleCommit: mockOracleCommit(), startTime, closeTime, rakeBps,
  });
  await keeper.complete(tx, keeperSigner, { feeRate: FEE_RATE });
  await send(client, keeperSigner, tx);
  const poolId = computeTypeId(seedInput, 0);

  tx = await player.draftDeposit({ poolId, depositorLock: playerLock, upAmount: up, downAmount: down });
  await player.complete(tx, playerSigner, { feeRate: FEE_RATE });
  await send(client, playerSigner, tx);
  return poolId;
}

test("keeper folds a coincident RESOLVE + ACTIVATE into one batched tx", async (t) => {
  if (!ENABLED) return t.skip("devnet env not loaded (DEVNET_DEPLOYER_PRIVATE_KEY unset)");

  const { client, funder, config, keeper, player } = await bootstrap();
  const { signer: keeperSigner, lock: creatorLock } = await fundNewWallet(client, funder, 20000n);
  const { signer: oracleSigner } = await fundNewWallet(client, funder, 5000n);
  const { signer: playerSigner, lock: playerLock } = await fundNewWallet(client, funder, 5000n);
  t.diagnostic("funded keeper + oracle + player wallets");
  const ctx = { client, keeper, player, keeperSigner, creatorLock, playerSigner, playerLock };

  // A (30s) closes exactly when B (60s) opens: T is the coincident boundary.
  const now = (await client.getTipHeader()).timestamp / 1000n;
  const startA = now + 30n;
  const T = now + 60n; // A.closeTime == B.startTime
  const closeB = now + 120n;

  const poolA = await createFundedPool(ctx, { startTime: startA, closeTime: T, rakeBps: 200, up: 300n * CKB, down: 200n * CKB });
  t.diagnostic(`A (30s) created ${poolA} — resolves at T`);
  const poolB = await createFundedPool(ctx, { startTime: T, closeTime: closeB, rakeBps: 200, up: 300n * CKB, down: 200n * CKB });
  t.diagnostic(`B (60s) created ${poolB} — activates at T`);

  const logs = [];
  const log = (m) => { logs.push(m); t.diagnostic(`[svc] ${m}`); };
  const oracle = new MockOracle({ client, signer: oracleSigner, log }); // manual mode
  const service = createService({
    config: {
      role: "keeper", config, creatorLock, lanes: [lane("S-30s"), lane("M-60s")],
      indexIntervalSecs: 5, dbPath: ":memory:", apiPort: 0, feeRate: FEE_RATE,
    },
    keeper, signer: keeperSigner, creatorLock, oracle, log,
  });
  service.setWindingDown(true); // drive only the two pools we made
  await service.start();

  try {
    // Step 1: activate A alone (tick before B's start ⇒ B stays OPEN).
    await oracle.publish(BTC_FEED, startA);
    await waitForPool(keeper, poolA, (p) => p.data.status === STATUS_LOCKED, { timeoutMs: 90000, label: "A ACTIVATE" });
    assert.equal((await keeper.getPool(poolB)).data.status, STATUS_OPEN, "B still OPEN before T");
    t.diagnostic("A LOCKED; B still OPEN");

    // Step 2: ONE tick at the coincident boundary T. The keeper wakes for A (resolve)
    // and B (activate) in the same bucket, both read this cell ⇒ one batched tx.
    await oracle.publish(BTC_FEED, T);
    const a = await waitForPool(keeper, poolA, (p) => p.data.status === STATUS_SETTLED, { timeoutMs: 90000, label: "A RESOLVE" });
    const b = await waitForPool(keeper, poolB, (p) => p.data.status === STATUS_LOCKED, { timeoutMs: 90000, label: "B ACTIVATE" });

    // Both transitioned off the same tick at T...
    assert.equal(a.data.settlePrice, T, "A settled on the T tick");
    assert.equal(a.data.winner, SIDE_UP, "A: UP wins (settle > start)");
    assert.equal(b.data.startPrice, T, "B activated on the T tick");

    // ...and the executor folded them into a SINGLE transaction.
    const batched = logs.filter((l) => /sent batch\[2\]/.test(l));
    assert.ok(batched.length >= 1, `expected a batch[2] tx; saw logs:\n${logs.filter((l) => /sent |batch|FAILED/.test(l)).join("\n")}`);
    t.diagnostic(`BATCH ok — ${batched[0]}`);
  } finally {
    await service.stop().catch(() => {});
  }
});
