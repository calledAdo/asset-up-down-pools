//! `ckb-testtool` integration tests for the CREATE transition (mint PoolCell).
//!
//! Requires `make contracts-build` first.

#![cfg(test)]

use ckb_testtool::{
    ckb_hash::Blake2bBuilder,
    ckb_types::{
        bytes::Bytes,
        core::{HeaderBuilder, TransactionBuilder},
        packed::{CellInput, CellOutput, Script, Uint64},
        prelude::*,
    },
    context::Context,
};
use up_down_common::constants::*;
use up_down_common::pool_data::PoolData;

const MAX_CYCLES: u64 = 100_000_000;
const CAP: u64 = 1_000 * 100_000_000;

fn pool_type_bin() -> Bytes {
    std::fs::read("../target/riscv64imac-unknown-none-elf/release/pool_type")
        .expect("build contracts first: make contracts-build")
        .into()
}

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

fn treasury_hash() -> [u8; 32] {
    ckb_testtool::ckb_hash::blake2b_256(bin("treasury_lock"))
}

fn fresh_pool() -> PoolData {
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
        close_time: 1_000_900,
        up_total: 0,
        down_total: 0,
        start_price: 0,
        settle_price: 0,
        used_pt: 0,
        rake_bps: 100,
        status: STATUS_OPEN,
        winner: SIDE_UNDECIDED,
    }
}

fn type_id(first_input: &CellInput, output_index: u64) -> Bytes {
    let mut b = Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    b.update(first_input.as_slice());
    b.update(&output_index.to_le_bytes());
    let mut h = [0u8; 32];
    b.finalize(&mut h);
    h.to_vec().into()
}

/// Run a CREATE tx; `pool_args` overrides the PoolCell typeID args (pass `None`
/// for the correctly-seeded value). `now_secs` is the header-dep clock.
fn run_create(
    pool: PoolData,
    pool_args: Option<Bytes>,
    now_secs: u64,
) -> Result<u64, ckb_testtool::ckb_error::Error> {
    let mut context = Context::default();
    let cap: Uint64 = CAP.pack();

    let pool_out = context.deploy_cell(pool_type_bin());
    let always_out = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    let lock = context
        .build_script(&always_out, Bytes::new())
        .expect("lock");

    // Funding input (also seeds the typeID).
    let funding_out = context.create_cell(
        CellOutput::new_builder()
            .capacity(cap.clone())
            .lock(lock.clone())
            .build(),
        Bytes::new(),
    );
    let input = CellInput::new_builder()
        .previous_output(funding_out)
        .build();

    let args = pool_args.unwrap_or_else(|| type_id(&input, 0));
    let pool_type_script: Script = context.build_script(&pool_out, args).expect("pool_type");

    let output = CellOutput::new_builder()
        .capacity(cap)
        .lock(lock)
        .type_(Some(pool_type_script).pack())
        .build();

    let ts: Uint64 = (now_secs * 1000).pack();
    let header = HeaderBuilder::default().timestamp(ts).build();
    context.insert_header(header.clone());

    let tx = TransactionBuilder::default()
        .input(input)
        .output(output)
        .output_data(Bytes::from(pool.to_bytes()).pack())
        .header_dep(header.hash())
        .build();
    let tx = context.complete_tx(tx);

    context.verify_tx(&tx, MAX_CYCLES)
}

#[test]
fn create_succeeds() {
    let p = fresh_pool();
    assert!(run_create(p.clone(), None, p.start_time - 100).is_ok());
}

