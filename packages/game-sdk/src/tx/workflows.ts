//! High-level "draft tx" workflows: resolve on-chain state via a CCC client, then
//! delegate to the pure builders. Like the rest of the tx layer, these return a
//! structurally complete draft with **no fee inputs / change** — run
//! `completeFeeAndChange` then sign.
//!
//! Wiring ergonomics: each workflow takes the chain `client` plus ONE `deployment`
//! object (the code hashes + cell deps together), and accepts any CCC `ScriptLike`
//! for caller locks — so a wallet's `ccc.Script` drops straight in.

import { ccc } from "@ckb-ccc/core";

import { decodeAmount } from "../ckb/cellData.js";
import { treasuryLockScript } from "../ckb/scripts.js";
import {
  SIDE_DOWN,
  SIDE_UP,
  STATUS_FINALIZED,
  STATUS_VOID,
  VARIANT_XUDT,
  WINNER_VOID,
} from "../constants.js";
import type { Hex } from "../internal/bytes.js";
import {
  toPoolCodeDeps,
  toPoolDeployment,
  type PoolDeploymentConfig,
} from "../presets/config.js";
import { collectAssetCells, collectShareCells, getPool } from "../query/pools.js";
import type { CellDepInfo, PoolCodeDeps, PoolDeployment, Script } from "../types.js";
import { buildCreatePoolTx, type BuildCreatePoolParams } from "./create.js";
import {
  buildDepositTx,
  type AssetInputCell,
  type TreasuryCellRef,
} from "./deposit.js";
import { buildRedeemTx, type ShareInputCell } from "./redeem.js";
import { buildWithdrawTx } from "./withdraw.js";
import { buildBurnSharesTx } from "./burnShares.js";
import { buildCloseTx } from "./close.js";
import { poolTypeScript } from "../ckb/scripts.js";
import {
  buildActivateTx,
  buildCorrectStartTx,
  buildResolveTx,
  buildCorrectSettleTx,
  buildFinalizeTx,
  buildTransitionBatch,
  type KeeperTransitionParams,
  type BatchTransitionItem,
  type TransitionKind,
} from "./keeperTransitions.js";
import type { OracleTick } from "./oracleTick.js";
import { resolveAssetDep } from "./asset.js";

/** The xUDT context the pure builders need, all derived from chain + CCC. */
interface XudtContext {
  treasury: TreasuryCellRef;
  assetType: Script;
  assetTypeDep: CellDepInfo;
}

/**
 * Split one `deployment` config into the code-hash view (`deploy`, for script
 * derivation) and the cell-dep view (`deps`, for tx assembly) the pure builders
 * take separately. Lets the workflows expose a single `deployment` field.
 */
function deploymentViews(deployment: PoolDeploymentConfig): {
  deploy: PoolDeployment;
  deps: PoolCodeDeps;
} {
  return { deploy: toPoolDeployment(deployment), deps: toPoolCodeDeps(deployment) };
}

/**
 * Draft a CREATE transaction. No chain reads are needed — CREATE only mints — so
 * this is a thin wrapper over {@link buildCreatePoolTx}, kept for API symmetry
 * with the other workflows.
 */
export function initiateCreatePool(params: BuildCreatePoolParams): ccc.Transaction {
  return buildCreatePoolTx(params);
}

/** @public */
export interface InitiateDepositParams {
  client: ccc.Client;
  /** The pool deployment (code hashes + cell deps) in one object. */
  deployment: PoolDeploymentConfig;
  /** The pool to deposit into, by its `pool_id` (typeID). */
  poolId: Hex;
  /** Lock that will own the minted shares (and any xUDT change) — any CCC `ScriptLike`. */
  depositorLock: ccc.ScriptLike;
  upAmount: bigint;
  downAmount: bigint;
  /** Override the staked-asset code dep (e.g. devnet, where CCC's xUDT outpoint is wrong). */
  assetTypeDep?: CellDepInfo;
}

/** Tip block hash, attached to CLOSE as the `HeaderDep[0]` the contract reads "now" from. */
async function tipHeaderHash(client: ccc.Client): Promise<Hex> {
  return (await client.getTipHeader()).hash as Hex;
}

/**
 * Locate a pool's sole TreasuryCell (xUDT pools) by its pool-bound lock and the
 * pool's configured `asset_type_hash`, and read the staked asset's type script
 * straight off it — so callers never pass the asset type themselves.
 */
