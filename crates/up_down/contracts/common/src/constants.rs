//! Enums, the grace function, and oracle identity defaults.

// --- variant -------------------------------------------------------------
pub const VARIANT_CKB: u8 = 0;
pub const VARIANT_XUDT: u8 = 1;

// --- status --------------------------------------------------------------
pub const STATUS_OPEN: u8 = 0;
pub const STATUS_LOCKED: u8 = 1;
/// Provisional resolution: a settle price/winner is recorded but still
/// contestable (an earlier in-band tick may replace it) until `void_time`.
pub const STATUS_SETTLED: u8 = 2;
/// Reserved, unused. CLOSE is a terminal consumption (1→0): the PoolCell is
/// destroyed, so no cell ever carries this status. The value `3` is kept reserved
/// (never reassigned) so the VOID/FINALIZED encodings below stay pinned.
pub const STATUS_CLOSED: u8 = 3;
pub const STATUS_VOID: u8 = 4;
/// Resolution is final (the contest window closed, proven by an oracle tick at
/// or after `void_time`). Redemption runs from here.
pub const STATUS_FINALIZED: u8 = 5;

// --- side / winner -------------------------------------------------------
pub const SIDE_UNDECIDED: u8 = 0; // winner only
pub const SIDE_UP: u8 = 1;
pub const SIDE_DOWN: u8 = 2;
pub const WINNER_VOID: u8 = 3; // winner only

// --- economics -----------------------------------------------------------
pub const RAKE_BPS_MAX: u16 = 10_000;
pub const GRACE_MIN_SECS: u64 = 60;
pub const GRACE_MAX_SECS: u64 = 600;

/// Bounds for the post-settlement teardown grace (see [`close_grace`]).
pub const CLOSE_GRACE_MIN_SECS: u64 = 60 * 60; // 1 hour
pub const CLOSE_GRACE_MAX_SECS: u64 = 7 * 24 * 60 * 60; // 7 days
pub const CLOSE_GRACE_MULT: u64 = 8;

/// Liveness/price grace derived purely from pool duration (nothing stored).
/// `clamp(duration / 10, 60s, 600s)`.
pub fn grace(duration: u64) -> u64 {
    let g = duration / 10;
    if g < GRACE_MIN_SECS {
        GRACE_MIN_SECS
    } else if g > GRACE_MAX_SECS {
        GRACE_MAX_SECS
    } else {
        g
    }
}

/// Post-settlement window before a FINALIZED/VOID pool may be swept and destroyed
/// (CLOSE), derived purely from pool duration: `clamp(duration * 8, 1h, 7d)`.
/// Short lanes free their seed capital in hours while long lanes still give days;
/// it gives winners time to redeem, after which the remaining treasury (rake +
/// unclaimed dust) goes to whoever the lock authorizes.
pub const fn close_grace(duration: u64) -> u64 {
    let g = duration.saturating_mul(CLOSE_GRACE_MULT);
    if g < CLOSE_GRACE_MIN_SECS {
        CLOSE_GRACE_MIN_SECS
    } else if g > CLOSE_GRACE_MAX_SECS {
        CLOSE_GRACE_MAX_SECS
    } else {
        g
    }
}

/// Deployed Lean Oracle `oracle_type` v2 code hash (testnet) — the oracle
/// CellDep must carry this type code hash. From the lean_oracle README.
pub const ORACLE_TYPE_CODE_HASH: [u8; 32] = [
    0x10, 0xc9, 0xbc, 0xc3, 0xaf, 0x00, 0xfc, 0x37, 0x28, 0xcb, 0x95, 0xd5, 0xe1, 0x4e, 0xc8, 0x82,
    0x71, 0x6a, 0xf5, 0xf5, 0x31, 0xa0, 0x10, 0x85, 0x25, 0x26, 0xce, 0x78, 0x4f, 0x69, 0x58, 0xec,
];

/// Oracle **trust-root** identity, pinned per-pool in PoolData and verified
/// against the oracle cell's data by `find_oracle`. These are *defaults* for the
/// SDK/tests — the contract reads the values from PoolData, not from here.
///
/// `GUARDIAN_SET_TYPE_HASH` is the Wormhole guardian-set cell's **type hash**
/// (the signature trust root); set it to the deployed value. `PYTH_EMITTER_*`
/// identify the Pyth source (Pythnet = chain 26).
pub const GUARDIAN_SET_TYPE_HASH: [u8; 32] = [
    0x57, 0xbd, 0xdf, 0x3d, 0x57, 0xea, 0x45, 0xc8, 0x8a, 0xb6, 0x8d, 0x0d, 0xe7, 0x06, 0xbb, 0xae,
    0xcd, 0x68, 0x89, 0x5f, 0xd6, 0x06, 0x2b, 0x09, 0x96, 0x26, 0xde, 0xb1, 0x57, 0x10, 0x01, 0x19,
];
pub const PYTH_EMITTER_CHAIN: u32 = 26;
/// Pyth's Pythnet Wormhole emitter address. Set to the deployed value.
pub const PYTH_EMITTER_ADDRESS: [u8; 32] = [
    0xe1, 0x01, 0xfa, 0xed, 0xac, 0x58, 0x51, 0xe3, 0x2b, 0x9b, 0x23, 0xb5, 0xf9, 0x41, 0x1a, 0x8c,
    0x2b, 0xac, 0x4a, 0xae, 0x3e, 0xd4, 0xdd, 0x7b, 0x81, 0x1d, 0xd1, 0xa7, 0x2e, 0xa4, 0xaa, 0x71,
];
