//! `ckb-testtool` integration tests for activation + the start-price contest:
//! ACTIVATE (OPEN→LOCKED provisional | OPEN→VOID) and CORRECT-start
//! (LOCKED→LOCKED). The clock is the oracle's authenticated `publish_time`; the
//! start tick lives in `(start_time, close_time)` and corrections lower `used_pt`
//! toward the first post-start tick. Requires `make contracts-build` first.

#![cfg(test)]

use ckb_testtool::{
    ckb_types::{
        bytes::Bytes,
        core::{ScriptHashType, TransactionBuilder},
        packed::{CellDep, CellInput, CellOutput, Script, Uint64},
        prelude::*,
    },
    context::Context,
};
use up_down_common::constants::*;
use up_down_common::pool_data::PoolData;

const MAX_CYCLES: u64 = 100_000_000;
const START: u64 = 1_000_000;
const CLOSE: u64 = 1_000_900;
const FEED_ID: [u8; 32] = [0x11; 32];
const PRICE: i64 = 50_000;
const CAP: u64 = 1_000 * 100_000_000;

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

fn oracle_blob(price: i64, publish_time: u64, feed: [u8; 32]) -> Bytes {
    let mut d = vec![0u8; 152];
    d[0..32].copy_from_slice(&feed);
    d[64..72].copy_from_slice(&price.to_le_bytes());
    d[84..92].copy_from_slice(&publish_time.to_le_bytes());
    d[32..64].copy_from_slice(&GUARDIAN_SET_TYPE_HASH);
    d[116..120].copy_from_slice(&PYTH_EMITTER_CHAIN.to_le_bytes());
    d[120..152].copy_from_slice(&PYTH_EMITTER_ADDRESS);
    d.into()
}

