//! Minimal decoder for the fields we read from a Lean Oracle cell.
//!
//! The oracle cell data is a fixed 152-byte layout (`OracleData` in the
//! lean_oracle `common` crate). We only need a few fields here, decoded by
//! their fixed offsets — we deliberately avoid depending on the oracle crate.

pub const ORACLE_STATE_LEN: usize = 152;

// Field offsets within the 152-byte oracle layout.
const OFF_FEED_ID: usize = 0; // [0..32]
const OFF_GUARDIAN_SET_TYPE_HASH: usize = 32; // [32..64]
const OFF_PRICE: usize = 64; // i64 [64..72]
const OFF_PUBLISH_TIME: usize = 84; // u64 [84..92]
const OFF_EMITTER_CHAIN: usize = 116; // u32 [116..120]
const OFF_EMITTER_ADDRESS: usize = 120; // [120..152]

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OracleRead {
    pub feed_id: [u8; 32],
    pub guardian_set_type_hash: [u8; 32],
    pub price: i64,
    pub publish_time: u64,
    pub emitter_chain: u32,
    pub emitter_address: [u8; 32],
}

impl OracleRead {
    pub fn from_bytes(d: &[u8]) -> Option<Self> {
        if d.len() != ORACLE_STATE_LEN {
            return None;
        }
        let mut feed_id = [0u8; 32];
        feed_id.copy_from_slice(&d[OFF_FEED_ID..OFF_FEED_ID + 32]);
        let mut guardian_set_type_hash = [0u8; 32];
        guardian_set_type_hash
            .copy_from_slice(&d[OFF_GUARDIAN_SET_TYPE_HASH..OFF_GUARDIAN_SET_TYPE_HASH + 32]);
        let mut emitter_address = [0u8; 32];
        emitter_address.copy_from_slice(&d[OFF_EMITTER_ADDRESS..OFF_EMITTER_ADDRESS + 32]);
        Some(Self {
            feed_id,
            guardian_set_type_hash,
            price: i64::from_le_bytes(d[OFF_PRICE..OFF_PRICE + 8].try_into().ok()?),
            publish_time: u64::from_le_bytes(
                d[OFF_PUBLISH_TIME..OFF_PUBLISH_TIME + 8].try_into().ok()?,
            ),
            emitter_chain: u32::from_le_bytes(
                d[OFF_EMITTER_CHAIN..OFF_EMITTER_CHAIN + 4]
                    .try_into()
                    .ok()?,
            ),
            emitter_address,
        })
    }

    /// Recompute the oracle-identity commitment from this cell's data plus the
    /// (separately supplied) oracle type code hash. Compared against the pool's
    /// stored `oracle_commit`. See [`oracle_commit`].
    pub fn commit(&self, code_hash: &[u8; 32]) -> [u8; 32] {
        oracle_commit(
            code_hash,
            &self.guardian_set_type_hash,
            self.emitter_chain,
            &self.emitter_address,
        )
    }
}

/// The oracle-identity commitment stored in PoolData: a single 32-byte hash that
/// binds the trusted oracle's **type code hash** and its **trust root** (Wormhole
/// guardian-set type hash + Pyth emitter chain/address). Storing this one hash —
/// instead of all four fields — keeps PoolData slim while pinning the same
/// identity (blake2b collision-resistance binds the tuple exactly).
///
/// `H = blake2b_ckb(code_hash ‖ guardian_set_type_hash ‖ emitter_chain_le ‖ emitter_address)`.
pub fn oracle_commit(
    code_hash: &[u8; 32],
    guardian_set_type_hash: &[u8; 32],
    emitter_chain: u32,
    emitter_address: &[u8; 32],
) -> [u8; 32] {
    let mut hasher = blake2b_ref::Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    hasher.update(code_hash);
    hasher.update(guardian_set_type_hash);
    hasher.update(&emitter_chain.to_le_bytes());
    hasher.update(emitter_address);
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);
    out
}
