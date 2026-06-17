# ckb-up-down-sdk

TypeScript SDK for the [CKB Up/Down](../../README.md) parimutuel prediction pools.

> **Status: primitives + read layer.** This package ships the correctness-critical
> primitives (codec, oracle commitment, script derivation, typeID, payout math)
> and the chain-read layer (pool/share/treasury queries), all verified against the
> Rust contracts. Transaction builders are next (assembled and VM-verified against
> a devnet).

## What's here

- **`PoolData` codec** (`encodePoolData` / `decodePoolData`) — a byte-for-byte
  mirror of the Rust `PoolData` layout (CKB = 141 bytes, xUDT = 173). Integer
  fields are `bigint` to match the on-chain u64/u128/i64 ranges. Tested against
  golden vectors emitted by the Rust source of truth.
- **`oracleCommit`** — recomputes `H(code_hash ‖ guardian_set_type_hash ‖
  emitter_chain_le ‖ emitter_address)` (CKB blake2b), the per-pool oracle pin.
- **Script derivation** (`poolTypeScript`, `shareScript`, `treasuryLockScript`,
  `poolAdminLockScript`) — the PoolCell type, the derived UP/DOWN share tokens
  (`args = pool_type_hash ‖ side`), the xUDT TreasuryCell lock, and the PoolCell
  admin lock (`args = creator_lock_hash`). All `data2`.
- **`computeTypeId`** — the `pool_id` seed `blake2b_ckb(first_input ‖ index_le8)`,
  mirroring the standard Type ID rule the contract enforces.
- **`redeemPayout` / `mulDivFloor`** — the parimutuel payout
  (`x + floor(x·(loser − rake)/winner)`, rake on the losing pool, 1:1 refund on
  VOID/tie), a faithful mirror of `validate_redeem`. Tested with vectors.
- **`encodeAmount` / `decodeAmount`** — the xUDT-style u128 LE cell-data amount
  (share + treasury cells).
- **Queries** (`getPool`, `listPools`, `getShareBalances`, `getTreasuryBalance`)
  over a CCC client, built on pure, unit-tested cell classifiers (`query/cells`).
- **CCC client wiring** (`createClient`, `createPrivateKeySigner`) — self-contained
  (testnet/mainnet/devnet), replicated rather than shared.
- **Constants** mirroring `constants.rs`.

## Install / build / test

```sh
cd packages/game-sdk
npm install
npm test    # builds, then runs the byte-exact fixtures against the Rust vectors
```

## Keeping in sync

The codec, `oracleCommit`, and `constants` mirror the Rust `common` crate. If the
on-chain layout, the `oracle_commit` preimage, or any constant changes, update the
matching TS and regenerate the golden vectors.

The SDK is self-contained: it depends only on the Rust contracts (which it
mirrors) and on caller-supplied inputs. Script derivation takes a
`PoolDeployment` (the pinned `data2` code hashes) as a parameter; assembling those
hashes is the caller's responsibility, not the SDK's.
