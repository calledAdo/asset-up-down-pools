//! Opt-in devnet integration test: drive a CKB pool through its ENTIRE lifecycle
//! against a live offckb devnet and the real deployed scripts —
//!   CREATE → DEPOSIT(up+down) → ACTIVATE → RESOLVE → FINALIZE → REDEEM → BURN
//! The oracle-gated transitions are fed a self-minted mock oracle cell (see
//! mockOracle.mjs) whose price + publish_time we choose, so the whole flow runs in
//! seconds with no waiting and without the Lean Oracle. CLOSE is omitted — its
//! 7-day grace is real wall-clock (covered by the Rust contract tests).
//!
//! Run from packages/game-sdk with the deployer env loaded:
//!   node --env-file=../../deployment/.env tests/integration/devnet/lifecycle.test.mjs
//!
//! Requires: a running offckb devnet with the four scripts deployed (artifacts in
//! deployment/artifacts/devnet.*.json) and a funded DEVNET_DEPLOYER_PRIVATE_KEY.

import test from "node:test";
import assert from "node:assert/strict";

import { ccc } from "@ckb-ccc/core";

import {
  KeeperClient,
  PlayerClient,
  createClient,
  createPrivateKeySigner,
  computeTypeId,
  definePoolNetworkConfig,
  redeemPayout,
  STATUS_OPEN,
  STATUS_LOCKED,
  STATUS_SETTLED,
  STATUS_FINALIZED,
  SIDE_UP,
  SIDE_DOWN,
  SIDE_UNDECIDED,
  VARIANT_CKB,
} from "../../../dist/index.js";

import { mockOracleCommit, mintMockOracleCells } from "./mockOracle.mjs";
import { deployDeps } from "./deployDeps.mjs";

const RPC = process.env.DEVNET_CKB_RPC_URL ?? "http://127.0.0.1:8114";
// Opt-in gate: the env-file provides the deployer key, signalling devnet is wired.
const ENABLED = Boolean(process.env.DEVNET_DEPLOYER_PRIVATE_KEY);
// offckb genesis account #0 — funds the bootstrap and every role. NOT the deployer:
// keeping the funder distinct from the always_success-locked deps means fee funding
// can never consume a dep cell, so the test is repeatable.
const GENESIS_KEY = "0x6109170b275a09ad54877b82f7d9930f88cab5717d484fb4741ae9d1dd078cd6";
const CKB = 100000000n;

const devnetSecp = {
  codeHash: process.env.DEVNET_SECP256K1_BLAKE160_CODE_HASH,
  hashType: process.env.DEVNET_SECP256K1_BLAKE160_HASH_TYPE,
  depTxHash: process.env.DEVNET_SECP256K1_BLAKE160_DEP_TX_HASH,
  depIndex: Number(process.env.DEVNET_SECP256K1_BLAKE160_DEP_INDEX ?? 0),
  depType: process.env.DEVNET_SECP256K1_BLAKE160_DEP_TYPE,
};

