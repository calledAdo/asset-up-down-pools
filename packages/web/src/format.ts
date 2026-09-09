//! Display helpers. On-chain amounts arrive as decimal strings of base units
//! (1 CKB = 1e8 shannons); times are unix seconds as strings.
//!
//! Two conventions the whole board depends on:
//!
//!   · Figures are grouped and tabular, never raw. A board is read by
//!     comparing straight down a column, and `31282` under `216000` does not
//!     compare — `31,282` under `216,000` does.
//!   · Countdowns clamp at zero. Time that has already elapsed has to be
//!     asked for explicitly (`elapsed`), because a clock that silently runs
//!     negative is how a locked round ends up looking open.

const SHANNON = 100_000_000n;

/** Whole CKB, grouped — the board's default for a pot or a stake. */
export function fmtAmount(baseUnits: string | bigint): string {
  const v = typeof baseUnits === "bigint" ? baseUnits : BigInt(baseUnits || "0");
  return (v / SHANNON).toLocaleString("en-US");
}

/** Compact CKB for a cell or a margin total, where the magnitude is the
 *  reading and the last three digits are noise: `216k`, `6.19M`. */
export function fmtAmountShort(baseUnits: string | bigint): string {
  const v = typeof baseUnits === "bigint" ? baseUnits : BigInt(baseUnits || "0");
  const n = Number(v / SHANNON);
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return n.toLocaleString("en-US");
}

/** CKB (possibly fractional) → shannons bigint. */
export function ckbToShannons(ckb: string): bigint {
  const [whole, frac = ""] = ckb.trim().split(".");
  const fracPadded = (frac + "00000000").slice(0, 8);
  return BigInt(whole || "0") * SHANNON + BigInt(fracPadded || "0");
}

/** Never let a half-typed amount throw. */
export function safeShannons(v: string): bigint {
  const t = v.trim();
  if (!t || !/^\d*\.?\d*$/.test(t)) return 0n;
  try {
    const n = ckbToShannons(t);
    return n > 0n ? n : 0n;
  } catch {
    return 0n;
  }
}

export function fmtPct(p: number | null): string {
  return p === null ? "—" : `${(p * 100).toFixed(1)}%`;
}

/** A side with nothing on it has no multiple. That is an em dash, never a
 *  zero and never a `1.00×` — there is no payout to quote, and inventing one
 *  is exactly the lie this product exists to not tell. */
export function fmtMultiple(m: number | null): string {
  if (m === null) return "—";
  if (m >= 1000) return `${Math.round(m).toLocaleString("en-US")}×`;
  if (m >= 100) return `${m.toFixed(0)}×`;
  return `${m.toFixed(2)}×`;
}

/** Seconds → `4:07`, `1h 04m`, `2d 6h`. Clamped at zero. */
export function cd(secs: number): string {
  return elapsed(Math.max(0, secs));
}

/** The same format, but willing to describe time that has already gone. */
export function elapsed(secs: number): string {
  const a = Math.abs(Math.round(secs));
  if (a >= 86400) return `${Math.floor(a / 86400)}d ${Math.floor((a % 86400) / 3600)}h`;
  if (a >= 3600) return `${Math.floor(a / 3600)}h ${String(Math.floor((a % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`;
}

/** `14:35` UTC — rounds are scheduled on an absolute grid, so the clock that
 *  labels them is absolute too. A local time would make the same round look
 *  like a different round to two people comparing notes. */
export function fmtUtc(unixSecs: string | number, withSecs = false): string {
  const n = Number(unixSecs);
  if (!n) return "—";
  return new Date(n * 1000).toISOString().slice(11, withSecs ? 19 : 16);
}

export function fmtDate(unixSecs: string): string {
  const n = Number(unixSecs);
  if (!n) return "—";
  return new Date(n * 1000).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A feed price. Small quotes need decimals; large ones are noise below the
 *  unit, and a board full of `113,842.00` is a board of wasted columns. */
export function fmtPrice(v: string | number): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!n) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: n < 1 ? 6 : n < 100 ? 2 : 0,
    maximumFractionDigits: n < 1 ? 6 : n < 100 ? 2 : 0,
  });
}

export function shortId(hex: string): string {
  return hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : hex;
}
