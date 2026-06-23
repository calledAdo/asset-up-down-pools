//! Integration tests for `pool_admin_lock`: continuation (permissionless ops)
//! and creator-escape (terminal CLOSE). Requires `make contracts-build` first.

#![cfg(test)]

use ckb_testtool::{
    ckb_types::{
        bytes::Bytes,
        core::{HeaderBuilder, ScriptHashType, TransactionBuilder},
        packed::{CellDep, CellInput, CellOutput, Script, Uint64},
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
const CLOSE_GRACE: u64 = close_grace(CLOSE_TIME - START); // = 7200s

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

fn share_hash() -> [u8; 32] {
    ckb_testtool::ckb_hash::blake2b_256(bin("share_xudt"))
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
        share_xudt_code_hash: share_hash(),
        treasury_lock_code_hash: None,
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

fn open_pool() -> PoolData {
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
        start_time: START,
        close_time: CLOSE_TIME,
        up_total: 200 * CKB as u128,
        down_total: 100 * CKB as u128,
        start_price: 0,
        settle_price: 0,
        used_pt: 0,
        rake_bps: 0,
        status: STATUS_OPEN,
        winner: SIDE_UNDECIDED,
    }
}

fn oracle_blob(price: i64, publish_time: u64, feed: [u8; 32]) -> Bytes {
    let mut d = vec![0u8; 152];
    d[0..32].copy_from_slice(&feed);
    d[32..64].copy_from_slice(&GUARDIAN_SET_TYPE_HASH);
    d[64..72].copy_from_slice(&price.to_le_bytes());
    d[84..92].copy_from_slice(&publish_time.to_le_bytes());
    d[116..120].copy_from_slice(&PYTH_EMITTER_CHAIN.to_le_bytes());
    d[120..152].copy_from_slice(&PYTH_EMITTER_ADDRESS);
    d.into()
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

/// DEPOSIT under `pool_admin_lock` - continuation path (no creator needed).
/// `out_pool_lock_override` swaps the *output* PoolCell lock (None = keep the
/// real admin lock, i.e. a legitimate continuation).
fn run_deposit_continuation(
    out_pool_lock_override: Option<Script>,
) -> Result<u64, ckb_testtool::ckb_error::Error> {
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
        share_xudt_code_hash: share_hash,
        treasury_lock_code_hash: None,
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

    let out_pool_lock = out_pool_lock_override.unwrap_or_else(|| pool_admin.clone());

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
                .lock(out_pool_lock)
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
    let now = CLOSE_TIME + CLOSE_GRACE + 100;
    assert!(run_close(false, now).is_err());
}

#[test]
fn close_with_creator_succeeds() {
    let now = CLOSE_TIME + CLOSE_GRACE + 100;
    assert!(run_close(true, now).is_ok());
}

#[test]
fn deposit_continuation_without_creator_succeeds() {
    assert!(run_deposit_continuation(None).is_ok());
}

/// A continuation that recreates the PoolCell under a *different* lock must be
/// rejected; otherwise a permissionless deposit/activate/resolve could capture
/// the pool's future liveness and CLOSE/teardown authority. Pinned by both
/// `pool_type` (ERROR_LOCK_MUTATED) and `pool_admin_lock` (ADMIN_UNAUTHORIZED).
#[test]
fn deposit_continuation_lock_hijack_fails() {
    let mut context = Context::default();
    let always_out = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    // An attacker-chosen lock (valid always-success, but a different hash).
    let attacker_lock = context
        .build_script(&always_out, Bytes::from_static(b"attacker"))
        .unwrap();
    assert!(run_deposit_continuation(Some(attacker_lock)).is_err());
}

/// Lock authorization is per lock-script group, not per first input. If two
/// PoolCells share the same `pool_admin_lock`, a valid continuation for one must
/// not authorize a terminal CLOSE of the other unless the creator is also present.
#[test]
fn mixed_group_continuation_does_not_authorize_close_without_creator() {
    let mut context = Context::default();
    context.deploy_cell(bin("pool_admin_lock"));

    let pool_out = context.deploy_cell(bin("pool_type"));
    let always_out = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    let user_lock = context
        .build_script(&always_out, Bytes::from_static(b"user"))
        .unwrap();
    let creator_hash: [u8; 32] = user_lock.calc_script_hash().unpack();
    let pool_admin = pool_lock(&context, &creator_hash);

    let pool_type_a = context
        .build_script(&pool_out, Bytes::from(vec![0x22u8; 32]))
        .unwrap();
    let pool_type_b = context
        .build_script(&pool_out, Bytes::from(vec![0x33u8; 32]))
        .unwrap();

    let prev_a = open_pool();
    let mut next_a = prev_a.clone();
    next_a.status = STATUS_LOCKED;
    next_a.start_price = 50_000;
    next_a.used_pt = START + 5;

    let pool_a_in = context.create_cell(
        CellOutput::new_builder()
            .capacity(cap(1_000 * CKB))
            .lock(pool_admin.clone())
            .type_(Some(pool_type_a.clone()).pack())
            .build(),
        prev_a.to_bytes().into(),
    );
    let pool_b_in = context.create_cell(
        CellOutput::new_builder()
            .capacity(cap(1_000 * CKB))
            .lock(pool_admin.clone())
            .type_(Some(pool_type_b).pack())
            .build(),
        finalized_pool().to_bytes().into(),
    );

    let oracle_type = Script::new_builder()
        .code_hash(ORACLE_TYPE_CODE_HASH.pack())
        .hash_type(ScriptHashType::Type)
        .args(Bytes::from(prev_a.feed_id.to_vec()).pack())
        .build();
    let oracle_out = context.create_cell(
        CellOutput::new_builder()
            .capacity(cap(1_000 * CKB))
            .lock(user_lock.clone())
            .type_(Some(oracle_type).pack())
            .build(),
        oracle_blob(50_000, START + 5, prev_a.feed_id),
    );
    let oracle_dep = CellDep::new_builder().out_point(oracle_out).build();

    let ts: Uint64 = ((CLOSE_TIME + CLOSE_GRACE + 100) * 1000).pack();
    let header = HeaderBuilder::default().timestamp(ts).build();
    context.insert_header(header.clone());

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_a_in).build())
        .input(CellInput::new_builder().previous_output(pool_b_in).build())
        .output(
            CellOutput::new_builder()
                .capacity(cap(1_000 * CKB))
                .lock(pool_admin)
                .type_(Some(pool_type_a).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(cap(1_000 * CKB))
                .lock(user_lock)
                .build(),
        )
        .output_data(Bytes::from(next_a.to_bytes()).pack())
        .output_data(Bytes::new().pack())
        .header_dep(header.hash())
        .cell_dep(oracle_dep)
        .build();
    let tx = context.complete_tx(tx);

    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}
