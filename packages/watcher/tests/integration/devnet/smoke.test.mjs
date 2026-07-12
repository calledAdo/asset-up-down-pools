//! Opt-in devnet smoke: start the combined service against a live offckb devnet
//! and confirm the keeper mints a rolling pool (CREATE, oracle-free) that the
//! indexer surfaces via the API. Oracle transitions show as "skipped: no tick".
//!
//! Run from packages/watcher with a running devnet + funded creator key:
//!   node --env-file=.env tests/integration/devnet/smoke.test.mjs
//!
//! Skips cleanly when WATCHER_CREATOR_PRIVATE_KEY is unset.

import test from "node:test";
import assert from "node:assert/strict";

import {
  KeeperClient,
  createPrivateKeySigner,
  devnetConfig,
} from "ckb-up-down-sdk";

import { createService } from "../../../dist/index.js";

const KEY = process.env.WATCHER_CREATOR_PRIVATE_KEY;
const RPC = process.env.WATCHER_CKB_RPC_URL ?? "http://127.0.0.1:8114";
const PORT = Number(process.env.WATCHER_SMOKE_PORT ?? 8899);

test("service mints a rolling pool and serves it via the API", async (t) => {
  if (!KEY) return t.skip("WATCHER_CREATOR_PRIVATE_KEY not set");

  const config = devnetConfig({
    ckbJsonRpcUrl: RPC,
    devnetSecp: {
      codeHash: process.env.DEVNET_SECP256K1_BLAKE160_CODE_HASH,
      hashType: process.env.DEVNET_SECP256K1_BLAKE160_HASH_TYPE,
      depTxHash: process.env.DEVNET_SECP256K1_BLAKE160_DEP_TX_HASH,
      depIndex: Number(process.env.DEVNET_SECP256K1_BLAKE160_DEP_INDEX ?? 0),
      depType: process.env.DEVNET_SECP256K1_BLAKE160_DEP_TYPE,
    },
  });

  const keeper = new KeeperClient({ config });
  const signer = createPrivateKeySigner(keeper.client, KEY);
  const { script: creatorLock } = await signer.getRecommendedAddressObj();

  // One fast lane with a short deposit window so a CREATE fires promptly.
  const MIN = 60n;
  const lane = {
    label: "BTC-5m-smoke",
    feedId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    durationSecs: 5n * MIN,
    rakeBps: 200,
    asset: { kind: "ckb" },
    oracleIdentity: {
      oracleTypeCodeHash: "0x" + "11".repeat(32),
      guardianSetTypeHash: "0x" + "22".repeat(32),
      emitterChain: 26,
      emitterAddress: "0x" + "33".repeat(32),
    },
    createLeadSecs: 2n * MIN,
  };

  const service = createService({
    config: {
      role: "all",
      config,
      creatorLock,
      lanes: [lane],
      pollIntervalSecs: 5,
      indexIntervalSecs: 5,
      dbPath: ":memory:",
      apiPort: PORT,
    },
    keeper,
    signer,
  });

  await service.start();
  try {
    // Poll the API until a pool shows up (CREATE committed + indexed), up to ~90s.
    let pools = [];
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`http://127.0.0.1:${PORT}/pools`);
      pools = await res.json();
      if (pools.length > 0) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    assert.ok(pools.length > 0, "expected the keeper to mint at least one pool");
    assert.equal(pools[0].lane.label, "BTC-5m-smoke");
    assert.equal(pools[0].status, "open");
  } finally {
    await service.stop();
  }
});
