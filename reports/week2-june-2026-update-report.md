# Builder Track Weekly Report — June 2026 (Week 2)

**Name:** Adokiye
**Project:** CKB Up/Down — asset up/down prediction pools
**Repository:** https://github.com/calledAdo/asset-up-down-pools
**Builds on:** [Lean Oracle](https://github.com/calledAdo/lean-oracle)

> First reporting week for a new project. CKB Up/Down is a **parimutuel asset
> up/down prediction pool** that consumes the Lean Oracle as its price source.
> This week took it from a blank idea to a complete, tested on-chain contract
> layer in its own public repository.

## ✅ Completed Tasks

### Repository, architecture, and specs

- **New project repo** (`asset-up-down-pools`) scaffolded as a Rust workspace that
  mirrors the Lean Oracle layout (`crates/up_down/`, shared `common/` crate, one
  crate per script, `ckb-testtool` integration tests, a `Makefile`).
- **Design locked in** across `ARCHITECTURE.md` + four spec docs:
  - `pool_type-spec.md` — PoolCell byte layout (CKB 141 / xUDT 173 bytes) and the
    per-transition validation rules.
  - `share_xudt-spec.md` — the UP/DOWN share token and its pool-gated mint/burn.
  - `timing-spec.md` — the oracle `publish_time` contest and grace/void timing.
  - `oracle-lane-spec.md` — dedicated oracle-cell lane topology and advancement.
- **Two-variant model** settled: a single `variant` byte selects CKB-native pools
  (the PoolCell's own capacity is the treasury) vs xUDT pools (a separate
  `TreasuryCell` guarded by `treasury_lock`), so one script set serves both.

### On-chain contract layer (Rust / RISC-V)

Four CKB scripts plus a shared crate, all building clean:

- **`pool_type`** — the pool state machine: `CREATE → DEPOSIT → ACTIVATE →
  (CORRECT-start) → RESOLVE → (CORRECT-settle) → FINALIZE → REDEEM → CLOSE`, with
  `VOID` refund branches. Enforces funds conservation, parimutuel payout math
  (`payout = X + floor(X × (loser − rake) / winner)`), share-supply invariants, and
  the oracle boundary proofs.
- **`share_xudt`** — UP/DOWN fungible share tokens (xUDT-data compatible). Supply
  may change only when the owning PoolCell is in inputs; otherwise it conserves like
  standard xUDT, so positions trade freely on a secondary market.
- **`treasury_lock`** — thin guard: the xUDT treasury is spendable only in a tx that
  also consumes its PoolCell.
- **`pool_admin_lock`** — the PoolCell lock: permissionless on continuation (anyone
  can drive a valid transition) and a creator-escape path for terminal CLOSE.
- **`common`** — `PoolData` codec, the minimal Lean Oracle cell decoder, constants,
  the grace function, and the error table.

### Oracle `publish_time` contest (the core novelty)

- The entire price phase runs on the oracle's **authenticated `publish_time`**, not
  the (backward-manipulable) header timestamp. Both the **start** and **settle**
  prices are *contests*: a provisional value can be replaced only by a strictly
  **earlier** authentic tick, so the recorded price converges to the first tick after
  each boundary and a griefer can only push *toward* the truth.
- `FINALIZE` latches the result once an authentic tick proves `publish_time ≥
  void_time` (`void_time = close_time + grace`, `grace = clamp(duration/10, 60s,
  600s)`), so a late correction can never flip the winner after payouts begin.

### Security hardening

- **Share-supply freeze** — closed a critical gap: because `share_xudt` is permissive
  whenever its PoolCell is present, every PoolCell-consuming transition that isn't a
  deposit/redeem (ACTIVATE/CORRECT/RESOLVE/FINALIZE/CLOSE) now explicitly pins
  `net_minted(UP) == net_minted(DOWN) == 0`. Without it, a resolver — who already
  knows the public winning price — could mint winning shares from nothing and drain
  the treasury.
- **Oracle trust-root commitment** — the pool pins its oracle by
  `oracle_commit = H(code_hash ‖ guardian_set_type_hash ‖ emitter_chain ‖
  emitter_address)`, recomputed from the dep cell. The bare type script is shared by
  every oracle cell of a feed (forgeable); the commitment binds the real Wormhole
  guardians + Pyth source.
- **Creation-forgery defense** — identified that Lean Oracle's cell *creation* did
  not authenticate price, so a commit-matching cell could carry a fabricated price.
  Drove a Lean Oracle **v3 zero-init-at-creation** change (committed on a branch in
  the oracle repo; not yet built/deployed) so a nonzero `publish_time` ⟹ the price
  was VAA-verified.

### Tests, repo init, and an external audit pass

- **70 `ckb-testtool` integration tests** passing against the real RISC-V binaries —
  covering CREATE (incl. time bounds), DEPOSIT (CKB + xUDT, dual-side, wrong-asset
  rejection), ACTIVATE + CORRECT-start, RESOLVE/CORRECT/FINALIZE/VOID, REDEEM (incl.
  rake and 1:1 refunds), CLOSE (incl. the real `pool_admin_lock` creator path),
  `share_xudt` transfer + cross-pool isolation, and `PoolData` round-trips.
- **Acted on an external audit:** added CREATE future-boundary checks, a
  defense-in-depth xUDT depositor asset-type check, and the previously-missing
  `pool_admin_lock` and `share_xudt` transfer tests; reconciled spec/implementation
  drift.
- **Git initialized and pushed** to a new public repo with a `.gitignore` that keeps
  `target/` (1.5 GB of artifacts), `.claude/`, and any keys/`.env` out of history,
  while tracking `Cargo.lock` for reproducible on-chain code hashes.

---

## 📚 Key Learning Areas

### 1. Header time is backward-manipulable; oracle time is not

A CKB tx author chooses the header dep, so a header `now` can be set *earlier* than
real time but never later. That makes any "before T" upper bound unenforceable and
any "after T" lower bound safe. The fix that unlocked the whole price phase: use the
oracle's signed `publish_time` as the clock — a tick at time `T` proves real time
`≥ T` because Pyth cannot sign the future. The one residual exception (the DEPOSIT
`now < start_time` cutoff) is therefore handled as a liveness assumption, not an
on-chain guarantee.

### 2. A contest beats both the strict straddle and the one-shot band

An earlier design pinned the price with a strict straddle (`prev < boundary ≤ pub`),
but under a permissionless oracle lock a loser could advance the monotonic cell one
tick past close to force a VOID. A plain price band fixed the griefing but reintroduced
cherry-picking. The **monotone-down contest** gets both: corrections only move toward
the canonical first post-boundary tick, so there is nothing to grief and nothing to
cherry-pick.

### 3. A permissive token gate pushes all supply control upstream

`share_xudt` deliberately returns success whenever its PoolCell is present. That keeps
the token script tiny and auditable, but it makes a single global invariant
load-bearing: **every** PoolCell-consuming transition must account for **every** share
movement of both sides. Discovering and codifying that invariant (and freezing supply
on the non-trading transitions) was the most important safety lesson of the week.

---

## 🛑 Constraints / Risks Acknowledged

- **DEPOSIT cutoff is a liveness assumption.** `now < start_time` uses header time,
  which is bypassable; the real cutoff is prompt permissionless `ACTIVATE` at
  `start_time`. Proving `now ≤ T` on-chain in a UTXO system is not generally possible.
- **Lean Oracle v3 is committed but not deployed.** Until the zero-init creation
  change is built and promoted (and the pinned `ORACLE_TYPE_CODE_HASH` / `oracle_commit`
  regenerated), the creation-forgery hole exists against the pinned v2 oracle.
- **Off-chain tooling not built yet** — no deployment toolbox, SDK, or web UI.
- **Testnet-only, unaudited** — treat as experimental play-to-earn; no
  mainnet-equivalent value at risk.

---

## 🔜 Next Steps (carried into Week 3+)

- Build and promote **Lean Oracle v3** (zero-init creation), then regenerate the
  pinned oracle code hash + `oracle_commit` downstream.
- **`game-sdk` (TypeScript, wraps `lean-oracle-sdk`)** — `createPool`, `deposit`,
  `activate`, `resolve`, `redeem`, `getPool`, `listShares`.
- **Deployment toolbox** mirroring the oracle's versioned-promote pipeline.
- **End-to-end lifecycle test** (create → deposit → activate → resolve → finalize →
  redeem → close in one run).
- Thin **CCC / JoyID web UI** for deposit/redeem and share balances.

---

## 🧪 Commands / checks (typical for this week)

```bash
# From the repo root: compile the four contract binaries (release, RISC-V)
make contracts-build

# Run the host + ckb-testtool integration suite (70 tests)
make contracts-test
```
