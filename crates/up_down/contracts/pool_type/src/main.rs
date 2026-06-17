//! `pool_type` — the pool state-machine type script.
//!
//! Recognizes transitions by script-group shape and the input/output `status`
//! fields, then validates each per `docs/pool_type-spec.md`:
//!
//! - CREATE   (0 inputs, 1 output)            status -> OPEN
//! - DEPOSIT  (1->1)  OPEN      -> OPEN
//! - ACTIVATE (1->1)  OPEN      -> LOCKED (provisional start) | VOID
//! - CORRECT  (1->1)  LOCKED    -> LOCKED    (earlier start tick wins)
//! - RESOLVE  (1->1)  LOCKED    -> SETTLED (provisional) | VOID (never resolved)
//! - CORRECT  (1->1)  SETTLED   -> SETTLED   (earlier settle tick wins)
//! - FINALIZE (1->1)  SETTLED   -> FINALIZED (contest window closed)
//! - REDEEM   (1->1)  FINALIZED -> FINALIZED / VOID -> VOID
//! - CLOSE    (1->0)  FINALIZED | VOID -> (terminal)
//!
//! All transitions are implemented for both the CKB and xUDT variants. The
//! trusted oracle's identity (`oracle_code_hash` + `feed_id`) is pool config,
//! matched exactly against the dep's type script (see `find_oracle`).

#![no_std]
#![cfg_attr(not(test), no_main)]

#[cfg(test)]
extern crate alloc;

#[cfg(not(test))]
use ckb_std::default_alloc;

#[cfg(not(test))]
ckb_std::entry!(program_entry);
#[cfg(not(test))]
default_alloc!(16384, 1258306, 64);

use ckb_std::{
    ckb_constants::Source,
    ckb_types::prelude::*,
    error::SysError,
    high_level::{
        load_cell_capacity, load_cell_data, load_cell_lock, load_cell_type, load_cell_type_hash,
        load_header, load_input, load_script, QueryIter,
    },
};
use up_down_common::{
    constants::*,
    errors::*,
    oracle_read::OracleRead,
    pool_data::PoolData,
};

pub fn program_entry() -> i8 {
    // Script args carry the typeID (`pool_id`), exactly 32 bytes.
    let script = match load_script() {
        Ok(s) => s,
        Err(_) => return ERROR_SYSCALL,
    };
    if script.args().raw_data().len() != 32 {
        return ERROR_ENCODING;
    }

    let input_count = QueryIter::new(load_cell_data, Source::GroupInput).count();
    let output_count = QueryIter::new(load_cell_data, Source::GroupOutput).count();

    match (input_count, output_count) {
        (0, 1) => validate_create(),
        (1, 1) => validate_transition(),
        (1, 0) => validate_close(),
        _ => ERROR_INVALID_SCRIPT_GROUP,
    }
}

// ---- shared helpers ------------------------------------------------------

fn load_pool(index: usize, source: Source) -> Result<PoolData, i8> {
    let data = load_cell_data(index, source).map_err(|_| ERROR_SYSCALL)?;
    PoolData::from_bytes(&data).ok_or(ERROR_POOL_DATA_MALFORMED)
}

/// Block time (seconds) from the first header dep. CKB header timestamps are in
/// milliseconds; Pyth/pool times are in seconds.
fn now_secs() -> Result<u64, i8> {
    let header = load_header(0, Source::HeaderDep).map_err(|_| ERROR_SYSCALL)?;
    let ms: u64 = header.raw().timestamp().unpack();
    Ok(ms / 1000)
}

/// Find the unique oracle CellDep the pool trusts.
///
/// We locate candidates by the oracle type's **args** (`== feed_id`), then pin
/// identity by recomputing the **commitment** from the cell — its type
/// `code_hash` plus its data trust root (guardian-set type hash + Pyth emitter
/// chain/address) — and requiring it to equal the pool's stored `oracle_commit`.
/// The type script alone is shared by every oracle cell of the feed (forgeable);
/// the commitment binds the real Wormhole guardians + Pyth source, so an
/// attacker's same-type cell with their own trust root won't match.
fn find_oracle(p: &PoolData) -> Result<OracleRead, i8> {
    let mut found: Option<OracleRead> = None;
    let mut i = 0usize;
    loop {
        match load_cell_type(i, Source::CellDep) {
            Ok(Some(script)) => {
                if script.args().raw_data().as_ref() == &p.feed_id[..] {
                    let data = load_cell_data(i, Source::CellDep).map_err(|_| ERROR_SYSCALL)?;
                    if let Some(o) = OracleRead::from_bytes(&data) {
                        let mut code_hash = [0u8; 32];
                        code_hash.copy_from_slice(script.code_hash().as_slice());
                        if o.commit(&code_hash) == p.oracle_commit {
                            if found.is_some() {
                                return Err(ERROR_ORACLE_BAND); // ambiguous
                            }
                            found = Some(o);
                        }
                    }
                }
            }
            Ok(None) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(ERROR_SYSCALL),
        }
        i += 1;
    }
    found.ok_or(ERROR_ORACLE_BAND)
}

