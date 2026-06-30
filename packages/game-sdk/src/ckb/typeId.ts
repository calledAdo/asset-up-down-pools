//! typeID computation — mirrors `validate_type_id_seed` in `pool_type`:
//!
//!   pool_id = blake2b_ckb(first_input.as_slice() ‖ output_index_le(8))
//!
//! `first_input.as_slice()` is the molecule serialization of the tx's first
//! CellInput (since(8) ‖ previous_output: tx_hash(32) ‖ index(4) = 44 bytes), and
//! `output_index` is the index of the PoolCell output. Same rule as the standard
//! CKB Type ID script.

import { ccc } from "@ckb-ccc/core";

import { concatBytes, type Hex } from "../internal/bytes.js";

export interface FirstInputLike {
  previousOutput: { txHash: Hex; index: number | bigint };
  /** since; defaults to 0. */
  since?: number | bigint;
}

export function computeTypeId(firstInput: FirstInputLike, outputIndex: number | bigint): Hex {
  const input = ccc.CellInput.from({
    previousOutput: firstInput.previousOutput,
    since: firstInput.since ?? 0n,
  });
  const inputBytes = ccc.bytesFrom(input.toBytes());

  const idxLe = new Uint8Array(8);
  new DataView(idxLe.buffer).setBigUint64(0, BigInt(outputIndex), true);

  return ccc.hashCkb(concatBytes(inputBytes, idxLe)) as Hex;
}
