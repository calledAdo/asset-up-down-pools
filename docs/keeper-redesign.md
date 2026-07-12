# Keeper redesign — edge-triggered, self-scheduling

> Status: **design only**, clean-slate (first build stage — no back-compat with the
> current `packages/watcher` keeper). Companion to [`timing-spec.md`](timing-spec.md)
> and [`pool_type-spec.md`](pool_type-spec.md), which define the contract bands this
> mirrors. This document covers the **keeper role only** — the indexer, API, and oracle
> worker are separate concerns and unchanged here.

---

## 1. The shift

The current keeper is **level-triggered**: a loop wakes on an interval, re-reads *all*
pools, recomputes everything (`plan()` + `nextKeeperWake()`), fires, sleeps. Robust and
self-healing, but it re-derives the whole world every tick.

The redesign is **edge-triggered and self-scheduling**: the lifecycle is deterministic —
the moment a pool exists, every boundary it will ever cross is known — so instead of
polling, every pool and every cadence carries its *own* `setTimeout` to the next moment it
needs attention. The keeper is asleep the rest of the time. Each wake does the minimum:
fire what's due, compute the next wake, re-arm.

A **periodic safety sweep** (§7) runs underneath as a backstop, so a single lost timer
can't silently strand a pool — it reconciles the schedule against chain state and repairs
drift in both directions. Event-driven for efficiency; swept for robustness.

---

## 2. Two kinds of scheduled work

There are exactly two kinds of future work, and they differ fundamentally:

- **Create** belongs to a **cadence** (5m, 1h, …), not a pool — there's no `poolId` yet.
  It repeats forever on the grid.
- **Lifecycle** belongs to a **pool** — activate → … → close. A finite chain that ends
  when the pool is consumed.

So the unit stored in the schedule is a **wake entry** — a *revisit token*, not a
concrete on-chain action:

```ts
type WakeEntry =
  | { kind: "create"; cadence: Cadence }   // no poolId — mint the next round of this lane
  | { kind: "pool";   poolId: Hex };        // revisit this pool; the action is derived at fire time
```

The concrete action is **not stored** — only *when to revisit*. At fire time the keeper re-reads
the pool and derives the action from *fresh* chain + oracle state via `decide` (§3). The market is
permissionless, so by fire time another party may have already driven that transition (possibly
with a worse price), a late deposit may have arrived, or the process may have been down across
boundaries — so the action must come from current state, never a stored guess. The registry only
says *which pool to look at, and when*. You never act on a stale decision. A useful corollary: if
the market (or a sibling keeper) already drove the transition, `decide` returns null and the
keeper spends nothing — so "let someone else act first" is preserved *structurally* by deriving at
fire time, independent of any scheduling delay.

---

## 3. The decision — `classify` (pure) + `decide` (pure given the current tick)

The decision is a **classification** over `(status, time, on-chain oracle)`, **not** a
monotonic ladder. The keeper reads **the oracle cell's current tick** (the last on-chain
update for the feed) and acts only if that tick already satisfies the contract band; it
never reaches back for a historical tick. Keeping liveliness + correctness of the cell is
the **oracle worker's** job (§8); the keeper is a pure reader.

This makes the whole decision pure given one input — the current tick `T`:

```ts
interface OracleSource {
  /** The last on-chain update for the feed (its tick + live CellDep), or null if none. */
  readCurrentTick(feedId: Hex): Promise<OracleTick | null>;
}

/** Pure: the concrete action due now, given the pool, the clock, and the current tick. */
function decide(pool: PoolView, now: bigint, T: OracleTick | null): Action | null;
```

