//! Chain queries: locate and decode pools, share balances, and treasuries via a
//! CCC client. (Exercised end-to-end against a devnet; the decode/classify logic
//! they rely on is unit-tested in `query/cells`.)

import { ccc } from "@ckb-ccc/core";

import { SIDE_DOWN, SIDE_UP } from "../constants.js";
import type { Hex } from "../internal/bytes.js";
import { poolTypeScript, shareScript, treasuryLockScript } from "../ckb/scripts.js";
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
    lock: toScript(cell.cellOutput.lock),
    data: cell.outputData as Hex,
  };
}

/** Hash of a pool's type script (the value carried in share/treasury args). */
export function poolTypeHashOf(typeScript: Script): Hex {
  return ccc.Script.from(typeScript).hash() as Hex;
}

/** Fetch and decode a single pool by its exact type script. */
export async function getPoolByTypeScript(
  client: ccc.Client,
  deploy: PoolDeployment,
  typeScript: Script,
): Promise<PoolView | null> {
  for await (const cell of client.findCells({
    script: ccc.Script.from(typeScript),
    scriptType: "type",
    scriptSearchMode: "exact",
  })) {
    const view = toView(cell);
    const data = asPool(view, deploy);
    if (!data) continue;
    return {
      poolId: typeScript.args,
      outPoint: { txHash: cell.outPoint.txHash as Hex, index: Number(cell.outPoint.index) },
      typeScript,
      lock: view.lock,
      capacity: cell.cellOutput.capacity,
      data,
    };
  }
  return null;
}

/** Fetch and decode a single pool by its `pool_id` (typeID). */
export async function getPool(
  client: ccc.Client,
  deploy: PoolDeployment,
  poolId: Hex,
): Promise<PoolView | null> {
  return getPoolByTypeScript(client, deploy, poolTypeScript(deploy, poolId));
}

/** Enumerate all live pools for this deployment (prefix search on the code hash). */
export async function listPools(client: ccc.Client, deploy: PoolDeployment): Promise<PoolView[]> {
  const out: PoolView[] = [];
  for await (const cell of client.findCells({
    script: ccc.Script.from({ codeHash: deploy.poolTypeCodeHash, hashType: "data2", args: "0x" }),
    scriptType: "type",
    scriptSearchMode: "prefix",
  })) {
    const view = toView(cell);
    const data = asPool(view, deploy);
    if (!data || !view.type) continue;
    out.push({
      poolId: view.type.args,
      outPoint: { txHash: cell.outPoint.txHash as Hex, index: Number(cell.outPoint.index) },
      typeScript: view.type,
      lock: view.lock,
      capacity: cell.cellOutput.capacity,
      data,
    });
  }
  return out;
}

/** Total xUDT treasury balance held for a pool. */
export async function getTreasuryBalance(
  client: ccc.Client,
  deploy: PoolDeployment,
  poolTypeHash: Hex,
): Promise<bigint> {
  let total = 0n;
  for await (const cell of client.findCells({
    script: ccc.Script.from(treasuryLockScript(deploy, poolTypeHash)),
    scriptType: "lock",
    scriptSearchMode: "exact",
  })) {
    const amt = asTreasury(toView(cell), deploy, poolTypeHash);
    if (amt !== null) total += amt;
  }
  return total;
}

/** A holder's UP/DOWN share balances for one pool, filtered to `holderLock`. */
export async function getShareBalances(
  client: ccc.Client,
  deploy: PoolDeployment,
  poolTypeHash: Hex,
  holderLock: Script,
): Promise<{ up: bigint; down: bigint }> {
  const holderHash = ccc.Script.from(holderLock).hash();
  const out = { up: 0n, down: 0n };
  for (const side of [SIDE_UP, SIDE_DOWN]) {
    for await (const cell of client.findCells({
      script: ccc.Script.from(shareScript(deploy, poolTypeHash, side)),
      scriptType: "type",
      scriptSearchMode: "exact",
    })) {
      if (ccc.Script.from(cell.cellOutput.lock).hash() !== holderHash) continue;
      const s = asShare(toView(cell), deploy, poolTypeHash);
      if (!s) continue;
      if (s.side === SIDE_UP) out.up += s.amount;
      else if (s.side === SIDE_DOWN) out.down += s.amount;
    }
  }
  return out;
}
