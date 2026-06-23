//! `ckb-testtool` integration tests for the REDEEM transition (CKB variant).
//!
//! Requires `make contracts-build` first.

#![cfg(test)]

use ckb_testtool::{
    ckb_types::{
        bytes::Bytes,
        core::{ScriptHashType, TransactionBuilder},
        packed::{CellInput, CellOutput, Script, Uint64},
        prelude::*,
    },
    context::Context,
};
use up_down_common::constants::*;
use up_down_common::pool_data::PoolData;

const MAX_CYCLES: u64 = 100_000_000;
const CKB: u64 = 100_000_000;

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

fn settled_pool(up: u128, down: u128, winner: u8, rake_bps: u16) -> PoolData {
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
        up_total: up,
        down_total: down,
        start_price: 50_000,
        settle_price: if winner == SIDE_UP { 60_000 } else { 40_000 },
        used_pt: 1_000_905,
        rake_bps,
        status: if winner == WINNER_VOID {
            STATUS_VOID
        } else {
            STATUS_FINALIZED
        },
        winner,
    }
}

struct Redeem {
    pool: PoolData,
    /// (side, amount) share cells the burner spends.
    burns: Vec<(u8, u128)>,
    /// PoolCell capacity in / out (shannons).
    pool_in_cap: u64,
    pool_out_cap: u64,
}

fn run(r: Redeem) -> Result<u64, ckb_testtool::ckb_error::Error> {
    let mut context = Context::default();

    let pool_out = context.deploy_cell(bin("pool_type"));
    let _share_out = context.deploy_cell(bin("share_xudt"));
    let always_out = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    let lock = context
        .build_script(&always_out, Bytes::new())
        .expect("lock");

    let pool_type_script: Script = context
        .build_script(&pool_out, Bytes::from(vec![0x22u8; 32]))
        .expect("pool_type");
    let own = pool_type_script.calc_script_hash();
    let share_data_hash = r.pool.share_xudt_code_hash;

    let share_script = |side: u8| -> Script {
        let mut args = own.as_slice().to_vec();
        args.push(side);
        Script::new_builder()
            .code_hash(share_data_hash.pack())
            .hash_type(ScriptHashType::Data1)
            .args(Bytes::from(args).pack())
            .build()
    };

    let pool_in_cap: Uint64 = r.pool_in_cap.pack();
    let pool_out_cap: Uint64 = r.pool_out_cap.pack();
    let share_cap: u64 = 200 * CKB;

    // Inputs: PoolCell(SETTLED/VOID) + the burned share cells.
    let pool_in = context.create_cell(
        CellOutput::new_builder()
            .capacity(pool_in_cap)
            .lock(lock.clone())
            .type_(Some(pool_type_script.clone()).pack())
            .build(),
        r.pool.to_bytes().into(),
    );
    let mut tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build());

    let mut burned_caps: u64 = 0;
    for (side, amount) in &r.burns {
        let cap: Uint64 = share_cap.pack();
        let sc = context.create_cell(
            CellOutput::new_builder()
                .capacity(cap)
                .lock(lock.clone())
                .type_(Some(share_script(*side)).pack())
                .build(),
            Bytes::from(amount.to_le_bytes().to_vec()),
        );
        tx = tx.input(CellInput::new_builder().previous_output(sc).build());
        burned_caps += share_cap;
    }

    // Outputs: PoolCell (reduced capacity) + a sink cell for everything freed.
    let pool_cell_out = CellOutput::new_builder()
        .capacity(pool_out_cap)
        .lock(lock.clone())
        .type_(Some(pool_type_script).pack())
        .build();
    let freed = (r.pool_in_cap - r.pool_out_cap) + burned_caps; // payout + reclaimed share caps
    let sink_cap: Uint64 = freed.pack();
    let sink = CellOutput::new_builder()
        .capacity(sink_cap)
        .lock(lock)
        .build();

    let tx = tx
        .output(pool_cell_out)
        .output(sink)
        .output_data(Bytes::from(r.pool.to_bytes()).pack())
        .output_data(Bytes::new().pack())
        .build();
    let tx = context.complete_tx(tx);

    context.verify_tx(&tx, MAX_CYCLES)
}

// winner=UP, U=200, L=100, rake=0. Burn X=100 UP -> profit 50 -> payout 150.
fn happy_partial() -> Redeem {
    Redeem {
        pool: settled_pool(200 * CKB as u128, 100 * CKB as u128, SIDE_UP, 0),
        burns: vec![(SIDE_UP, 100 * CKB as u128)],
        pool_in_cap: 1_000 * CKB,
        pool_out_cap: 1_000 * CKB - 150 * CKB, // payout 150
    }
}

#[test]
fn redeem_partial_succeeds() {
    assert!(run(happy_partial()).is_ok());
}

#[test]
fn redeem_full_winner_succeeds() {
    // Burn all 200 UP -> profit 100 -> payout 300 (the whole pool, rake 0).
    let r = Redeem {
        pool: settled_pool(200 * CKB as u128, 100 * CKB as u128, SIDE_UP, 0),
        burns: vec![(SIDE_UP, 200 * CKB as u128)],
        pool_in_cap: 1_000 * CKB,
        pool_out_cap: 1_000 * CKB - 300 * CKB,
    };
    assert!(run(r).is_ok());
}

