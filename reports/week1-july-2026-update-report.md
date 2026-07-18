# Builder Track Weekly Report — July 2026 (Week 1)

**Name:** Adokiye
**Project:** CKB Up/Down — asset up/down prediction pools
**Repository:** https://github.com/calledAdo/asset-up-down-pools
**Builds on:** [Lean Oracle](https://github.com/calledAdo/lean-oracle)

> Week 4 of June delivered the game SDK. Week 1 of July brought the rest of the
> off-chain stack into the repository: the **operational backend** (`packages/watcher`)
> that drives the pool lifecycle and serves the frontend, the **player web app**
> (`packages/web`), the written **design specs** the whole system is built against, and
> a small **contract refinement** to the oracle price bands. This is the week the
> project became an end-to-end system on paper and in code, not just a contract + SDK.

## ✅ Completed Tasks

### Design specs committed

- Added the written baseline the contract and off-chain layers are built against:
  - `pool_type-spec` — pool data layout, status/winner enums, and the full transition
    table (CREATE, DEPOSIT/WITHDRAW, ACTIVATE, CORRECT-start, RESOLVE, CORRECT-settle,
    FINALIZE, REDEEM, CLOSE).
  - `timing-spec` — the price phase runs on authenticated oracle `publish_time`, not the
    header clock (which is backward-manipulable); the grace and close-grace derivations;
    and one dedicated oracle cell **per feed** (shared across a feed's cadences), which is
    what lets coincident transitions from different cadences batch into one transaction.
  - `share_xudt-spec`, `oracle-lane-spec`, `sdk-packaging-sketch` — the share token, lane
    topology, and the SDK/deployment decoupling boundary.

### Contract: inclusive lower bound on the oracle price bands

- Changed the ACTIVATE, RESOLVE, and CORRECT bands from strict-both-ends to
  `[start, close)` / `[close, void)`: inclusive lower, strict upper. A tick at
  `publish_time == start_time` (or `== close_time`) is the canonical boundary price and
  already proves real time reached the boundary — rejecting it discarded the best possible
  tick and forced a correction to a strictly later, worse one.
- Factored the four price-setting paths into shared `set_start_tick` / `set_settle_tick`
  helpers (the initial stamp and its correction are the same check with a different
  ceiling), and delegated deposit funding-provenance to the staked asset's own xUDT
  conservation rather than re-checking it in `pool_type`.
- Full contract suite green (84 Rust integration tests).

### Operational backend — `packages/watcher`

- Added `ckb-up-down-watcher`, the backend with three concerns behind one codebase:
  a **keeper** that drives each pool's lifecycle, an **indexer** that projects chain
  state into SQLite for the frontend, and a **Fastify API** that serves reads and builds
  unsigned write transactions.
- Built it pure-core + thin-shell, mirroring the SDK: a pure planner decides actions from
  chain state; the shells do I/O (indexer, executor, API, service composition, entrypoint).
- Made it **role-split** for deployment (`all | keeper | indexer | oracle`): each keeper
  owns a wallet and a private `tx_log`, exactly one indexer writes the shared projection
  DB, and one oracle worker is the sole writer of every feed's oracle cell. A
  docker-compose runs one indexer plus a keeper per cadence.
- Added two idempotency layers so a crash mid-broadcast can't wedge or double-fire: an
  on-chain status check plus a `tx_log` open-row guard, with a startup reconciler that
  resolves dangling in-flight rows against the chain.
- Exposed `POST /tx/{deposit,withdraw,redeem,burn}` so the browser never links an SDK —
  the backend builds the unsigned transaction and the wallet only signs and submits.
- 22 source modules, 9 test fixtures.

### Player web app — `packages/web`

- Added the Vite + React single-page app. Architecture rule: **no project SDK in the
  browser** — reads come from the watcher API, and writes are built server-side and only
  signed/submitted client-side via CCC (the sole chain dependency in the bundle).
- Built the pages: Markets (lanes board), Pool detail (odds/timing + price chart +
  deposit/redeem/burn), My positions, and History.
- Gave it a signature visual identity — the tug-of-war bar (UP vs DOWN split with a
  fulcrum at the live implied probability, recurring at three scales) — plus a live
  countdown, a themeable token system, and the "Tilt" brand.
- Added a zero-dependency mock backend that serves the same REST contract, so the UI can
  be developed and demoed without a running chain.

### Deployment artifacts and cross-agent continuity

- Started tracking testnet/mainnet deployment artifacts (they record the canonical
  deployed code hashes and outpoints the whole team builds against) while keeping local
  devnet artifacts ignored, and documented that the oracle binding is watcher-owned
  operational config, not a deployment artifact.
- Added a portable, plain-text work record (`llmtimeline/`) and its maintenance protocol,
  so context survives across working sessions and different tools.

---

## 📚 Key Learning Areas

### 1. The price clock must be the oracle, not the chain header

A UTXO header timestamp is backward-manipulable (a transaction author can reference an old
block), so a header-based "before void_time" bound is unenforceable. Anchoring the whole
price phase on the oracle's authenticated, monotone `publish_time` — where a signed tick at
time `T` proves real time reached `T` — is what makes activation, resolution, and the
no-resolution VOID safe. Only CLOSE reads the header, and only for a teardown grace.

### 2. The browser should sign, not assemble

Keeping transaction assembly server-side and leaving the browser to sign and submit keeps
the CKB tx-building surface (and the SDK's Node-shaped dependencies) out of the bundle, and
means a contract or lane change ships without a frontend release. The frontend treats the
watcher purely as an HTTP contract.

### 3. Split the backend by what must have exactly one writer

Each shared resource gets a single owner: one indexer writes the projection DB, one oracle
worker writes each feed's cell, and each keeper owns its own wallet and private log. That
separation is what lets the pieces scale independently and keeps concurrent writers from
colliding on the same on-chain cells.

---

## 🛑 Constraints / Risks Acknowledged

- **Not yet run live end-to-end.** The watcher (including its oracle subsystem) is built and
  unit-tested but has not been exercised against a live devnet node yet.
- **Keeper is level-triggered this week.** The backend shipped with a polling planner; a
  redesign to an edge-triggered, self-scheduling keeper is the Week 2 focus.
- **No public testnet/mainnet deployment.** Presets and artifacts are devnet-only until a
  real deployment exists.
- **Frontend uses a mock backend for demos.** The real indexer swap is a straightforward
  config change (`VITE_WATCHER_API_URL`) but has not been wired against a live API.

---

## 🔜 Next Steps (carried into Week 2)

- Redesign the keeper from a polling loop into an edge-triggered, self-scheduling driver.
- Run the watcher against a local devnet and drive a full round end-to-end.
- Point the web app at a live indexer and confirm reads render and a deposit round-trips.

---

## 🧪 Commands / checks (typical for this week)

```bash
# Contracts
make contracts-build && make contracts-test    # 84 tests

# Watcher backend
cd packages/watcher && npm install && npm run typecheck && npm test

# Web frontend (mock backend + dev server)
cd packages/web && npm install && npm run mock   # one terminal
npm run dev                                       # another -> http://localhost:5173
```
