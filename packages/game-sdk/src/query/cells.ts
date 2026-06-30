//! Pure cell classifiers/decoders for chain queries. These take a minimal cell
//! shape (the type/lock scripts + data) and decode the pool-relevant payloads,
//! using the same matching rules the contract uses (code hash + args).

import { decodeAmount } from "../ckb/cellData.js";
import { SIDE_DOWN, SIDE_UP } from "../constants.js";
import { hexToBytes, type Hex } from "../internal/bytes.js";
import { decodePoolData } from "../codec/poolData.js";
import type { PoolData, PoolDeployment, Script } from "../types.js";

export interface CellView {
  type?: Script | null;
  /** Hash of the type script, when known. The impure query layer computes it. */
  typeHash?: Hex | null;
  lock: Script;
  data: Hex;
}

function eqHashLower(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Decode a PoolCell's data if its type script is a pool_type cell. */
export function asPool(cell: CellView, deploy: PoolDeployment): PoolData | null {
  if (!cell.type || !eqHashLower(cell.type.codeHash, deploy.poolTypeCodeHash)) return null;
  return decodePoolData(cell.data);
}

/** The pool typeID (== type script args) for a PoolCell, or null. */
export function poolIdOf(cell: CellView, deploy: PoolDeployment): Hex | null {
  if (!cell.type || !eqHashLower(cell.type.codeHash, deploy.poolTypeCodeHash)) return null;
  return cell.type.args;
}

/**
 * If this is a share cell for `poolTypeHash`, return `{ side, amount }`. Matches
 * `share_xudt` cells by `code_hash` and `args == poolTypeHash ‖ side`.
 */
export function asShare(
  cell: CellView,
  poolTypeHash: Hex,
  shareXudtCodeHash: Hex,
): { side: number; amount: bigint } | null {
  if (!cell.type || !eqHashLower(cell.type.codeHash, shareXudtCodeHash)) return null;
  const args = hexToBytes(cell.type.args);
  if (args.length !== 33) return null;
  const wantPrefix = hexToBytes(poolTypeHash);
  for (let i = 0; i < 32; i++) if (args[i] !== wantPrefix[i]) return null;
  const side = args[32];
  if (side !== SIDE_UP && side !== SIDE_DOWN) return null;
  const amount = decodeAmount(cell.data);
  if (amount === null) return null;
  return { side, amount };
}

/**
 * If this is the xUDT TreasuryCell for `poolTypeHash`, return its amount. The
 * lock binding (`lock == { treasury_lock, args: poolTypeHash }`) identifies the
 * pool's treasury, but the lock alone doesn't fix the staked-asset *type*: a
 * wrong xUDT sent to that lock would otherwise be counted. So we also require the
 * cell's type-script hash to equal the pool's `assetTypeHash` (matching what the
 * on-chain transitions enforce), and need `cell.typeHash` to be populated.
 */
export function asTreasury(
  cell: CellView,
  poolTypeHash: Hex,
  assetTypeHash: Hex,
  treasuryLockCodeHash: Hex,
): bigint | null {
  if (!eqHashLower(cell.lock.codeHash, treasuryLockCodeHash)) return null;
  if (!eqHashLower(cell.lock.args, poolTypeHash)) return null;
  if (!cell.type || !cell.typeHash) return null;
  if (!eqHashLower(cell.typeHash, assetTypeHash)) return null;
  return decodeAmount(cell.data);
}