`now` is the chain-tip time for the price phase (oracle `publish_time` is the authority;
chain `now` only gates CLOSE). `T == null` or a tick that doesn't satisfy any band ⇒ no
action this wake (skip → short retry; the worker hasn't advanced the cell yet).

### Decision table

All bands on the oracle `publish_time` clock (`pt = T.publishTime`), per
[`pool_type-spec.md`](pool_type-spec.md) §2. `void = close + grace(d)`,
`grace(d) = clamp(d/10, 60s, 600s)`. `close_grace(d) = clamp(d·8, 1h, 7d)`.

| status | condition on `T.pt` / `now` | action |
|---|---|---|
| OPEN, both sides funded | `start < pt < close` | **ACTIVATE** |
| OPEN, one-sided | `pt > start` | **VOID** |
| OPEN | `pt ≥ close` (activation window missed) | **VOID** |
| OPEN | `pt ≤ start` (cell behind) | — skip → retry |
| LOCKED, `now < close` | `start ≤ pt < used_pt` | **CORRECT-start** |
| LOCKED, `now < close` | else | — wait → `close` |
| LOCKED, `now ≥ close` | `close < pt < void` | **RESOLVE** |
| LOCKED, `now ≥ close` | `pt ≥ void` (no resolution) | **VOID** |
| LOCKED, `now ≥ close` | `pt ≤ close` (cell behind) | — skip → retry |
| SETTLED, `now < void` | `close ≤ pt < used_pt` | **CORRECT-settle** |
| SETTLED | `pt ≥ void` | **FINALIZE** |
| FINALIZED / VOID | header `now > close + close_grace(d)` | **CLOSE** |
| CLOSED / gone | — | **DROP** |

Notes:

- **Corrections are opportunistic and state-preserving** (LOCKED→LOCKED, SETTLED→SETTLED).
  Policy: *always converge* — correct whenever the cell's current tick is strictly earlier
  than `used_pt` (and at or after the phase reference boundary — `start` for correct-start,
  `close` for correct-settle, inclusive). If the worker has already published the
  cell **beyond** the window (`pt ≥ used_pt`), no row matches → leave it as is. Each
  correction lowers `used_pt` monotonically toward the canonical first tick.
- **VOID is a fallback branch**, not a separate phase — reached from OPEN (one-sided, or
  activation missed) and from LOCKED (window closed with no resolution). It is the natural
  result of "the forward transition is no longer possible," which is also how **catch-up
  after downtime** resolves: a pool found long past its window simply voids.
- **CLOSE reads the header clock**, needs no oracle, and is **terminal** — it de-registers
  the pool (§6), it does not re-arm.
- The keeper's *own* forward transitions always use the cell's canonical first-tick (the
  worker advances it at the boundary), so corrections only ever fire against **someone
  else's** suboptimal transition. They are a fairness nicety; the contract's FINALIZE latch
  is what guarantees *safety*.

### Where each status re-arms (the pure `nextWakeTime` side)

`classify` exposes two pure read-outs: **`decide(pool, now, tick) → Action | null`** (the action
performable *right now* — used at fire time) and **`nextWakeTime(pool, now) → at`** (when to
re-arm). The action column below is what `decide` will yield at that wake; `nextWakeTime` gives
the time. Each pool holds **exactly one** outstanding wake:

| status | next wake at | what fires there |
|---|---|---|
| OPEN | `start` | activate, or void (one-sided / missed), or correct-start if found already LOCKED |
| LOCKED | `close` | resolve, or void (past void), or correct-settle if found already SETTLED |
| SETTLED | `void` | finalize |
| VOID / FINALIZED | `close + close_grace` | close |

The wake's `decide` branches on the *actual* status it finds — that is what absorbs
permissionless external transitions and downtime catch-up. Example: the keeper arms an OPEN
pool's wake for `start` expecting to ACTIVATE; if a third party locked it first, the wake
finds LOCKED at `now ≈ start < close` while the cell still holds the canonical start tick,
and CORRECT-start fires instead. After any action the keeper **re-reads + re-classifies** to
set the next wake — this resolves the LOCKED-vs-VOID / SETTLED-vs-VOID branch uncertainty
(the contract picks the branch; the keeper learns it by reading back).

**One scheduling rule, used everywhere — `nextWakeTime(pool, now)`.** The re-arm column gives the
*boundary*; this turns it into a wake time, and it is the **only** way a wake is placed — startup,
after a crash, after each action, steady state alike:

- boundary still in the **future** → arm there (`+ postBoundaryDelay`, so the oracle cell is
  advanced first);
- boundary already **past** (overdue — startup/crash/a catch-up step) → arm at **`now`**: an
  overdue-but-undone action fires as soon as the handler can run it, no artificial delay. Recovery
  is near-immediate.

Computing `now` once means all overdue pools share the `now` wake → they coalesce into **one
bucket and batch** (§5) instead of stampeding as separate txs. The only delay that remains is a
**`retryDelay` backoff**, applied *by the wake handler* solely when it could **not** act — the
oracle cell isn't advanced to the boundary yet (`decide` returns null while the pool is past its
boundary), or a tx failed. That's a backoff on an external dependency to avoid a hot loop, **not**
a recovery delay; everything actionable fires at its natural time.

