//! Mode-A scenario 9 — lane-scope enforcement.
//!
//! A per-feed keeper owns only its configured (feedId, durationSecs) lanes, NOT every
//! pool under its creator lock. We create two pools on the same feed + creator: a
//! CONFIGURED 30s pool and an UNCONFIGURED 90s pool. The keeper (lanes=[S-30s]) must
//! drive the 30s pool but leave the 90s one untouched — even though a valid tick is
//! available for both. This guards against a keeper reviving a retired/unconfigured
//! duration (validates `laneKeySet` in service.ts).
//!
//! Run from packages/watcher with the deployer env loaded + a running devnet:
//!   node --env-file=../../deployment/.env tests/integration/devnet/keeper-lane-scope.test.mjs

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

test("the keeper drives only its configured lane, ignoring an unconfigured duration", async (t) => {
  if (!ENABLED) return t.skip("devnet env not loaded (DEVNET_DEPLOYER_PRIVATE_KEY unset)");

  const { client, funder, config, keeper, player } = await bootstrap();
  const { signer: keeperSigner, lock: creatorLock } = await fundNewWallet(client, funder, 20000n);
  const { signer: oracleSigner } = await fundNewWallet(client, funder, 5000n);
  const { signer: playerSigner, lock: playerLock } = await fundNewWallet(client, funder, 5000n);

  const now = (await client.getTipHeader()).timestamp / 1000n;
  const startTime = now + 30n; // both open at the same instant
  const configuredClose = startTime + 30n; // duration 30 — IN lanes=[S-30s]
  const unconfiguredClose = startTime + 90n; // duration 90 — NOT configured

  async function createFunded(closeTime) {
    const seedInput = await firstLiveCell(client, creatorLock);
    let tx = await keeper.draftCreate({
      seedInput, creatorLock, asset: { kind: "ckb" },
      feedId: BTC_FEED, oracleCommit: mockOracleCommit(), startTime, closeTime, rakeBps: 200,
    });
    await keeper.complete(tx, keeperSigner, { feeRate: FEE_RATE });
    await send(client, keeperSigner, tx);
    const poolId = computeTypeId(seedInput, 0);
    tx = await player.draftDeposit({ poolId, depositorLock: playerLock, upAmount: 300n * CKB, downAmount: 200n * CKB });
    await player.complete(tx, playerSigner, { feeRate: FEE_RATE });
    await send(client, playerSigner, tx);
    return poolId;
  }

  const configuredPool = await createFunded(configuredClose); // 30s — owned
  const unconfiguredPool = await createFunded(unconfiguredClose); // 90s — out of scope
  t.diagnostic(`configured(30s)=${configuredPool}  unconfigured(90s)=${unconfiguredPool}`);

  const oracle = new MockOracle({ client, signer: oracleSigner, log: (m) => t.diagnostic(`[oracle] ${m}`) });
  const service = createService({
    config: {
      role: "keeper", config, creatorLock, lanes: [lane("S-30s")], // ONLY the 30s lane
      indexIntervalSecs: 5, dbPath: ":memory:", apiPort: 0, feeRate: FEE_RATE,
    },
    keeper, signer: keeperSigner, creatorLock, oracle, log: (m) => t.diagnostic(`[svc] ${m}`),
  });
  service.setWindingDown(true);
  await service.start();

  try {
    // One tick valid for BOTH pools' activation window.
    await oracle.publish(BTC_FEED, startTime);

    // The configured pool is driven...
    await waitForPool(keeper, configuredPool, (p) => p.data.status === STATUS_LOCKED, { timeoutMs: 90000, label: "configured ACTIVATE" });
    t.diagnostic("configured 30s pool ACTIVATED");

    // ...and the keeper has now had a full cycle (plus we pass the unconfigured pool's
    // own start + a sweep interval). The unconfigured pool must remain untouched.
    await waitChainTime(client, configuredClose + 5n);
    await new Promise((r) => setTimeout(r, 65000)); // > one 60s safety-sweep interval
    const orphan = await keeper.getPool(unconfiguredPool);
    assert.equal(orphan.data.status, STATUS_OPEN, "unconfigured 90s pool was NOT driven (still OPEN)");
    assert.equal(orphan.data.startPrice, 0n, "unconfigured pool never had a start price stamped");
    t.diagnostic("unconfigured 90s pool left OPEN — lane scope enforced");
  } finally {
    await service.stop().catch(() => {});
  }
});