fn open_pool(up: u128, down: u128) -> PoolData {
    PoolData {
        variant: VARIANT_CKB,
        asset_type_hash: None,
        share_xudt_code_hash: share_hash(),
        treasury_lock_code_hash: None,
        feed_id: FEED_ID,
        oracle_commit: up_down_common::oracle_read::oracle_commit(
            &ORACLE_TYPE_CODE_HASH,
            &GUARDIAN_SET_TYPE_HASH,
            PYTH_EMITTER_CHAIN,
            &PYTH_EMITTER_ADDRESS,
        ),
        start_time: START,
        close_time: CLOSE,
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

fn locked(start_price: i64, used_pt: u64) -> PoolData {
    let mut p = open_pool(100, 50);
    p.status = STATUS_LOCKED;
    p.start_price = start_price;
    p.used_pt = used_pt;
    p
}

fn locked_next(prev: &PoolData, start_price: i64, used_pt: u64) -> PoolData {
    let mut next = prev.clone();
    next.status = STATUS_LOCKED;
    next.start_price = start_price;
    next.used_pt = used_pt;
    next
}

/// Run an activation-phase tx. `oracle_feed` lets tests forge a foreign feed;
/// `mint > 0` adds an un-backed UP-share mint to exercise the supply freeze.
fn run(
    prev: PoolData,
    next: PoolData,
    oracle_price: i64,
    oracle_pub: u64,
    oracle_feed: [u8; 32],
    mint: u128,
) -> Result<u64, ckb_testtool::ckb_error::Error> {
    let mut context = Context::default();
    let cap: Uint64 = CAP.pack();

    let pool_out = context.deploy_cell(bin("pool_type"));
    let _share_out = context.deploy_cell(bin("share_xudt"));
    let always_out = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    let lock = context
        .build_script(&always_out, Bytes::new())
        .expect("lock");
    let pool_type_script = context
        .build_script(&pool_out, Bytes::from(vec![0x22u8; 32]))
        .expect("pool_type");
    let own = pool_type_script.calc_script_hash();

    let oracle_type = Script::new_builder()
        .code_hash(ORACLE_TYPE_CODE_HASH.pack())
        .hash_type(ScriptHashType::Type)
        .args(Bytes::from(oracle_feed.to_vec()).pack())
        .build();
    let oracle_out = context.create_cell(
        CellOutput::new_builder()
            .capacity(cap.clone())
            .lock(lock.clone())
            .type_(Some(oracle_type).pack())
            .build(),
        oracle_blob(oracle_price, oracle_pub, oracle_feed),
    );
    let oracle_dep = CellDep::new_builder().out_point(oracle_out).build();

    let input_out = context.create_cell(
        CellOutput::new_builder()
            .capacity(cap.clone())
            .lock(lock.clone())
            .type_(Some(pool_type_script.clone()).pack())
            .build(),
        prev.to_bytes().into(),
    );
    let pool_cell_out = CellOutput::new_builder()
        .capacity(cap.clone())
        .lock(lock.clone())
        .type_(Some(pool_type_script).pack())
        .build();

    let mut builder = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(input_out).build())
        .output(pool_cell_out)
        .output_data(Bytes::from(next.to_bytes()).pack())
        .cell_dep(oracle_dep);

    if mint > 0 {
        let mut a = own.as_slice().to_vec();
        a.push(SIDE_UP);
        let share = Script::new_builder()
            .code_hash(prev.share_xudt_code_hash.pack())
            .hash_type(ScriptHashType::Data1)
            .args(Bytes::from(a).pack())
            .build();
        builder = builder
            .output(
                CellOutput::new_builder()
                    .capacity(cap)
                    .lock(lock)
                    .type_(Some(share).pack())
                    .build(),
            )
            .output_data(Bytes::from(mint.to_le_bytes().to_vec()).pack());
    }

    let tx = context.complete_tx(builder.build());
    context.verify_tx(&tx, MAX_CYCLES)
}

// ---- ACTIVATE → LOCKED (provisional start) -------------------------------

#[test]
fn activate_locked_succeeds() {
    let prev = open_pool(100, 50);
    let next = locked_next(&prev, PRICE, START + 5);
    assert!(run(prev, next, PRICE, START + 5, FEED_ID, 0).is_ok());
}

#[test]
fn activate_used_pt_must_match() {
    let prev = open_pool(100, 50);
    let next = locked_next(&prev, PRICE, START + 6); // != oracle pub
    assert!(run(prev, next, PRICE, START + 5, FEED_ID, 0).is_err());
}

#[test]
fn activate_wrong_start_price_fails() {
    let prev = open_pool(100, 50);
    let next = locked_next(&prev, PRICE + 1, START + 5);
    assert!(run(prev, next, PRICE, START + 5, FEED_ID, 0).is_err());
}

#[test]
fn activate_tick_at_start_fails() {
    let prev = open_pool(100, 50);
    let next = locked_next(&prev, PRICE, START);
    assert!(run(prev, next, PRICE, START, FEED_ID, 0).is_err());
}

#[test]
fn activate_tick_at_or_past_close_fails() {
    let prev = open_pool(100, 50);
    let next = locked_next(&prev, PRICE, CLOSE);
    assert!(run(prev, next, PRICE, CLOSE, FEED_ID, 0).is_err());
}

#[test]
fn activate_one_sided_must_not_lock() {
    let prev = open_pool(100, 0);
    let next = locked_next(&prev, PRICE, START + 5);
    assert!(run(prev, next, PRICE, START + 5, FEED_ID, 0).is_err());
}

#[test]
fn activate_foreign_feed_rejected() {
    let prev = open_pool(100, 50);
    let next = locked_next(&prev, PRICE, START + 5);
    let foreign = [0x99u8; 32];
    assert!(run(prev, next, PRICE, START + 5, foreign, 0).is_err());
}

#[test]
fn activate_minting_shares_rejected() {
    let prev = open_pool(100, 50);
    let next = locked_next(&prev, PRICE, START + 5);
    assert!(run(prev, next, PRICE, START + 5, FEED_ID, 1_000_000).is_err());
}

// ---- CORRECT-start (LOCKED → LOCKED) -------------------------------------

#[test]
fn correct_start_with_earlier_tick_succeeds() {
    let prev = locked(PRICE, START + 50);
    let next = locked_next(&prev, 49_500, START + 10);
    assert!(run(prev, next, 49_500, START + 10, FEED_ID, 0).is_ok());
}

#[test]
fn correct_start_not_earlier_fails() {
    let prev = locked(PRICE, START + 10);
    let next = locked_next(&prev, PRICE, START + 20);
    assert!(run(prev, next, PRICE, START + 20, FEED_ID, 0).is_err());
}

#[test]
fn correct_start_before_start_fails() {
    let prev = locked(PRICE, START + 50);
    let next = locked_next(&prev, PRICE, START);
    assert!(run(prev, next, PRICE, START, FEED_ID, 0).is_err());
}

// ---- ACTIVATE → VOID -----------------------------------------------------

#[test]
fn activate_void_one_sided_succeeds() {
    let prev = open_pool(100, 0); // empty DOWN side
    let mut next = prev.clone();
    next.status = STATUS_VOID;
    next.winner = WINNER_VOID;
    assert!(run(prev, next, PRICE, START + 5, FEED_ID, 0).is_ok());
}

#[test]
fn activate_void_never_activated_succeeds() {
    let prev = open_pool(100, 50);
    let mut next = prev.clone();
    next.status = STATUS_VOID;
    next.winner = WINNER_VOID;
    assert!(run(prev, next, PRICE, CLOSE + 1, FEED_ID, 0).is_ok());
}

#[test]
fn activate_void_two_sided_before_close_fails() {
    let prev = open_pool(100, 50);
    let mut next = prev.clone();
    next.status = STATUS_VOID;
    next.winner = WINNER_VOID;
    assert!(run(prev, next, PRICE, START + 5, FEED_ID, 0).is_err());
}
