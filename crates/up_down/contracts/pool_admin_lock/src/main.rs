//! `pool_admin_lock` — the PoolCell's lock.
//!
//! `args = creator_lock_hash (32)`. Two authorization paths:
//! - **Continuation:** the PoolCell's type (typeID) continues in the outputs
//!   **under this same lock** - this makes activate/resolve/redeem permissionless
//!   (anyone can drive a valid transition; `pool_type` enforces correctness). The
//!   lock must be carried through unchanged, or a permissionless transition could
//!   hand control to an attacker lock (defense-in-depth; `pool_type` pins this too).
//! - **Creator escape:** an input carries the creator lock hash - for terminal
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

    // Continuation path: every typed cell in this lock group must continue in an
    // output under the same lock. This is group-wide, not just GroupInput[0], so
    // a continuation for one PoolCell cannot authorize closing another one.
    let mut has_typed_input = false;
    let mut all_continue = true;
    for (input_index, input_type) in
        QueryIter::new(load_cell_type_hash, Source::GroupInput).enumerate()
    {
        let own_type = match input_type {
            Some(h) => h,
            None => continue,
        };
        has_typed_input = true;
        let own_lock = match load_cell_lock_hash(input_index, Source::GroupInput) {
            Ok(h) => h,
            Err(_) => return ERROR_SYSCALL,
        };
        let continues = QueryIter::new(load_cell_type_hash, Source::Output)
            .enumerate()
            .any(|(output_index, output_type)| {
                output_type == Some(own_type)
                    && load_cell_lock_hash(output_index, Source::Output)
                        .map(|lh| lh == own_lock)
                        .unwrap_or(false)
            });
        if !continues {
            all_continue = false;
            break;
        }
    }
    if has_typed_input && all_continue {
        return 0;
    }

    // Creator-escape path: an input is locked by the creator.
    let creator_present = QueryIter::new(load_cell_lock_hash, Source::Input).any(|h| h == creator);
    if creator_present {
        0
    } else {
        ERROR_ADMIN_UNAUTHORIZED
    }
}
