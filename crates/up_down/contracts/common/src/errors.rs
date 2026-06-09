//! Canonical `i8` error-code table for the Up/Down scripts. Centralized so
//! failure semantics stay stable and easy to read in tests.

// Generic encoding/parsing failure (bad cell data, witness, or script args).
pub const ERROR_ENCODING: i8 = -1;
// Generic syscall failure (loading cells, scripts, headers, witnesses).
pub const ERROR_SYSCALL: i8 = -2;

// --- pool_type -----------------------------------------------------------
// PoolCell data did not match the expected binary layout.
pub const ERROR_POOL_DATA_MALFORMED: i8 = 10;
// The script-group shape (input/output counts) is not a recognized transition.
pub const ERROR_INVALID_SCRIPT_GROUP: i8 = 11;
// A config field changed across a transition that must preserve it.
pub const ERROR_CONFIG_MUTATED: i8 = 12;
// The status transition is not permitted by the state machine.
pub const ERROR_BAD_STATUS_TRANSITION: i8 = 13;
// typeID (`pool_id`) seed rule failed at creation.
pub const ERROR_TYPE_ID_INVALID: i8 = 14;
// Funds conservation (treasury / capacity delta vs totals) failed.
pub const ERROR_FUNDS_NOT_CONSERVED: i8 = 15;
// Minted/burned share amount, side, or token type was wrong.
pub const ERROR_SHARE_MISMATCH: i8 = 16;
// Oracle CellDep failed identity (feed id / oracle_commit), was ambiguous, or its
// publish_time fell outside the transition's allowed window.
pub const ERROR_ORACLE_BAND: i8 = 17;
// A time-window check failed: the header-clock gate (DEPOSIT cutoff / CLOSE grace) or
// an oracle `publish_time` window (e.g. a VOID/FINALIZE that needs pub ≥ void_time).
pub const ERROR_TIME_WINDOW: i8 = 18;
// Parimutuel payout math did not match.
pub const ERROR_PAYOUT_MISMATCH: i8 = 19;

// --- share_xudt ----------------------------------------------------------
// Transfer mode: total supply of this token changed without its PoolCell.
pub const ERROR_SHARE_SUPPLY_CHANGED: i8 = 30;

// --- treasury_lock -------------------------------------------------------
// The owning PoolCell was not present in the inputs.
pub const ERROR_TREASURY_POOL_ABSENT: i8 = 40;

// --- pool_admin_lock -----------------------------------------------------
// Neither the continuation path nor the creator-escape path was satisfied.
pub const ERROR_ADMIN_UNAUTHORIZED: i8 = 50;
