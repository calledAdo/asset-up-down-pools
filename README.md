# CKB Up/Down

A **parimutuel BTC up/down prediction pool** on Nervos CKB, built on top of
[Lean Oracle](../lean_oracle) (a Pyth/Wormhole price oracle). Players stake into the UP or
DOWN side of a timed pool and receive fungible **xUDT share tokens**; the pool is activated
at `start_time` and resolved at `close_time` from authenticated oracle prices, and winners
redeem pro-rata against the losing side — fully on-chain, no custodian, no protocol liquidity.

> Status: on-chain contract layer complete and tested (70 integration tests). Off-chain
> tooling (deployment, SDK, web UI) not built yet. Testnet play-to-earn target.

## Layout

```
ARCHITECTURE.md            system design (source of truth)
docs/
  pool_type-spec.md        PoolCell byte layout + per-transition validation rules
  share_xudt-spec.md       UP/DOWN share token (pool-gated mint/burn)
  timing-spec.md           oracle publish_time contest + grace/void timing
  oracle-lane-spec.md      dedicated oracle-cell lane topology & advancement
DRAFT.md                   original ideation (superseded by ARCHITECTURE.md)
crates/up_down/            Rust workspace
  contracts/
    common/                PoolData layout, oracle decode, constants, errors
    pool_type/             pool state machine (CREATE/DEPOSIT/ACTIVATE/RESOLVE/REDEEM/CLOSE)
    share_xudt/            UP/DOWN xUDT governance (mint gated on PoolCell presence)
    treasury_lock/         xUDT treasury guard (spendable only with PoolCell present)
    pool_admin_lock/       PoolCell lock (continuation / creator-escape)
  tests/                   ckb-testtool integration tests
Makefile                   build / test entry points
```

## Build & test

Requires the Rust `riscv64imac-unknown-none-elf` target (for the contracts) and the host
toolchain (for tests).

```sh
make contracts-build   # compile the four contract binaries (release, RISC-V)
make contracts-test    # run the host + ckb-testtool integration suite
```

`contracts-test` reads the prebuilt binaries from `crates/up_down/target/.../release/`, so
always run `contracts-build` first (or after changing any contract).

## Security model (in brief)

- **Oracle clock:** the whole price phase runs on the oracle's authenticated `publish_time`
  (not the manipulable header timestamp). Activation and resolution are *contests* that
  converge to the first tick after each boundary, so a griefer can only push toward truth.
- **Share supply:** `share_xudt` is permissive whenever its PoolCell is in inputs, so every
  PoolCell-consuming transition that isn't deposit/redeem explicitly freezes supply.
- **Oracle identity:** pinned per-pool by `oracle_commit = H(code_hash ‖ guardian_set_type_hash
  ‖ emitter_chain ‖ emitter_address)`, recomputed from the dep cell.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`docs/`](docs/) for the full design.
