//! `ckb-testtool` integration tests for the xUDT variant: DEPOSIT and REDEEM
//! against a real TreasuryCell guarded by `treasury_lock`.
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
const START: u64 = 1_000_000;

fn bin(name: &str) -> Bytes {
    std::fs::read(format!(
        "../target/riscv64imac-unknown-none-elf/release/{name}"
    ))
    .expect("build contracts first: make contracts-build")
    .into()
}

fn amount(a: u128) -> Bytes {
    Bytes::from(a.to_le_bytes().to_vec())
}

/// Shared fixtures for an xUDT-variant pool test.
struct Env {
    context: Context,
    lock: Script,         // always-success (cells' generic lock)
    pool_type: Script,    // pool_type with a fixed pool_id arg
    own: [u8; 32],        // pool_type script hash
    asset_type: Script,   // the staked xUDT's type (always-success as type)
    treasury_lock: Script,
    share_code: [u8; 32],
}

impl Env {
    fn new() -> Self {
        let mut context = Context::default();
        let pool_out = context.deploy_cell(bin("pool_type"));
        let always_out = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());

        let lock = context.build_script(&always_out, Bytes::new()).unwrap();
        let pool_type = context
            .build_script(&pool_out, Bytes::from(vec![0x22u8; 32]))
            .unwrap();
        let own: [u8; 32] = pool_type.calc_script_hash().unpack();
        let asset_type = context
            .build_script(&always_out, Bytes::from_static(b"asset"))
            .unwrap();

        let tl_code = ckb_testtool::ckb_hash::blake2b_256(bin("treasury_lock"));
        let treasury_lock = Script::new_builder()
            .code_hash(tl_code.pack())
            .hash_type(ScriptHashType::Data1)
            .args(Bytes::from(own.to_vec()).pack())
            .build();
        let share_code = ckb_testtool::ckb_hash::blake2b_256(bin("share_xudt"));

        // deploy treasury_lock + share_xudt code so deps resolve.
        context.deploy_cell(bin("treasury_lock"));
        context.deploy_cell(bin("share_xudt"));

        Env {
            context,
            lock,
            pool_type,
            own,
            asset_type,
            treasury_lock,
            share_code,
        }
    }

    fn asset_hash(&self) -> [u8; 32] {
        self.asset_type.calc_script_hash().unpack()
    }

    fn share(&self, side: u8) -> Script {
        let mut args = self.own.to_vec();
        args.push(side);
        Script::new_builder()
            .code_hash(self.share_code.pack())
            .hash_type(ScriptHashType::Data1)
            .args(Bytes::from(args).pack())
            .build()
    }

    fn cap(&self, c: u64) -> Uint64 {
        c.pack()
    }
}

fn xudt_pool(asset: [u8; 32], up: u128, down: u128, status: u8, winner: u8) -> PoolData {
    PoolData {
        variant: VARIANT_XUDT,
        asset_type_hash: Some(asset),
        feed_id: [0x11; 32],
        oracle_commit: up_down_common::oracle_read::oracle_commit(
            &ORACLE_TYPE_CODE_HASH, &GUARDIAN_SET_TYPE_HASH, PYTH_EMITTER_CHAIN, &PYTH_EMITTER_ADDRESS,
        ),
        start_time: START,
        close_time: START + 900,
        up_total: up,
        down_total: down,
        start_price: 50_000,
        settle_price: if winner == SIDE_UP { 60_000 } else { 40_000 },
        used_pt: 1_000_905,
        rake_bps: 0,
        status,
        winner,
    }
}