/// PoolCell capacity must not change across a non-funds transition.
fn pool_capacity_unchanged() -> Result<bool, i8> {
    let i = load_cell_capacity(0, Source::GroupInput).map_err(|_| ERROR_SYSCALL)?;
    let o = load_cell_capacity(0, Source::GroupOutput).map_err(|_| ERROR_SYSCALL)?;
    Ok(i == o)
}

// ---- dispatch ------------------------------------------------------------

fn validate_transition() -> i8 {
    let prev = match load_pool(0, Source::GroupInput) {
        Ok(p) => p,
        Err(e) => return e,
    };
    let next = match load_pool(0, Source::GroupOutput) {
        Ok(p) => p,
        Err(e) => return e,
    };
    if !prev.config_unchanged(&next) {
        return ERROR_CONFIG_MUTATED;
    }

    match (prev.status, next.status) {
        (STATUS_OPEN, STATUS_OPEN) => validate_deposit(&prev, &next),
        (STATUS_OPEN, STATUS_LOCKED) | (STATUS_OPEN, STATUS_VOID) => validate_activate(&prev, &next),
        // Start-price contest: a provisional LOCKED start price may be replaced
        // by a strictly earlier tick in (start, close) until resolution.
        (STATUS_LOCKED, STATUS_LOCKED) => validate_correct_start(&prev, &next),
        (STATUS_LOCKED, STATUS_SETTLED) | (STATUS_LOCKED, STATUS_VOID) => {
            validate_resolve(&prev, &next)
        }
        // Settle-price contest: a provisional SETTLED result may be replaced by a
        // strictly earlier tick in (close, void_time) until finalize.
        (STATUS_SETTLED, STATUS_SETTLED) => validate_correct_settle(&prev, &next),
        // Latch the result once an oracle tick proves the contest window passed.
        (STATUS_SETTLED, STATUS_FINALIZED) => validate_finalize(&prev, &next),
        // Payouts run only from the finalized result (or a no-resolution VOID).
        (STATUS_FINALIZED, STATUS_FINALIZED) | (STATUS_VOID, STATUS_VOID) => {
            validate_redeem(&prev, &next)
        }
        _ => ERROR_BAD_STATUS_TRANSITION,
    }
}

// ---- ACTIVATE (provisional start price; same oracle clock) ----------------
//
// Activation opens the *start-price contest*: the recorded start tick must lie in
// (start_time, close_time), and CORRECT-start (LOCKED→LOCKED) may replace it with
// a strictly earlier one — `used_pt` converges down to the first tick after start.
// RESOLVE later flips `used_pt` to the settle reference and freezes `start_price`.

fn validate_activate(prev: &PoolData, next: &PoolData) -> i8 {
    if let Err(e) = phase_frozen(prev, next) {
        return e;
    }
    let oracle = match find_oracle(prev) {
        Ok(o) => o,
        Err(e) => return e,
    };

    match next.status {
        STATUS_LOCKED => {
            // One-sided pools must VOID, not LOCK.
            if prev.up_total == 0 || prev.down_total == 0 {
                return ERROR_BAD_STATUS_TRANSITION;
            }
            // Provisional start tick: strictly after start, before close.
            if !(oracle.publish_time > prev.start_time && oracle.publish_time < prev.close_time) {
                return ERROR_ORACLE_BAND;
            }
            if next.settle_price != 0 || next.winner != SIDE_UNDECIDED {
                return ERROR_POOL_DATA_MALFORMED;
            }
            if next.start_price != oracle.price || next.used_pt != oracle.publish_time {
                return ERROR_POOL_DATA_MALFORMED;
            }
            0
        }
        STATUS_VOID => {
            // Void if one-sided (proven past start so no more deposits) or if the
            // activation window closed un-activated (tick at/after close).
            let one_sided = prev.up_total == 0 || prev.down_total == 0;
            let past_start = oracle.publish_time > prev.start_time;
            let past_close = oracle.publish_time >= prev.close_time;
            if !((one_sided && past_start) || past_close) {
                return ERROR_TIME_WINDOW;
            }
            if next.winner != WINNER_VOID
                || next.start_price != 0
                || next.settle_price != 0
                || next.used_pt != 0
            {
                return ERROR_POOL_DATA_MALFORMED;
            }
            0
        }
        _ => ERROR_BAD_STATUS_TRANSITION,
    }
}

