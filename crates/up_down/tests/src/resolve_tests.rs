//! `ckb-testtool` integration tests for the resolution phase:
//! RESOLVE (LOCKED→SETTLED|VOID), CORRECT (SETTLED→SETTLED), FINALIZE
//! (SETTLED→FINALIZED). The clock is the oracle's authenticated `publish_time`;
//! `void_time = close + grace`. Requires `make contracts-build` first.

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

// 15-minute pool, grace = clamp(900/10) = 90s, void_time = CLOSE + 90.
const START: u64 = 1_000_000;
const CLOSE: u64 = 1_000_900;
const VOID_TIME: u64 = 1_000_990;
const FEED_ID: [u8; 32] = [0x11; 32];
const START_PRICE: i64 = 50_000;
const CAP: u64 = 1_000 * 100_000_000;

fn bin(name: &str) -> Bytes {
    std::fs::read(format!(
        "../target/riscv64imac-unknown-none-elf/release/{name}"
    ))
    .expect("build contracts first: make contracts-build")
    .into()
}

fn oracle_blob(price: i64, publish_time: u64) -> Bytes {
    let mut d = vec![0u8; 152];
    d[0..32].copy_from_slice(&FEED_ID);
    d[64..72].copy_from_slice(&price.to_le_bytes());
    d[84..92].copy_from_slice(&publish_time.to_le_bytes());
    d[32..64].copy_from_slice(&GUARDIAN_SET_TYPE_HASH);
    d[116..120].copy_from_slice(&PYTH_EMITTER_CHAIN.to_le_bytes());
    d[120..152].copy_from_slice(&PYTH_EMITTER_ADDRESS);
    d.into()
}

fn base() -> PoolData {
    PoolData {
        variant: VARIANT_CKB,
        asset_type_hash: None,
        feed_id: FEED_ID,
        oracle_commit: up_down_common::oracle_read::oracle_commit(
            &ORACLE_TYPE_CODE_HASH,
            &GUARDIAN_SET_TYPE_HASH,
            PYTH_EMITTER_CHAIN,
            &PYTH_EMITTER_ADDRESS,
        ),
        start_time: START,
        close_time: CLOSE,
        up_total: 100,
        down_total: 50,
        start_price: START_PRICE,
        settle_price: 0,
        used_pt: 0,
        rake_bps: 100,
        status: STATUS_LOCKED,
        winner: SIDE_UNDECIDED,
    }
}

fn locked() -> PoolData {
    base()
}

fn settled(settle_price: i64, used_pt: u64, winner: u8) -> PoolData {
    let mut p = base();
    p.status = STATUS_SETTLED;
    p.settle_price = settle_price;
    p.used_pt = used_pt;
    p.winner = winner;
    p
}

