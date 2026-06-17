//! Recompute the oracle-identity commitment stored in PoolData. Mirrors
//! `oracle_read::oracle_commit` in the Rust `common` crate:
//!
//!   H = blake2b_ckb(code_hash ‖ guardian_set_type_hash ‖ emitter_chain_le(4) ‖ emitter_address)

import { ccc } from "@ckb-ccc/core";

import { concatBytes, hexToFixed, type Hex } from "../internal/bytes.js";

export interface OracleIdentity {
  /** Lean Oracle `oracle_type` code hash (32-byte hex). */
  oracleTypeCodeHash: Hex;
  /** Wormhole guardian-set cell type hash (32-byte hex). */
  guardianSetTypeHash: Hex;
  /** Pyth emitter chain (u32; Pythnet = 26). */
  emitterChain: number;
  /** Pyth emitter address (32-byte hex). */
  emitterAddress: Hex;
}

export function oracleCommit(id: OracleIdentity): Hex {
  if (!Number.isInteger(id.emitterChain) || id.emitterChain < 0 || id.emitterChain > 0xffff_ffff) {
    throw new Error(`emitterChain out of u32 range: ${id.emitterChain}`);
  }
  const chainLe = new Uint8Array(4);
  new DataView(chainLe.buffer).setUint32(0, id.emitterChain, true);

  const preimage = concatBytes(
    hexToFixed(id.oracleTypeCodeHash, 32, "oracleTypeCodeHash"),
    hexToFixed(id.guardianSetTypeHash, 32, "guardianSetTypeHash"),
    chainLe,
    hexToFixed(id.emitterAddress, 32, "emitterAddress"),
  );
  return ccc.hashCkb(preimage) as Hex;
}