#[test]
fn xudt_deposit_succeeds() {
    let mut e = Env::new();
    let asset = e.asset_hash();
    let d: u128 = 100;

    let prev = xudt_pool(asset, 100, 50, STATUS_OPEN, SIDE_UNDECIDED);
    let next = xudt_pool(asset, 200, 50, STATUS_OPEN, SIDE_UNDECIDED); // +100 UP

    let pool_cap = e.cap(200 * CKB);
    let tre_cap = e.cap(200 * CKB);

    // Inputs: PoolCell, TreasuryCell(=100), depositor asset(=100), funding.
    let pool_in = e.context.create_cell(
        CellOutput::new_builder()
            .capacity(pool_cap.clone())
            .lock(e.lock.clone())
            .type_(Some(e.pool_type.clone()).pack())
            .build(),
        prev.to_bytes().into(),
    );
    let tre_in = e.context.create_cell(
        CellOutput::new_builder()
            .capacity(tre_cap.clone())
            .lock(e.treasury_lock.clone())
            .type_(Some(e.asset_type.clone()).pack())
            .build(),
        amount(100),
    );
    let dep_in = e.context.create_cell(
        CellOutput::new_builder()
            .capacity(e.cap(200 * CKB))
            .lock(e.lock.clone())
            .type_(Some(e.asset_type.clone()).pack())
            .build(),
        amount(d),
    );
    let fund_in = e.context.create_cell(
        CellOutput::new_builder()
            .capacity(e.cap(200 * CKB))
            .lock(e.lock.clone())
            .build(),
        Bytes::new(),
    );

    // Outputs: PoolCell, TreasuryCell(=200), share(UP,100), change.
    let pool_o = CellOutput::new_builder()
        .capacity(pool_cap)
        .lock(e.lock.clone())
        .type_(Some(e.pool_type.clone()).pack())
        .build();
    let tre_o = CellOutput::new_builder()
        .capacity(tre_cap)
        .lock(e.treasury_lock.clone())
        .type_(Some(e.asset_type.clone()).pack())
        .build();
    let share_o = CellOutput::new_builder()
        .capacity(e.cap(200 * CKB))
        .lock(e.lock.clone())
        .type_(Some(e.share(SIDE_UP)).pack())
        .build();
    let change_o = CellOutput::new_builder()
        .capacity(e.cap(200 * CKB))
        .lock(e.lock.clone())
        .build();

    let ts: Uint64 = ((START - 100) * 1000).pack();
    let header = HeaderBuilder::default().timestamp(ts).build();
    e.context.insert_header(header.clone());

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build())
        .input(CellInput::new_builder().previous_output(tre_in).build())
        .input(CellInput::new_builder().previous_output(dep_in).build())
        .input(CellInput::new_builder().previous_output(fund_in).build())
        .output(pool_o)
        .output(tre_o)
        .output(share_o)
        .output(change_o)
        .output_data(Bytes::from(next.to_bytes()).pack())
        .output_data(amount(200).pack())
        .output_data(amount(d).pack())
        .output_data(Bytes::new().pack())
        .header_dep(header.hash())
        .build();
    let tx = e.context.complete_tx(tx);
    assert!(e.context.verify_tx(&tx, MAX_CYCLES).is_ok());
}

#[test]
fn xudt_redeem_succeeds() {
    let mut e = Env::new();
    let asset = e.asset_hash();
    // winner=UP, U=200, L=100, rake=0; burn X=100 -> profit 50 -> payout 150.
    let pool = xudt_pool(asset, 200, 100, STATUS_FINALIZED, SIDE_UP);

    let pool_cap = e.cap(200 * CKB);
    let tre_cap = e.cap(200 * CKB);

    let pool_in = e.context.create_cell(
        CellOutput::new_builder()
            .capacity(pool_cap.clone())
            .lock(e.lock.clone())
            .type_(Some(e.pool_type.clone()).pack())
            .build(),
        pool.to_bytes().into(),
    );
    let tre_in = e.context.create_cell(
        CellOutput::new_builder()
            .capacity(tre_cap.clone())
            .lock(e.treasury_lock.clone())
            .type_(Some(e.asset_type.clone()).pack())
            .build(),
        amount(300), // U+L
    );
    let share_in = e.context.create_cell(
        CellOutput::new_builder()
            .capacity(e.cap(200 * CKB))
            .lock(e.lock.clone())
            .type_(Some(e.share(SIDE_UP)).pack())
            .build(),
        amount(100),
    );

    let pool_o = CellOutput::new_builder()
        .capacity(pool_cap)
        .lock(e.lock.clone())
        .type_(Some(e.pool_type.clone()).pack())
        .build();
    let tre_o = CellOutput::new_builder()
        .capacity(tre_cap)
        .lock(e.treasury_lock.clone())
        .type_(Some(e.asset_type.clone()).pack())
        .build();
    let payout_o = CellOutput::new_builder()
        .capacity(e.cap(200 * CKB))
        .lock(e.lock.clone())
        .type_(Some(e.asset_type.clone()).pack())
        .build();

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build())
        .input(CellInput::new_builder().previous_output(tre_in).build())
        .input(CellInput::new_builder().previous_output(share_in).build())
        .output(pool_o)
        .output(tre_o)
        .output(payout_o)
        .output_data(Bytes::from(pool.to_bytes()).pack())
        .output_data(amount(150).pack()) // 300 - 150
        .output_data(amount(150).pack()) // payout
        .build();
    let tx = e.context.complete_tx(tx);
    assert!(e.context.verify_tx(&tx, MAX_CYCLES).is_ok());
}

