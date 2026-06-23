//! `share_xudt` — UP/DOWN share token (xUDT-data-compatible, pool-gated).
//!
//! `args = pool_type_script_hash (32) || side (1)`. Cell data is standard xUDT:
//! amount as `u128` little-endian in the first 16 bytes.
//!
//! Two modes (see `docs/share_xudt-spec.md`):
//! - MINT/BURN: the owning PoolCell (type hash == args[0..32]) is in inputs ->
//!   supply may change; amount/side correctness is enforced by `pool_type`.
//! - TRANSFER/BURN: otherwise -> supply may not INCREASE (no mint without the
//!   PoolCell), but a holder may freely BURN their own shares to reclaim the
//!   cell's CKB (e.g. a loser cleaning up a worthless position). A standalone burn
//!   yields only the burner's own cell capacity, never a treasury payout (that
//!   needs the PoolCell + `pool_type`), so it strands no one.

#![no_std]
#![cfg_attr(not(test), no_main)]

#[cfg(test)]
extern crate alloc;

#[cfg(not(test))]
use ckb_std::default_alloc;

#[cfg(not(test))]
ckb_std::entry!(program_entry);
#[cfg(not(test))]
default_alloc!(4096, 65536, 64);

use ckb_std::{
    ckb_constants::Source,
    high_level::{load_cell_data, load_cell_type_hash, load_script, QueryIter},
};

// Local copies (kept standalone so this binary's hash is stable). Must match
// `up_down_common::errors`.
const ERROR_ENCODING: i8 = -1;
const ERROR_SYSCALL: i8 = -2;
const ERROR_SHARE_SUPPLY_CHANGED: i8 = 30;

pub fn program_entry() -> i8 {
    let script = match load_script() {
        Ok(s) => s,
        Err(_) => return ERROR_SYSCALL,
    };
    let args = script.args().raw_data();
    // args = pool_type_script_hash (32) || side (1); side is exactly UP or DOWN.
    // Rejecting other side bytes here means no off-side junk token can ever exist
    // (it would otherwise mint freely in any pool-present tx, though it would be
    // unredeemable). 1 = UP, 2 = DOWN (mirrors SIDE_UP / SIDE_DOWN).
    if args.len() != 33 || (args[32] != 1 && args[32] != 2) {
        return ERROR_ENCODING;
    }
    let mut pool_type_hash = [0u8; 32];
    pool_type_hash.copy_from_slice(&args[0..32]);

    // MINT/BURN authorization: owning PoolCell present in inputs.
    if pool_present(&pool_type_hash) {
        return 0;
    }

    // TRANSFER/BURN: supply may not increase (no mint without the PoolCell), but a
    // holder may burn (decrease) freely to reclaim their cell's CKB. Burning is
    // pure self-forfeiture — it touches no treasury — so it is always safe.
    match (
        sum_amount(Source::GroupInput),
        sum_amount(Source::GroupOutput),
    ) {
        (Some(i), Some(o)) if o <= i => 0,
        (Some(_), Some(_)) => ERROR_SHARE_SUPPLY_CHANGED, // mint (o > i) forbidden
        _ => ERROR_ENCODING,
    }
}

fn pool_present(pool_type_hash: &[u8; 32]) -> bool {
    QueryIter::new(load_cell_type_hash, Source::Input)
        .flatten()
        .any(|h| &h == pool_type_hash)
}

fn sum_amount(source: Source) -> Option<u128> {
    let mut total: u128 = 0;
    for data in QueryIter::new(load_cell_data, source) {
        if data.len() < 16 {
            return None;
        }
        let amt = u128::from_le_bytes(data[0..16].try_into().ok()?);
        total = total.checked_add(amt)?;
    }
    Some(total)
}
