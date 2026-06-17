//! xUDT-style cell-data amount codec. Share tokens and the xUDT TreasuryCell
//! carry a little-endian u128 amount in the first 16 bytes of cell data — the
//! same `data[0..16]` the contract reads (`sum_share`, `treasury_balance`).

import { bytesToHex, getU128LE, hexToBytes, setU128LE, type Hex } from "../internal/bytes.js";

export const AMOUNT_LEN = 16;

/** Encode a u128 amount as a 16-byte little-endian hex blob (xUDT data). */
export function encodeAmount(amount: bigint): Hex {
  const out = new Uint8Array(AMOUNT_LEN);
  setU128LE(new DataView(out.buffer), 0, amount);
  return bytesToHex(out);
}

/** Read the leading u128 amount from cell data; returns null if too short. */
export function decodeAmount(input: Uint8Array | string): bigint | null {
  const d = typeof input === "string" ? hexToBytes(input) : input;
  if (d.length < AMOUNT_LEN) return null;
  return getU128LE(new DataView(d.buffer, d.byteOffset, d.byteLength), 0);
}