async function findTreasuryCell(
  client: ccc.Client,
  poolTypeHash: Hex,
  treasuryLockCodeHash: Hex,
  assetTypeHash: Hex,
): Promise<{ ref: TreasuryCellRef; assetType: Script }> {
  const treasuryLock = treasuryLockScript({ treasuryLockCodeHash } as PoolDeployment, poolTypeHash);
  let found: { ref: TreasuryCellRef; assetType: Script } | undefined;
  for await (const cell of client.findCells({
    script: ccc.Script.from(treasuryLock),
    scriptType: "lock",
    scriptSearchMode: "exact",
  })) {
    const t = cell.cellOutput.type;
    if (!t || (t.hash() as Hex).toLowerCase() !== assetTypeHash.toLowerCase()) continue;
    const balance = decodeAmount(cell.outputData as Hex);
    if (balance === null) continue;
    if (found) {
      // The contract requires exactly one TreasuryCell; a split treasury would
      // draft a tx that fails on-chain. Fail here with a clear error instead.
      throw new Error(`ambiguous treasury: multiple cells found for pool ${poolTypeHash}`);
    }
    found = {
      ref: {
        outPoint: { txHash: cell.outPoint.txHash as Hex, index: Number(cell.outPoint.index) },
        capacity: cell.cellOutput.capacity,
        balance,
      },
      assetType: { codeHash: t.codeHash as Hex, hashType: t.hashType, args: t.args as Hex },
    };
  }
  if (!found) throw new Error(`treasury cell not found for pool ${poolTypeHash}`);
  return found;
}

/**
 * Resolve the xUDT context for a pool: find the treasury, read the asset type off
 * it, and resolve the asset's code dep (CCC known xUDT, or `depOverride`).
 */
async function resolveXudtContext(
  client: ccc.Client,
  pool: { typeScript: Script; data: { assetTypeHash?: Hex; treasuryLockCodeHash?: Hex } },
  depOverride?: CellDepInfo,
): Promise<XudtContext> {
  if (!pool.data.treasuryLockCodeHash || !pool.data.assetTypeHash) {
    throw new Error("xUDT pool data is missing treasuryLockCodeHash / assetTypeHash");
  }
  const poolTypeHash = ccc.Script.from(pool.typeScript).hash() as Hex;
  const { ref, assetType } = await findTreasuryCell(
    client,
    poolTypeHash,
    pool.data.treasuryLockCodeHash,
    pool.data.assetTypeHash,
  );
  const assetTypeDep = await resolveAssetDep(client, assetType, depOverride);
  return { treasury: ref, assetType, assetTypeDep };
}

/**
 * Draft a DEPOSIT transaction for `poolId`. Fetches the live PoolCell (and, for
 * xUDT pools, the TreasuryCell) then delegates to {@link buildDepositTx}.
 */
export async function initiateDeposit(params: InitiateDepositParams): Promise<ccc.Transaction> {
  const { deploy, deps } = deploymentViews(params.deployment);
  const depositorLock = ccc.Script.from(params.depositorLock);
  const pool = await getPool(params.client, deploy, params.poolId);
  if (!pool) {
    throw new Error(`pool not found: ${params.poolId}`);
  }

  let ctx: XudtContext | undefined;
  let assetInputs: AssetInputCell[] | undefined;
  if (pool.data.variant === VARIANT_XUDT) {
    ctx = await resolveXudtContext(params.client, pool, params.assetTypeDep);
    // Gather the depositor's own asset cells to fund the stake (Σ ≥ total).
    assetInputs = await collectAssetCells(
      params.client,
      ctx.assetType,
      depositorLock,
      params.upAmount + params.downAmount,
    );
  }

  return buildDepositTx({
    deploy,
    deps,
    pool,
    depositorLock,
    upAmount: params.upAmount,
    downAmount: params.downAmount,
    assetType: ctx?.assetType,
    assetTypeDep: ctx?.assetTypeDep,
    treasury: ctx?.treasury,
    assetInputs,
  });
}

