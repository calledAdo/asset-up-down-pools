//! Shared library for the CKB Up/Down scripts.
//!
//! Holds the protocol knowledge meant to be shared between the on-chain scripts
//! and host-side tests:
//! - `pool_data`   — PoolCell byte layout (variant-dependent) + encode/decode
//! - `oracle_read` — minimal decoder for the Lean Oracle cell fields we consume
//! - `constants`   — enums, the grace function, and pinned external code hashes
//! - `errors`      — compact `i8` status codes returned by the scripts

#![no_std]
extern crate alloc;

pub mod constants;
pub mod errors;
pub mod oracle_read;
pub mod pool_data;
