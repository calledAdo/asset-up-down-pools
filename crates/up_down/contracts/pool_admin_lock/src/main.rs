//! `pool_admin_lock` — the PoolCell's lock.
//!
//! `args = creator_lock_hash (32)`. Two authorization paths:
//! - **Continuation:** the PoolCell's type (typeID) continues in the outputs —
//!   this makes activate/resolve/redeem permissionless (anyone can drive a valid
//!   transition; `pool_type` enforces correctness).
//! - **Creator escape:** an input carries the creator lock hash — for terminal
//!   teardown/CLOSE, where the type does not continue.

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
    high_level::{load_cell_lock_hash, load_cell_type_hash, load_script, QueryIter},
};
use up_down_common::errors::*;

pub fn program_entry() -> i8 {
    let script = match load_script() {
        Ok(s) => s,
        Err(_) => return ERROR_SYSCALL,
    };
    let args = script.args().raw_data();
    if args.len() != 32 {
        return ERROR_ENCODING;
    }
    let mut creator = [0u8; 32];
    creator.copy_from_slice(&args);

    // Continuation path: this PoolCell's type hash appears in some output.
    if let Ok(Some(own_type)) = load_cell_type_hash(0, Source::GroupInput) {
        let continues = QueryIter::new(load_cell_type_hash, Source::Output)
            .flatten()
            .any(|h| h == own_type);
        if continues {
            return 0;
        }
    }

    // Creator-escape path: an input is locked by the creator.
    let creator_present = QueryIter::new(load_cell_lock_hash, Source::Input).any(|h| h == creator);
    if creator_present {
        0
    } else {
        ERROR_ADMIN_UNAUTHORIZED
    }
}
