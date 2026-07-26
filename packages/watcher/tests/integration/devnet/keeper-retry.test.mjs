//! Mode-A scenario 6 — lagging-tick retry: no spin, and coalesced.
//!
//! When the oracle cell hasn't advanced past a boundary yet, `decide` returns null
//! and the keeper must back off — arming a retry on a shared wall-clock grid, NOT
//! re-firing at ~0ms (the boundary busy-loop that was fixed). Two pools that go
//! overdue together must retry in the SAME slot (one wake, one oracle read), then
//! activate in one batched tx once the tick lands.
//!
//! We assert both: readCurrentTick is called only a handful of times across a ~15s
//! lag (a spin would be thousands), and the delayed activation is a batch[2].
//!
//! Run from packages/watcher with the deployer env loaded + a running devnet:
//!   node --env-file=../../deployment/.env tests/integration/devnet/keeper-retry.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { STATUS_OPEN, STATUS_LOCKED } from "ckb-up-down-sdk";
import { computeTypeId } from "ckb-up-down-sdk/ckb";

import { createService } from "../../../dist/index.js";
import {
  ENABLED, CKB, FEE_RATE, BTC_FEED,
  bootstrap, fundNewWallet, firstLiveCell, lane, send, waitForPool, waitChainTime, mockOracleCommit,
} from "./board.mjs";
import { MockOracle } from "./mockOracle.mjs";

test("lagging tick: keeper backs off (no spin) and coalesces the retries into one batch", async (t) => {
  if (!ENABLED) return t.skip("devnet env not loaded (DEVNET_DEPLOYER_PRIVATE_KEY unset)");

  const { client, funder, config, keeper, player } = await bootstrap();
  const { signer: keeperSigner, lock: creatorLock } = await fundNewWallet(client, funder, 20000n);
  const { signer: oracleSigner } = await fundNewWallet(client, funder, 5000n);
  const { signer: playerSigner, lock: playerLock } = await fundNewWallet(client, funder, 5000n);

  const s30 = lane("S-30s");
  const now = (await client.getTipHeader()).timestamp / 1000n;
  const startTime = now + 30n; // both pools share this boundary
  const closeTime = startTime + s30.durationSecs;

  // Two two-sided S-30s pools that go overdue for ACTIVATE at the same instant.
  async function createFunded() {
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
    return poolId;
  }
  const poolA = await createFunded();
  const poolB = await createFunded();
  t.diagnostic(`two pools share boundary T=${startTime}: ${poolA}, ${poolB}`);

  const logs = [];
  const oracle = new MockOracle({ client, signer: oracleSigner, log: (m) => t.diagnostic(`[oracle] ${m}`) });
  const service = createService({
    config: {
      role: "keeper", config, creatorLock, lanes: [s30],
      indexIntervalSecs: 5, dbPath: ":memory:", apiPort: 0, feeRate: FEE_RATE,
    },
    keeper, signer: keeperSigner, creatorLock, oracle,
    log: (m) => { logs.push(m); t.diagnostic(`[svc] ${m}`); },
  });
  service.setWindingDown(true);
  await service.start();

  try {
    // Let the boundary pass with NO tick published: both pools go overdue and must retry.
    await waitChainTime(client, startTime + 3n);
    assert.equal((await keeper.getPool(poolA)).data.status, STATUS_OPEN, "A still OPEN (tick lags)");
    assert.equal((await keeper.getPool(poolB)).data.status, STATUS_OPEN, "B still OPEN (tick lags)");

    // Measure reads across a ~15s lag window. Coalesced 5s-grid retries ⇒ a handful;
    // a busy-loop would be thousands.
    const readsBefore = oracle.reads;
    await new Promise((r) => setTimeout(r, 15000));
    const readsDuringLag = oracle.reads - readsBefore;
    t.diagnostic(`readCurrentTick calls over ~15s lag: ${readsDuringLag}`);
    assert.ok(readsDuringLag <= 15, `keeper is spinning: ${readsDuringLag} reads in ~15s (expected a handful)`);

    // Now the tick lands: the coalesced retry activates BOTH in one batched tx.
    await oracle.publish(BTC_FEED, startTime);
    await waitForPool(keeper, poolA, (p) => p.data.status === STATUS_LOCKED, { timeoutMs: 60000, label: "A activate" });
    await waitForPool(keeper, poolB, (p) => p.data.status === STATUS_LOCKED, { timeoutMs: 60000, label: "B activate" });
    assert.ok(logs.some((l) => /sent batch\[2\]/.test(l)), `expected a coalesced batch[2]; saw:\n${logs.filter((l) => /sent |batch/.test(l)).join("\n")}`);
    t.diagnostic("lagging tick backed off cleanly then coalesced into one batched activation");
  } finally {
    await service.stop().catch(() => {});
  }
});