/// CORRECT-start (LOCKED → LOCKED): replace the provisional start tick with a
/// strictly earlier one (`start < pub < used_pt`), recomputing `start_price`.
/// Converges to the first post-start tick. Settle state stays empty.
fn validate_correct_start(prev: &PoolData, next: &PoolData) -> i8 {
    if let Err(e) = phase_frozen(prev, next) {
        return e;
    }
    let oracle = match find_oracle(prev) {
        Ok(o) => o,
        Err(e) => return e,
    };
    if !(oracle.publish_time > prev.start_time && oracle.publish_time < prev.used_pt) {
        return ERROR_ORACLE_BAND;
    }
    if next.settle_price != 0 || next.winner != SIDE_UNDECIDED {
        return ERROR_POOL_DATA_MALFORMED;
    }
    if next.start_price != oracle.price || next.used_pt != oracle.publish_time {
        return ERROR_POOL_DATA_MALFORMED;
    }
    0
}

// ---- RESOLVE / CONTEST / FINALIZE ----------------------------------------
//
// The clock for this whole phase is the **oracle's authenticated publish_time**,
// not the (manipulable) header timestamp. `void_time = close_time + grace` is the
// contest deadline. A tick's publish_time both prices the pool and proves how far
// real time has advanced (Pyth can't sign a future tick).
//
//   RESOLVE  (LOCKED -> SETTLED):  close < pub < void_time  -> provisional result
//   RESOLVE  (LOCKED -> VOID):     pub >= void_time          -> never resolved
//   CORRECT  (SETTLED -> SETTLED): close < pub < used_pt     -> earlier tick wins
//   FINALIZE (SETTLED -> FINALIZED): pub >= void_time         -> latch, no more edits
//
// Ties fold into `winner = VOID` while staying SETTLED, so a correction can still
// adjust them without an illegal status reversal.

/// settle-price -> winner: UP if above start, DOWN if below, VOID on a tie.
fn winner_for(price: i64, start_price: i64) -> u8 {
    if price > start_price {
        SIDE_UP
    } else if price < start_price {
        SIDE_DOWN
    } else {
        WINNER_VOID
    }
}

/// Common guards for the activation/resolution phases: totals, PoolCell capacity,
/// and share supply are frozen. Which of start_price/settle_price/used_pt/winner
/// may move is decided by each transition. Returns `own`.
fn phase_frozen(prev: &PoolData, next: &PoolData) -> Result<[u8; 32], i8> {
    if next.up_total != prev.up_total || next.down_total != prev.down_total {
        return Err(ERROR_FUNDS_NOT_CONSERVED);
    }
    match pool_capacity_unchanged() {
        Ok(true) => {}
        Ok(false) => return Err(ERROR_FUNDS_NOT_CONSERVED),
        Err(e) => return Err(e),
    }
    let own = match load_cell_type_hash(0, Source::GroupInput) {
        Ok(Some(h)) => h,
        _ => return Err(ERROR_SYSCALL),
    };
    shares_frozen(&own)?;
    // xUDT variant: the staked funds live in the TreasuryCell, whose `treasury_lock`
    // is permissive while the PoolCell is in inputs. `pool_capacity_unchanged` only
    // pins the PoolCell's own bytes — not the treasury — so without this a
    // permissionless activate/resolve/correct/finalize could drain (or split) the
    // TreasuryCell. Conserve it: input balance == output balance. `_opt` tolerates a
    // genuinely treasury-less pool (e.g. a zero-deposit OPEN→VOID) yet still rejects
    // an ambiguous (split) treasury, keeping the single-treasury invariant redeem
    // relies on. (CKB-variant funds are the PoolCell capacity, frozen above.)
    if prev.variant == VARIANT_XUDT {
        let asset = prev.asset_type_hash.ok_or(ERROR_POOL_DATA_MALFORMED)?;
        let tin = treasury_balance_opt(&own, &asset, Source::Input)?.unwrap_or(0);
        let tout = treasury_balance_opt(&own, &asset, Source::Output)?.unwrap_or(0);
        if tin != tout {
            return Err(ERROR_FUNDS_NOT_CONSERVED);
        }
    }
    Ok(own)
}

