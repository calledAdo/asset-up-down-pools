# Builder Track Weekly Report — June 2026 (Week 4)

**Name:** Adokiye
**Project:** CKB Up/Down — asset up/down prediction pools
**Repository:** https://github.com/calledAdo/asset-up-down-pools
**Builds on:** [Lean Oracle](https://github.com/calledAdo/lean-oracle)

> Week 4 built the **game SDK** (`packages/game-sdk`): a TypeScript package that
> mirrors the on-chain pool layout, derives every script identity, reads pool/share
> state, and assembles unsigned transactions for the player and keeper flows. This
> report covers the SDK only.

## ✅ Completed Tasks

### Package scaffold and public API

- Created `ckb-up-down-sdk`, a self-contained TypeScript package under
  `packages/game-sdk`, with CCC as the only runtime dependency.
- Split the package into a curated root export plus focused subpaths:
  - `ckb-up-down-sdk` — stable consumer API: clients, constants, domain types,
    pool decoding, payout math, and read helpers.
  - `ckb-up-down-sdk/presets` — network config helpers and the bundled devnet
    preset.
  - `ckb-up-down-sdk/tx` — pure transaction builders and workflow helpers.
  - `ckb-up-down-sdk/ckb` — script derivation, typeID, codecs, client/signer
    factories, and oracle commitment helpers.
  - `ckb-up-down-sdk/oracle` — the optional oracle tick resolver interface.
- Added a role-split client layer: `PoolReaderClient` for reads and completion,
  `PlayerClient` for deposit/withdraw/redeem/burn drafts, and `KeeperClient` for
  create/transition/close drafts.

### Contract-mirroring primitives

- Implemented the `PoolData` codec as a byte-for-byte mirror of the Rust layout
  for both CKB and xUDT pools, including the selected share xUDT code hash and,
  for xUDT pools, the selected treasury lock code hash.
- Added the same `oracle_commit` calculation used by the contracts:
  `H(code_hash ‖ guardian_set_type_hash ‖ emitter_chain_le ‖ emitter_address)`.
- Added script derivation helpers for the PoolCell type, UP/DOWN share tokens,
  treasury lock, and pool admin lock, all using the configured `data2` deployment
  identities.
- Added `computeTypeId`, xUDT amount encode/decode helpers, constants mirrored
  from the Rust code, and `redeemPayout` / `mulDivFloor` for the parimutuel payout
  formula.

### Chain read layer

- Added pool queries over a CCC client: `getPool(poolId)` and `listPools(filter?)`
  with filters for creator, status, and feed id.
- Added pool-keyed share and treasury reads:
  `getShareBalances`, `getShareSupply`, `listShareCells`, and
  `getTreasuryBalance`.
- Made the read layer derive share and asset identities from each pool's own
  on-chain data instead of assuming the deployment defaults. This keeps reads
  correct for pools pinned to older or non-default script versions.
- Added `operatorLockHashes` support to network config so an operator can list
  only the pools it manages, instead of scanning every permissionless pool.

### Transaction builders and workflows

- Added pure builders plus client-resolving workflows for the full pool lifecycle:
  CREATE, DEPOSIT, WITHDRAW, ACTIVATE, CORRECT-START, RESOLVE, CORRECT-SETTLE,
  FINALIZE, REDEEM, CLOSE, and losing-share BURN.
- Kept the builder model as **draft transactions with no fee inputs/change**. The
  SDK assembles the contract-relevant transaction shape; the caller's signer owns
  fee selection, change, signing, and broadcast.
- Added CKB and xUDT support across the transaction layer, including asset
  resolution for standard xUDT pools and explicit override hooks for devnet or
  non-standard tokens.
- Added off-chain precondition checks that mirror contract expectations, including
  status guards, oracle tick-band validation, pool asset checks, and payout math.
- Updated DEPOSIT to match the newer contract rule that deposits are status-gated
  and do not read a header. CLOSE remains the transition that attaches a tip
  header because it reads chain time.

### Devnet config and integration surface

- Added `PoolNetworkConfig`, `definePoolNetworkConfig`, and
  `configForPoolTypeVersion` so callers can operate against explicit deployment
  artifacts and older pool-type versions.
- Added a bundled `devnetConfig` preset copied from local deployment artifacts,
  while keeping testnet/mainnet config BYO until real deployments exist.
- Added optional Lean Oracle compatibility through a structural `OracleTick`
  resolver, without hard-coupling the SDK root to `lean-oracle-sdk`.

### Tests

- Added fixture coverage for the codec, oracle commitment, script derivation,
  payout math, cell classifiers, transaction plumbing, transaction builders,
  keeper transitions, client API shape, oracle adapter, and asset resolution.
- Added opt-in devnet integration scaffolding for CREATE + read-back and full
  lifecycle testing when a local offckb devnet is running with deployed scripts.

---

## 📚 Key Learning Areas

### 1. The SDK must mirror the contract, not reinterpret it

The safest SDK surface is a close off-chain reflection of the on-chain rules:
same byte layout, same script identities, same payout formula, same transition
preconditions. That keeps SDK failures early and local instead of turning into
rejected CKB transactions.

### 2. Root exports should stay stable; low-level power belongs in subpaths

Most consumers need clients, reads, constants, and payout helpers. Builders,
script plumbing, config authoring, and oracle wiring are still available, but they
live behind explicit subpaths. This keeps the package usable for applications
without hiding the lower-level tools needed by operators and custom integrations.

### 3. Reads should be pool-keyed, not deployment-default-keyed

A pool carries the script identities it was created with. Reading shares or assets
from deployment defaults can silently misread older or non-default pools. The SDK
therefore treats the PoolCell data as the source of truth for follow-up reads.

---

## 🛑 Constraints / Risks Acknowledged

- **No public testnet/mainnet preset yet.** The preset shape exists, but real
  testnet/mainnet values must come from actual promoted deployments.
- **Devnet preset is a local snapshot.** It should be refreshed after the next
  devnet redeploy so code hashes stay aligned with the current contract binaries.
- **Transactions are unsigned drafts.** This is deliberate: wallets or operator
  signers still need to add fees/change, sign, and broadcast.
- **Oracle discovery remains external.** The SDK accepts a resolved `OracleTick`;
  a keeper or oracle adapter is responsible for locating and validating the live
  oracle cell.

---

## 🔜 Next Steps (carried into Week 5+)

- Run and publish a real testnet deployment, then add testnet/mainnet presets from
  canonical artifacts.
- Refresh the bundled devnet preset after the next devnet redeploy.
- Keep the SDK package internal until the integrator-facing API is stable enough
  to publish publicly.
- Wire application/backend consumers against the SDK's role-split clients and
  transaction draft model.

---

## 🧪 Commands / checks (typical for this week)

```bash
cd packages/game-sdk
npm install
npm run typecheck
npm test

# Optional, with local offckb devnet + deployment/.env configured:
npm run test:integration:devnet
```