test("full CKB pool lifecycle on devnet (create → deposit → activate → resolve → finalize → redeem)", async (t) => {
  if (!ENABLED) return t.skip("devnet env not loaded (DEVNET_DEPLOYER_PRIVATE_KEY unset)");

  const client = createClient("devnet", RPC, devnetSecp);
  const signer = createPrivateKeySigner(client, GENESIS_KEY);
  const { script: lock } = await signer.getRecommendedAddressObj();

  // Bootstrap fresh, always_success-locked dep cells so the run is deterministic.
  const deployment = await deployDeps(client, signer);
  const config = definePoolNetworkConfig({ name: "devnet", ckbJsonRpcUrl: RPC, deployment, devnetSecp });
  t.diagnostic("deployed fresh dep cells under always_success");

  // The genesis account plays every role (keeper + creator + depositor + redeemer).
  const keeper = new KeeperClient({ config, cccClient: client });
  const player = new PlayerClient({ config, cccClient: client });

  // Seed input for the typeID — the funder's first live cell.
  let seedOutPoint;
  for await (const cell of client.findCells({ script: ccc.Script.from(lock), scriptType: "lock", scriptSearchMode: "exact" })) {
    seedOutPoint = cell.outPoint;
    break;
  }
  assert.ok(seedOutPoint, "deployer has no live cells to seed the pool");
  const seedInput = { previousOutput: { txHash: seedOutPoint.txHash, index: Number(seedOutPoint.index) }, since: 0n };

  // Boundaries on the chain clock. Deposits close at start_time, so the deposit
  // window is [now, start) — 10 min of headroom. The transitions are gated on the
  // oracle publish_time only (not the wall clock), so they fire immediately.
  const now = (await client.getTipHeader()).timestamp / 1000n;
  const startTime = now + 600n;
  const closeTime = now + 900n;
  const voidTime = closeTime + 60n; // grace(300s) = clamp(30,60,600) = 60
  const feedId = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
  const oracleCommit = mockOracleCommit();

  const send = async (tx) => {
    const hash = await signer.sendTransaction(tx);
    await client.waitTransaction(hash, 0, 120000);
    return hash;
  };

  // ---- CREATE ------------------------------------------------------------
  let tx = await keeper.draftCreate({
    seedInput,
    creatorLock: lock,
    asset: { kind: "ckb" },
    feedId,
    oracleCommit,
    startTime,
    closeTime,
    rakeBps: 200,
  });
  await keeper.complete(tx, signer, { feeRate: 1000n });
  const createHash = await send(tx);
  const poolId = computeTypeId(seedInput, 0);

  let pool = await keeper.getPool(poolId);
  assert.ok(pool, "pool not found after CREATE");
  assert.equal(pool.data.status, STATUS_OPEN);
  assert.equal(pool.data.variant, VARIANT_CKB);
  assert.equal(pool.data.oracleCommit.toLowerCase(), oracleCommit.toLowerCase());
  t.diagnostic(`CREATE ok — pool ${poolId} (tx ${createHash})`);

  // ---- DEPOSIT (300 UP + 200 DOWN) ---------------------------------------
  const upStake = 300n * CKB;
  const downStake = 200n * CKB;
  tx = await player.draftDeposit({ poolId, depositorLock: lock, upAmount: upStake, downAmount: downStake });
  await player.complete(tx, signer, { feeRate: 1000n });
  const depositHash = await send(tx);

  pool = await keeper.getPool(poolId);
  assert.equal(pool.data.status, STATUS_OPEN);
  assert.equal(pool.data.upTotal, upStake);
  assert.equal(pool.data.downTotal, downStake);
  let shares = await player.getShareBalances(poolId, lock);
  assert.equal(shares.up, upStake, "UP shares minted");
  assert.equal(shares.down, downStake, "DOWN shares minted");
  t.diagnostic(`DEPOSIT ok — up=${shares.up} down=${shares.down} (tx ${depositHash})`);

  // ---- mint mock oracle cells (activate / resolve / finalize ticks) -------
  // settle (110) > start (100) ⇒ UP wins.
  const [activateTick, resolveTick, finalizeTick] = await mintMockOracleCells(client, signer, [
    { feedId, price: 100, publishTime: startTime + 1n }, // in (start, close)
    { feedId, price: 110, publishTime: closeTime + 1n }, // in (close, void)
    { feedId, price: 110, publishTime: voidTime + 5n }, // >= void
  ]);
  t.diagnostic("minted 3 mock oracle cells");

  // ---- ACTIVATE (OPEN → LOCKED) ------------------------------------------
  tx = await keeper.draftActivate({ poolId, oracle: activateTick });
  await keeper.complete(tx, signer, { feeRate: 1000n });
  const activateHash = await send(tx);
  pool = await keeper.getPool(poolId);
  assert.equal(pool.data.status, STATUS_LOCKED, "pool LOCKED after ACTIVATE");
  assert.equal(pool.data.startPrice, 100n);
  assert.equal(pool.data.usedPt, startTime + 1n);
  assert.equal(pool.data.winner, SIDE_UNDECIDED);
  t.diagnostic(`ACTIVATE ok — startPrice=${pool.data.startPrice} (tx ${activateHash})`);

  // ---- RESOLVE (LOCKED → SETTLED, UP wins) -------------------------------
  tx = await keeper.draftResolve({ poolId, oracle: resolveTick });
  await keeper.complete(tx, signer, { feeRate: 1000n });
  const resolveHash = await send(tx);
  pool = await keeper.getPool(poolId);
  assert.equal(pool.data.status, STATUS_SETTLED, "pool SETTLED after RESOLVE");
  assert.equal(pool.data.settlePrice, 110n);
  assert.equal(pool.data.winner, SIDE_UP, "UP wins (settle > start)");
  t.diagnostic(`RESOLVE ok — settlePrice=${pool.data.settlePrice} winner=UP (tx ${resolveHash})`);

  // ---- FINALIZE (SETTLED → FINALIZED) ------------------------------------
  tx = await keeper.draftFinalize({ poolId, oracle: finalizeTick });
  await keeper.complete(tx, signer, { feeRate: 1000n });
  const finalizeHash = await send(tx);
  pool = await keeper.getPool(poolId);
  assert.equal(pool.data.status, STATUS_FINALIZED, "pool FINALIZED after FINALIZE");
  t.diagnostic(`FINALIZE ok (tx ${finalizeHash})`);

  // ---- REDEEM (burn winning UP shares, collect payout) -------------------
  const expectedPayout = redeemPayout({
    status: pool.data.status,
    winner: pool.data.winner,
    upTotal: pool.data.upTotal,
    downTotal: pool.data.downTotal,
    rakeBps: pool.data.rakeBps,
    burnedUp: upStake,
    burnedDown: 0n,
  });
  const poolCapBefore = pool.capacity;

  tx = await player.draftRedeem({ poolId, redeemerLock: lock });
  await player.complete(tx, signer, { feeRate: 1000n });
  const redeemHash = await send(tx);

  pool = await keeper.getPool(poolId);
  assert.equal(pool.data.status, STATUS_FINALIZED, "pool stays FINALIZED after REDEEM");
  assert.equal(pool.capacity, poolCapBefore - expectedPayout, "PoolCell capacity dropped by payout");
  shares = await player.getShareBalances(poolId, lock);
  assert.equal(shares.up, 0n, "winning UP shares burned");
  t.diagnostic(`REDEEM ok — payout=${expectedPayout} (tx ${redeemHash})`);

  // ---- BURN (loser reclaims CKB from worthless DOWN shares) --------------
  // The holder still owns the losing DOWN position; DOWN lost so it pays
  // nothing. Burning those shares (no PoolCell, no treasury) destroys them and
  // returns the share cells' CKB capacity to the holder as plain CKB.
  assert.equal(shares.down, downStake, "DOWN (losing) shares still held before burn");
  tx = await player.draftBurnShares({ poolId, holderLock: lock, sides: [SIDE_DOWN] });
  await player.complete(tx, signer, { feeRate: 1000n });
  const burnHash = await send(tx);
  shares = await player.getShareBalances(poolId, lock);
  assert.equal(shares.down, 0n, "losing DOWN shares burned, CKB reclaimed");
  t.diagnostic(`BURN ok — losing DOWN shares destroyed (tx ${burnHash})`);

  t.diagnostic("full lifecycle verified end-to-end against live devnet scripts");
});
