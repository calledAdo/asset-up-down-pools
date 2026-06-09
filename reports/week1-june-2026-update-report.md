# Builder Track Weekly Report — June 2026 (Week 1)

**Name:** Adokiye
**Project:** CKB Up/Down — asset up/down prediction pools
**Repository:** https://github.com/calledAdo/asset-up-down-pools
**Builds on:** [Lean Oracle](https://github.com/calledAdo/lean-oracle)

> First week of a new project that consumes the Lean Oracle as its price source.
> CKB Up/Down is a **parimutuel asset up/down prediction pool**: players stake into
> an UP or DOWN side, receive fungible xUDT share tokens, and winners redeem
> pro-rata against the losing side — fully on-chain, no custodian, no protocol
> liquidity. Week 1 covered the design and the core contract build.

## ✅ Completed Tasks

### Architecture and specs

- **Design locked in** across `ARCHITECTURE.md` and four spec documents:
  - `pool_type-spec.md` — PoolCell byte layout and per-transition validation rules.
  - `share_xudt-spec.md` — the UP/DOWN share token and its pool-gated mint/burn.
  - `timing-spec.md` — how pool boundaries tie to authenticated oracle prices.
  - `oracle-lane-spec.md` — dedicated oracle-cell lane topology and advancement.
- **Pool/treasury model** chosen over a per-bet-cell sketch: each pool is one
  long-lived **PoolCell** (state) plus, for xUDT pools, one **TreasuryCell** (funds);
  totals are maintained live on every deposit so there is no sum-all-cells step.
- **Two variants, one script set:** a single `variant` byte selects a CKB-native pool
  (the PoolCell's own capacity is the treasury) or an xUDT pool (a separate
  TreasuryCell holds the staked asset). Fixed at creation, immutable after.
- **Slim-data decisions:** `pool_id` lives in the type-script args (the typeID), not
  in cell data; the UP/DOWN share-token identities are **derived** on-chain from the
  pool's own type hash + side, not stored — keeping `PoolData` minimal.

### Shared crate (`common`)

- **`PoolData` codec** — manual little-endian, variant-led layout (the `variant` byte
  decides whether `asset_type_hash` is present), with round-trip tests.
- **Lean Oracle cell decoder** (`oracle_read`) — reads the few fields the pool needs
  from the oracle's fixed 152-byte layout by their offsets, without depending on the
  oracle crate.
- **Constants and errors** — status/side enums, the `grace` function, the pinned
  external code hashes, and a centralized `i8` error table.

### `pool_type` — core state machine (CKB + xUDT)

- **Script-group routing:** `(0,1)` = CREATE, `(1,1)` = transition, `(1,0)` = CLOSE.
- **CREATE** — validates a fresh OPEN pool and the typeID seed
  (`blake2b(first_input, output_index)`, mirroring the standard Type ID script).
- **DEPOSIT** — funds conservation (CKB capacity delta or xUDT treasury delta equals
  the staked total), with a single deposit able to buy **both** UP and DOWN at once,
  and each side's minted shares pinned to that side's total delta.
- **ACTIVATE / RESOLVE** — read the trusted oracle as a CellDep to record the start
  and settle prices.
- **REDEEM** — parimutuel payout `X + floor(X × (loser − rake) / winner)`, with rake
  on the losing pool and 1:1 refunds on VOID / tie.
- **CLOSE** — terminal sweep of a finished pool after a teardown grace.

### The other three scripts

- **`share_xudt`** — UP/DOWN fungible tokens (xUDT-data compatible). Supply may change
  only when the owning PoolCell is in inputs; otherwise it conserves like standard
  xUDT, so positions trade freely. The binding to `pool_type` is **non-circular**
  (the token carries the pool's hash as data; only the pool hardcodes the token code
  hash), so the scripts are deployable without a cycle.
- **`treasury_lock`** — a thin guard: the xUDT treasury is spendable only in a tx that
  also consumes its PoolCell. All value logic stays in `pool_type`.
- **`pool_admin_lock`** — the PoolCell lock: permissionless on continuation (anyone
  can drive a valid transition) plus a creator-escape path for terminal CLOSE.

### First integration test suite

- A `ckb-testtool` harness running against the real RISC-V binaries, with initial
  coverage of CREATE, DEPOSIT (CKB + xUDT), ACTIVATE, RESOLVE, REDEEM, and CLOSE.

---

## 📚 Key Learning Areas

### 1. Deriving identities keeps state slim and avoids cycles

Storing the UP/DOWN token args in `PoolData` would have been redundant: each token's
type is a pure function of the pool's immutable typeID + side + the pinned
`share_xudt` code hash. Deriving it on-chain shrinks the cell and, crucially, keeps
the pool↔token binding one-directional (deployable without a code-hash cycle).

### 2. One script set for two fund models

Unifying CKB-native and xUDT pools behind a single `variant` byte meant the state
machine could be written once. The only branch is *where funds live*: the PoolCell's
own capacity (CKB) versus a separate `treasury_lock`-guarded TreasuryCell (xUDT).

### 3. The `ckb-testtool` hash-pinning gotcha

`context.build_script()` returns a context-dependent type-id as the code hash — not
the binary's data hash. Any script the pool pins by code hash (i.e. `share_xudt`)
must be built manually with `hash_type = Data1` and
`code_hash = blake2b_256(binary)`, or the derived-identity checks won't line up.

---

## 🛑 Constraints / Risks Acknowledged

- **Oracle reference identity still being hardened.** Week 1 located and pinned the
  oracle, but verifying that the dep cell is the *real* one (right guardians + Pyth
  source, not just the right type) is still open.
- **Pinned to the testnet oracle v2 deployment** (`oracle_type` v2 code hash,
  BTC/USD feed) — testnet, unaudited.
- **Single-PoolCell serialization** — deposits/redeems on one pool serialize to one
  tx per block. Accepted tradeoff (buys live totals); scaling path is an
  intent + solver batch model, later.

---

## 🔜 Next Steps

- Harden the oracle reference into a single tamper-evident commitment.
- Replace the first-pass price boundary with a robust, griefing-resistant timing
  model.
- A thorough security audit of the share-token gate and the state machine.
- Grow the integration suite toward full branch coverage.

---

## 🧪 Commands / checks (typical for this week)

```bash
# Compile the four contract binaries (release, RISC-V)
make contracts-build

# Run the host + ckb-testtool integration suite
make contracts-test
```
