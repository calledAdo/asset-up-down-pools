//! PoolCell data layout and manual little-endian encoding.
//!
//! `pool_id` lives in the type-script args (the typeID), not here. The UP/DOWN
//! share-token and treasury identities are config, not build-time constants. The
//! layout is led by `variant`, which decides whether xUDT-only fields are present:
//!
//! - CKB variant  (`variant == 0`): `POOL_LEN_CKB  = 173`
//! - xUDT variant (`variant == 1`): `POOL_LEN_XUDT = 237`
//!
//! See `docs/pool_type-spec.md` for the full offset tables.

use crate::constants::{VARIANT_CKB, VARIANT_XUDT};
use alloc::vec::Vec;

pub const POOL_LEN_CKB: usize = 173;
pub const POOL_LEN_XUDT: usize = 237;

/// The contiguous oracle-identity block that follows the script-identity config:
/// feed_id(32) oracle_commit(32) = 64. `oracle_commit` is a single hash binding
/// the oracle type code hash + the trust root (guardian-set type hash + Pyth
/// emitter chain/address) — see `oracle_read::oracle_commit`. `feed_id` stays in
/// the clear because it's the oracle type's args (used to locate the cell).
const ORACLE_ID_LEN: usize = 64;

/// Bytes after the oracle-identity block: start_time(8) close_time(8)
/// up_total(16) down_total(16) start_price(8) settle_price(8) used_pt(8)
/// rake_bps(2) status(1) winner(1) = 76.
const TAIL_LEN: usize = 76;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolData {
    pub variant: u8,
    /// Some iff `variant == VARIANT_XUDT`.
    pub asset_type_hash: Option<[u8; 32]>,
    /// Code hash of this pool's UP/DOWN share xUDT script.
    pub share_xudt_code_hash: [u8; 32],
    /// Code hash of this pool's treasury lock, present iff `variant == VARIANT_XUDT`.
    pub treasury_lock_code_hash: Option<[u8; 32]>,
    /// Pyth feed id — the oracle type script's args. Pins which feed *and*,
    /// together with `oracle_code_hash`, exactly which oracle type is trusted.
    pub feed_id: [u8; 32],
    /// Commitment to the trusted oracle's identity: a single hash binding the
    /// oracle type code hash + trust root (guardian-set type hash, Pyth emitter
    /// chain/address). `find_oracle` recomputes it from the dep cell and matches.
    /// See `oracle_read::oracle_commit`.
    pub oracle_commit: [u8; 32],
    pub start_time: u64,
    pub close_time: u64,
    pub up_total: u128,
    pub down_total: u128,
    pub start_price: i64,
    pub settle_price: i64,
    /// `publish_time` of the oracle tick backing the price of the *current phase*.
    /// In LOCKED it tracks the **start** tick (in `(start,close)`); RESOLVE flips it
    /// to the **settle** tick (in `(close,void)`). Within a phase a CORRECT may only
    /// replace it with a strictly *earlier* tick (monotone-down convergence toward the
    /// first tick after the boundary). State, not config. Zero until activation.
    pub used_pt: u64,
    pub rake_bps: u16,
    pub status: u8,
    pub winner: u8,
}

impl PoolData {
    /// Decode PoolCell data. Peeks `variant`, then branches on length.
    pub fn from_bytes(d: &[u8]) -> Option<Self> {
        let variant = *d.first()?;
        let (asset_type_hash, treasury_lock_code_hash, r0) = match variant {
            VARIANT_CKB => (None, None, 33usize),
            VARIANT_XUDT => {
                let mut h = [0u8; 32];
                h.copy_from_slice(d.get(1..33)?);
                let mut t = [0u8; 32];
                t.copy_from_slice(d.get(65..97)?);
                (Some(h), Some(t), 97usize)
            }
            _ => return None,
        };

        if d.len() != r0 + ORACLE_ID_LEN + TAIL_LEN {
            return None;
        }

        let share_off = match variant {
            VARIANT_CKB => 1usize,
            VARIANT_XUDT => 33usize,
            _ => return None,
        };
        let mut share_xudt_code_hash = [0u8; 32];
        share_xudt_code_hash.copy_from_slice(d.get(share_off..share_off + 32)?);

        let mut feed_id = [0u8; 32];
        feed_id.copy_from_slice(&d[r0..r0 + 32]);
        let mut oracle_commit = [0u8; 32];
        oracle_commit.copy_from_slice(&d[r0 + 32..r0 + 64]);
        let r = r0 + ORACLE_ID_LEN;

        Some(Self {
            variant,
            asset_type_hash,
            share_xudt_code_hash,
            treasury_lock_code_hash,
            feed_id,
            oracle_commit,
            start_time: u64::from_le_bytes(d[r..r + 8].try_into().ok()?),
            close_time: u64::from_le_bytes(d[r + 8..r + 16].try_into().ok()?),
            up_total: u128::from_le_bytes(d[r + 16..r + 32].try_into().ok()?),
            down_total: u128::from_le_bytes(d[r + 32..r + 48].try_into().ok()?),
            start_price: i64::from_le_bytes(d[r + 48..r + 56].try_into().ok()?),
            settle_price: i64::from_le_bytes(d[r + 56..r + 64].try_into().ok()?),
            used_pt: u64::from_le_bytes(d[r + 64..r + 72].try_into().ok()?),
            rake_bps: u16::from_le_bytes(d[r + 72..r + 74].try_into().ok()?),
            status: d[r + 74],
            winner: d[r + 75],
        })
    }

    /// Encode back into the exact byte layout.
    pub fn to_bytes(&self) -> Vec<u8> {
        let cap = if self.variant == VARIANT_XUDT {
            POOL_LEN_XUDT
        } else {
            POOL_LEN_CKB
        };
        let mut out = Vec::with_capacity(cap);
        out.push(self.variant);
        if let Some(h) = &self.asset_type_hash {
            out.extend_from_slice(h);
        }
        out.extend_from_slice(&self.share_xudt_code_hash);
        if let Some(h) = &self.treasury_lock_code_hash {
            out.extend_from_slice(h);
        }
        out.extend_from_slice(&self.feed_id);
        out.extend_from_slice(&self.oracle_commit);
        out.extend_from_slice(&self.start_time.to_le_bytes());
        out.extend_from_slice(&self.close_time.to_le_bytes());
        out.extend_from_slice(&self.up_total.to_le_bytes());
        out.extend_from_slice(&self.down_total.to_le_bytes());
        out.extend_from_slice(&self.start_price.to_le_bytes());
        out.extend_from_slice(&self.settle_price.to_le_bytes());
        out.extend_from_slice(&self.used_pt.to_le_bytes());
        out.extend_from_slice(&self.rake_bps.to_le_bytes());
        out.push(self.status);
        out.push(self.winner);
        out
    }

    /// Config fields that must never change after creation.
    pub fn config_unchanged(&self, o: &Self) -> bool {
        self.variant == o.variant
            && self.asset_type_hash == o.asset_type_hash
            && self.share_xudt_code_hash == o.share_xudt_code_hash
            && self.treasury_lock_code_hash == o.treasury_lock_code_hash
            && self.feed_id == o.feed_id
            && self.oracle_commit == o.oracle_commit
            && self.start_time == o.start_time
            && self.close_time == o.close_time
            && self.rake_bps == o.rake_bps
    }

    /// Pool duration in seconds.
    pub fn duration(&self) -> u64 {
        self.close_time.saturating_sub(self.start_time)
    }
}