/// Run an xUDT CREATE. `treasury` is the (amount) of an output TreasuryCell bound
/// to this PoolCell, or `None` to omit it entirely.
fn run_xudt_create_with(
    treasury: Option<u128>,
    pool_treasury_lock_code_hash: [u8; 32],
    treasury_cell_lock_code_hash: [u8; 32],
) -> Result<u64, ckb_testtool::ckb_error::Error> {
    use ckb_testtool::ckb_types::core::ScriptHashType;

    let mut context = Context::default();
    let pool_out = context.deploy_cell(pool_type_bin());
    context.deploy_cell(bin("treasury_lock"));
    let always_out = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    let lock = context
        .build_script(&always_out, Bytes::new())
        .expect("lock");
    let asset_type = context
        .build_script(&always_out, Bytes::from_static(b"asset"))
        .expect("asset");
    let asset_hash: [u8; 32] = asset_type.calc_script_hash().unpack();

    let cap_full: Uint64 = CAP.pack();
    let funding_out = context.create_cell(
        CellOutput::new_builder()
            .capacity(cap_full)
            .lock(lock.clone())
            .build(),
        Bytes::new(),
    );
    let input = CellInput::new_builder()
        .previous_output(funding_out)
        .build();

    let pool_type_script: Script = context
        .build_script(&pool_out, type_id(&input, 0))
        .expect("pool_type");
    let own: [u8; 32] = pool_type_script.calc_script_hash().unpack();

    let treasury_lock = Script::new_builder()
        .code_hash(treasury_cell_lock_code_hash.pack())
        .hash_type(ScriptHashType::Data1)
        .args(Bytes::from(own.to_vec()).pack())
        .build();

    let mut p = fresh_pool();
    p.variant = VARIANT_XUDT;
    p.asset_type_hash = Some(asset_hash);
    p.treasury_lock_code_hash = Some(pool_treasury_lock_code_hash);

    // Pool at output 0 (typeID seeded for index 0).
    let pool_cap: u64 = if treasury.is_some() {
        600 * 100_000_000
    } else {
        CAP
    };
    let pool_cap_p: Uint64 = pool_cap.pack();
    let pool_output = CellOutput::new_builder()
        .capacity(pool_cap_p)
        .lock(lock.clone())
        .type_(Some(pool_type_script).pack())
        .build();

    let ts: Uint64 = ((p.start_time - 100) * 1000).pack();
    let header = HeaderBuilder::default().timestamp(ts).build();
    context.insert_header(header.clone());

    let mut builder = TransactionBuilder::default()
        .input(input)
        .output(pool_output)
        .output_data(Bytes::from(p.to_bytes()).pack());

    if let Some(amt) = treasury {
        let tre_cap: Uint64 = (CAP - pool_cap).pack();
        let tre_out = CellOutput::new_builder()
            .capacity(tre_cap)
            .lock(treasury_lock)
            .type_(Some(asset_type).pack())
            .build();
        builder = builder
            .output(tre_out)
            .output_data(Bytes::from(amt.to_le_bytes().to_vec()).pack());
    }

    let tx = builder.header_dep(header.hash()).build();
    let tx = context.complete_tx(tx);
    context.verify_tx(&tx, MAX_CYCLES)
}

fn run_xudt_create(treasury: Option<u128>) -> Result<u64, ckb_testtool::ckb_error::Error> {
    let tl_code = treasury_hash();
    run_xudt_create_with(treasury, tl_code, tl_code)
}

#[test]
fn xudt_create_with_zero_treasury_succeeds() {
    assert!(run_xudt_create(Some(0)).is_ok());
}

#[test]
fn xudt_create_without_treasury_fails() {
    assert!(run_xudt_create(None).is_err());
}

#[test]
fn xudt_create_with_seeded_treasury_fails() {
    // A non-zero initial treasury isn't reflected by up_total/down_total.
    assert!(run_xudt_create(Some(1)).is_err());
}

#[test]
fn create_zero_share_code_hash_fails() {
    let mut p = fresh_pool();
    p.share_xudt_code_hash = [0; 32];
    assert!(run_create(p, None, 999_900).is_err());
}

#[test]
fn xudt_create_zero_treasury_code_hash_fails() {
    assert!(run_xudt_create_with(Some(0), [0; 32], [0; 32]).is_err());
}

#[test]
fn create_wrong_type_id_fails() {
    let p = fresh_pool();
    assert!(run_create(
        p.clone(),
        Some(Bytes::from(vec![0x99u8; 32])),
        p.start_time - 100
    )
    .is_err());
}

#[test]
fn create_nonzero_totals_fails() {
    let mut p = fresh_pool();
    p.up_total = 5;
    assert!(run_create(p.clone(), None, p.start_time - 100).is_err());
}

#[test]
fn create_bad_time_ordering_fails() {
    let mut p = fresh_pool();
    p.close_time = p.start_time; // start >= close
    assert!(run_create(p.clone(), None, p.start_time - 100).is_err());
}

#[test]
fn create_start_in_past_fails() {
    let p = fresh_pool();
    assert!(run_create(p.clone(), None, p.start_time).is_err());
}

#[test]
fn create_close_in_past_fails() {
    let mut p = fresh_pool();
    p.start_time = 2_000_000;
    p.close_time = 2_000_900;
    assert!(run_create(p.clone(), None, p.close_time).is_err());
}