#[test]
fn redeem_with_rake_succeeds() {
    // rake 1% of L=100CKB -> 1CKB; distributable 99CKB; X=100CKB, U=200CKB ->
    // profit = floor(100*99/200) CKB = 49.5 CKB = 4_950_000_000 shannons;
    // payout = 100 CKB + 4_950_000_000 = 14_950_000_000.
    let r = Redeem {
        pool: settled_pool(200 * CKB as u128, 100 * CKB as u128, SIDE_UP, 100),
        burns: vec![(SIDE_UP, 100 * CKB as u128)],
        pool_in_cap: 1_000 * CKB,
        pool_out_cap: 1_000 * CKB - (100 * CKB + 4_950_000_000),
    };
    assert!(run(r).is_ok());
}

#[test]
fn redeem_overpay_fails() {
    let mut r = happy_partial();
    r.pool_out_cap -= 1; // payout one shannon too much
    assert!(run(r).is_err());
}

#[test]
fn redeem_burning_loser_fails() {
    // winner=UP but burner burns DOWN (loser) shares.
    let r = Redeem {
        pool: settled_pool(200 * CKB as u128, 100 * CKB as u128, SIDE_UP, 0),
        burns: vec![(SIDE_DOWN, 100 * CKB as u128)],
        pool_in_cap: 1_000 * CKB,
        pool_out_cap: 1_000 * CKB - 150 * CKB,
    };
    assert!(run(r).is_err());
}

// Regression (sign-flip finding): share accounting must stay unsigned. A REDEEM
// with NO winning-share input but an OUTPUT winning-share cell of `u128::MAX`
// must be rejected. With a `u128 as i128` cast, `u128::MAX` reads as -1, so
// `burned = in - out = 0 - (-1) = 1` would let the tx mint ~2^128 winning shares
// while claiming a 1-unit burn. share_xudt is permissive (PoolCell in inputs), so
// pool_type is the only guard.
#[test]
fn redeem_mint_disguised_as_burn_fails() {
    let mut context = Context::default();
    let pool_out = context.deploy_cell(bin("pool_type"));
    let _share_out = context.deploy_cell(bin("share_xudt"));
    let always_out = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    let lock = context
        .build_script(&always_out, Bytes::new())
        .expect("lock");

    let pool_type_script: Script = context
        .build_script(&pool_out, Bytes::from(vec![0x22u8; 32]))
        .expect("pool_type");
    let own = pool_type_script.calc_script_hash();
    // winner=UP, U=200, L=100, rake=0. Attacker claims payout=1 (x would read as 1).
    let pool = settled_pool(200, 100, SIDE_UP, 0);
    let share_data_hash = pool.share_xudt_code_hash;
    let share_up: Script = {
        let mut args = own.as_slice().to_vec();
        args.push(SIDE_UP);
        Script::new_builder()
            .code_hash(share_data_hash.pack())
            .hash_type(ScriptHashType::Data1)
            .args(Bytes::from(args).pack())
            .build()
    };

    let pool_in_cap: u64 = 1_000 * CKB;
    let pool_out_cap: u64 = 1_000 * CKB - 1; // payout = 1
    let in_cap: Uint64 = pool_in_cap.pack();
    let fund_cap: Uint64 = (300 * CKB).pack();
    let out_cap: Uint64 = pool_out_cap.pack();
    let share_cap: Uint64 = (200 * CKB).pack();

    let pool_in = context.create_cell(
        CellOutput::new_builder()
            .capacity(in_cap)
            .lock(lock.clone())
            .type_(Some(pool_type_script.clone()).pack())
            .build(),
        pool.to_bytes().into(),
    );
    let fund_in = context.create_cell(
        CellOutput::new_builder()
            .capacity(fund_cap)
            .lock(lock.clone())
            .build(),
        Bytes::new(),
    );

    // No winning-share INPUT; instead an OUTPUT UP-share cell of u128::MAX.
    let pool_cell_out = CellOutput::new_builder()
        .capacity(out_cap)
        .lock(lock.clone())
        .type_(Some(pool_type_script).pack())
        .build();
    let mint_out = CellOutput::new_builder()
        .capacity(share_cap)
        .lock(lock.clone())
        .type_(Some(share_up).pack())
        .build();
    let sink_cap: Uint64 = ((pool_in_cap + 300 * CKB) - pool_out_cap - 200 * CKB).pack();
    let sink = CellOutput::new_builder()
        .capacity(sink_cap)
        .lock(lock)
        .build();

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build())
        .input(CellInput::new_builder().previous_output(fund_in).build())
        .output(pool_cell_out)
        .output(mint_out)
        .output(sink)
        .output_data(Bytes::from(pool.to_bytes()).pack())
        .output_data(Bytes::from(u128::MAX.to_le_bytes().to_vec()).pack())
        .output_data(Bytes::new().pack())
        .build();
    let tx = context.complete_tx(tx);
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn void_refund_succeeds() {
    // VOID pool: burn 70 UP + 30 DOWN -> 1:1 refund of 100.
    let r = Redeem {
        pool: settled_pool(200 * CKB as u128, 100 * CKB as u128, WINNER_VOID, 0),
        burns: vec![(SIDE_UP, 70 * CKB as u128), (SIDE_DOWN, 30 * CKB as u128)],
        pool_in_cap: 1_000 * CKB,
        pool_out_cap: 1_000 * CKB - 100 * CKB,
    };
    assert!(run(r).is_ok());
}
