//! Integration tests for `pool_admin_lock`: continuation (permissionless ops)
//! and creator-escape (terminal CLOSE). Requires `make contracts-build` first.

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
const START: u64 = 1_000_000;
const CLOSE_TIME: u64 = 1_000_900;

fn bin(name: &str) -> Bytes {
    std::fs::read(format!(
        "../target/riscv64imac-unknown-none-elf/release/{name}"
    ))
    .expect("build contracts first: make contracts-build")
    .into()
}

/// Typed capacity: `u64::pack()` is ambiguous (Uint64 vs BeUint64), so pin it.
fn cap(n: u64) -> Uint64 {
    n.pack()
}

fn admin_lock_hash() -> [u8; 32] {
    ckb_testtool::ckb_hash::blake2b_256(bin("pool_admin_lock"))
}

fn pool_lock(_context: &Context, creator_lock_hash: &[u8; 32]) -> Script {
    Script::new_builder()
        .code_hash(admin_lock_hash().pack())
        .hash_type(ScriptHashType::Data1)
        .args(Bytes::from(creator_lock_hash.to_vec()).pack())
        .build()
}

fn finalized_pool() -> PoolData {
    PoolData {
        variant: VARIANT_CKB,
        asset_type_hash: None,
        feed_id: [0x11; 32],
        oracle_commit: up_down_common::oracle_read::oracle_commit(
            &ORACLE_TYPE_CODE_HASH,
            &GUARDIAN_SET_TYPE_HASH,
            PYTH_EMITTER_CHAIN,
            &PYTH_EMITTER_ADDRESS,
        ),
        start_time: START,
        close_time: CLOSE_TIME,
        up_total: 200 * CKB as u128,
        down_total: 100 * CKB as u128,
        start_price: 50_000,
        settle_price: 60_000,
        used_pt: 1_000_905,
        rake_bps: 0,
        status: STATUS_FINALIZED,
        winner: SIDE_UP,
    }
}

/// CLOSE with `pool_admin_lock`: creator input required when the pool is consumed.
fn run_close(creator_in_tx: bool, now_secs: u64) -> Result<u64, ckb_testtool::ckb_error::Error> {
    let mut context = Context::default();
    context.deploy_cell(bin("pool_admin_lock"));

    let pool_out = context.deploy_cell(bin("pool_type"));
    let always_out = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    let creator_lock = context
        .build_script(&always_out, Bytes::from_static(b"creator"))
        .unwrap();
    let creator_hash: [u8; 32] = creator_lock.calc_script_hash().unpack();
    let pool_admin = pool_lock(&context, &creator_hash);

    let pool_type_script = context
        .build_script(&pool_out, Bytes::from(vec![0x22u8; 32]))
        .unwrap();

    let in_cap: Uint64 = (1_000 * CKB).pack();
    let out_cap: Uint64 = (1_000 * CKB).pack();

    let pool_in = context.create_cell(
        CellOutput::new_builder()
            .capacity(in_cap)
            .lock(pool_admin.clone())
            .type_(Some(pool_type_script).pack())
            .build(),
        finalized_pool().to_bytes().into(),
    );
    let sink = CellOutput::new_builder()
        .capacity(out_cap)
        .lock(creator_lock.clone())
        .build();

    let ts: Uint64 = (now_secs * 1000).pack();
    let header = HeaderBuilder::default().timestamp(ts).build();
    context.insert_header(header.clone());

    let mut builder = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build())
        .output(sink)
        .output_data(Bytes::new().pack())
        .header_dep(header.hash());

    if creator_in_tx {
        let fund = context.create_cell(
            CellOutput::new_builder()
                .capacity(cap(200 * CKB))
                .lock(creator_lock)
                .build(),
            Bytes::new(),
        );
        builder = builder.input(CellInput::new_builder().previous_output(fund).build());
    }

    let tx = context.complete_tx(builder.build());
    context.verify_tx(&tx, MAX_CYCLES)
}

