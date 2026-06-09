//! `treasury_lock` — thin guard for the xUDT-variant TreasuryCell.
//!
//! `args = pool_type_script_hash (32)`. The treasury is spendable only in a tx
//! that also consumes its PoolCell (an input whose type hash == args). All value
//! logic lives in `pool_type`, which necessarily runs in that case.

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
    high_level::{load_cell_type_hash, load_script, QueryIter},
};

// Local copies (standalone so this binary's hash is stable). Must match
// `up_down_common::errors`.
const ERROR_ENCODING: i8 = -1;
const ERROR_SYSCALL: i8 = -2;
const ERROR_TREASURY_POOL_ABSENT: i8 = 40;

pub fn program_entry() -> i8 {
    let script = match load_script() {
        Ok(s) => s,
        Err(_) => return ERROR_SYSCALL,
    };
    let args = script.args().raw_data();
    if args.len() != 32 {
        return ERROR_ENCODING;
    }
    let mut pool_type_hash = [0u8; 32];
    pool_type_hash.copy_from_slice(&args);

    let present = QueryIter::new(load_cell_type_hash, Source::Input)
        .flatten()
        .any(|h| h == pool_type_hash);

    if present {
        0
    } else {
        ERROR_TREASURY_POOL_ABSENT
    }
}
