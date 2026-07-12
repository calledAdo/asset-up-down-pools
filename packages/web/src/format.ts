//! Display helpers. On-chain amounts arrive as decimal strings of base units
//! (1 CKB = 1e8 shannons); times are unix seconds as strings.

const SHANNON = 100_000_000n;

/** Format a base-unit string as CKB with up to 4 decimals. */
export function fmtCkb(baseUnits: string): string {
  const v = BigInt(baseUnits || "0");
  const whole = v / SHANNON;
  const frac = v % SHANNON;
  if (frac === 0n) return `${whole}`;
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "").slice(0, 4);
  return `${whole}.${fracStr}`;
}

/** CKB (possibly fractional) → shannons bigint. */
export function ckbToShannons(ckb: string): bigint {
  const [whole, frac = ""] = ckb.trim().split(".");
  const fracPadded = (frac + "00000000").slice(0, 8);
  return BigInt(whole || "0") * SHANNON + BigInt(fracPadded || "0");
}

export function fmtPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

export function fmtMultiple(m: number | null): string {
  return m === null ? "—" : `${m.toFixed(2)}×`;
}

export function fmtTime(unixSecs: string): string {
  const n = Number(unixSecs);
  if (!n) return "—";
  return new Date(n * 1000).toLocaleString();
}

/** Compact "in 3m 20s" / "2m ago" relative to now. */
export function fmtRelative(unixSecs: string): string {
  const target = Number(unixSecs) * 1000;
  if (!target) return "—";
  const delta = Math.round((target - Date.now()) / 1000);
  const abs = Math.abs(delta);
  const unit = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)}m` : abs < 86400 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
  return delta >= 0 ? `in ${unit}` : `${unit} ago`;
}

export function shortId(hex: string): string {
  return hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : hex;
}