/** @public */
export interface InitiateWithdrawParams {
  client: ccc.Client;
  /** The pool deployment (code hashes + cell deps) in one object. */
  deployment: PoolDeploymentConfig;
  /** The pool to withdraw from, by its `pool_id` (typeID). Must be OPEN. */
  poolId: Hex;
  /** Lock that holds the shares being burned and receives the funds — any CCC `ScriptLike`. */
  withdrawerLock: ccc.ScriptLike;
  /** UP shares to burn (== amount pulled off the UP side). */
  upAmount: bigint;
  /** DOWN shares to burn. */
  downAmount: bigint;
  /** Override the staked-asset code dep (e.g. devnet, where CCC's xUDT outpoint is wrong). */
  assetTypeDep?: CellDepInfo;
}

/**
 * Pick the fewest of `cells` whose amounts sum to at least `need`, returning them
 * as side-tagged share inputs. Throws if the holder's cells can't cover `need`.
 */
function selectShareInputs(
  cells: { outPoint: { txHash: Hex; index: number }; amount: bigint }[],
  side: number,
  need: bigint,
): ShareInputCell[] {
  if (need <= 0n) return [];
  // Largest-first keeps the input count (and any change) small.
  const sorted = [...cells].sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0));
  const picked: ShareInputCell[] = [];
  let acc = 0n;
  for (const c of sorted) {
    if (acc >= need) break;
    picked.push({ ...c, side });
    acc += c.amount;
  }
  if (acc < need) {
    throw new Error(`insufficient ${side === SIDE_UP ? "UP" : "DOWN"} shares to withdraw (have ${acc}, need ${need})`);
  }
  return picked;
}

/**
 * Draft a WITHDRAW transaction for `poolId`. Fetches the live PoolCell (and, for
 * xUDT pools, the TreasuryCell), auto-selects enough of the withdrawer's share
 * cells to cover the requested per-side amounts, then delegates to
 * {@link buildWithdrawTx}.
 */
export async function initiateWithdraw(params: InitiateWithdrawParams): Promise<ccc.Transaction> {
  const { deploy, deps } = deploymentViews(params.deployment);
  const withdrawerLock = ccc.Script.from(params.withdrawerLock);
  const pool = await getPool(params.client, deploy, params.poolId);
  if (!pool) throw new Error(`pool not found: ${params.poolId}`);

  const poolTypeHash = ccc.Script.from(pool.typeScript).hash() as Hex;
  const shareInputs: ShareInputCell[] = [];
  if (params.upAmount > 0n) {
    const cells = await collectShareCells(
      params.client,
      poolTypeHash,
      pool.data.shareXudtCodeHash,
      withdrawerLock,
      SIDE_UP,
    );
    shareInputs.push(...selectShareInputs(cells, SIDE_UP, params.upAmount));
  }
  if (params.downAmount > 0n) {
    const cells = await collectShareCells(
      params.client,
      poolTypeHash,
      pool.data.shareXudtCodeHash,
      withdrawerLock,
      SIDE_DOWN,
    );
    shareInputs.push(...selectShareInputs(cells, SIDE_DOWN, params.downAmount));
  }

  const ctx =
    pool.data.variant === VARIANT_XUDT
      ? await resolveXudtContext(params.client, pool, params.assetTypeDep)
      : undefined;

  return buildWithdrawTx({
    deploy,
    deps,
    pool,
    withdrawerLock,
    upAmount: params.upAmount,
    downAmount: params.downAmount,
    shareInputs,
    assetType: ctx?.assetType,
    assetTypeDep: ctx?.assetTypeDep,
    treasury: ctx?.treasury,
  });
}

/** @public */
export interface InitiateRedeemParams {
  client: ccc.Client;
  /** The pool deployment (code hashes + cell deps) in one object. */
  deployment: PoolDeploymentConfig;
  poolId: Hex;
  /** Lock receiving the payout / freed CKB — any CCC `ScriptLike`. */
  redeemerLock: ccc.ScriptLike;
  /** Override the staked-asset code dep (e.g. devnet, where CCC's xUDT outpoint is wrong). */
  assetTypeDep?: CellDepInfo;
}

/**
 * Draft a REDEEM transaction for `poolId`. Auto-gathers the redeemer's share cells
 * to burn — the winning side for a finalized win, or both sides for a refund
 * (VOID / finalized tie) — then delegates to {@link buildRedeemTx}.
 */