fn validate_resolve(prev: &PoolData, next: &PoolData) -> i8 {
    let g = grace(prev.duration());
    let void_time = prev.close_time.saturating_add(g);
    if let Err(e) = phase_frozen(prev, next) {
        return e;
    }
    // From resolution on, the (LOCKED-contested) start price is frozen. RESOLVE
    // flips `used_pt` from the start tick to the settle tick.
    if next.start_price != prev.start_price {
        return ERROR_FUNDS_NOT_CONSERVED;
    }

    let oracle = match find_oracle(prev) {
        Ok(o) => o,
        Err(e) => return e,
    };

    match next.status {
        STATUS_SETTLED => {
            // Provisional resolution: an authentic tick strictly after close and
            // before the contest deadline.
            if !(oracle.publish_time > prev.close_time && oracle.publish_time < void_time) {
                return ERROR_ORACLE_BAND;
            }
            if next.settle_price != oracle.price
                || next.used_pt != oracle.publish_time
                || next.winner != winner_for(oracle.price, prev.start_price)
            {
                return ERROR_POOL_DATA_MALFORMED;
            }
            0
        }
        STATUS_VOID => {
            // No resolution happened and the window has closed (proven by an
            // authentic tick at/after void_time). 1:1 refund.
            if oracle.publish_time < void_time {
                return ERROR_TIME_WINDOW;
            }
            if next.winner != WINNER_VOID
                || next.settle_price != prev.settle_price
                || next.used_pt != prev.used_pt
            {
                return ERROR_POOL_DATA_MALFORMED;
            }
            0
        }
        _ => ERROR_BAD_STATUS_TRANSITION,
    }
}

/// CORRECT-settle (SETTLED -> SETTLED): replace the recorded settle tick with a
/// strictly earlier in-band one (`close < pub < used_pt`), recomputing the winner.
fn validate_correct_settle(prev: &PoolData, next: &PoolData) -> i8 {
    if let Err(e) = phase_frozen(prev, next) {
        return e;
    }
    if next.start_price != prev.start_price {
        return ERROR_FUNDS_NOT_CONSERVED;
    }
    let oracle = match find_oracle(prev) {
        Ok(o) => o,
        Err(e) => return e,
    };
    // Strictly earlier than the current tick, still after close. (No void_time
    // check needed: used_pt is already < void_time, so pub < used_pt is too.)
    if !(oracle.publish_time > prev.close_time && oracle.publish_time < prev.used_pt) {
        return ERROR_ORACLE_BAND;
    }
    if next.settle_price != oracle.price
        || next.used_pt != oracle.publish_time
        || next.winner != winner_for(oracle.price, prev.start_price)
    {
        return ERROR_POOL_DATA_MALFORMED;
    }
    0
}

/// FINALIZE (SETTLED -> FINALIZED): latch the result once an authentic tick
/// proves real time reached `void_time`. Nothing but `status` may change.
fn validate_finalize(prev: &PoolData, next: &PoolData) -> i8 {
    let g = grace(prev.duration());
    let void_time = prev.close_time.saturating_add(g);
    if let Err(e) = phase_frozen(prev, next) {
        return e;
    }
    if next.start_price != prev.start_price
        || next.settle_price != prev.settle_price
        || next.used_pt != prev.used_pt
        || next.winner != prev.winner
    {
        return ERROR_POOL_DATA_MALFORMED;
    }
    let oracle = match find_oracle(prev) {
        Ok(o) => o,
        Err(e) => return e,
    };
    if oracle.publish_time < void_time {
        return ERROR_TIME_WINDOW;
    }
    0
}

// ---- stubs (next pass) ---------------------------------------------------

fn validate_create() -> i8 {
    let out = match load_pool(0, Source::GroupOutput) {
        Ok(p) => p,
        Err(e) => return e,
    };
    if out.status != STATUS_OPEN
        || out.winner != SIDE_UNDECIDED
        || out.up_total != 0
        || out.down_total != 0
        || out.start_price != 0
        || out.settle_price != 0
        || out.used_pt != 0
        || out.start_time >= out.close_time
        || out.rake_bps > RAKE_BPS_MAX
    {
        return ERROR_POOL_DATA_MALFORMED;
    }
    // xUDT variant must name a real staked asset. (Treasury cell correctness —
    // lock binding and balance — is enforced when funds first move, at DEPOSIT.)
    if out.variant == VARIANT_XUDT && out.asset_type_hash.map_or(true, |h| h == [0u8; 32]) {
        return ERROR_POOL_DATA_MALFORMED;
    }
    let now = match now_secs() {
        Ok(n) => n,
        Err(e) => return e,
    };
    // Pool boundaries must lie in the future at creation.
    if out.start_time <= now || out.close_time <= now {
        return ERROR_TIME_WINDOW;
    }
    validate_type_id_seed()
}

