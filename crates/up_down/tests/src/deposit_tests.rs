//! `ckb-testtool` integration tests for the DEPOSIT transition (CKB variant).
//!
//! Requires `make contracts-build` first.

#![cfg(test)]

use ckb_testtool::{
    ckb_types::{
        bytes::Bytes,
        core::TransactionBuilder,
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

fn bin(name: &str) -> Bytes {
    std::fs::read(format!(
        "../target/riscv64imac-unknown-none-elf/release/{name}"
    ))
    .expect("build contracts first: make contracts-build")
    .into()
}

fn open_pool(up: u128, down: u128) -> PoolData {
    PoolData {
        variant: VARIANT_CKB,
        asset_type_hash: None,
        feed_id: [0x11; 32],
        oracle_commit: up_down_common::oracle_read::oracle_commit(
            &ORACLE_TYPE_CODE_HASH, &GUARDIAN_SET_TYPE_HASH, PYTH_EMITTER_CHAIN, &PYTH_EMITTER_ADDRESS,
        ),
        start_time: START,
        close_time: START + 900,
        up_total: up,
        down_total: down,
        start_price: 0,
        settle_price: 0,
        used_pt: 0,
        rake_bps: 100,
        status: STATUS_OPEN,
        winner: SIDE_UNDECIDED,
    }
}

struct Deposit {
    prev: PoolData,
    next: PoolData,
    /// share-token units actually minted to the depositor.
    minted: u128,
    side: u8,
    /// PoolCell output capacity (shannons).
    pool_out_cap: u64,
    now_secs: u64,
}

fn run(d: Deposit) -> Result<u64, ckb_testtool::ckb_error::Error> {
    let mut context = Context::default();
    context.set_capture_debug(true);

    let pool_out = context.deploy_cell(bin("pool_type"));
    let _share_out = context.deploy_cell(bin("share_xudt"));
    let always_out = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    let lock = context.build_script(&always_out, Bytes::new()).expect("lock");

    let pool_type_script: Script = context
        .build_script(&pool_out, Bytes::from(vec![0x22u8; 32]))
        .expect("pool_type");
    let own = pool_type_script.calc_script_hash();

    // share token type for the deposited side — built by DATA hash (hash_type
    // Data1) so its code hash is the deterministic blake2b of the binary, which
    // is what `pool_type` pins. (context.build_script would use a context-
    // dependent type-id instead.)
    let mut share_args = own.as_slice().to_vec();
    share_args.push(d.side);
    let share_data_hash = ckb_testtool::ckb_hash::blake2b_256(bin("share_xudt"));
    let share_script: Script = Script::new_builder()
        .code_hash(share_data_hash.pack())
        .hash_type(ckb_testtool::ckb_types::core::ScriptHashType::Data1)
        .args(Bytes::from(share_args).pack())
        .build();

    let pool_in_cap: Uint64 = (200 * CKB).pack();
    let pool_out_cap_p: Uint64 = d.pool_out_cap.pack();
    let fund_cap: Uint64 = (400 * CKB).pack();
    let share_cap: Uint64 = (200 * CKB).pack();
    let change_cap: Uint64 = (200 * CKB).pack();

    // Inputs: PoolCell + funding.
    let pool_in = context.create_cell(
        CellOutput::new_builder()
            .capacity(pool_in_cap)
            .lock(lock.clone())
            .type_(Some(pool_type_script.clone()).pack())
            .build(),
        d.prev.to_bytes().into(),
    );
    let fund_in = context.create_cell(
        CellOutput::new_builder()
            .capacity(fund_cap)
            .lock(lock.clone())
            .build(),
        Bytes::new(),
    );

    // Outputs: PoolCell, share cell, change.
    let pool_cell_out = CellOutput::new_builder()
        .capacity(pool_out_cap_p)
        .lock(lock.clone())
        .type_(Some(pool_type_script).pack())
        .build();
    let share_cell_out = CellOutput::new_builder()
        .capacity(share_cap)
        .lock(lock.clone())
        .type_(Some(share_script).pack())
        .build();
    let change_out = CellOutput::new_builder()
        .capacity(change_cap)
        .lock(lock)
        .build();

    let ts: Uint64 = (d.now_secs * 1000).pack();
    let header = ckb_testtool::ckb_types::core::HeaderBuilder::default()
        .timestamp(ts)
        .build();
    context.insert_header(header.clone());

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build())
        .input(CellInput::new_builder().previous_output(fund_in).build())
        .output(pool_cell_out)
        .output(share_cell_out)
        .output(change_out)
        .output_data(Bytes::from(d.next.to_bytes()).pack())
        .output_data(Bytes::from(d.minted.to_le_bytes().to_vec()).pack())
        .output_data(Bytes::new().pack())
        .header_dep(header.hash())
        .build();
    let tx = context.complete_tx(tx);

    let r = context.verify_tx(&tx, MAX_CYCLES);
    for m in context.captured_messages() {
        println!("DBG: {}", m.message);
    }
    r
}

// Stake D = 100 CKB on UP; pool capacity rises by D; 100 share units minted.
fn happy() -> Deposit {
    let d: u128 = 100 * CKB as u128;
    Deposit {
        prev: open_pool(100 * CKB as u128, 50 * CKB as u128),
        next: open_pool(200 * CKB as u128, 50 * CKB as u128),
        minted: d,
        side: SIDE_UP,
        pool_out_cap: 200 * CKB + 100 * CKB, // in + D
        now_secs: START - 100,
    }
}

#[test]
fn deposit_succeeds() {
    assert!(run(happy()).is_ok());
}

#[test]
fn deposit_wrong_share_amount_fails() {
    let mut d = happy();
    d.minted -= 1; // minted != D
    assert!(run(d).is_err());
}

#[test]
fn deposit_capacity_mismatch_fails() {
    let mut d = happy();
    d.pool_out_cap -= 1; // capacity delta != D
    assert!(run(d).is_err());
}

#[test]
fn deposit_after_start_fails() {
    let mut d = happy();
    d.now_secs = START + 10; // past the open window
    assert!(run(d).is_err());
}

// Buy UP and DOWN in one tx: up +100, down +30, treasury +130, shares match.
#[test]
fn deposit_both_sides_succeeds() {
    let mut context = Context::default();
    let pool_out = context.deploy_cell(bin("pool_type"));
    let _share_out = context.deploy_cell(bin("share_xudt"));
    let always_out = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    let lock = context.build_script(&always_out, Bytes::new()).expect("lock");
    let pool_type_script: Script = context
        .build_script(&pool_out, Bytes::from(vec![0x22u8; 32]))
        .expect("pool_type");
    let own = pool_type_script.calc_script_hash();
    let share_hash = ckb_testtool::ckb_hash::blake2b_256(bin("share_xudt"));
    let share = |side: u8| -> Script {
        let mut a = own.as_slice().to_vec();
        a.push(side);
        Script::new_builder()
            .code_hash(share_hash.pack())
            .hash_type(ckb_testtool::ckb_types::core::ScriptHashType::Data1)
            .args(Bytes::from(a).pack())
            .build()
    };

    let prev = open_pool(100 * CKB as u128, 50 * CKB as u128);
    let next = open_pool(200 * CKB as u128, 80 * CKB as u128); // up +100, down +30

    let cap200: Uint64 = (200 * CKB).pack();
    let cap400: Uint64 = (400 * CKB).pack();
    let pool_in = context.create_cell(
        CellOutput::new_builder()
            .capacity(cap200.clone())
            .lock(lock.clone())
            .type_(Some(pool_type_script.clone()).pack())
            .build(),
        prev.to_bytes().into(),
    );
    let fund_in = context.create_cell(
        CellOutput::new_builder().capacity(cap400).lock(lock.clone()).build(),
        Bytes::new(),
    );

    let pool_out_cap: Uint64 = (200 * CKB + 130 * CKB).pack(); // + total stake
    let scap: Uint64 = (100 * CKB).pack();
    let ts: Uint64 = ((START - 100) * 1000).pack();
    let header = ckb_testtool::ckb_types::core::HeaderBuilder::default().timestamp(ts).build();
    context.insert_header(header.clone());

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build())
        .input(CellInput::new_builder().previous_output(fund_in).build())
        .output(
            CellOutput::new_builder()
                .capacity(pool_out_cap)
                .lock(lock.clone())
                .type_(Some(pool_type_script).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(scap.clone())
                .lock(lock.clone())
                .type_(Some(share(SIDE_UP)).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(scap)
                .lock(lock)
                .type_(Some(share(SIDE_DOWN)).pack())
                .build(),
        )
        .output_data(Bytes::from(next.to_bytes()).pack())
        .output_data(Bytes::from((100u128 * CKB as u128).to_le_bytes().to_vec()).pack())
        .output_data(Bytes::from((30u128 * CKB as u128).to_le_bytes().to_vec()).pack())
        .header_dep(header.hash())
        .build();
    let tx = context.complete_tx(tx);
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_ok());
}

// Both sides move but the DOWN share mint doesn't match its total delta.
#[test]
fn deposit_both_sides_share_mismatch_fails() {
    // Reuse the single-side `run` path: up rises by D but we also bump down_total
    // in state without minting any DOWN shares -> net_minted(DOWN)=0 != down_d.
    let mut d = happy();
    d.next = open_pool(200 * CKB as u128, 60 * CKB as u128); // down also +10, unfunded
    d.pool_out_cap = 200 * CKB + 110 * CKB; // treasury matches 110 total...
    assert!(run(d).is_err()); // ...but DOWN shares weren't minted
}