---

## 4. Concrete actions and the executor

`decide` emits one of the concrete actions; the executor turns each into a tx. Beyond the
current set (create/activate/resolve/finalize/close) this needs:

```ts
type Action =
  | { kind: "create"; cadence: Cadence; startTime: bigint; closeTime: bigint }
  | { kind: "activate" | "resolve" | "finalize"; poolId: Hex; tick: OracleTick }
  | { kind: "correctStart" | "correctSettle";    poolId: Hex; tick: OracleTick }   // NEW
  | { kind: "void";   poolId: Hex; tick: OracleTick }                               // NEW (explicit)
  | { kind: "close";  poolId: Hex };
```

New keeper-client / SDK draft builders are required: `draftCorrectStart`,
`draftCorrectSettle`, `draftVoid`, and `draftTransitionBatch` extended to fold corrections
and voids alongside activate/resolve/finalize. (Dependency, not part of the keeper itself.)

Idempotency is unchanged from today: `tx_log` open-row guard (blocks re-fire across the
broadcast→commit gap) over on-chain status (a committed transition changes status so the
next `decide` won't re-emit it).

---

## 5. Batching — the reason wake entries bucket by timestamp

The schedule buckets entries by their due **timestamp**; coincident work shares one wake
and folds into as few txs as possible. A fired bucket:

1. Reads the **current tick once per feed** (not per pool) — `readCurrentTick(feedId)`.
2. Runs pure `decide(pool, now, T)` for every pool in the bucket.
3. Partitions the resulting actions:
   - **oracle-dependent** (activate / resolve / finalize / void / both corrections) →
     group **by oracle cell** → one tx per group. Grouping by cell is mandatory:
     `pool_type`'s `find_oracle` rejects a tx carrying two same-feed oracle deps. Because
     every same-feed pool in the bucket read the *same* current cell, they share one CellDep
     and collapse into a single tx for free.
   - **create** and **close** → individual txs (create has a typeID seed input; close is
     admin-gated; neither batches).
4. On a batch failure, fall back to per-pool txs so one stale PoolCell can't sink the
   others (existing executor behaviour), clearing the cache before each rebuild.

### Cross-cadence batching

Because the bucket coalesces by *timestamp* and the executor groups by oracle *cell*, a batch
is **not limited to one cadence** — any same-feed transitions due at the same boundary fold
together. The grid makes this routine: every coarse boundary is also a fine one (a 1h
boundary is a 5m boundary), and coincident transitions need the *same* first-tick ≥ that
boundary. So at the top of the hour a **5m RESOLVE and a 1h ACTIVATE** (same feed) read the
one shared cell and go out as a single tx. This relies on **one oracle cell per feed** (not
per lane) — see [`timing-spec.md`](timing-spec.md) §2; the implemented `OracleWorker` is
already per-feed. Cross-*feed* transitions (BTC + ETH) never batch — different cells, separate
txs.

### Recovery batches identically — and a size cap

Crash recovery is **not** a one-at-a-time path. `start()` arms every overdue pool at the same
`now` (§10), so they land in **one bucket**; the wake handler reads the feed tick once, `decide`s
each, and the executor groups by oracle cell exactly as in steady state — so a pile of missed
ACTIVATE / RESOLVE / FINALIZE / VOID / CORRECT transitions on one feed collapses into **one tx**
(mixed kinds are fine — each PoolCell validates its own transition; they only share the oracle
CellDep). A multi-step pool (e.g. VOID then CLOSE) re-arms at `now` after each step, so it advances
in successive batched *waves*, never inline. Because a recovery bucket can be large, the executor
**caps batch size and chunks** into several batched txs (each chunk keeps the per-cell grouping and
the batch→singleton failure fallback). CLOSE and CREATE stay individual (not oracle-batched).

Serialization (§9) does not undercut this: it gates whole *wakes*, and a wake batches its entire
bucket — so coincident and overdue actions go out together, never one tx at a time.

---

## 6. The scheduler (`Timeline`)

Your two registries — `timerId → timestamp` and `timestamp → bucket` — fold into one slot
map (the `timerId → timestamp` reverse lookup is unnecessary in JS: a `setTimeout` callback
closes over its timestamp). A small index gives each pool/cadence exactly one outstanding
wake and makes "move" and "remove" O(1):

```ts
type Slot = { timerId: NodeJS.Timeout; entries: WakeEntry[] };

class Timeline {
  private slots = new Map<bigint, Slot>();        // dueTime → { its timer, its bucket }
  private poolIndex = new Map<Hex, bigint>();      // poolId  → where it currently sits
  private cadenceIndex = new Map<string, bigint>();// laneKey → where its next create sits

  schedulePool(poolId: Hex, dueTime: bigint): void;   // move: remove old entry, insert at new time
  scheduleCreate(cadence: Cadence, dueTime: bigint): void;
  removePool(poolId: Hex): void;                       // purge from its slot, no re-insert
  cancelAll(): void;                                   // clear every timer (on stop)
  // fires onWake(dueTime) when a slot's timer elapses
}
```

- **Bucket by the logical grid timestamp**, not wall-clock-with-jitter, so coincident
  events actually coalesce. The real `setTimeout` delay depends on the entry kind:
  - **pool** (oracle) wakes fire at `boundary + postBoundaryDelay` — give the oracle worker
    time to advance the cell, and absorb wall-vs-chain skew;
  - **create** wakes fire at `boundary − createLead` — pre-stage the round so it is OPEN
    before its deposit window opens.
  So a single boundary `S` has two slots a few seconds apart: the next-create at `S − lead`
  (leading edge) and the new pool's activate at `S + postBoundaryDelay` (trailing edge),
  bracketing `S`. They never share a tx (create isn't oracle-batched), so the split is
  harmless; the activate still batches with the closing round's resolve at `S + delay`.
- **Move** (any forward transition / correction): `schedulePool` removes the pool's old
  entry via `poolIndex` and inserts it into the new slot. Corrections "move" to the *same*
  phase deadline.
- **Close de-registration**: `removePool` deletes the pool's entry and its index slot and
  does **not** re-insert — the cell is consumed on-chain, gone forever. This is the one
  action that shrinks the schedule rather than advancing the entry.
- An emptied slot clears its timer and is deleted.

---

## 7. The safety sweep

A low-frequency timer (e.g. every few minutes) that reconciles `listOwnPools()` (creator-
lock-scoped, configured feeds) against the schedule, **both directions**:

- a live pool with no scheduled wake → `classify` it and schedule one (repairs a lost
  timer, or a pool created by a sibling keeper / out of band);
- a scheduled `poolIndex` entry whose pool no longer exists on chain → `removePool`
  (repairs a close whose in-flight removal raced).

A just-closed `poolId` is held in a short-lived "retiring" set so the sweep won't re-add it
during the broadcast→commit window; the `tx_log` open-row guard is the second line. The
sweep is a backstop, not the primary driver — under normal operation the edge-triggered
wakes do everything.

---

## 8. The oracle seam

The keeper depends only on `readCurrentTick(feedId)` (§3) — a pure read of the cell's last
update. No advancing, no historical mint. **Liveliness + correctness of the cell is the
oracle worker's responsibility**: it is the sole writer of each feed's cell and advances it
to the canonical first-tick at every boundary the lanes need (grid boundaries +
boundaries+grace), so that when the keeper reads at a boundary the cell holds the right
tick. If the worker is behind, the keeper reads a stale/absent tick, `decide` returns
nothing, and the wake short-retries until the cell catches up (or the window passes and the
pool voids). The oracle worker is out of scope for this redesign and unchanged.

---

## 9. Wake serialization

`onWake` is `async` — it reads the chain, decides, sends txs, and re-arms timers,
**suspending at every `await`**. Node is single-threaded, but two timers firing close
together can *interleave*: handler A suspends on an RPC, handler B runs and mutates the same
`slots`/`poolIndex` maps and selects wallet cells, then A resumes on stale assumptions.
Two failure modes: **wallet contention** (A and B pick the same input cell → the second tx
is rejected) and **registry corruption** (A reads an index entry B has since moved/deleted →
a lost or duplicated wake).

**Decision: serialize fire-handlers single-flight** — `onWake` bodies run through one
run-queue, so B waits for A to finish entirely. Handlers are short and I/O-bound relative to
block-time cadence, and batching already coalesces same-instant work into one fire, so
genuinely-concurrent fires are rare (a retry overlapping a boundary) and the cost is
negligible. The wallet **`Mutex` stays** as the inner guard — it is also shared with the
oracle worker in single-process (`all`) mode, where the two contend for the same wallet.

Serialization is **between** wakes, not within one: a single wake processes and batches its whole
bucket (§5), so coincident or overdue actions are handled together — never one tx at a time.

---

## 10. The Keeper

```ts
class Keeper {
  constructor(deps: {
    cadences: Cadence[];
    timeline: Timeline;
    executor: ActionExecutor;   // Action → tx (+ tx_log idempotency, batch-by-cell, fallback)
    oracle: OracleSource;        // readCurrentTick only
    chain: ChainReader;          // getTip(), readPool(poolId), listOwnPools()
    txlog: TxLog;                // reconcile (startup) + open-row guard
    mutex: Mutex;                // wallet serialization (shared with the oracle worker in `all`)
    clock?: () => bigint;
    log?: (m: string) => void;
  }) {}

  async start(): Promise<void>;
  async stop(): Promise<void>;
  setWindingDown(on: boolean): void;  // externally-managed flag (§11); OFF by default on start

  private async onWake(dueTime: bigint): Promise<void>;  // serialized (§9)
  private async onSweep(): Promise<void>;                // §7
}
```

### `start()` — the restart sequence (identical after a crash or a planned stop)

The in-memory schedule (the `Timeline` + its indexes) is **never persisted** — it is fully
rebuilt from durable truth on every start. The only durable state is the **chain** (source of
truth for pools) and the **`tx_log`** (in-flight idempotency). So a crash and a clean
stop+restart take the *same* path, and it is safe to run repeatedly.

**`start()` only reconciles, reads, and *schedules* — it never executes a transition inline.**
All execution flows through the ordinary (serialized, §9) wake handler, so startup reuses the
steady-state machinery wholesale instead of carrying a catch-up path of its own:

1. **Reconcile the `tx_log` first.** Resolve every dangling `sent` row against the chain
   (`getTransaction`): committed → mark committed; rejected / not-found → mark failed
   (re-fireable); still pending → leave `sent`. A crash mid-broadcast leaves a `sent` row that
   would otherwise wedge that action's idempotency guard forever. This runs *before* anything
   reads pools or plans, so the guards are honest.
2. **List our live pools from chain.** `listOwnPools()` — creator-lock-scoped, filtered to the
   configured feeds. The keeper has no memory of what it created; it rediscovers the world from
   chain, which also reflects whatever happened while it was down (external transitions,
   deposits, others' closes).
3. **Schedule every live pool.** For each, `schedulePool(poolId, nextWakeTime(pool, now))` — the
   *same* call steady-state uses (§3). Not-yet-due pools arm at their boundary; overdue pools (we
   were down across a boundary) arm at **`now`** (fired as soon as the handler runs). Because `now`
   is computed once, all overdue pools share that wake → they coalesce into one bucket and their
   transitions batch (§5). When it fires, the ordinary pool-wake handler reads → `decide`s →
   executes → re-arms, walking a long-missed pool forward one action per wake: past its window →
   VOID, SETTLED past `void` → FINALIZE, terminal past `close_grace` → CLOSE. No startup-specific code.
4. **Seed creates — only if not winding down (§11).** With `windingDown` off, for each cadence
   `scheduleCreate` **one** wake at the boundary for the current round; the create handler
   (idempotent — it skips the mint if that round already exists) self-perpetuates from there, so
   this single seed is all that's needed. Like everything else it is *scheduled*, not run inline —
   an overdue current-round create just fires at `now`. The cold/warm split is
   only *which grid phase* that boundary comes from:
   - **Cold** (no live pools) → the operator's **`firstCreateAt`** (may be future; see *Cadence
     anchoring* below).
   - **Warm** (live pools exist) → the phase inferred from an existing pool's `startTime`, so the
     restart continues the existing grid (the operator anchor is *not* re-applied).
   If `windingDown` is on, skip entirely — no cadence gets a new pool; the step-3 pools just
   drain to close and the keeper quiesces.
5. **Arm the safety sweep** (§7). The keeper is now live — event-driven from here.

Idempotency makes the re-fire risk harmless: if a previous incarnation broadcast a tx but
crashed before recording its commit, step 1 catches the committed ones; for anything it
re-attempts, the on-chain status has already advanced (so `classify` won't re-emit it) or the
`tx_log` open-row guard blocks the duplicate.

### Cadence anchoring (operator-supplied first-create times)

Each cadence's grid phase is **chosen by the operator at startup**, not fixed to the Unix
epoch: every `Cadence` carries a `firstCreateAt` timestamp (per feed × cadence), and its grid
is `firstCreateAt + k·duration`. The keeper fires that cadence's first create at `firstCreateAt`
and rolls every `duration` after. This is how you align long cadences to a meaningful wall-clock
anchor — a **1d** cadence pinned to **12:00 noon**, a **1h** to the top of the hour — while a
**5m** cadence can just start a few minutes after boot (`startup + 3 min`). These times are
explicit startup config for the feed, which also makes the first-create ordering across cadences
deterministic.

**Restart caveat:** `firstCreateAt` only anchors a **cold** cadence (no live pools). On a warm
restart the keeper continues the grid implied by the *existing* pools (step 4, warm branch), so
the phase stays stable across restarts and a restart at a different wall-clock time can't fork a
cadence onto a new, misaligned grid. **Re-anchoring a live cadence requires draining it first**
(wind down → let it close out → restart cold with the new `firstCreateAt`).

### A `create` wake fires

A create wake is keyed to a boundary `B` (a round's deposit window opens at `B`) and fires
at `B − createLead`, so the new pool is committed and OPEN before `B`.

1. If `windingDown` is on → do nothing (no create, no re-arm).
2. If a pool with `startTime = S = B + duration` already exists (a sibling keeper or a prior
   incarnation minted it), **skip the mint** and go to step 4 — the create is idempotent.
   Otherwise CREATE the round (`startTime = S`, `closeTime = S + duration`, deposit window the
   **full** interval `[B, S]`); the executor returns the new `poolId`.
3. If we minted, `schedulePool(newPoolId, S)` — the new pool's first wake is its ACTIVATE at `S`.
   (If we skipped, that round's wake is already armed by `start()` step 3 / the sweep.)
4. `scheduleCreate(cadence, S)` — the next create, keyed to boundary `S` (fires at
   `S − createLead`, mints `startTime = S + duration`). The mint rolls forever.

So **one CREATE spawns exactly two follow-ups, both at the next cadence boundary `S`**: the
new pool's ACTIVATE and the next CREATE. They cluster at `S` with the *closing* round's
RESOLVE (`startTime = S − duration`, which activated at `S − duration` and resolves at `S`);
RESOLVE + ACTIVATE batch into one oracle tx, CREATE is its own (pre-staged a hair earlier by
the lead — see §6).

### A `pool` wake fires

The keeper carries no plan for the pool — it reads current state and derives the action.

1. `readPool(poolId)`. Gone (closed) → `removePool`, done.
2. `T = readCurrentTick(feedId)` once per feed for the whole bucket.
3. `action = decide(pool, now, T)`:
   - **action returned** → execute it (batched by cell with the bucket's other actions,
     serialized through the wallet mutex);
   - **null** → nothing to do this wake (not yet due, already done by someone else during the
     wait, or the oracle cell isn't advanced to the boundary yet).
4. **Re-arm** from current state (re-read after a successful execute, so it reflects the post-state):
   - terminal + closed → `removePool` (no re-arm);
   - could not act because the oracle cell is behind, or the tx failed → `now + retryDelay` (backoff);
   - otherwise → `schedulePool(poolId, nextWakeTime(pool, now))` — its boundary if future, or `now`
     if the next action is itself already overdue (the catch-up cascade, one action per wake).

---

## 11. Wind-down (externally-managed flag)

The keeper holds one **`windingDown` flag**, **off by default on every start** (so a normal
restart resumes creating — §10 step 4). It is set externally (`setWindingDown`); the keeper
does not orchestrate or detect drain.

- **It gates creation in exactly two places** — `start()` step 4 (seed creates) and the
  `create`-wake handler (§10). Both no-op when it is on. So turning it on stops **all** new
  pools for **every** cadence — the steady-state rolling mint *and* any restart re-seed.
- Existing pools are **unaffected** — their lifecycle wakes keep firing, so they
  activate → resolve → finalize → close and de-register normally. The schedule simply empties
  of `pool` entries as they close; the keeper quiesces.
- During that quiet window the operator does maintenance out of band (e.g. a redeploy).
- Turning it **off** does not itself create anything; resume by re-running the step-4 seed, or
  just restart the keeper (start defaults to off and re-seeds).
- It can also be initialised **on** from config for a maintenance restart where you want to
  drain without minting new pools.

---

## 12. Reuse vs replace

- **Replace:** `planner.ts` (`plan`, `planCreates`, `transitionFor`, `closeable`,
  `nextKeeperWake`) and the polling loop in `service.ts` → `Keeper` + `Timeline` +
  `classify`/`decide` + `Cadence`.
- **Keep (largely as-is):** `executor.ts` (batch-by-cell + per-pool fallback + tx_log),
  `reconcile.ts`, `mutex.ts`, the timing helpers in `config.ts` (`grace`, `voidTimeOf`,
  `laneKey`), and the `OracleSource` *seam* (slimmed to `readCurrentTick`).
- **Untouched:** indexer, API, oracle worker (separate roles).

## 13. Dependencies / open items

- **SDK keeper-client** must grow `draftCorrectStart`, `draftCorrectSettle`, `draftVoid`,
  and batch support for them (§4).
- **Executor** must cap + chunk batch size for large (recovery) buckets, keeping per-cell grouping
  and the batch→singleton fallback (§5).
- **Oracle worker** must reliably hold canonical first-ticks at boundaries for the
  read-only keeper to function (§8) — already its remit, called out as the hard dependency.
- `Cadence` value object: owns grid math (`nextBoundary`, `roundStartFor(now)` — both phased to
  `firstCreateAt`, NOT epoch-aligned), feed, duration, **`firstCreateAt` (operator anchor for a
  cold start)**, rake, asset, oracleIdentity, createLead.