export async function initiateRedeem(params: InitiateRedeemParams): Promise<ccc.Transaction> {
  const { deploy, deps } = deploymentViews(params.deployment);
  const redeemerLock = ccc.Script.from(params.redeemerLock);
  const pool = await getPool(params.client, deploy, params.poolId);
  if (!pool) throw new Error(`pool not found: ${params.poolId}`);

  const refund =
    pool.data.status === STATUS_VOID ||
    (pool.data.status === STATUS_FINALIZED && pool.data.winner === WINNER_VOID);
  const sides = refund ? [SIDE_UP, SIDE_DOWN] : [pool.data.winner];

  const poolTypeHash = ccc.Script.from(pool.typeScript).hash() as Hex;
  const shareInputs: ShareInputCell[] = [];
  for (const side of sides) {
    const cells = await collectShareCells(
      params.client,
      poolTypeHash,
      pool.data.shareXudtCodeHash,
      redeemerLock,
      side,
    );
    for (const c of cells) shareInputs.push({ ...c, side });
  }
  if (shareInputs.length === 0) {
    throw new Error("redeemer holds no redeemable shares for this pool");
  }

  const ctx =
    pool.data.variant === VARIANT_XUDT
      ? await resolveXudtContext(params.client, pool, params.assetTypeDep)
      : undefined;

  return buildRedeemTx({
    deploy,
    deps,
    pool,
    redeemerLock,
    shareInputs,
    assetType: ctx?.assetType,
    assetTypeDep: ctx?.assetTypeDep,
    treasury: ctx?.treasury,
  });
}

/** @public */
export interface InitiateBurnSharesParams {
  client: ccc.Client;
  /** The pool deployment (code hashes + cell deps) in one object. */
  deployment: PoolDeploymentConfig;
  /** The pool whose shares to burn (by its `pool_id`). The PoolCell needn't exist. */
  poolId: Hex;
  /** Lock holding the shares to burn — any CCC `ScriptLike`. */
  holderLock: ccc.ScriptLike;
  /** Sides to burn; defaults to both UP and DOWN (whatever the holder holds). */
  sides?: number[];
}

/**
 * Draft a BURN for `poolId`: auto-gather the holder's share cells (the given
 * `sides`, default both) and destroy them to reclaim their CKB. Derives the pool
 * type hash from `poolId` alone, so it works even after the pool has been CLOSED.
 * Throws if the holder holds no such shares.
 */
export async function initiateBurnShares(params: InitiateBurnSharesParams): Promise<ccc.Transaction> {
  const { deploy, deps } = deploymentViews(params.deployment);
  const holderLock = ccc.Script.from(params.holderLock);
  const poolTypeHash = ccc.Script.from(poolTypeScript(deploy, params.poolId)).hash() as Hex;
  const sides = params.sides ?? [SIDE_UP, SIDE_DOWN];

  const shareInputs: ShareInputCell[] = [];
  for (const side of sides) {
    const cells = await collectShareCells(
      params.client,
      poolTypeHash,
      deploy.shareXudtCodeHash,
      holderLock,
      side,
    );
    for (const c of cells) shareInputs.push({ ...c, side });
  }
  if (shareInputs.length === 0) {
    throw new Error("holder holds no shares to burn for this pool");
  }

  return buildBurnSharesTx({ deps, shareInputs });
}

/** @public */
export interface InitiateCloseParams {
  client: ccc.Client;
  /** The pool deployment (code hashes + cell deps) in one object. */
  deployment: PoolDeploymentConfig;
  poolId: Hex;
  /** The creator's lock (sole CLOSE authority) — any CCC `ScriptLike`. */
  creatorLock: ccc.ScriptLike;
  /** Override the staked-asset code dep (e.g. devnet, where CCC's xUDT outpoint is wrong). */
  assetTypeDep?: CellDepInfo;
}

/**
 * Draft a CLOSE transaction for `poolId`. Fetches the PoolCell (and, for xUDT
 * pools, the TreasuryCell to sweep) then delegates to {@link buildCloseTx}.
 */
