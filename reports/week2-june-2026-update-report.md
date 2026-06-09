# Builder Track Weekly Report — June 2026 (Week 2)

**Name:** Adokiye
**Project:** CKB Up/Down — asset up/down prediction pools
**Repository:** https://github.com/calledAdo/asset-up-down-pools
**Builds on:** [Lean Oracle](https://github.com/calledAdo/lean-oracle)

> Week 2 took the Week 1 contract layer from "works" to "hardened": a tamper-evident
> oracle pin, a griefing-resistant pricing model, a critical supply-control fix, an
> external-audit follow-up, and the project's public repository initialization.

## ✅ Completed Tasks

### Oracle trust-root commitment

- Replaced the weaker "pin the oracle type + feed id" approach with a single stored
  **`oracle_commit = H(code_hash ‖ guardian_set_type_hash ‖ emitter_chain ‖
  emitter_address)`**, recomputed from the dep cell at read time. The bare oracle type
  script is shared by every oracle cell of a feed (forgeable on its own); the
  commitment binds the deployed oracle code **and** its trust root (the Wormhole
  guardian set + the Pyth source) in one 32-byte hash, keeping `PoolData` slim.

### The `publish_time` contest (the pricing model)

- Moved the entire price phase off the header timestamp — which a tx author can set
  *backward* by depping an old block — and onto the oracle's authenticated
  **`publish_time`**. A signed tick at time `T` proves real time `≥ T` (Pyth cannot
  sign the future), so it both prices the pool and bounds the clock.
- Made **both** the start and settle prices *contests*: a provisional value can be
  replaced only by a strictly **earlier** authentic tick, converging to the first tick
  after each boundary. This recovers the canonical first-tick price the older strict
  straddle aimed at, **without** its griefing flaw (a loser advancing a shared cell to
  force a VOID) and **without** the cherry-picking the plain price band allowed —
  corrections can only move *toward* the truth.
- Added the `FINALIZE` latch: once an authentic tick proves `publish_time ≥ void_time`
  (`void_time = close_time + grace`, `grace = clamp(duration/10, 60s, 600s)`), the
  result is locked and redemption opens. Introduced `STATUS_FINALIZED` and reused a
  single `used_pt` field for whichever phase (start vs settle) is active.

### Critical fix — freeze share supply on every non-trading transition

- A security review surfaced a **critical** gap: `share_xudt` returns success whenever
  its PoolCell is present (it delegates all supply control to `pool_type`), but the
  ACTIVATE/RESOLVE/CLOSE transitions never checked shares. Anyone running the
  permissionless RESOLVE — who already knows the winning side from the public oracle
  price — could mint winning shares from nothing and drain the treasury.
- **Fix:** a `shares_frozen` guard (`net_minted(UP) == net_minted(DOWN) == 0`) on every
  PoolCell-consuming transition that isn't a deposit/redeem, with regression tests.
  Also hardened `share_xudt` to reject any side byte other than UP/DOWN.

### Cross-repo coordination — an oracle creation-forgery class

- While designing the price clock, identified that the Lean Oracle's cell *creation*
  path does not authenticate a price, so a cell matching our pinned `oracle_commit`
  could carry a fabricated in-band price and be read as authentic over a CellDep.
- The remedy is an oracle-side **v3 "zero-init at creation"** change (a nonzero
  `publish_time` then provably implies the cell was VAA-authenticated). That work is
  **tracked in the Lean Oracle repository**, not here; this repo only depends on it.
  Until v3 is built and promoted, our pinned `ORACLE_TYPE_CODE_HASH` / `oracle_commit`
  stay on v2 and must be regenerated once v3 ships. *(Documented as a known constraint
  below — no oracle code is vendored or modified in this repo.)*

### External-audit follow-up and test growth

- Acted on an external audit of the contract layer:
  - **CREATE** now requires both boundaries to be in the future (`start_time > now &&
    close_time > now`).
  - **xUDT DEPOSIT** now has a defense-in-depth check that the depositor's funding
    cells are the configured staked asset (not a worthless token).
  - Added the previously-missing **`pool_admin_lock`** tests (the real lock, including
    the creator-escape CLOSE path) and **`share_xudt` transfer + cross-pool isolation**
    tests.
  - Reconciled spec/implementation drift (the pricing model, status enum, byte lengths,
    and the header-vs-oracle clock) across all five docs.
- The integration suite now stands at **70 `ckb-testtool` tests**, all passing against
  the real RISC-V binaries.

### Repository initialization and structuring

- Wrote a sectioned **`.gitignore`** that keeps `target/` (≈1.5 GB of build
  artifacts), `.claude/`, and any keys/`.env` out of history while **tracking
  `Cargo.lock`** for reproducible on-chain code hashes; added a **`README.md`**
  orienting the layout, build/test commands, and security model.
- **Initialized git and published** the project to its own public repository
  (`asset-up-down-pools`), and started this `reports/` folder.

---

## 📚 Key Learning Areas

### 1. Header time is backward-manipulable; oracle time is not

A CKB tx author picks the header dep, so header `now` can be set earlier than real
time but never later. That makes "before T" upper bounds unenforceable and "after T"
lower bounds safe. Anchoring the price phase to the oracle's signed `publish_time`
sidesteps the manipulation entirely — the one residual upper bound (the DEPOSIT
cutoff) is handled as a liveness assumption rather than an on-chain guarantee.

### 2. A monotone-down contest beats both the straddle and the band

The strict straddle was griefable under a permissionless oracle lock; the plain price
band fixed that but allowed cherry-picking a favorable in-band tick. Letting
corrections move *only earlier*, converging to the first post-boundary tick, removes
both problems at once — there is nothing to grief and nothing to cherry-pick.

### 3. A permissive token gate makes one upstream invariant load-bearing

Because `share_xudt` defers entirely to `pool_type` when its PoolCell is present, the
safety of the whole scheme rests on a single rule: **every** PoolCell-consuming
transition must account for **every** share movement of both sides. The critical bug
this week was exactly a transition that forgot to — the lesson is to make that
invariant explicit and uniformly enforced.

---

## 🛑 Constraints / Risks Acknowledged

- **DEPOSIT cutoff is a liveness assumption.** `now < start_time` uses header time
  (bypassable); the real cutoff is prompt permissionless `ACTIVATE` at `start_time`.
- **Depends on Lean Oracle v3 (not yet deployed).** The creation-forgery defense lives
  in the oracle repo; until that v3 binary is built and promoted, the pinned v2 oracle
  retains the hole, and our pins must be regenerated when v3 ships.
- **Off-chain tooling not built yet** — no deployment toolbox, SDK, or web UI.
- **Testnet-only, unaudited** — experimental play-to-earn; no mainnet value at risk.

---

## 🔜 Next Steps (carried into Week 3+)

- **`game-sdk` (TypeScript, wraps `lean-oracle-sdk`)** — `createPool`, `deposit`,
  `activate`, `resolve`, `redeem`, `getPool`, `listShares`.
- **Deployment toolbox** mirroring the oracle's versioned-promote pipeline.
- **End-to-end lifecycle test** (create → deposit → activate → resolve → finalize →
  redeem → close in one run).
- Thin **CCC / JoyID web UI** for deposit/redeem and share balances.
- Regenerate the pinned oracle code hash + `oracle_commit` once Lean Oracle v3 ships.

---

## 🧪 Commands / checks (typical for this week)

```bash
# Compile the four contract binaries (release, RISC-V)
make contracts-build

# Run the host + ckb-testtool integration suite (70 tests)
make contracts-test
```
