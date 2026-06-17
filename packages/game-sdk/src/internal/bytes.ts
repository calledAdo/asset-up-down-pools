//! Little-endian byte helpers. These mirror Rust `to_le_bytes`/`from_le_bytes`
//! exactly (via `DataView`), so encoded payloads survive on-chain VM verification.
//! Browser-safe: no `Buffer` dependency.

export type Hex = `0x${string}`;

export function isHex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x([0-9a-fA-F]{2})*$/.test(value);
}

export function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (s.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex: ${hex}`);
    out[i] = byte;
  }
  return out;
}

/** Decode a hex string and assert it is exactly `len` bytes. */
export function hexToFixed(hex: string, len: number, field: string): Uint8Array {
  const b = hexToBytes(hex);
  if (b.length !== len) {
    throw new Error(`${field} must be ${len} bytes, got ${b.length} (${hex})`);
  }
  return b;
}

export function bytesToHex(b: Uint8Array): Hex {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s as Hex;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const U64_MASK = (1n << 64n) - 1n;

/** Write a little-endian unsigned 128-bit integer at `off`. */
export function setU128LE(dv: DataView, off: number, value: bigint): void {
  if (value < 0n || value > (1n << 128n) - 1n) {
    throw new Error(`u128 out of range: ${value}`);
  }
  dv.setBigUint64(off, value & U64_MASK, true);
  dv.setBigUint64(off + 8, value >> 64n, true);
}

/** Read a little-endian unsigned 128-bit integer at `off`. */
export function getU128LE(dv: DataView, off: number): bigint {
  const lo = dv.getBigUint64(off, true);
  const hi = dv.getBigUint64(off + 8, true);
  return (hi << 64n) | lo;
}
