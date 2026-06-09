//! Enums, the grace function, and pinned external code hashes.

// --- variant -------------------------------------------------------------
pub const VARIANT_CKB: u8 = 0;
pub const VARIANT_XUDT: u8 = 1;

// --- status --------------------------------------------------------------
pub const STATUS_OPEN: u8 = 0;
pub const STATUS_LOCKED: u8 = 1;
/// Provisional resolution: a settle price/winner is recorded but still
/// contestable (an earlier in-band tick may replace it) until `void_time`.
pub const STATUS_SETTLED: u8 = 2;
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

/// Post-settlement window before a SETTLED/VOID pool may be swept and destroyed
/// (CLOSE). Gives winners ample time to redeem; afterwards the remaining
/// treasury (rake + unclaimed dust) goes to whoever the lock authorizes. 7 days.
pub const CLOSE_GRACE_SECS: u64 = 7 * 24 * 60 * 60;

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

/// `share_xudt` code (data) hash — `pool_type` derives the expected UP/DOWN
/// token type scripts from this. This is the blake2b data hash of the compiled
/// `share_xudt` binary; **regenerate it whenever `share_xudt` changes** (e.g.
/// via the `print_share_code_hash` probe) and on each real deployment.
pub const SHARE_XUDT_CODE_HASH: [u8; 32] = [
    0xf9, 0x14, 0x42, 0xe1, 0xe8, 0xd3, 0xcc, 0xea, 0xfd, 0x7b, 0x0d, 0x14, 0xae, 0xd3, 0x32, 0x07,
    0xb0, 0x5e, 0x6b, 0xe2, 0x42, 0xa6, 0x83, 0x4a, 0x9a, 0x0f, 0xa6, 0x99, 0x55, 0xee, 0xa4, 0xba,
];

/// `treasury_lock` code (data) hash — `pool_type` uses this to identify a pool's
/// TreasuryCell (lock == `Script{TREASURY_LOCK_CODE_HASH, args: pool_type_hash}`).
/// Regenerate if `treasury_lock` changes (keep it standalone so it doesn't).
pub const TREASURY_LOCK_CODE_HASH: [u8; 32] = [
    0x57, 0x76, 0x2c, 0xd0, 0xc6, 0xdb, 0x91, 0x7e, 0x78, 0xc1, 0xc3, 0xaf, 0xfa, 0xf4, 0xde, 0x20,
    0xa1, 0xe1, 0x69, 0xc2, 0xf6, 0x9f, 0x93, 0xce, 0xe7, 0x98, 0x91, 0x1f, 0xe5, 0x61, 0x5d, 0x2d,
];