#[test]
fn xudt_deposit_wrong_asset_type_fails() {
    let mut e = Env::new();
    let asset = e.asset_hash();
    let always = e
        .context
        .deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    let wrong_asset = e
        .context
        .build_script(&always, Bytes::from_static(b"wrong"))
        .unwrap();
    let d: u128 = 100;
    let prev = xudt_pool(asset, 100, 50, STATUS_OPEN, SIDE_UNDECIDED);
    let next = xudt_pool(asset, 200, 50, STATUS_OPEN, SIDE_UNDECIDED);

    let pool_cap = e.cap(200 * CKB);
    let tre_cap = e.cap(200 * CKB);

    let pool_in = e.context.create_cell(
        CellOutput::new_builder()
            .capacity(pool_cap.clone())
            .lock(e.lock.clone())
            .type_(Some(e.pool_type.clone()).pack())
            .build(),
        prev.to_bytes().into(),
    );
    let tre_in = e.context.create_cell(
        CellOutput::new_builder()
            .capacity(tre_cap.clone())
            .lock(e.treasury_lock.clone())
            .type_(Some(e.asset_type.clone()).pack())
            .build(),
        amount(100),
    );
    // Depositor brings the wrong xUDT type; treasury is bumped but net depositor
    // outflow of the *configured* asset is zero.
    let dep_in = e.context.create_cell(
        CellOutput::new_builder()
            .capacity(e.cap(200 * CKB))
            .lock(e.lock.clone())
            .type_(Some(wrong_asset).pack())
            .build(),
        amount(d),
    );
    let fund_in = e.context.create_cell(
        CellOutput::new_builder()
            .capacity(e.cap(200 * CKB))
            .lock(e.lock.clone())
            .build(),
        Bytes::new(),
    );

    let pool_o = CellOutput::new_builder()
        .capacity(pool_cap)
        .lock(e.lock.clone())
        .type_(Some(e.pool_type.clone()).pack())
        .build();
    let tre_o = CellOutput::new_builder()
        .capacity(tre_cap)
        .lock(e.treasury_lock.clone())
        .type_(Some(e.asset_type.clone()).pack())
        .build();
    let share_o = CellOutput::new_builder()
        .capacity(e.cap(200 * CKB))
        .lock(e.lock.clone())
        .type_(Some(e.share(SIDE_UP)).pack())
        .build();
    let change_o = CellOutput::new_builder()
        .capacity(e.cap(200 * CKB))
        .lock(e.lock.clone())
        .build();

    let ts: Uint64 = ((START - 100) * 1000).pack();
    let header = HeaderBuilder::default().timestamp(ts).build();
    e.context.insert_header(header.clone());

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build())
        .input(CellInput::new_builder().previous_output(tre_in).build())
        .input(CellInput::new_builder().previous_output(dep_in).build())
        .input(CellInput::new_builder().previous_output(fund_in).build())
        .output(pool_o)
        .output(tre_o)
        .output(share_o)
        .output(change_o)
        .output_data(Bytes::from(next.to_bytes()).pack())
        .output_data(amount(200).pack())
        .output_data(amount(d).pack())
        .output_data(Bytes::new().pack())
        .header_dep(header.hash())
        .build();
    let tx = e.context.complete_tx(tx);
    assert!(e.context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn xudt_redeem_treasury_overdraw_fails() {
    let mut e = Env::new();
    let asset = e.asset_hash();
    let pool = xudt_pool(asset, 200, 100, STATUS_FINALIZED, SIDE_UP);
    let pool_cap = e.cap(200 * CKB);
    let tre_cap = e.cap(200 * CKB);

    let pool_in = e.context.create_cell(
        CellOutput::new_builder()
            .capacity(pool_cap.clone())
            .lock(e.lock.clone())
            .type_(Some(e.pool_type.clone()).pack())
            .build(),
        pool.to_bytes().into(),
    );
    let tre_in = e.context.create_cell(
        CellOutput::new_builder()
            .capacity(tre_cap.clone())
            .lock(e.treasury_lock.clone())
            .type_(Some(e.asset_type.clone()).pack())
            .build(),
        amount(300),
    );
    let share_in = e.context.create_cell(
        CellOutput::new_builder()
            .capacity(e.cap(200 * CKB))
            .lock(e.lock.clone())
            .type_(Some(e.share(SIDE_UP)).pack())
            .build(),
        amount(100),
    );

    let pool_o = CellOutput::new_builder()
        .capacity(pool_cap)
        .lock(e.lock.clone())
        .type_(Some(e.pool_type.clone()).pack())
        .build();
    let tre_o = CellOutput::new_builder()
        .capacity(tre_cap)
        .lock(e.treasury_lock.clone())
        .type_(Some(e.asset_type.clone()).pack())
        .build();
    let payout_o = CellOutput::new_builder()
        .capacity(e.cap(200 * CKB))
        .lock(e.lock.clone())
        .type_(Some(e.asset_type.clone()).pack())
        .build();

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(pool_in).build())
        .input(CellInput::new_builder().previous_output(tre_in).build())
        .input(CellInput::new_builder().previous_output(share_in).build())
        .output(pool_o)
        .output(tre_o)
        .output(payout_o)
        .output_data(Bytes::from(pool.to_bytes()).pack())
        .output_data(amount(100).pack()) // drained 200 (too much, payout should be 150)
        .output_data(amount(200).pack())
        .build();
    let tx = e.context.complete_tx(tx);
    assert!(e.context.verify_tx(&tx, MAX_CYCLES).is_err());
}