/// typeID rule: the pool's args == blake2b(first_input, our output index), using
/// CKB's default-hash personalization. Mirrors the standard Type ID script.
fn validate_type_id_seed() -> i8 {
    let script = match load_script() {
        Ok(s) => s,
        Err(_) => return ERROR_SYSCALL,
    };
    let args = script.args().raw_data();

    let first_input = match load_input(0, Source::Input) {
        Ok(i) => i,
        Err(_) => return ERROR_SYSCALL,
    };

    let mut output_index: Option<u64> = None;
    for (i, s) in QueryIter::new(load_cell_type, Source::Output).enumerate() {
        if let Some(s) = s {
            if s.as_slice() == script.as_slice() {
                output_index = Some(i as u64);
                break;
            }
        }
    }
    let output_index = match output_index {
        Some(idx) => idx,
        None => return ERROR_SYSCALL,
    };

    let mut hasher = blake2b_ref::Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    hasher.update(first_input.as_slice());
    hasher.update(&output_index.to_le_bytes());
    let mut expected = [0u8; 32];
    hasher.finalize(&mut expected);

    if args.as_ref() != &expected[..] {
        return ERROR_TYPE_ID_INVALID;
    }
    0
}

fn validate_deposit(prev: &PoolData, next: &PoolData) -> i8 {
    let now = match now_secs() {
        Ok(n) => n,
        Err(e) => return e,
    };
    // Deposits close at start_time.
    if now >= prev.start_time {
        return ERROR_TIME_WINDOW;
    }
    // Price/winner state is untouched while OPEN.
    if next.start_price != prev.start_price
        || next.settle_price != prev.settle_price
        || next.used_pt != prev.used_pt
        || next.winner != prev.winner
    {
        return ERROR_POOL_DATA_MALFORMED;
    }

    // Either side may rise (neither may fall); the total staked must increase.
    // A single deposit can buy UP and DOWN at once.
    if next.up_total < prev.up_total || next.down_total < prev.down_total {
        return ERROR_FUNDS_NOT_CONSERVED;
    }
    let up_d = next.up_total - prev.up_total;
    let down_d = next.down_total - prev.down_total;
    let total = up_d + down_d;
    if total == 0 {
        return ERROR_FUNDS_NOT_CONSERVED;
    }

    let own = match load_cell_type_hash(0, Source::GroupInput) {
        Ok(Some(h)) => h,
        _ => return ERROR_SYSCALL,
    };

    // Funds conservation: stake D enters the treasury.
    match prev.variant {
        VARIANT_CKB => {
            let in_cap = match load_cell_capacity(0, Source::GroupInput) {
                Ok(c) => c as u128,
                Err(_) => return ERROR_SYSCALL,
            };
            let out_cap = match load_cell_capacity(0, Source::GroupOutput) {
                Ok(c) => c as u128,
                Err(_) => return ERROR_SYSCALL,
            };
            if out_cap != in_cap + total {
                return ERROR_FUNDS_NOT_CONSERVED;
            }
        }
        VARIANT_XUDT => {
            let asset = match prev.asset_type_hash {
                Some(a) => a,
                None => return ERROR_POOL_DATA_MALFORMED,
            };
            let tin = match treasury_balance(&own, &asset, Source::Input) {
                Ok(v) => v,
                Err(e) => return e,
            };
            let tout = match treasury_balance(&own, &asset, Source::Output) {
                Ok(v) => v,
                Err(e) => return e,
            };
            if tout != tin + total {
                return ERROR_FUNDS_NOT_CONSERVED;
            }
            // Depositor cells must be the configured staked asset (not a worthless
            // token); net outflow from non-treasury asset cells funds the stake.
            let dep_net = match depositor_net_asset(&own, &asset) {
                Ok(v) => v,
                Err(e) => return e,
            };
            if dep_net != total as i128 {
                return ERROR_FUNDS_NOT_CONSERVED;
            }
            // The xUDT PoolCell holds no funds itself; its capacity stays put.
            match pool_capacity_unchanged() {
                Ok(true) => {}
                Ok(false) => return ERROR_FUNDS_NOT_CONSERVED,
                Err(e) => return e,
            }
        }
        _ => return ERROR_POOL_DATA_MALFORMED,
    }

    // Share minting: each side's net mint == that side's total delta.
    let up_minted = match net_minted(&own, SIDE_UP) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let down_minted = match net_minted(&own, SIDE_DOWN) {
        Ok(v) => v,
        Err(e) => return e,
    };
    if up_minted != up_d as i128 || down_minted != down_d as i128 {
        return ERROR_SHARE_MISMATCH;
    }
    0
}

