# Builder Track Weekly Report — July 2026 (Week 3)

**Name:** Adokiye
**Project:** CKB Up/Down — asset up/down prediction pools
**Repository:** https://github.com/calledAdo/asset-up-down-pools
**Builds on:** [Lean Oracle](https://github.com/calledAdo/lean-oracle)

> Week 2 rebuilt and hardened the keeper in isolation (unit-tested, never run live). Week 3
> closed the last gap before a live devnet run: a narrow **deployment-coherence slice** so the
> keeper, the oracle worker, and the process topology actually agree with each other in a
> multi-process deployment. Keeper discovery became lane-scoped, the oracle worker was put on
> the keeper's exact grid, the Compose topology was collapsed to the correct per-feed shape, and
> the watcher was switched onto the **published** lean-oracle-sdk instead of an out-of-repo path.
> This report covers the watcher/keeper only.

## ✅ Completed Tasks

### Confirmed the keeper topology first (decision, then code)

- Settled the partitioning question before touching code: **one keeper per feed/asset**, driving
  all configured durations for that feed — not one process per cadence. The reason is the oracle
  cell is per feed, and coincident cadence boundaries share that one cell, so a single keeper is
  what lets same-feed transitions batch into one transaction. Per-cadence processes remain an
  optional isolation/sharding mode at high load, but cost extra Node runtimes, SQLite files,
  wallets/funding, RPC sweeps, and cross-cadence batching.
- Fixed ownership as a **logical scope rule** — `(creatorLock, feedId, durationSecs)` — rather
  than a process count, so the topology decision and the discovery rule are separable.

### Lane-scoped keeper discovery

- Made the keeper filter discovered and read pools by the exact configured `(feedId,
  durationSecs)` set (`laneKeySet` / `laneKeyOf`) instead of by feed alone. Previously a per-feed
  keeper could revive a **retired duration** under its own creator lock — a pool of a cadence no
  longer in the board would still be picked up and driven. Scoping to the configured lane set
  makes the keeper touch only the lanes it actually owns.

### Put the oracle worker on the keeper's grid

- Derived the oracle worker's boundaries from the keeper's `Cadence` value object (new
  `boundaryAtOrBefore`) rather than independent epoch math. With a non-zero `firstCreateAt`
  anchor, the worker (which advances the cell) and the keeper (which waits on the boundary)
  previously agreed only by accident — both defaulted to a 0 anchor. Sharing the same grid math
  makes them coherent for any anchor, which is the precondition for the worker having a fresh tick
  ready exactly when the keeper wakes.

### Corrected the process topology

- Collapsed the four per-cadence keeper services in the Compose file into a single `keeper-btc`
  handling all BTC durations (preserving same-cell batching), and **added the missing `oracle`
  writer service** that the implemented role never had in Compose. Updated `.env.example` to
  follow (oracle wiring, per-feed keys, operator lock hashes).
- Removed a dead polling knob (`pollIntervalSecs` / `WATCHER_POLL_SECS`) left over from the
  pre-redesign level-triggered loop — the keeper self-schedules, so it had no effect.
- Rewrote the README to the per-feed topology and the oracle role.

### Dependency hygiene

- Switched the watcher to depend on the **published** `lean-oracle-sdk@^0.2.0` from the registry
  instead of a local out-of-repo `file:` path, so the build is reproducible and no longer assumes
  a sibling checkout at a fixed location.

### Tests

- Added focused fixtures for the new invariants: lane-set membership, `boundaryAtOrBefore`, and
  anchored `nextDue`. Full watcher suite green (nine fixture files); typecheck clean.

---

## 📚 Key Learning Areas

### 1. The batching boundary defines the process boundary

The oracle cell is per feed, and a single transaction can't carry two versions of the same-feed
oracle dep. That one fact decides the topology: partition keepers by feed (so coincident
transitions can share a cell and batch), not by cadence (which would scatter same-feed work
across processes and forbid the batch). The cheapest correct default falls out of the constraint,
not out of taste.

### 2. Two processes that must rendezvous need identical math

The keeper waits on a boundary; the worker advances the cell to that boundary. If they compute the
grid differently, they only line up at the default anchor. Making both derive boundaries from the
same `Cadence` object removes an entire class of "works until someone sets an anchor" bug.

### 3. Scope is a rule, not a deployment shape

"Which pools does this keeper own?" and "how many keeper processes are there?" are separate
questions. Encoding ownership as `(creatorLock, feedId, durationSecs)` lets the board run as one
process now and shard later without changing what any keeper is allowed to touch.

---

## 🛑 Constraints / Risks Acknowledged

- **Still not run live.** This slice was the last piece of coherence work before a live devnet
  run; the keeper + oracle path had still never been exercised against a live node at week's end.
- **Devnet preset drift.** The bundled devnet code hashes remained a snapshot behind the current
  binaries — a live deposit/withdraw round-trip needs a devnet redeploy first.

---

## 🔜 Next Steps (carried into Week 4)

- Run the redesigned keeper **and** the oracle worker against a live devnet, unattended, and drive
  real rounds through CREATE → ACTIVATE → RESOLVE → FINALIZE → REDEEM.
- Exercise the real Lean Oracle path end-to-end (real Hermes BTC/USD, on-chain Wormhole
  verification), not just a mock oracle cell.

---

## 🧪 Commands / checks (typical for this week)

```bash
cd packages/watcher
npm install
npm run typecheck
npm test
```
