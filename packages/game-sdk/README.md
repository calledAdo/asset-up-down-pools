# ckb-up-down-sdk

TypeScript SDK for the [CKB Up/Down](../../README.md) parimutuel prediction pools.

> **Status: primitives + read layer + transaction layer + clients.** This package
> ships the correctness-critical primitives (codec, oracle commitment, script
> derivation, typeID, payout math), the chain-read layer (pool/share/treasury
> queries), transaction builders + workflows for every pool_type transition, and
> role-split clients. All verified against the Rust contracts; CREATE + read-back
> is VM-verified end-to-end against a live devnet.

## What's here

- **`PoolData` codec** (`encodePoolData` / `decodePoolData`) — a byte-for-byte
  mirror of the Rust `PoolData` layout (CKB = 173 bytes, xUDT = 237). Integer
  fields are `bigint` to match the on-chain u64/u128/i64 ranges. The layout also
  pins the selected share xUDT code hash, and for xUDT pools the selected treasury
  lock code hash. Tested against golden vectors emitted by the Rust source of truth.
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
- **Queries** over a CCC client, built on pure, unit-tested cell classifiers
  (`query/cells`): `getPool(poolId)`; `listPools(filter?)` with
  `{ creator, status, feedId }` (a `creator` switches to an efficient lock-scoped
  search of only your pools); and the pool-keyed share/treasury reads
  `getShareBalances` / `getShareSupply` / `listShareCells` / `getTreasuryBalance`,
  which take a `PoolView` and read the share/asset code from the pool's own data
  (so a pool that pinned a non-default share code still reads correctly). On a
  client, `listManagedPools()` unions `config.operatorLockHashes`.
- **CCC client wiring** (`createClient`, `createPrivateKeySigner`) — self-contained
  (testnet/mainnet/devnet), replicated rather than shared.
- **Constants** mirroring `constants.rs`.
- **Transaction builders** (pure) + **workflows** (client-resolving) for every
  `pool_type` transition — CREATE, DEPOSIT, WITHDRAW, ACTIVATE, CORRECT-START,
  RESOLVE, CORRECT-SETTLE, FINALIZE, REDEEM, CLOSE — for both CKB and xUDT pools. Each
  mirrors the matching `validate_*` and enforces the same preconditions off-chain
  (oracle bands, payout math, status guards) so an invalid transaction never
  assembles. Builders return a **draft with no fee inputs/change** — the caller
  owns its fee policy.
- **Role-split clients**: `PlayerClient` (deposit/withdraw/redeem/burn) and
  `KeeperClient` (create/transitions/close), both over a shared `PoolReaderClient`
  (the reads + a `complete(tx, signer)` helper).
- **Network config** (`PoolNetworkConfig`) built from your deployment artifacts,
  with `configForPoolTypeVersion` to operate on pools under an older code hash.
  For the live offckb devnet, `devnetConfig({ devnetSecp })` returns a ready-made
  config from a bundled script snapshot (copied from `deployment/artifacts`, never
  imported) — supply only the machine-specific `devnetSecp` override.

## Entry points

The package root is a **curated surface** — the stable, consumer-facing API. Lower
layers live behind dedicated subpaths, each a barrel with its own documented
exports (the same shape as `lean-oracle-sdk`):

| Import | What it gives you |
| --- | --- |
| `ckb-up-down-sdk` | role-split clients (`PoolReaderClient`/`PlayerClient`/`KeeperClient`), constants + domain types (`PoolData`, `Script`, …), `PoolData` decode, payout math (`redeemPayout`/`mulDivFloor`), the chain read layer (`getPool`, `listPools`, balances) |
| `ckb-up-down-sdk/presets` | network config authoring (`definePoolNetworkConfig`, `configForPoolTypeVersion`) + bundled presets — only **devnet** (`devnetConfig`) ships bundled; testnet/mainnet are BYO from your own artifacts |
| `ckb-up-down-sdk/tx` | pure tx builders (`build*`), `initiate*` workflows, plumbing (`attach*`, `completeFeeAndChange`, `OracleTick`), staked-asset resolution |
| `ckb-up-down-sdk/ckb` | script derivation, `computeTypeId`, the amount codec, `oracleCommit`, CCC client/signer factories, hex helpers |
| `ckb-up-down-sdk/oracle` | the optional `OracleTick` resolver (the only oracle-integration point) |

Most apps only need the root (a client + constants/types). Drop to `/tx` or `/ckb`
for custom assembly; reach for `/presets` to wire a network.

