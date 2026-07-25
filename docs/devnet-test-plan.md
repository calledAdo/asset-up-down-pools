# Devnet test plan — the redesigned keeper + oracle, end to end

Status: plan of record. Tests live under `packages/watcher/tests/integration/devnet/`
(keeper runtime) and reuse the game-sdk devnet harness (`deployDeps`, `mockOracle`).
They are **opt-in** — gated on a devnet env being loaded — and never run in `npm test`.

## Goal

Prove the redesigned, edge-triggered keeper and the real oracle subsystem drive the
full pool lifecycle on a live offckb devnet — with emphasis on the three things unit
tests can't reach: **batching across cadences**, **crash/restart recovery**, and the
**real Lean Oracle worker**. The single-pool builder path is already covered by
`packages/game-sdk/.../lifecycle.test.mjs`; this plan is about the *runtime*.

## Two constraints that shape everything

1. **Timing is contract-fixed.**
   - `grace = clamp(d/10, 60s, 600s)` → FINALIZE (`void_time`) is **≥60s after close**,
     for any duration. Rounds shorter than ~30s don't finalize faster; they only risk
     tx-confirmation races inside the round window.
   - `closeGrace = clamp(d·8, 1h, 7d)` → CLOSE is **≥1h after FINALIZE**, always.
   - ⇒ The *meaningful* lifecycle ends at **REDEEM/BURN** (reachable from FINALIZED in
     ~90s for a 30s round). **CLOSE is a ≥1h tail** — assert its *scheduling*, never
     block a fast test on its *completion*.

2. **Oracle: real vs mock — both are needed.**
   - **Mock** (`mockOracle.mjs`): we choose price + publish_time. The only way to force
     VOID (never publish), CORRECT (worse-then-better tick), band edges, and lagging-tick
     retries. Deterministic and fast.
   - **Real** (Lean Oracle + Hermes): real BTC price at real time; can't force edge cases,
     but it's the never-run-live subsystem — the actual gap.

## The test board (small, nesting durations)

A shared **`firstCreateAt` anchor** with durations that divide each other, so boundaries
coincide periodically (the precondition for batching):

| lane    | duration | createLead | notes |
|---------|----------|-----------|-------|
| S-30s   | 30s      | 5s        | fastest; full lifecycle → FINALIZE ≈ 90s |
| M-60s   | 60s      | 5s        | coincides with S every 60s |
| L-120s  | 120s     | 10s       | coincides with S+M every 120s (fat batch) |

30 | 60 | 120 nest, so every 60s the 30+60 boundaries batch and every 120s all three do.
The 60s grace floor keeps several pools alive in different states at once — good for
batching and restart coverage. All CKB-staked, 2% rake.

## Harness (two modes)

**Mode A — deterministic keeper runtime (`createService`, role="all").** Wire the real
service to a **`MockOracle`** implementing `OracleSource`: as the `oracleAdvancer` it mints
a controllable mock cell when the real `OracleWorker` fires at a boundary; as the keeper's
`oracle` reader it returns the current mock tick (with a real on-chain `cellDep`). So every
piece is production code — `Keeper`, `Timeline`, `OracleWorker`, executor, reconciler,
service wiring — except the price. A monotone-in-time price makes UP win deterministically.
For edge cases the same `MockOracle` runs in **manual mode** (the worker off; the test mints
ticks itself) to delay, omit, or downgrade a tick.

**Mode B — real oracle e2e.** The actual role split: `oracle` (WATCHER_ORACLE=live, deployed
devnet Lean Oracle) + `keeper` + `indexer`, separate wallets, real Hermes ticks.

**Bootstrap** (both): `deployDeps` mints fresh always-success-locked code cells (repeatable),
`definePoolNetworkConfig` builds the SDK config, genesis account #0 funds every role, explicit
`feeRate` (offckb fee stats are null), miner kept running (headers must advance).

## Scenario catalog

