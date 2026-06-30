//! PoolData encode/decode — a byte-for-byte mirror of
//! `crates/up_down/contracts/common/src/pool_data.rs`. The layout is led by
//! `variant`, which decides whether xUDT-only fields are present:
//!
//!   variant(1) [asset_type_hash(32) if xUDT] share_xudt_code_hash(32)
//!   [treasury_lock_code_hash(32) if xUDT] feed_id(32) oracle_commit(32)
//!   start_time(8) close_time(8) up_total(16) down_total(16)
//!   start_price(8, i64) settle_price(8, i64) used_pt(8) rake_bps(2) status(1) winner(1)
//!
//! CKB = 173 bytes, xUDT = 237 bytes.

import {
  POOL_LEN_CKB,
  POOL_LEN_XUDT,
  RAKE_BPS_MAX,
  VARIANT_CKB,
  VARIANT_XUDT,
} from "../constants.js";
import {
  bytesToHex,
  getU128LE,
  hexToFixed,
  setU128LE,
  type Hex,
} from "../internal/bytes.js";
import type { PoolData } from "../types.js";

const U64_MAX = (1n << 64n) - 1n;

function requireU64(name: string, v: bigint): bigint {
  if (v < 0n || v > U64_MAX) throw new Error(`${name} out of u64 range: ${v}`);
  return v;
}

function requireU8(name: string, v: number): number {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new Error(`${name} out of u8 range: ${v}`);
  return v;
}

export function encodePoolData(pd: PoolData): Uint8Array {
  const isXudt = pd.variant === VARIANT_XUDT;
  if (pd.variant !== VARIANT_CKB && !isXudt) {
    throw new Error(`unknown variant: ${pd.variant}`);
  }
  if (isXudt && !pd.assetTypeHash) {
    throw new Error("xUDT variant requires assetTypeHash");
  }
  if (!isXudt && pd.assetTypeHash) {
    throw new Error("CKB variant must not carry assetTypeHash");
  }
  if (!pd.shareXudtCodeHash) {
    throw new Error("shareXudtCodeHash is required");
  }
  if (isXudt && !pd.treasuryLockCodeHash) {
    throw new Error("xUDT variant requires treasuryLockCodeHash");
  }
  if (!isXudt && pd.treasuryLockCodeHash) {
    throw new Error("CKB variant must not carry treasuryLockCodeHash");
  }
  if (!Number.isInteger(pd.rakeBps) || pd.rakeBps < 0 || pd.rakeBps > RAKE_BPS_MAX) {
    throw new Error(`rakeBps out of range [0, ${RAKE_BPS_MAX}]: ${pd.rakeBps}`);
  }

  const len = isXudt ? POOL_LEN_XUDT : POOL_LEN_CKB;
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);

  let o = 0;
  out[o] = requireU8("variant", pd.variant);
  o += 1;
  if (isXudt) {
    out.set(hexToFixed(pd.assetTypeHash as string, 32, "assetTypeHash"), o);
    o += 32;
  }
  out.set(hexToFixed(pd.shareXudtCodeHash, 32, "shareXudtCodeHash"), o);
  o += 32;
  if (isXudt) {
    out.set(hexToFixed(pd.treasuryLockCodeHash as string, 32, "treasuryLockCodeHash"), o);
    o += 32;
  }
  out.set(hexToFixed(pd.feedId, 32, "feedId"), o);
  o += 32;
  out.set(hexToFixed(pd.oracleCommit, 32, "oracleCommit"), o);
  o += 32;
  dv.setBigUint64(o, requireU64("startTime", pd.startTime), true);
  o += 8;
  dv.setBigUint64(o, requireU64("closeTime", pd.closeTime), true);
  o += 8;
  setU128LE(dv, o, pd.upTotal);
  o += 16;
  setU128LE(dv, o, pd.downTotal);
  o += 16;
  dv.setBigInt64(o, BigInt.asIntN(64, pd.startPrice), true);
  o += 8;
  dv.setBigInt64(o, BigInt.asIntN(64, pd.settlePrice), true);
  o += 8;
  dv.setBigUint64(o, requireU64("usedPt", pd.usedPt), true);
  o += 8;
  dv.setUint16(o, pd.rakeBps, true);
  o += 2;
  out[o] = requireU8("status", pd.status);
  o += 1;
  out[o] = requireU8("winner", pd.winner);
  o += 1;

  return out;
}

export function encodePoolDataHex(pd: PoolData): Hex {
  return bytesToHex(encodePoolData(pd));
}

/** Decode PoolCell data. Returns `null` on unknown variant or wrong length. */
export function decodePoolData(input: Uint8Array | string): PoolData | null {
  const d = typeof input === "string" ? hexToFixedLoose(input) : input;
  if (d.length === 0) return null;
  const variant = d[0];

  let r0: number;
  let assetTypeHash: Hex | undefined;
  let treasuryLockCodeHash: Hex | undefined;
  let shareOffset: number;
  if (variant === VARIANT_CKB) {
    shareOffset = 1;
    r0 = 33;
  } else if (variant === VARIANT_XUDT) {
    if (d.length < 97) return null;
    assetTypeHash = bytesToHex(d.subarray(1, 33));
    shareOffset = 33;
    treasuryLockCodeHash = bytesToHex(d.subarray(65, 97));
    r0 = 97;
  } else {
    return null;
  }

  const expected = r0 + 64 + 76; // oracle-id block (64) + tail (76)
  if (d.length !== expected) return null;

  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const shareXudtCodeHash = bytesToHex(d.subarray(shareOffset, shareOffset + 32));
  const feedId = bytesToHex(d.subarray(r0, r0 + 32));
  const oracleCommit = bytesToHex(d.subarray(r0 + 32, r0 + 64));
  let r = r0 + 64;

  const startTime = dv.getBigUint64(r, true);
  const closeTime = dv.getBigUint64(r + 8, true);
  const upTotal = getU128LE(dv, r + 16);
  const downTotal = getU128LE(dv, r + 32);
  const startPrice = dv.getBigInt64(r + 48, true);
  const settlePrice = dv.getBigInt64(r + 56, true);
  const usedPt = dv.getBigUint64(r + 64, true);
  const rakeBps = dv.getUint16(r + 72, true);
  const status = d[r + 74];
  const winner = d[r + 75];

  return {
    variant,
    assetTypeHash,
    shareXudtCodeHash,
    treasuryLockCodeHash,
    feedId,
    oracleCommit,
    startTime,
    closeTime,
    upTotal,
    downTotal,
    startPrice,
    settlePrice,
    usedPt,
    rakeBps,
    status,
    winner,
  };
}

function hexToFixedLoose(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (s.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
