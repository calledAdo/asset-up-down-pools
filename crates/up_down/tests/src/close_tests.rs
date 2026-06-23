//! `ckb-testtool` integration tests for the CLOSE transition (terminal sweep).
//! Uses `pool_admin_lock` (creator-escape path) alongside `pool_type`.
//!
//! Requires `make contracts-build` first.

#![cfg(test)]

use ckb_testtool::{
    ckb_types::{
        bytes::Bytes,
        core::{HeaderBuilder, ScriptHashType, TransactionBuilder},
        packed::{CellInput, CellOutput, Script, Uint64},
        prelude::*,
    },
    context::Context,
};
use up_down_common::constants::*;
use up_down_common::pool_data::PoolData;

const MAX_CYCLES: u64 = 100_000_000;
const CKB: u64 = 100_000_000;
const START_TIME: u64 = 1_000_000;
const CLOSE_TIME: u64 = 1_000_900;
// close_grace(900) = clamp(900*8, 1h, 7d) = 7200s.
const CLOSE_GRACE: u64 = close_grace(CLOSE_TIME - START_TIME);

fn bin(name: &str) -> Bytes {
    std::fs::read(format!(
        "../target/riscv64imac-unknown-none-elf/release/{name}"
    ))
    .expect("build contracts first: make contracts-build")
    .into()
}

fn share_hash() -> [u8; 32] {
    ckb_testtool::ckb_hash::blake2b_256(bin("share_xudt"))
}

fn pool_lock(_context: &Context, creator_lock_hash: &[u8; 32]) -> Script {
    let code = ckb_testtool::ckb_hash::blake2b_256(bin("pool_admin_lock"));
    Script::new_builder()
        .code_hash(code.pack())
        .hash_type(ScriptHashType::Data1)
        .args(Bytes::from(creator_lock_hash.to_vec()).pack())
        .build()
}

fn pool(status: u8) -> PoolData {
    PoolData {
        variant: VARIANT_CKB,
        asset_type_hash: None,
        share_xudt_code_hash: share_hash(),
        treasury_lock_code_hash: None,
        feed_id: [0x11; 32],
        oracle_commit: up_down_common::oracle_read::oracle_commit(
            &ORACLE_TYPE_CODE_HASH,
            &GUARDIAN_SET_TYPE_HASH,
            PYTH_EMITTER_CHAIN,
            &PYTH_EMITTER_ADDRESS,
        ),
        start_time: 1_000_000,
        close_time: CLOSE_TIME,
        up_total: 200 * CKB as u128,
        down_total: 100 * CKB as u128,
        start_price: 50_000,
        settle_price: 60_000,
        used_pt: 1_000_905,
        rake_bps: 0,
        status,
        winner: if status == STATUS_VOID {
            WINNER_VOID
        } else {
            SIDE_UP
        },
    }
}

/// CLOSE = PoolCell consumed, no PoolCell output (terminal). Creator lock must
/// be present in inputs for `pool_admin_lock` authorization.
fn run(status: u8, now_secs: u64) -> Result<u64, ckb_testtool::ckb_error::Error> {
    let mut context = Context::default();
    context.deploy_cell(bin("pool_admin_lock"));

    let pool_out = context.deploy_cell(bin("pool_type"));
    let always_out = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    let creator_lock = context
        .build_script(&always_out, Bytes::from_static(b"creator"))
        .unwrap();
    let creator_hash: [u8; 32] = creator_lock.calc_script_hash().unpack();
    let pool_admin = pool_lock(&context, &creator_hash);
    let pool_type_script: Script = context
        .build_script(&pool_out, Bytes::from(vec![0x22u8; 32]))
        .expect("pool_type");

    let in_cap: Uint64 = (1_000 * CKB).pack();
    let out_cap: Uint64 = (1_000 * CKB).pack();

    let pool_in = context.create_cell(
        CellOutput::new_builder()
            .capacity(in_cap)
            .lock(pool_admin)
            .type_(Some(pool_type_script).pack())
            .build(),
        pool(status).to_bytes().into(),
    );
    let fund = context.create_cell(
        CellOutput::new_builder()
            .capacity(out_cap.clone())
            .lock(creator_lock.clone())
            .build(),
        Bytes::new(),
    );
    let sink = CellOutput::new_builder()
        .capacity(out_cap)
        .lock(creator_lock)
        .build();

    let ts: Uint64 = (now_secs * 1000).pack();
    let header = HeaderBuilder::default().timestamp(ts).build();
    context.insert_header(header.clone());

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build())
        .input(CellInput::new_builder().previous_output(fund).build())
        .output(sink)
        .output_data(Bytes::new().pack())
        .header_dep(header.hash())
        .build();
    let tx = context.complete_tx(tx);

    context.verify_tx(&tx, MAX_CYCLES)
}

#[test]
fn close_finalized_after_grace_succeeds() {
    assert!(run(STATUS_FINALIZED, CLOSE_TIME + CLOSE_GRACE + 100).is_ok());
}

#[test]
fn close_void_after_grace_succeeds() {
    assert!(run(STATUS_VOID, CLOSE_TIME + CLOSE_GRACE + 100).is_ok());
}

#[test]
fn close_before_grace_fails() {
    assert!(run(STATUS_FINALIZED, CLOSE_TIME + 100).is_err());
}

// A still-contestable SETTLED pool must not be closeable (must finalize first).
#[test]
fn close_settled_fails() {
    assert!(run(STATUS_SETTLED, CLOSE_TIME + CLOSE_GRACE + 100).is_err());
}

#[test]
fn close_open_pool_fails() {
    assert!(run(STATUS_OPEN, CLOSE_TIME + CLOSE_GRACE + 100).is_err());
}

#[test]
fn close_locked_pool_fails() {
    assert!(run(STATUS_LOCKED, CLOSE_TIME + CLOSE_GRACE + 100).is_err());
}
