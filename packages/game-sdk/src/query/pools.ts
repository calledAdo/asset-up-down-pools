//! Chain queries: locate and decode pools, share balances, and treasuries via a
//! CCC client. (Exercised end-to-end against a devnet; the decode/classify logic
//! they rely on is unit-tested in `query/cells`.)

import { ccc } from "@ckb-ccc/core";

import { SIDE_DOWN, SIDE_UP } from "../constants.js";
import { decodeAmount } from "../ckb/cellData.js";
import { bytesToHex, hexToFixed, type Hex } from "../internal/bytes.js";
import { poolAdminLockScript, poolTypeScript } from "../ckb/scripts.js";
import type { PoolData, PoolDeployment, Script } from "../types.js";
import { asPool, asShare, asTreasury, type CellView } from "./cells.js";

export interface PoolView {
  poolId: Hex;
  outPoint: { txHash: Hex; index: number };
  typeScript: Script;
  lock: Script;
  capacity: bigint;
  data: PoolData;
}

function toScript(s: ccc.Script): Script {
  return { codeHash: s.codeHash as Hex, hashType: s.hashType, args: s.args as Hex };
}

function toView(cell: ccc.Cell): CellView {
  const t = cell.cellOutput.type;
  return {
    type: t ? toScript(t) : null,
    typeHash: t ? (t.hash() as Hex) : null,
    lock: toScript(cell.cellOutput.lock),
    data: cell.outputData as Hex,
  };
}

/** Hash of a pool's type script (the value carried in share/treasury args). */
export function poolTypeHashOf(typeScript: Script): Hex {
  return ccc.Script.from(typeScript).hash() as Hex;
}

/**
 * Fetch and decode a single pool by its `pool_id` (typeID) — an exact search on
 * the derived pool_type script (returns at most one live cell). This is the only
 * way to fetch one pool: a pool's type script is fully determined by `poolId` +
 * `deploy`, so there is nothing a by-type-script variant could express that this
 * cannot.
 */
export async function getPool(
  client: ccc.Client,
  deploy: PoolDeployment,
  poolId: Hex,
): Promise<PoolView | null> {
  for await (const cell of client.findCells({
    script: ccc.Script.from(poolTypeScript(deploy, poolId)),
    scriptType: "type",
    scriptSearchMode: "exact",
  })) {
    const pool = cellToPoolView(cell, deploy);
    if (pool) return pool;
  }
  return null;
}

/** Decode one found cell into a `PoolView`, or null if it isn't a valid PoolCell. */
function cellToPoolView(cell: ccc.Cell, deploy: PoolDeployment): PoolView | null {
  const view = toView(cell);
  const data = asPool(view, deploy);
  if (!data || !view.type) return null;
  return {
    poolId: view.type.args,
    outPoint: { txHash: cell.outPoint.txHash as Hex, index: Number(cell.outPoint.index) },
    typeScript: view.type,
    lock: view.lock,
    capacity: cell.cellOutput.capacity,
    data,
  };
}

/** Filter for {@link listPools}. */
export interface PoolFilter {
  /**
   * Only pools created under this creator-lock **hash** (the PoolCell's
   * `pool_admin_lock` args). Switches the search to a **lock-scoped** query — the
   * efficient, correct way to list only the pools you operate, instead of scanning
   * every pool on the permissionless deployment. `ccc.Script.from(lock).hash()`.
   */
  creator?: Hex;
  /** Keep only pools in this status (or any of these). */
  status?: number | number[];
  /** Keep only pools tracking this Pyth feed id. */
  feedId?: Hex;
}

/**
 * Enumerate live pools, optionally filtered. With no `filter.creator` this is a
 * deployment-wide scan over every pool_type cell — and since the contracts are
 * permissionless, that includes pools created by anyone. Pass `filter.creator` to
 * switch to a lock-scoped search returning only your pools; `status` / `feedId`
 * narrow the decoded results in memory.
 */