export async function initiateClose(params: InitiateCloseParams): Promise<ccc.Transaction> {
  const { deploy, deps } = deploymentViews(params.deployment);
  const creatorLock = ccc.Script.from(params.creatorLock);
  const pool = await getPool(params.client, deploy, params.poolId);
  if (!pool) throw new Error(`pool not found: ${params.poolId}`);

  const ctx =
    pool.data.variant === VARIANT_XUDT
      ? await resolveXudtContext(params.client, pool, params.assetTypeDep)
      : undefined;

  // Auto-pick one live PLAIN cell under the creator's lock to satisfy pool_admin_lock's
  // creator-escape (teardown is not continuation). Plain only (no type, empty data) so we
  // never consume a meaningful cell that shares the lock — e.g. a deployed code/oracle cell.
  let creatorInput: { outPoint: { txHash: Hex; index: number } } | undefined;
  for await (const cell of params.client.findCells({
    script: creatorLock,
    scriptType: "lock",
    scriptSearchMode: "exact",
    filter: { scriptLenRange: [0, 1], outputDataLenRange: [0, 1] },
  })) {
    creatorInput = { outPoint: { txHash: cell.outPoint.txHash as Hex, index: Number(cell.outPoint.index) } };
    break;
  }
  if (!creatorInput) {
    throw new Error("creator has no live cell to authorize CLOSE (creator-escape)");
  }

  return buildCloseTx({
    deploy,
    deps,
    pool,
    creatorLock,
    creatorInput,
    assetType: ctx?.assetType,
    assetTypeDep: ctx?.assetTypeDep,
    treasury: ctx?.treasury,
    headerDep: await tipHeaderHash(params.client),
  });
}

/** @public */
export interface InitiateKeeperTransitionParams {
  client: ccc.Client;
  /** The pool deployment (code hashes + cell deps) in one object. */
  deployment: PoolDeploymentConfig;
  poolId: Hex;
  /** The resolved oracle observation backing the transition. */
  oracle: OracleTick;
}

/**
 * Build a client-resolving workflow around one keeper-transition builder. A
 * transition moves no staked asset — `phase_frozen` keeps the treasury out of the
 * transaction — so this is identical for CKB and xUDT pools: no asset/treasury
 * resolution at all.
 */
function keeperWorkflow(
  build: (p: KeeperTransitionParams) => ccc.Transaction,
): (params: InitiateKeeperTransitionParams) => Promise<ccc.Transaction> {
  return async (params) => {
    const { deploy, deps } = deploymentViews(params.deployment);
    const pool = await getPool(params.client, deploy, params.poolId);
    if (!pool) throw new Error(`pool not found: ${params.poolId}`);
    return build({ deploy, deps, pool, oracle: params.oracle });
  };
}

/** One pool's transition within a batch: which pool, the kind, and its tick. */
export interface InitiateTransitionBatchItem {
  poolId: Hex;
  kind: TransitionKind;
  oracle: OracleTick;
}

/** @public */
export interface InitiateTransitionBatchParams {
  client: ccc.Client;
  /** The pool deployment (code hashes + cell deps) in one object. */
  deployment: PoolDeploymentConfig;
  items: InitiateTransitionBatchItem[];
}

/**
 * Resolve each pool by id and fold their transitions into ONE transaction (see
 * {@link buildTransitionBatch}). Same contract guarantees as a single transition:
 * each pool is its own `pool_type` group and `pool_admin_lock` checks continuation
 * group-wide. Items are read fresh from the client, so a caller that clears its
 * cache first builds against current chain state.
 */
export async function initiateTransitionBatch(
  params: InitiateTransitionBatchParams,
): Promise<ccc.Transaction> {
  const { deploy, deps } = deploymentViews(params.deployment);
  const items: BatchTransitionItem[] = [];
  for (const it of params.items) {
    const pool = await getPool(params.client, deploy, it.poolId);
    if (!pool) throw new Error(`pool not found: ${it.poolId}`);
    items.push({ deploy, deps, pool, oracle: it.oracle, kind: it.kind });
  }
  return buildTransitionBatch(items);
}

/** Draft an ACTIVATE transaction (OPEN → LOCKED | VOID) for `poolId`. */
export const initiateActivate = keeperWorkflow(buildActivateTx);
/** Draft a CORRECT-START transaction (LOCKED → LOCKED) for `poolId`. */
export const initiateCorrectStart = keeperWorkflow(buildCorrectStartTx);
/** Draft a RESOLVE transaction (LOCKED → SETTLED | VOID) for `poolId`. */
export const initiateResolve = keeperWorkflow(buildResolveTx);
/** Draft a CORRECT-SETTLE transaction (SETTLED → SETTLED) for `poolId`. */
export const initiateCorrectSettle = keeperWorkflow(buildCorrectSettleTx);
/** Draft a FINALIZE transaction (SETTLED → FINALIZED) for `poolId`. */
export const initiateFinalize = keeperWorkflow(buildFinalizeTx);