fn is_treasury_cell(lock_code: &[u8], lock_args: &[u8], own_type_hash: &[u8; 32]) -> bool {
    lock_code == &TREASURY_LOCK_CODE_HASH[..] && lock_args == own_type_hash
}

/// Sum staked-asset amounts in `source`. `treasury_only` selects treasury vs
/// depositor (non-treasury) cells; both require `type_hash == asset_type_hash`.
fn sum_staked_asset(
    source: Source,
    own_type_hash: &[u8; 32],
    asset_type_hash: &[u8; 32],
    treasury_only: bool,
) -> Result<u128, i8> {
    let mut total: u128 = 0;
    let mut i = 0usize;
    loop {
        match load_cell_type_hash(i, source) {
            Ok(Some(th)) if &th == asset_type_hash => {
                let lock = load_cell_lock(i, source).map_err(|_| ERROR_SYSCALL)?;
                let is_treasury = is_treasury_cell(
                    lock.code_hash().as_slice(),
                    lock.args().raw_data().as_ref(),
                    own_type_hash,
                );
                if is_treasury == treasury_only {
                    let data = load_cell_data(i, source).map_err(|_| ERROR_SYSCALL)?;
                    if data.len() < 16 {
                        return Err(ERROR_FUNDS_NOT_CONSERVED);
                    }
                    let amt = u128::from_le_bytes(data[0..16].try_into().unwrap());
                    total = total.checked_add(amt).ok_or(ERROR_FUNDS_NOT_CONSERVED)?;
                }
            }
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(ERROR_SYSCALL),
        }
        i += 1;
    }
    Ok(total)
}

/// Net staked asset flowing from depositor cells (inputs − outputs).
fn depositor_net_asset(own_type_hash: &[u8; 32], asset_type_hash: &[u8; 32]) -> Result<i128, i8> {
    let inp = sum_staked_asset(Source::Input, own_type_hash, asset_type_hash, false)? as i128;
    let out = sum_staked_asset(Source::Output, own_type_hash, asset_type_hash, false)? as i128;
    Ok(inp - out)
}

/// The sole TreasuryCell balance in `source`: a cell whose lock is
/// `Script{TREASURY_LOCK_CODE_HASH, args: own_type_hash}` and whose type hash is
/// the pool's `asset_type_hash`. Errors if missing, ambiguous, or malformed.
fn treasury_balance(
    own_type_hash: &[u8; 32],
    asset_type_hash: &[u8; 32],
    source: Source,
) -> Result<u128, i8> {
    treasury_balance_opt(own_type_hash, asset_type_hash, source)?.ok_or(ERROR_FUNDS_NOT_CONSERVED)
}

/// Like [`treasury_balance`] but returns `Ok(None)` when no treasury cell is present
/// in `source`, instead of erroring. A split (ambiguous) treasury is still rejected.
fn treasury_balance_opt(
    own_type_hash: &[u8; 32],
    asset_type_hash: &[u8; 32],
    source: Source,
) -> Result<Option<u128>, i8> {
    let mut found: Option<u128> = None;
    let mut i = 0usize;
    loop {
        match load_cell_lock(i, source) {
            Ok(lock) => {
                if is_treasury_cell(
                    lock.code_hash().as_slice(),
                    lock.args().raw_data().as_ref(),
                    own_type_hash,
                ) {
                    match load_cell_type_hash(i, source) {
                        Ok(Some(th)) if &th == asset_type_hash => {}
                        _ => return Err(ERROR_FUNDS_NOT_CONSERVED),
                    }
                    let data = load_cell_data(i, source).map_err(|_| ERROR_SYSCALL)?;
                    if data.len() < 16 {
                        return Err(ERROR_FUNDS_NOT_CONSERVED);
                    }
                    let amt = u128::from_le_bytes(data[0..16].try_into().unwrap());
                    if found.is_some() {
                        return Err(ERROR_FUNDS_NOT_CONSERVED); // ambiguous treasury
                    }
                    found = Some(amt);
                }
            }
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(ERROR_SYSCALL),
        }
        i += 1;
    }
    Ok(found)
}