export async function listPools(
  client: ccc.Client,
  deploy: PoolDeployment,
  filter?: PoolFilter,
): Promise<PoolView[]> {
  const search = filter?.creator
    ? {
        script: ccc.Script.from(poolAdminLockScript(deploy, filter.creator)),
        scriptType: "lock" as const,
        scriptSearchMode: "exact" as const,
      }
    : {
        script: ccc.Script.from({ codeHash: deploy.poolTypeCodeHash, hashType: "data2", args: "0x" }),
        scriptType: "type" as const,
        scriptSearchMode: "prefix" as const,
      };
  const statuses =
    filter?.status === undefined
      ? null
      : new Set(Array.isArray(filter.status) ? filter.status : [filter.status]);
  const feed = filter?.feedId?.toLowerCase();

  const out: PoolView[] = [];
  for await (const cell of client.findCells(search)) {
    const pool = cellToPoolView(cell, deploy);
    if (!pool) continue;
    if (statuses && !statuses.has(pool.data.status)) continue;
    if (feed && pool.data.feedId.toLowerCase() !== feed) continue;
    out.push(pool);
  }
  return out;
}

/**
 * Total xUDT treasury balance held for `pool` (xUDT pools only). The staked-asset
 * type and treasury lock are read from the pool's OWN data, so the query matches
 * that pool's configuration exactly; cells of any other type sent to the treasury
 * lock are ignored, as on-chain. Throws for a CKB pool, which holds funds in
 * PoolCell capacity, not a treasury.
 */
export async function getTreasuryBalance(client: ccc.Client, pool: PoolView): Promise<bigint> {
  const { assetTypeHash, treasuryLockCodeHash } = pool.data;
  if (!assetTypeHash || !treasuryLockCodeHash) {
    throw new Error("getTreasuryBalance: pool is not an xUDT pool (no treasury)");
  }
  const poolTypeHash = poolTypeHashOf(pool.typeScript);
  let total = 0n;
  for await (const cell of client.findCells({
    script: ccc.Script.from({ codeHash: treasuryLockCodeHash, hashType: "data2", args: poolTypeHash }),
    scriptType: "lock",
    scriptSearchMode: "exact",
  })) {
    const amt = asTreasury(toView(cell), poolTypeHash, assetTypeHash, treasuryLockCodeHash);
    if (amt !== null) total += amt;
  }
  return total;
}

/**
 * Every share cell of `poolTypeHash` held under `holderLock`, found via ONE
 * **lock-scoped** query. This scans the holder's own cells (typically few) and
 * filters them to this pool's shares — rather than scanning the pool's entire
 * share supply across all holders and discarding the misses. It is the right shape
 * for a per-holder read (positions / redeem / withdraw / burn), the hot path,
 * and mirrors how {@link collectAssetCells} already works. Whole-pool indexing
 * ({@link listShareCells}) deliberately stays type-scoped.
 */
async function holderShareCells(
  client: ccc.Client,
  poolTypeHash: Hex,
  shareXudtCodeHash: Hex,
  holderLock: ccc.ScriptLike,
): Promise<{ outPoint: { txHash: Hex; index: number }; side: number; amount: bigint }[]> {
  const out: { outPoint: { txHash: Hex; index: number }; side: number; amount: bigint }[] = [];
  for await (const cell of client.findCells({
    script: ccc.Script.from(holderLock),
    scriptType: "lock",
    scriptSearchMode: "exact",
  })) {
    const s = asShare(toView(cell), poolTypeHash, shareXudtCodeHash);
    if (!s) continue;
    out.push({
      outPoint: { txHash: cell.outPoint.txHash as Hex, index: Number(cell.outPoint.index) },
      side: s.side,
      amount: s.amount,
    });
  }
  return out;
}

/**
 * A holder's UP/DOWN share balances for `pool`, filtered to `holderLock`. The
 * pool's share token code is read from its own data (`PoolData.shareXudtCodeHash`),
 * so a pool that pinned a non-default share code is still read correctly.
 */
export async function getShareBalances(
  client: ccc.Client,
  pool: PoolView,
  holderLock: ccc.ScriptLike,
): Promise<{ up: bigint; down: bigint }> {
  const out = { up: 0n, down: 0n };
  const cells = await holderShareCells(
    client,
    poolTypeHashOf(pool.typeScript),
    pool.data.shareXudtCodeHash,
    holderLock,
  );
  for (const c of cells) {
    if (c.side === SIDE_UP) out.up += c.amount;
    else if (c.side === SIDE_DOWN) out.down += c.amount;
  }
  return out;
}

