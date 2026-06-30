//! On-chain script derivation. The pool's scripts reference each other by code
//! (data) hash; the UP/DOWN share-token identities and the TreasuryCell lock are
//! *derived* from the PoolCell's type hash + a small tag, not stored. `pool_type`
//! matches these by code hash + args (not hash_type), and the binaries are
//! deployed by data hash, so everything is referenced under `data2`.

import {
  SIDE_DOWN,
  SIDE_UP,
} from "../constants.js";
import { bytesToHex, concatBytes, hexToFixed, type Hex } from "../internal/bytes.js";
import type { PoolDeployment, Script } from "../types.js";

const DATA2 = "data2" as const;

/** The PoolCell type script. `args` is the pool's typeID (`pool_id`). */
export function poolTypeScript(deploy: PoolDeployment, poolId: Hex): Script {
  return {
    codeHash: deploy.poolTypeCodeHash,
    hashType: DATA2,
    args: bytesToHex(hexToFixed(poolId, 32, "poolId")),
  };
}

/**
 * The UP/DOWN share-token type script for a pool.
 * `args = pool_type_hash(32) ‖ side(1)`; `side` is SIDE_UP or SIDE_DOWN.
 */
export function shareScript(deploy: PoolDeployment, poolTypeHash: Hex, side: number): Script {
  if (side !== SIDE_UP && side !== SIDE_DOWN) {
    throw new Error(`share side must be SIDE_UP(${SIDE_UP}) or SIDE_DOWN(${SIDE_DOWN}), got ${side}`);
  }
  return {
    codeHash: deploy.shareXudtCodeHash,
    hashType: DATA2,
    args: bytesToHex(concatBytes(hexToFixed(poolTypeHash, 32, "poolTypeHash"), Uint8Array.of(side))),
  };
}

/**
 * The xUDT pool's TreasuryCell lock. `args = pool_type_hash(32)` — spendable only
 * in a tx that also consumes the matching PoolCell.
 */
export function treasuryLockScript(deploy: PoolDeployment, poolTypeHash: Hex): Script {
  return {
    codeHash: deploy.treasuryLockCodeHash,
    hashType: DATA2,
    args: bytesToHex(hexToFixed(poolTypeHash, 32, "poolTypeHash")),
  };
}

/**
 * The PoolCell lock. `args = creator_lock_hash(32)`: permissionless on
 * continuation (the typeID continues in outputs), with a creator-escape path for
 * terminal CLOSE.
 */
export function poolAdminLockScript(deploy: PoolDeployment, creatorLockHash: Hex): Script {
  return {
    codeHash: deploy.poolAdminLockCodeHash,
    hashType: DATA2,
    args: bytesToHex(hexToFixed(creatorLockHash, 32, "creatorLockHash")),
  };
}