/// Net minted amount of a side's share token = Σ outputs − Σ inputs, as i128.
fn net_minted(own_type_hash: &[u8; 32], side: u8) -> Result<i128, i8> {
    let out = sum_share(Source::Output, own_type_hash, side)? as i128;
    let inp = sum_share(Source::Input, own_type_hash, side)? as i128;
    Ok(out - inp)
}

/// Sum the amounts of share cells matching `(SHARE_XUDT_CODE_HASH, own||side)`.
fn sum_share(source: Source, own_type_hash: &[u8; 32], side: u8) -> Result<u128, i8> {
    let mut total: u128 = 0;
    let mut i = 0usize;
    loop {
        match load_cell_type(i, source) {
            Ok(Some(s)) => {
                if s.code_hash().as_slice() == &SHARE_XUDT_CODE_HASH[..] {
                    let a = s.args().raw_data();
                    if a.len() == 33 && &a[0..32] == own_type_hash && a[32] == side {
                        let data = load_cell_data(i, source).map_err(|_| ERROR_SYSCALL)?;
                        if data.len() < 16 {
                            return Err(ERROR_SHARE_MISMATCH);
                        }
                        let amt = u128::from_le_bytes(data[0..16].try_into().unwrap());
                        total = total.checked_add(amt).ok_or(ERROR_SHARE_MISMATCH)?;
                    }
                }
            }
            Ok(None) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(ERROR_SYSCALL),
        }
        i += 1;
    }
    Ok(total)
}

fn validate_redeem(prev: &PoolData, next: &PoolData) -> i8 {
    // PoolCell state is immutable across redemptions (the ratio must stay fixed;
    // share supply itself bounds total redemption).
    if next.up_total != prev.up_total
        || next.down_total != prev.down_total
        || next.start_price != prev.start_price
        || next.settle_price != prev.settle_price
        || next.used_pt != prev.used_pt
        || next.winner != prev.winner
    {
        return ERROR_POOL_DATA_MALFORMED;
    }
    let own = match load_cell_type_hash(0, Source::GroupInput) {
        Ok(Some(h)) => h,
        _ => return ERROR_SYSCALL,
    };

    // The treasury (CKB capacity, or the xUDT TreasuryCell) may only shrink, by
    // exactly `payout`.
    let payout = match prev.variant {
        VARIANT_CKB => {
            let in_cap = match load_cell_capacity(0, Source::GroupInput) {
                Ok(c) => c as u128,
                Err(_) => return ERROR_SYSCALL,
            };
            let out_cap = match load_cell_capacity(0, Source::GroupOutput) {
                Ok(c) => c as u128,
                Err(_) => return ERROR_SYSCALL,
            };
            if out_cap > in_cap {
                return ERROR_FUNDS_NOT_CONSERVED;
            }
            in_cap - out_cap
        }
        VARIANT_XUDT => {
            let asset = match prev.asset_type_hash {
                Some(a) => a,
                None => return ERROR_POOL_DATA_MALFORMED,
            };
            let tin = match treasury_balance(&own, &asset, Source::Input) {
                Ok(v) => v,
                Err(e) => return e,
            };
            let tout = match treasury_balance(&own, &asset, Source::Output) {
                Ok(v) => v,
                Err(e) => return e,
            };
            if tout > tin {
                return ERROR_FUNDS_NOT_CONSERVED;
            }
            match pool_capacity_unchanged() {
                Ok(true) => {}
                Ok(false) => return ERROR_FUNDS_NOT_CONSERVED,
                Err(e) => return e,
            }
            tin - tout
        }
        _ => return ERROR_POOL_DATA_MALFORMED,
    };

    // A finalized tie (winner == VOID) refunds exactly like a no-resolution VOID.
    let refund_1to1 = prev.status == STATUS_VOID
        || (prev.status == STATUS_FINALIZED && prev.winner == WINNER_VOID);
    if refund_1to1 {
        let bu = match burned(&own, SIDE_UP) {
            Ok(v) => v,
            Err(e) => return e,
        };
        let bd = match burned(&own, SIDE_DOWN) {
            Ok(v) => v,
            Err(e) => return e,
        };
        if bu < 0 || bd < 0 {
            return ERROR_SHARE_MISMATCH; // no minting on a refund
        }
        let total = (bu + bd) as u128;
        return if total == 0 || payout != total {
            ERROR_PAYOUT_MISMATCH // 1:1 principal refund
        } else {
            0
        };
    }

    match prev.status {
        STATUS_FINALIZED => {
            let (winner_side, winner_total, loser_total) = match prev.winner {
                SIDE_UP => (SIDE_UP, prev.up_total, prev.down_total),
                SIDE_DOWN => (SIDE_DOWN, prev.down_total, prev.up_total),
                _ => return ERROR_BAD_STATUS_TRANSITION,
            };
            let loser_side = if winner_side == SIDE_UP {
                SIDE_DOWN
            } else {
                SIDE_UP
            };
            let burned_w = match burned(&own, winner_side) {
                Ok(v) => v,
                Err(e) => return e,
            };
            let burned_l = match burned(&own, loser_side) {
                Ok(v) => v,
                Err(e) => return e,
            };
            if burned_w <= 0 || burned_l != 0 {
                return ERROR_SHARE_MISMATCH; // burn only winning shares
            }
            if winner_total == 0 {
                return ERROR_PAYOUT_MISMATCH;
            }
            let x = burned_w as u128;
            let rake = match mul_div_floor(loser_total, prev.rake_bps as u128, 10_000) {
                Some(v) => v,
                None => return ERROR_PAYOUT_MISMATCH,
            };
            let distributable = loser_total - rake;
            let profit = match mul_div_floor(x, distributable, winner_total) {
                Some(v) => v,
                None => return ERROR_PAYOUT_MISMATCH,
            };
            if payout != x + profit {
                return ERROR_PAYOUT_MISMATCH;
            }
            0
        }
        _ => ERROR_BAD_STATUS_TRANSITION,
    }
}

