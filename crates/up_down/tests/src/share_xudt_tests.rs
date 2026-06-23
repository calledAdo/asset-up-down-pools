//! Integration tests for `share_xudt` TRANSFER mode and cross-pool isolation.
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
use up_down_common::constants::SIDE_UP;

const MAX_CYCLES: u64 = 100_000_000;
const CKB: u64 = 100_000_000;

fn bin(name: &str) -> Bytes {
    std::fs::read(format!(
        "../target/riscv64imac-unknown-none-elf/release/{name}"
    ))
    .expect("build contracts first: make contracts-build")
    .into()
}

fn share_script(pool_type_hash: &[u8; 32], side: u8) -> Script {
    let mut args = pool_type_hash.to_vec();
    args.push(side);
    Script::new_builder()
        .code_hash(ckb_testtool::ckb_hash::blake2b_256(bin("share_xudt")).pack())
        .hash_type(ScriptHashType::Data1)
        .args(Bytes::from(args).pack())
        .build()
}

fn amount(a: u128) -> Bytes {
    Bytes::from(a.to_le_bytes().to_vec())
}

#[test]
fn transfer_conserves_supply() {
    let mut context = Context::default();
    context.deploy_cell(bin("share_xudt"));
    let always_out = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    let lock_a = context
        .build_script(&always_out, Bytes::from_static(b"alice"))
        .unwrap();
    let lock_b = context
        .build_script(&always_out, Bytes::from_static(b"bob"))
        .unwrap();

    let pool_hash = [0x22u8; 32];
    let share = share_script(&pool_hash, SIDE_UP);
    let cap: Uint64 = (200 * CKB).pack();
    let amt: u128 = 1_000;

    let share_in = context.create_cell(
        CellOutput::new_builder()
            .capacity(cap.clone())
            .lock(lock_a.clone())
            .type_(Some(share.clone()).pack())
            .build(),
        amount(amt),
    );

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(share_in).build())
        .output(
            CellOutput::new_builder()
                .capacity(cap)
                .lock(lock_b)
                .type_(Some(share).pack())
                .build(),
        )
        .output_data(amount(amt).pack())
        .build();
    let tx = context.complete_tx(tx);
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_ok());
}

#[test]
fn transfer_burn_succeeds() {
    // No PoolCell present: a holder burns their shares (no share output) and
    // reclaims the cell's CKB as a plain cell. Supply only decreases -> allowed.
    let mut context = Context::default();
    context.deploy_cell(bin("share_xudt"));
    let always_out = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    let lock = context.build_script(&always_out, Bytes::new()).unwrap();

    let pool_hash = [0x22u8; 32];
    let share = share_script(&pool_hash, SIDE_UP);
    let cap: Uint64 = (200 * CKB).pack();

    let share_in = context.create_cell(
        CellOutput::new_builder()
            .capacity(cap.clone())
            .lock(lock.clone())
            .type_(Some(share).pack())
            .build(),
        amount(1_000),
    );

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(share_in).build())
        // Plain CKB output (no share type): the burned cell's capacity returns as CKB.
        .output(CellOutput::new_builder().capacity(cap).lock(lock).build())
        .output_data(Bytes::new().pack())
        .build();
    let tx = context.complete_tx(tx);
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_ok());
}

#[test]
fn transfer_supply_increase_fails() {
    let mut context = Context::default();
    context.deploy_cell(bin("share_xudt"));
    let always_out = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    let lock = context.build_script(&always_out, Bytes::new()).unwrap();

    let pool_hash = [0x22u8; 32];
    let share = share_script(&pool_hash, SIDE_UP);
    let cap: Uint64 = (200 * CKB).pack();

    let share_in = context.create_cell(
        CellOutput::new_builder()
            .capacity(cap.clone())
            .lock(lock.clone())
            .type_(Some(share.clone()).pack())
            .build(),
        amount(100),
    );

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(share_in).build())
        .output(
            CellOutput::new_builder()
                .capacity(cap)
                .lock(lock)
                .type_(Some(share).pack())
                .build(),
        )
        .output_data(amount(101).pack()) // mint without PoolCell
        .build();
    let tx = context.complete_tx(tx);
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}

#[test]
fn cross_pool_mint_rejected() {
    // Pool B's UP token must NOT be mintable just because *some other* PoolCell
    // (pool A) is present — `share_xudt` keys on pool B's own type hash. We present
    // an A-stand-in cell whose type hash != pool_b_hash; with no pool-B PoolCell in
    // inputs, share_xudt falls to TRANSFER and rejects the supply increase. The
    // stand-in uses an always-success TYPE so only share_xudt can be the gate that
    // fails (a real pool_type cell would also reject for its own reasons, masking the
    // property under test).
    let mut context = Context::default();
    context.deploy_cell(bin("share_xudt"));
    let pool_out = context.deploy_cell(bin("pool_type"));
    let always_out = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
    let lock = context.build_script(&always_out, Bytes::new()).unwrap();

    // pool_b_hash is a genuine pool_type identity (pool B), absent from inputs.
    let pool_b_hash: [u8; 32] = context
        .build_script(&pool_out, Bytes::from(vec![0xBBu8; 32]))
        .unwrap()
        .calc_script_hash()
        .unpack();
    // "Pool A present" — an unrelated cell whose type hash differs from pool_b_hash.
    let pool_a_stub = context
        .build_script(&always_out, Bytes::from_static(b"poolA"))
        .unwrap();

    let share_b = share_script(&pool_b_hash, SIDE_UP);
    let cap: Uint64 = (200 * CKB).pack();

    let present_in = context.create_cell(
        CellOutput::new_builder()
            .capacity(cap.clone())
            .lock(lock.clone())
            .type_(Some(pool_a_stub).pack())
            .build(),
        Bytes::new(),
    );

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(present_in).build())
        .output(
            CellOutput::new_builder()
                .capacity(cap)
                .lock(lock)
                .type_(Some(share_b).pack())
                .build(),
        )
        .output_data(amount(500).pack()) // mint 500 from nothing → must fail
        .build();
    let tx = context.complete_tx(tx);
    assert!(context.verify_tx(&tx, MAX_CYCLES).is_err());
}
