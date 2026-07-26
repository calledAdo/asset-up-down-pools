//! Mode-A scenario 3 — the VOID collapse.
//!
//! The keeper never has a separate "void" action: it emits ACTIVATE/RESOLVE and the
//! SDK builder routes to a VOID output when the contract requires it — mirroring
//! validate_activate (OPEN -> LOCKED | VOID). Here we exercise the one-sided case: a
//! pool that took deposits on ONLY one side can't run a contest, so activating it must
//! produce VOID. The keeper drives that unattended off a normal boundary tick.
//!
//! Run from packages/watcher with the deployer env loaded + a running devnet:
//!   node --env-file=../../deployment/.env tests/integration/devnet/keeper-void.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { STATUS_OPEN, STATUS_VOID } from "ckb-up-down-sdk";
import { computeTypeId } from "ckb-up-down-sdk/ckb";

import { createService } from "../../../dist/index.js";
import {
  ENABLED, CKB, FEE_RATE, BTC_FEED,
  bootstrap, fundNewWallet, firstLiveCell, lane, send, waitForPool, mockOracleCommit,
} from "./board.mjs";
import { MockOracle } from "./mockOracle.mjs";

test("keeper VOIDs a one-sided pool via the activate->VOID collapse", async (t) => {
  if (!ENABLED) return t.skip("devnet env not loaded (DEVNET_DEPLOYER_PRIVATE_KEY unset)");

  const { client, funder, config, keeper, player } = await bootstrap();
  const { signer: keeperSigner, lock: creatorLock } = await fundNewWallet(client, funder, 20000n);
  const { signer: oracleSigner } = await fundNewWallet(client, funder, 5000n);
  const { signer: playerSigner, lock: playerLock } = await fundNewWallet(client, funder, 5000n);

  const s30 = lane("S-30s");
  const now = (await client.getTipHeader()).timestamp / 1000n;
  const startTime = now + 30n;
  const closeTime = startTime + s30.durationSecs;

  // CREATE + a ONE-SIDED deposit (UP only) — no contest possible ⇒ must VOID.
  const seedInput = await firstLiveCell(client, creatorLock);
  let tx = await keeper.draftCreate({
    seedInput, creatorLock, asset: { kind: "ckb" },
    feedId: BTC_FEED, oracleCommit: mockOracleCommit(), startTime, closeTime, rakeBps: s30.rakeBps,
  });
  await keeper.complete(tx, keeperSigner, { feeRate: FEE_RATE });
  await send(client, keeperSigner, tx);
  const poolId = computeTypeId(seedInput, 0);
  tx = await player.draftDeposit({ poolId, depositorLock: playerLock, upAmount: 300n * CKB, downAmount: 0n });
  await player.complete(tx, playerSigner, { feeRate: FEE_RATE });
  await send(client, playerSigner, tx);
  {
    const pool = await keeper.getPool(poolId);
    assert.equal(pool.data.status, STATUS_OPEN);
    assert.equal(pool.data.upTotal, 300n * CKB);
    assert.equal(pool.data.downTotal, 0n, "one-sided: nothing on DOWN");
  }
  t.diagnostic(`CREATE + one-sided DEPOSIT ok — pool ${poolId}`);

  const oracle = new MockOracle({ client, signer: oracleSigner, log: (m) => t.diagnostic(`[oracle] ${m}`) });
  const service = createService({
    config: {
      role: "keeper", config, creatorLock, lanes: [s30],
      indexIntervalSecs: 5, dbPath: ":memory:", apiPort: 0, feeRate: FEE_RATE,
    },
    keeper, signer: keeperSigner, creatorLock, oracle, log: (m) => t.diagnostic(`[svc] ${m}`),
  });
  service.setWindingDown(true);
  await service.start();

  try {
    // A normal boundary tick — the keeper emits ACTIVATE, which the builder routes to VOID.
    await oracle.publish(BTC_FEED, startTime);
    const pool = await waitForPool(keeper, poolId, (p) => p.data.status === STATUS_VOID, { timeoutMs: 90000, label: "VOID" });
    // Funds stay put (reclaimable) — VOID refunds, it doesn't pay out.
    assert.equal(pool.data.upTotal, 300n * CKB, "UP deposit preserved for refund");
    assert.equal(pool.data.downTotal, 0n);
    t.diagnostic("one-sided pool VOIDed via activate->VOID — funds preserved for refund");
  } finally {
    await service.stop().catch(() => {});
  }
});