/// Run a resolution-phase transition. `mint > 0` adds an un-backed share mint to
/// exercise the supply freeze. The oracle dep carries `(oracle_price, oracle_pub)`.
fn run(
    prev: PoolData,
    next: PoolData,
    oracle_price: i64,
    oracle_pub: u64,
    mint: u128,
) -> Result<u64, ckb_testtool::ckb_error::Error> {
    let mut context = Context::default();
    let cap: Uint64 = CAP.pack();

    let pool_out = context.deploy_cell(bin("pool_type"));
    let _share_out = context.deploy_cell(bin("share_xudt"));
    let always_out = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    let lock = context.build_script(&always_out, Bytes::new()).expect("lock");
    let pool_type_script = context
        .build_script(&pool_out, Bytes::from(vec![0x22u8; 32]))
        .expect("pool_type");
    let own = pool_type_script.calc_script_hash();

    let oracle_type = Script::new_builder()
        .code_hash(ORACLE_TYPE_CODE_HASH.pack())
        .hash_type(ScriptHashType::Type)
        .args(Bytes::from(FEED_ID.to_vec()).pack())
        .build();
    let oracle_out = context.create_cell(
        CellOutput::new_builder()
            .capacity(cap.clone())
            .lock(lock.clone())
            .type_(Some(oracle_type).pack())
            .build(),
        oracle_blob(oracle_price, oracle_pub),
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
        let share_hash = ckb_testtool::ckb_hash::blake2b_256(bin("share_xudt"));
        let share = Script::new_builder()
            .code_hash(share_hash.pack())
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

// ---- RESOLVE (provisional) ----------------------------------------------

#[test]
fn resolve_succeeds() {
    // tick at CLOSE+5 (in (close, void_time)), 51000 > start -> UP.
    let next = settled(51_000, CLOSE + 5, SIDE_UP);
    assert!(run(locked(), next, 51_000, CLOSE + 5, 0).is_ok());
}

#[test]
fn resolve_records_used_pt() {
    // next.used_pt must equal the oracle publish_time.
    let mut next = settled(51_000, CLOSE + 5, SIDE_UP);
    next.used_pt = CLOSE + 6; // mismatch
    assert!(run(locked(), next, 51_000, CLOSE + 5, 0).is_err());
}

#[test]
fn resolve_wrong_winner_fails() {
    let next = settled(51_000, CLOSE + 5, SIDE_DOWN); // UP actually won
    assert!(run(locked(), next, 51_000, CLOSE + 5, 0).is_err());
}

#[test]
fn resolve_tie_sets_winner_void() {
    // settle == start -> winner VOID, still SETTLED (correctable).
    let next = settled(START_PRICE, CLOSE + 5, WINNER_VOID);
    assert!(run(locked(), next, START_PRICE, CLOSE + 5, 0).is_ok());
}

#[test]
fn resolve_tick_at_close_fails() {
    // publish_time must be strictly after close.
    let next = settled(51_000, CLOSE, SIDE_UP);
    assert!(run(locked(), next, 51_000, CLOSE, 0).is_err());
}

#[test]
fn resolve_tick_past_void_time_fails() {
    // A SETTLED resolution needs pub < void_time.
    let next = settled(51_000, VOID_TIME, SIDE_UP);
    assert!(run(locked(), next, 51_000, VOID_TIME, 0).is_err());
}

#[test]
fn resolve_minting_winning_shares_rejected() {
    let next = settled(51_000, CLOSE + 5, SIDE_UP);
    assert!(run(locked(), next, 51_000, CLOSE + 5, 1_000_000).is_err());
}

// ---- RESOLVE → VOID (no resolution within the window) --------------------

#[test]
fn grace_void_succeeds() {
    // oracle tick at/after void_time proves the window closed with no result.
    let mut next = locked();
    next.status = STATUS_VOID;
    next.winner = WINNER_VOID;
    assert!(run(locked(), next, 51_000, VOID_TIME + 10, 0).is_ok());
}

#[test]
fn grace_void_too_early_fails() {
    // void before void_time is not allowed (window still open).
    let mut next = locked();
    next.status = STATUS_VOID;
    next.winner = WINNER_VOID;
    assert!(run(locked(), next, 51_000, CLOSE + 5, 0).is_err());
}

// ---- CORRECT (earlier in-band tick wins) ---------------------------------

#[test]
fn correct_with_earlier_tick_succeeds() {
    // current used_pt = CLOSE+50; correct down to CLOSE+10.
    let prev = settled(51_000, CLOSE + 50, SIDE_UP);
    let next = settled(50_500, CLOSE + 10, SIDE_UP);
    assert!(run(prev, next, 50_500, CLOSE + 10, 0).is_ok());
}

#[test]
fn correct_can_flip_winner() {
    // earlier tick prices below start -> DOWN wins.
    let prev = settled(51_000, CLOSE + 50, SIDE_UP);
    let next = settled(49_000, CLOSE + 10, SIDE_DOWN);
    assert!(run(prev, next, 49_000, CLOSE + 10, 0).is_ok());
}

#[test]
fn correct_not_earlier_fails() {
    // a tick >= current used_pt cannot replace it (monotone-down only).
    let prev = settled(51_000, CLOSE + 10, SIDE_UP);
    let next = settled(52_000, CLOSE + 20, SIDE_UP);
    assert!(run(prev, next, 52_000, CLOSE + 20, 0).is_err());
}

#[test]
fn correct_before_close_fails() {
    let prev = settled(51_000, CLOSE + 50, SIDE_UP);
    let next = settled(51_000, CLOSE, SIDE_UP);
    assert!(run(prev, next, 51_000, CLOSE, 0).is_err());
}

// ---- FINALIZE (latch) ----------------------------------------------------

#[test]
fn finalize_succeeds() {
    let prev = settled(51_000, CLOSE + 5, SIDE_UP);
    let mut next = prev.clone();
    next.status = STATUS_FINALIZED;
    assert!(run(prev, next, 51_000, VOID_TIME + 1, 0).is_ok());
}

#[test]
fn finalize_too_early_fails() {
    // no oracle tick at/after void_time yet -> cannot finalize.
    let prev = settled(51_000, CLOSE + 5, SIDE_UP);
    let mut next = prev.clone();
    next.status = STATUS_FINALIZED;
    assert!(run(prev, next, 51_000, CLOSE + 50, 0).is_err());
}

#[test]
fn finalize_must_not_change_result() {
    let prev = settled(51_000, CLOSE + 5, SIDE_UP);
    let mut next = prev.clone();
    next.status = STATUS_FINALIZED;
    next.settle_price = 99_999; // tampering
    assert!(run(prev, next, 51_000, VOID_TIME + 1, 0).is_err());
}
