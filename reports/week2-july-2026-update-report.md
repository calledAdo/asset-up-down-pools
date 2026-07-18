# Builder Track Weekly Report — July 2026 (Week 2)

**Name:** Adokiye
**Project:** CKB Up/Down — asset up/down prediction pools
**Repository:** https://github.com/calledAdo/asset-up-down-pools
**Builds on:** [Lean Oracle](https://github.com/calledAdo/lean-oracle)

> Week 1 shipped the operational backend with a polling keeper. Week 2 **rebuilt the
> keeper** from the ground up: from a level-triggered loop that re-scans the whole board
> on a fixed tick, to an **edge-triggered, self-scheduling** driver where every pool and
> cadence carries its own timer to its next due moment. The redesign was then reviewed
> against the specs and the contract, and hardened — a scheduling busy-loop, a safety
> backstop, a grid anchor, operator wind-down, and a retry-coalescing fix. This report
> covers the keeper only.

## ✅ Completed Tasks

### The redesign: edge-triggered, self-scheduling

- Replaced the polling planner with a scheduler that fires on state edges. A `Timeline`
  maps each due timestamp to a bucket of wake entries, so transitions that fall due
  together land in the same bucket and are handled in one wake — including across
  cadences, which is why the oracle is one cell **per feed** (a single transaction can't
  carry two same-feed oracle deps, so per-lane cells would prevent the batching).
- Made each wake carry only an **identity**, never a stored action. The action is derived
  at fire time from fresh chain state by a pure `decide(pool, now, tick)`, because the
  market is permissionless: a third party may already have driven the transition, or driven
  it with a suboptimal price, in which case the right move is a CORRECT rather than the
  transition originally scheduled. Deriving late instead of storing early is also what
  makes crash recovery fall out for free — an overdue pool simply fires, takes the same
  path, and reschedules itself.
- Built the pure core and unit-tested it exhaustively: `Cadence` (grid math for round
  boundaries and pre-stage create times), `Timeline` (one outstanding wake per pool/cadence,
  same-timestamp bucketing, de-registration on CLOSE), and `decide` + `nextWakeTime` (the
  full status × time × oracle-tick decision, including externally-driven transitions,
  opportunistic CORRECT-start/settle, and VOID).
- Kept the executor's batching: coincident transitions sharing an oracle cell fold into one
  transaction, with a per-pool fallback if a batch fails so one stale cell can't sink the
  others. Wired the new keeper into the service for the keeper/all roles.

### Review and correctness hardening

- Reviewed the implementation against the design doc, the contract, and the SDK builders.
  Confirmed a deliberate simplification is sound: the keeper emits `activate`/`resolve` for
  the void cases and lets the SDK builders route to a VOID output, which mirrors the
  contract's own `OPEN→LOCKED|VOID` and `LOCKED→SETTLED|VOID` routing — so no separate void
  builder is needed.
- **Fixed a boundary busy-loop.** When the oracle cell hadn't advanced past a boundary yet
  (the common case right at a boundary), an overdue pool was being re-armed at the current
  time instead of with a backoff, so it re-fired continuously and hammered the node until
  the cell caught up. The pool now re-arms from its post-execute state with a proper delay.
- **Added a safety-sweep backstop.** A low-frequency sweep re-derives the schedule from
  chain truth — listing every own pool and re-arming it, and re-seeding create wakes — so a
  dropped timer (a swallowed error, a pause, clock skew, an out-of-band pool) self-heals. It
  never sends a transaction itself; re-arming is idempotent.
- Removed code orphaned by the swap (the old polling planner and its batch path), porting
  their grouping/fallback coverage onto the new decision executor.

### Operability

- **Grid anchor** — made `firstCreateAt` a first-class lane setting, threaded through the
  lane presets and a `WATCHER_FIRST_CREATE_AT` environment variable (default 0 =
  epoch-aligned rounds). One shared anchor across a feed's nested cadences keeps every
  coarse boundary coincident with a fine one, which is the precondition for cross-cadence
  batching.
- **Operator wind-down** — wired `SIGUSR1` (stop minting new rounds so existing pools drain
  to a terminal state before a redeploy) and `SIGUSR2` (resume). Chosen over an HTTP endpoint
  because in the role-split deployment keepers are headless — only the indexer serves HTTP —
  so a signal is the mechanism that actually reaches the keeper process, needs no new network
  surface, and is already gated by host/container access. Resume kicks an immediate sweep so
  rolling creation restarts without waiting for the periodic one.

### Retry coalescing and a clock-skew fix

- Reworked the lagging-tick retry to snap to a **shared wall-clock grid** rather than
  `chain-tip + delay`. Two defects were tangled together: (1) the retry slot was built from
  chain-tip time while the scheduler fires timers on wall clock, so once the tip lagged real
  time by the retry interval the slot was already in the past and the whole retry batch
  re-fired immediately; and (2) pools that went overdue in different wakes read different
  tip values and scattered into different buckets. Grid-aligning the retry on wall clock
  gives a real bounded backoff (no spin) and makes the slot a deterministic function of
  time, so every pool retrying in the same window coalesces into one wake — one oracle read,
  one batched attempt.
- Kept overdue **detection** on chain-tip time (it must, to match the contract's header
  semantics); only the retry **timing** moved to wall clock.

### Tests

- Grew the keeper fixtures to cover startup scheduling, the decision matrix, the lagging-tick
  backoff, cross-wake retry coalescing, the safety sweep (including its wind-down behavior),
  and a wind-down create wake that neither mints nor re-arms. Full watcher suite green;
  typecheck clean.

---

## 📚 Key Learning Areas

### 1. Derive the action at fire time, not at schedule time

In a permissionless market the on-chain state can change under you between scheduling a wake
and it firing. Storing "what to do" when you schedule is a bug waiting to happen; storing only
"look at this pool" and deciding from fresh state at fire time is what makes the keeper correct
against third-party actions and makes crash recovery identical to normal operation.

### 2. Pick the clock deliberately, per concern

The same keeper uses two clocks on purpose. Overdue detection and phase gating use chain time
to match what the contract enforces. Retry backoff uses wall clock, because that's the clock
the scheduler's timers actually fire on — mixing the two made retries fire early and spin. A
timer's delay has to be measured in the clock it fires against.

### 3. Coalesce work onto shared time slots

Aligning retries (and creates, and coincident transitions) to shared timestamps isn't just
tidiness — it's what turns N near-simultaneous single-pool wakes into one wake with one oracle
read and one batched transaction. The scheduler is designed so that things due together are
handled together.

---

## 🛑 Constraints / Risks Acknowledged

- **Still not run live end-to-end.** The redesigned keeper and the oracle subsystem are
  unit-tested but have never been exercised against a live devnet node — this is the next
  milestone.
- **Wind-down is signal-only.** There is deliberately no HTTP control plane; toggling
  wind-down requires host/container access to signal the process.
- **Cross-cadence batching is bounded by the contract.** Coalesced retries reduce redundant
  reads and timer churn, but pools at genuinely different boundaries need different oracle
  ticks, so they may still land in separate transactions (one cell version per transaction).

---

## 🔜 Next Steps (carried into Week 3)

- Run the redesigned keeper and the oracle worker against a local devnet and drive a round
  through CREATE → ACTIVATE → RESOLVE → FINALIZE end-to-end.
- Point the web app at a live indexer and confirm a deposit round-trips.
- Refresh the devnet deployment/preset so on-chain code hashes match the current binaries.

---

## 🧪 Commands / checks (typical for this week)

```bash
cd packages/watcher
npm install
npm run typecheck
npm test

# Operator controls (keeper/all process):
#   kill -USR1 <pid>   # wind down — stop minting new rounds
#   kill -USR2 <pid>   # resume
```