Grouped; each names its mode. Assert per-pool status, parimutuel payout (winner = stake +
pro-rata of losing pool − rake), treasury==totals conservation, and — for batching —
tx shape (one oracle dep, multiple pool cells).

1. **Baseline lifecycle (A).** One lane, two-sided deposits; keeper autonomously
   ACTIVATE→RESOLVE→FINALIZE; players REDEEM (winner) + BURN (loser). *First proof.*
2. **Multi-pool batching (A).** 30/60/120 board; at a coincident boundary assert transitions
   fold into one tx. Include **batch fallback**: a third-party deposit staler one pool → batch
   fails → per-pool fallback → the rest still land.
3. **VOID (A, manual).** Never publish in the window → after `void_time` keeper routes
   ACTIVATE/RESOLVE → VOID; deposits refundable. Plus one-sided early-void.
4. **CORRECT-start/settle (A, manual).** Stamp a late tick, then expose an earlier qualifying
   one → keeper issues CORRECT to the canonical price.
5. **Externally-driven (A).** A third party ACTIVATEs/RESOLVEs before the keeper's wake →
   keeper does not double-transition; CORRECTs if the external tick was worse.
6. **Lagging-tick retry coalescing (A, manual).** Delay the boundary tick; multiple overdue
   pools coalesce into one retry wake (one read, one batch) — no busy-loop.
7. **Restart / recovery (A).** Kill the keeper mid-lifecycle (mixed states) → restart →
   reconcile tx_log, reschedule from chain, catch up overdue, no double-fire. Sub-cases:
   crash mid-broadcast (dangling tx_log resolved), sweep self-heal (out-of-band pool),
   restart during a batch.
8. **Wind-down / drain (A).** SIGUSR1 stops new CREATEs, existing pools finish; SIGUSR2
   resumes (sweep re-seeds creates).
9. **Lane-scope enforcement (A).** A pool at an unconfigured duration under the same creator
   lock is NOT driven (validates `laneKeySet`).
10. **Real oracle e2e (B).** Oracle worker advances the real cell from Hermes at boundaries;
    keeper drives a round to FINALIZE. Also assert a non-zero `firstCreateAt` advances the
    cell where the keeper waits (the anchored-grid fix). Watch oracle-wallet fuel.
11. **Indexer + API (B/all).** API projects pools/odds/timing; `/positions?address=` resolves;
    `/tx/*` build signable txs. (Natural place to fix the `?lock=` vs `?address=` mismatch.)
12. **Topology soak (B).** Run the per-feed compose ~15–30 min; assert no stuck pools, steady
    rolling creation, no busy-loop, invariants hold.

## Sequencing

1. Foundation: devnet + miner, `deployDeps`, short-duration board, funded wallets.
2. Mode-A `MockOracle` harness.
3. Scenario 1 (baseline) → validate the harness end to end.
4. Scenario 2 (batching) — the headline.
5. Scenarios 7–9 (restart, wind-down, lane-scope) — resilience + the changes we shipped.
6. Scenarios 3–6 (VOID, corrections, externally-driven, retry) — decision matrix.
7. Scenario 10 (real oracle e2e) — the production subsystem.
8. Scenarios 11–12 (indexer/API, soak).

## Gotchas

- offckb fee stats are null → always pass an explicit `feeRate`.
- Keep the miner running; CLOSE + header gating need advancing headers.
- CLOSE ≥1h — assert scheduling, verify completion only in a patient/opt-in test.
- Corrections/VOID need the mock (can't rewind a real feed).
- Match the keeper's read source to the oracle under test (mock cell for A, real cell for B).
- Mode B runs in wall-clock; budget generous timeouts.

## How to run (once a devnet is up)

```bash
# offckb devnet + miner (see llmtimeline notes for the exact offckb invocation)
# then, from packages/watcher, with the deployer env loaded:
node --env-file=../../deployment/.env tests/integration/devnet/keeper-lifecycle.test.mjs
node --env-file=../../deployment/.env tests/integration/devnet/keeper-batching.test.mjs
```