/// Freeze share supply: neither side's net supply may change.
///
/// `share_xudt` returns 0 for *any* of this pool's tokens whenever the PoolCell
/// is in inputs (it delegates all supply control to us). So every transition
/// that consumes the PoolCell but is **not** a deposit/redeem must pin supply
/// itself — otherwise free winning-side shares could be minted during
/// activate/resolve (or a void) and redeemed against the treasury.
fn shares_frozen(own_type_hash: &[u8; 32]) -> Result<(), i8> {
    if net_minted(own_type_hash, SIDE_UP)? != 0 || net_minted(own_type_hash, SIDE_DOWN)? != 0 {
        return Err(ERROR_SHARE_MISMATCH);
    }
    Ok(())
}

/// Net burned of a side's share token = Σ inputs − Σ outputs (negative = mint).
fn burned(own_type_hash: &[u8; 32], side: u8) -> Result<i128, i8> {
    let inp = sum_share(Source::Input, own_type_hash, side)? as i128;
    let out = sum_share(Source::Output, own_type_hash, side)? as i128;
    Ok(inp - out)
}

/// `floor(a * b / d)` in u128, or `None` on overflow / `d == 0`.
fn mul_div_floor(a: u128, b: u128, d: u128) -> Option<u128> {
    if d == 0 {
        return None;
    }
    a.checked_mul(b).map(|p| p / d)
}

fn validate_close() -> i8 {
    // Terminal sweep: the PoolCell is consumed and not recreated. Only a
    // finalized or voided pool may be destroyed (never OPEN/LOCKED/SETTLED — that
    // would strand depositors or pre-empt the contest), and only after the
    // post-settlement grace, so winners have had time to redeem. *Who* may sweep
    // is the lock's concern (`pool_admin_lock` creator-escape, since teardown is
    // not continuation).
    let prev = match load_pool(0, Source::GroupInput) {
        Ok(p) => p,
        Err(e) => return e,
    };
    if prev.status != STATUS_FINALIZED && prev.status != STATUS_VOID {
        return ERROR_BAD_STATUS_TRANSITION;
    }
    let now = match now_secs() {
        Ok(n) => n,
        Err(e) => return e,
    };
    if now <= prev.close_time.saturating_add(CLOSE_GRACE_SECS) {
        return ERROR_TIME_WINDOW;
    }
    // The PoolCell is in inputs, so `share_xudt` is permissive here too; forbid
    // any share mint during teardown (such shares would be unredeemable anyway,
    // but keep the supply-pinned invariant uniform across every consuming tx).
    let own = match load_cell_type_hash(0, Source::GroupInput) {
        Ok(Some(h)) => h,
        _ => return ERROR_SYSCALL,
    };
    if let Err(e) = shares_frozen(&own) {
        return e;
    }
    0
}
