# Builder Track Weekly Report — June 2026 (Week 3)

**Name:** Adokiye
**Project:** CKB Up/Down — asset up/down prediction pools
**Repository:** https://github.com/calledAdo/asset-up-down-pools
**Builds on:** [Lean Oracle](https://github.com/calledAdo/lean-oracle)

> Week 3 built the **off-chain deployment toolbox** (`deployment/`): a versioned
> publish → promote pipeline that turns the four contract binaries into canonical
> on-chain **code cells**, and records the code hashes + outpoints the runtime reads
> to create pools. This report covers the deployment toolbox only.

## ✅ Completed Tasks

### Code-deployment CLI for the four binaries

- A TypeScript CLI (`deployment/src/`, CCC-based) that publishes each contract binary
  — `share_xudt`, `treasury_lock`, `pool_admin_lock`, `pool_type` — as a raw code blob
  in a code cell, one `deploy:*` action per binary. Code deployment builds the
  contracts first and computes occupied capacity dynamically before broadcasting.
- Entry point `node ./dist/index.js <action> --network <testnet|devnet|mainnet>`, with
  per-binary npm scripts (`deploy:share-xudt`, `deploy:treasury-lock`,
  `deploy:pool-admin-lock`, `deploy:pool-type`).

### Versioned artifacts — candidate vs canonical

- Each deployment is recorded under `deployment/artifacts/<network>.<family>.json` with
  two fields: **`latestCandidate`** (the most recently deployed code) and a
  **`versions`** map (explicit canonical, promoted versions).
- **Promotion** (`promote:*`) moves a candidate into the canonical `versions` map. The
  rule that makes this safe: the runtime (watcher/keeper) selects an **explicit canonical
  version, never `latestCandidate`**, so a freshly-deployed-but-unblessed binary can
  never be picked up by accident.

### Script identity policy (`data2` / CKB-VM v2)

- Binaries are referenced with **`hashType: "data2"`** (CKB-VM v2), the identity the
  current Rust / `ckb-std` build path expects. `hashType: "data"` pins CKB-VM v0, whose
  memory model triggers `MemWriteOnExecutablePage` on these binaries. The chosen identity
  is **recorded in each artifact** so downstream state deployment never guesses.

### Decoupling — `pool_type` from script selection, and the toolbox from `game-sdk`

- `pool_type` no longer embeds the code hashes of `share_xudt` / `treasury_lock`. Those
  are **pool config**: pool creation writes `share_xudt_code_hash` into every `PoolData`
  payload (and `treasury_lock_code_hash` for xUDT pools). This lets state deployment pick
  explicit canonical code versions from artifacts **without rebuilding `pool_type`**.
- Decoupled the deployment toolbox from `game-sdk` in docs/types — shared shapes are
  **replicated, not imported across packages**, matching the project's decoupling rule.

### Pool creation kept out of scope (by design)

- The toolbox stops at **publish + promote**. Creating a live `PoolCell` (and, for xUDT
  pools, its `TreasuryCell`) is a **recurring runtime action** owned by the
  watcher/keeper, which assembles them from the canonical code versions recorded here.

### Broadcast safety + preflight validation

- **Dry-run by default:** `DRY_RUN` defaults to `true`; real chain broadcasts require
  flipping it `false` (plus an explicit `BROADCAST` operator flag). Per-network
  `<NET>_CKB_RPC_URL` + `<NET>_DEPLOYER_PRIVATE_KEY` come from a gitignored `.env`;
  devnet also takes the local secp `KnownScript` override. Devnet broadcast paths use an
  explicit fee-rate fallback.
- Two no-broadcast preflights: **`validate:config <action>`** (config / env / build-path
  checks for a planned action, no side effects) and **`validate:consistency`** (builds
  the binaries and reports their fresh code hashes so a deploy can be reconciled).

### Artifact tracking policy

- **testnet/mainnet artifacts are committed** — they are the canonical record of deployed
  code hashes + outpoints that the watcher/keeper reads to create pools. Only
  `deployment/artifacts/devnet*.json` is gitignored (every operator regenerates devnet
  locally). Keys, `.env`, signed payloads, and `dist/`/`node_modules/` stay out of git.

### Tests

- `node --test` over `tests/artifacts.test.mjs` (candidate/promote/versions artifact
  logic) and `tests/validate.test.mjs` (preflight checks), gated behind a `build` so they
  run against compiled output; `typecheck` + `build` scripts alongside.

---

## 📚 Key Learning Areas

### 1. Candidate vs canonical is the core safety boundary

Publishing and *blessing* are different acts. Keeping `latestCandidate` separate from the
canonical `versions` map — and having the runtime read **only** canonical versions — means
deploying a new binary is side-effect-free until an explicit `promote`, so there's no path
for an untested code cell to silently become live.

### 2. Script identity (`data2` vs `data`) is load-bearing, so record it

The same binary referenced as `data` vs `data2` runs on a different CKB-VM, and `data`
(VM v0) faults on these binaries. Because the identity must match at every downstream read,
the artifact stores it explicitly rather than letting consumers assume.

### 3. Code hashes as pool config, not baked-in dependencies

By moving `share_xudt` / `treasury_lock` hashes out of `pool_type` and into `PoolData`,
deployment and pool creation can compose canonical versions freely — a new share or
treasury binary doesn't force a `pool_type` redeploy. Decoupling code identity from the
type script keeps the version matrix flexible.

---

## 🛑 Constraints / Risks Acknowledged

- **Dry-run by default; real broadcasts are explicit.** Nothing hits chain without
  `DRY_RUN=false` + `BROADCAST` and a funded per-network deployer key in `.env`.
- **Depends on freshly built binaries.** Deploy/consistency build the contracts first;
  the published code hash is only as canonical as the committed contract source it built.
- **Pool creation lives elsewhere.** This toolbox does not create pools; that is the
  watcher/keeper's runtime job, reading the artifacts published here.
- **Testnet-only, unaudited** — experimental; no mainnet value at risk.

---

## 🔜 Next Steps (carried into Week 4+)

- A real **testnet deploy + promote** run for all four binaries, committing the
  resulting `testnet.*.json` artifacts.
- Wire the canonical artifacts into the **watcher/keeper** pool-creation path (select
  explicit versions, assemble PoolCell/TreasuryCell).
- Regenerate the pinned oracle code hash + `oracle_commit` once Lean Oracle v3 ships.

---

## 🧪 Commands / checks (typical for this week)

```bash
cd deployment
npm install && npm run build

# preflight: build binaries, report fresh code hashes (no broadcast)
node --enable-source-maps ./dist/index.js validate:consistency --network testnet

# publish then bless a binary (DRY_RUN=true unless explicitly disabled)
node --enable-source-maps ./dist/index.js deploy:share-xudt  --network testnet
node --enable-source-maps ./dist/index.js promote:share-xudt --network testnet

# toolbox unit tests (build + node --test)
npm test
```