/// DEPOSIT under `pool_admin_lock` — continuation path (no creator needed).
fn run_deposit_continuation() -> Result<u64, ckb_testtool::ckb_error::Error> {
    let mut context = Context::default();
    context.deploy_cell(bin("pool_admin_lock"));
    context.deploy_cell(bin("share_xudt"));

    let pool_out = context.deploy_cell(bin("pool_type"));
    let always_out = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    let user_lock = context
        .build_script(&always_out, Bytes::from_static(b"user"))
        .unwrap();
    let creator_hash: [u8; 32] = user_lock.calc_script_hash().unpack();
    let pool_admin = pool_lock(&context, &creator_hash);

    let pool_type_script = context
        .build_script(&pool_out, Bytes::from(vec![0x22u8; 32]))
        .unwrap();
    let own = pool_type_script.calc_script_hash();
    let share_hash = ckb_testtool::ckb_hash::blake2b_256(bin("share_xudt"));
    let mut share_args = own.as_slice().to_vec();
    share_args.push(SIDE_UP);
    let share_script = Script::new_builder()
        .code_hash(share_hash.pack())
        .hash_type(ScriptHashType::Data1)
        .args(Bytes::from(share_args).pack())
        .build();

    let prev = PoolData {
        variant: VARIANT_CKB,
        asset_type_hash: None,
        feed_id: [0x11; 32],
        oracle_commit: up_down_common::oracle_read::oracle_commit(
            &ORACLE_TYPE_CODE_HASH,
            &GUARDIAN_SET_TYPE_HASH,
            PYTH_EMITTER_CHAIN,
            &PYTH_EMITTER_ADDRESS,
        ),
        start_time: START,
        close_time: START + 900,
        up_total: 100 * CKB as u128,
        down_total: 50 * CKB as u128,
        start_price: 0,
        settle_price: 0,
        used_pt: 0,
        rake_bps: 100,
        status: STATUS_OPEN,
        winner: SIDE_UNDECIDED,
    };
    let mut next = prev.clone();
    next.up_total = 200 * CKB as u128;

    let pool_cap: Uint64 = (200 * CKB).pack();
    let pool_in = context.create_cell(
        CellOutput::new_builder()
            .capacity(pool_cap.clone())
            .lock(pool_admin.clone())
            .type_(Some(pool_type_script.clone()).pack())
            .build(),
        prev.to_bytes().into(),
    );
    let fund_in = context.create_cell(
        CellOutput::new_builder()
            .capacity(cap(400 * CKB))
            .lock(user_lock.clone())
            .build(),
        Bytes::new(),
    );

    let ts: Uint64 = ((START - 100) * 1000).pack();
    let header = HeaderBuilder::default().timestamp(ts).build();
    context.insert_header(header.clone());

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build())
        .input(CellInput::new_builder().previous_output(fund_in).build())
        .output(
            CellOutput::new_builder()
                .capacity(cap(300 * CKB))
                .lock(pool_admin)
                .type_(Some(pool_type_script).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(cap(200 * CKB))
                .lock(user_lock.clone())
                .type_(Some(share_script).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(cap(200 * CKB))
                .lock(user_lock)
                .build(),
        )
        .output_data(Bytes::from(next.to_bytes()).pack())
        .output_data(Bytes::from((100u128 * CKB as u128).to_le_bytes().to_vec()).pack())
        .output_data(Bytes::new().pack())
        .header_dep(header.hash())
        .build();
    let tx = context.complete_tx(tx);
    context.verify_tx(&tx, MAX_CYCLES)
}

#[test]
fn close_without_creator_fails() {
    let now = CLOSE_TIME + CLOSE_GRACE_SECS + 100;
    assert!(run_close(false, now).is_err());
}

#[test]
fn close_with_creator_succeeds() {
    let now = CLOSE_TIME + CLOSE_GRACE_SECS + 100;
    assert!(run_close(true, now).is_ok());
}

#[test]
fn deposit_continuation_without_creator_succeeds() {
    assert!(run_deposit_continuation().is_ok());
}