/** A holder's share cells for one side of a pool (outpoint + amount), for burning. */
export async function collectShareCells(
  client: ccc.Client,
  poolTypeHash: Hex,
  shareXudtCodeHash: Hex,
  holderLock: ccc.ScriptLike,
  side: number,
): Promise<{ outPoint: { txHash: Hex; index: number }; amount: bigint }[]> {
  const cells = await holderShareCells(client, poolTypeHash, shareXudtCodeHash, holderLock);
  return cells
    .filter((c) => c.side === side)
    .map((c) => ({ outPoint: c.outPoint, amount: c.amount }));
}

/**
 * Every live share cell of `pool` (both sides), with holder lock + amount —
 * regardless of who holds it. Backs position indexing and {@link getShareSupply}.
 * The pool type hash and share code are derived from the pool itself.
 */
export async function listShareCells(
  client: ccc.Client,
  pool: PoolView,
): Promise<
  {
    side: number;
    amount: bigint;
    holderLock: Script;
    holderLockHash: Hex;
    outPoint: { txHash: Hex; index: number };
  }[]
> {
  const poolTypeHash = poolTypeHashOf(pool.typeScript);
  const shareXudtCodeHash = pool.data.shareXudtCodeHash;
  const out: {
    side: number;
    amount: bigint;
    holderLock: Script;
    holderLockHash: Hex;
    outPoint: { txHash: Hex; index: number };
  }[] = [];
  // ONE prefix search on `args == poolTypeHash` matches BOTH sides (args are
  // `poolTypeHash ‖ side`); `asShare` reads the side back. Halves the queries vs a
  // per-side exact search — this runs per pool in the indexer's hot loop.
  for await (const cell of client.findCells({
    script: ccc.Script.from({
      codeHash: shareXudtCodeHash,
      hashType: "data2",
      args: bytesToHex(hexToFixed(poolTypeHash, 32, "poolTypeHash")),
    }),
    scriptType: "type",
    scriptSearchMode: "prefix",
  })) {
    const s = asShare(toView(cell), poolTypeHash, shareXudtCodeHash);
    if (!s) continue;
    const lock = cell.cellOutput.lock;
    out.push({
      side: s.side,
      amount: s.amount,
      holderLock: toScript(lock),
      holderLockHash: lock.hash() as Hex,
      outPoint: { txHash: cell.outPoint.txHash as Hex, index: Number(cell.outPoint.index) },
    });
  }
  return out;
}

/**
 * Total outstanding share supply for a pool, summed across all holders. Used to
 * decide a terminal pool is fully redeemed (both sides 0) and safe to CLOSE — the
 * contract does not check this, so the keeper guards it to avoid stranding redeemers.
 */
export async function getShareSupply(
  client: ccc.Client,
  pool: PoolView,
): Promise<{ up: bigint; down: bigint }> {
  const out = { up: 0n, down: 0n };
  for (const c of await listShareCells(client, pool)) {
    if (c.side === SIDE_UP) out.up += c.amount;
    else if (c.side === SIDE_DOWN) out.down += c.amount;
  }
  return out;
}

/** A holder's cells of `assetType` (outpoint + amount) until Σ ≥ `atLeast`. Throws if short. */
export async function collectAssetCells(
  client: ccc.Client,
  assetType: Script,
  holderLock: ccc.ScriptLike,
  atLeast: bigint,
): Promise<{ outPoint: { txHash: Hex; index: number }; amount: bigint }[]> {
  const assetHash = ccc.Script.from(assetType).hash();
  const out: { outPoint: { txHash: Hex; index: number }; amount: bigint }[] = [];
  let sum = 0n;
  for await (const cell of client.findCells({
    script: ccc.Script.from(holderLock),
    scriptType: "lock",
    scriptSearchMode: "exact",
  })) {
    const t = cell.cellOutput.type;
    if (!t || t.hash() !== assetHash) continue;
    const amt = decodeAmount(cell.outputData as Hex);
    if (amt === null) continue;
    out.push({ outPoint: { txHash: cell.outPoint.txHash as Hex, index: Number(cell.outPoint.index) }, amount: amt });
    sum += amt;
    if (sum >= atLeast) break;
  }
  if (sum < atLeast) {
    throw new Error(`holder has insufficient asset balance: have ${sum}, need ${atLeast}`);
  }
  return out;
}