```ts
import { PlayerClient, SIDE_UP } from "ckb-up-down-sdk";
import { devnetConfig } from "ckb-up-down-sdk/presets";
import { buildWithdrawTx } from "ckb-up-down-sdk/tx";
```

## The "draft, no fees" model

Every builder/workflow returns a structurally complete transaction **without** fee
inputs or a change output, so the caller owns fee policy and signing:

```ts
const tx = await player.draftDeposit({ poolId, depositorLock, upAmount: 100n, downAmount: 0n });
await player.complete(tx, signer, { feeRate: 1000n }); // add inputs + change
await signer.sendTransaction(tx);
```

CLOSE reads "now" from a header dep (the contract's `now_secs`), so the
workflow/`KeeperClient` attaches the chain tip automatically. CREATE,
DEPOSIT/WITHDRAW, and the oracle-driven transitions read no header.

## Staked asset

Pools stake either CKB or an xUDT. You only name the asset at **CREATE**, with a
high-level `asset`:

```ts
keeper.draftCreate({ …, asset: { kind: "ckb" } });           // CKB pool
keeper.draftCreate({ …, asset: { kind: "xudt", args } });    // standard xUDT — type+dep auto-resolved
keeper.draftCreate({ …, asset: { kind: "xudt", type, codeDep } }); // non-standard / devnet override
```

For a standard xUDT the type script and its code dep are resolved from the CCC
client's known scripts; pass an explicit `type`/`codeDep` only for a non-standard
token or a chain CCC can't resolve (e.g. devnet).

**Deposit / redeem / close** read the asset straight off the pool's on-chain
TreasuryCell, so they take no asset type/dep (only `draftDeposit` needs
`assetInputs`, the token cells that fund the stake; all three accept an optional
`assetTypeDep` to override dep resolution).

**The keeper transitions** (activate/correct-start/resolve/correct-settle/finalize)
move no staked asset, so `pool_type` keeps the TreasuryCell out of the transaction
entirely — these drafts touch no treasury or asset at all and are identical for CKB
and xUDT pools: `keeper.draftActivate({ poolId, oracle })`.

## Oracle integration (`ckb-up-down-sdk/oracle`)

The keeper's ACTIVATE/CORRECT/RESOLVE/FINALIZE drafts consume a resolved
`OracleTick`. The SDK core never discovers or decodes an oracle cell — that lives
behind the optional `/oracle` subpath, which is defined **structurally** (no hard
dependency on `lean-oracle-sdk`): a Lean Oracle client satisfies the reader shape.

```ts
import { resolveOracleTick } from "ckb-up-down-sdk/oracle";
import { LeanOracleTestnetClient } from "lean-oracle-sdk";

const tick = await resolveOracleTick(new LeanOracleTestnetClient(), feedId);
const tx = await keeper.draftResolve({ poolId, oracle: tick });
```

## Layout

- `codec/`, `ckb/` — `PoolData` codec, amount codec, oracle commitment, script
  derivation, typeID, CCC client wiring
- `query/` — pool/share/treasury reads over a CCC client
- `tx/` — pure builders + client-resolving workflows + shared plumbing
  (`oracleTick`, `readDeps`, `fees`, `cellCapacity`)
- `client/` — `PoolReaderClient`, `PlayerClient`, `KeeperClient`
- `presets/` — `PoolNetworkConfig` + adapters (no baked-in network constants)
- `oracle/` — the optional `OracleTick` resolver (the only oracle-integration point)
- `payout.ts`, `constants.ts`, `types.ts`

## Install / build / test

```sh
cd packages/game-sdk
npm install
npm test    # builds, then runs the fixtures (codec/script/payout/tx/client checks)
```

Opt-in devnet integration (requires a running offckb devnet with the four scripts
deployed and a funded deployer key in `deployment/.env`):

```sh
npm run test:integration:devnet   # CREATE a pool on-chain, then read it back
```

## Keeping in sync

The codec, `oracleCommit`, and `constants` mirror the Rust `common` crate. If the
on-chain layout, the `oracle_commit` preimage, or any constant changes, update the
matching TS and regenerate the golden vectors.

The SDK is self-contained: it depends only on the Rust contracts (which it
mirrors) and on caller-supplied inputs. Script derivation takes a
`PoolDeployment` (the pinned `data2` code hashes) as a parameter; assembling those
hashes is the caller's responsibility, not the SDK's.
