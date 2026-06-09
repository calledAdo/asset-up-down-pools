# Timing & oracle-boundary spec

> How `pool_type` ties pool boundaries (`start_time`, `close_time`) to authenticated
> Pyth prices, and how the liveness grace window works. Companion to
> [`pool_type-spec.md`](pool_type-spec.md).

---

## 1. Three clocks

| Clock | Cadence | Role |
|---|---|---|
| **Pyth / Hermes** | ~400ms ([Pythnet rides Solana 400ms blocks](https://docs.pyth.network/price-feeds/core/how-pyth-works/hermes)) | source of signed prices; Hermes keeps history |
| **CKB oracle cell** | per tx (seconds) | on-chain mirror; refreshed only when someone submits an update |
| **Pool boundaries** | hardcoded | `close_time = start_time + duration` |

The 400ms clock means the *first tick at/after any boundary* is at most ~0.4s late, and
[Hermes can return it at any later time](https://hermes.pyth.network/docs/#/rest/timestamp_price_updates).
So **price freshness is never the binding constraint — settler/tx latency is.**

### Hermes endpoint

`GET /v2/updates/price/{publish_time}?ids[]=<feed>` returns *the first update whose
`publish_time ≥ {publish_time}`* — i.e. the boundary-crossing blob. Its returned
`publish_time` is `≥` the request (sub-second later for liquid feeds). The settler calls
it with `{publish_time} = start_time` (then `close_time`) to get the first in-band blob
the price band accepts (any later in-band tick works too).

---

## 2. Use a dedicated oracle cell (per feed × cadence lane)

The price band requires the oracle cell to *hold* an in-band tick. Against the
**shared public** cell this is fragile (operationally, not for safety):

- **CellDep liveness race:** each update consumes+recreates the oracle cell (new
  outpoint). `activate` deps on the specific outpoint the settler created; any other
  updater touching the shared cell in between kills that dep and fails `activate`.
- **Churn:** the shared feed is advanced by many unrelated parties, adding constant
  CellDep-invalidation noise to our transition txs.

**Decision:** the game deploys its **own** oracle cell (`initiateOracleDeployTx`, own
lock). Only the game settler advances it ⇒ the blob sticks and the dep stays live.
Updated only at boundaries (≈2× per pool), so it's cheap. Back-to-back pools in one
lane have monotonically increasing boundaries (`start₁ < close₁=start₂ < …`) ⇒ **one
cell per lane**; overlapping cadences (15m + 1d) get one cell each.

---

## 3. Two independent guarantees

### 3.1 Price correctness — the price band (any verified tick in the window)

`pool_type` reads the oracle cell as a **CellDep**, located by `type.args == feed_id`, and
pins its identity by recomputing a single commitment from the cell —
`H(type.code_hash ‖ guardian_set_type_hash ‖ emitter_chain ‖ emitter_address)` — and
requiring it to equal the pool's stored `oracle_commit`. The type script is shared by every
oracle cell of a feed, so it's forgeable on its own; the commitment binds the deployed
oracle code + the trust root (Wormhole signature root + Pyth source), which is what actually
authenticates. Then:

```
activate:  start_time < oracle.publish_time < close_time   ⇒ start_price  = oracle.price
resolve:   close_time < oracle.publish_time < void_time     ⇒ settle_price = oracle.price
                                                              (void_time = close_time + grace)
```

**Both the start price and the settle price are contests on the oracle `publish_time`
clock** (not the header — see §3.2), using the single `used_pt` field for whichever phase
is active:

- **Activation** (`OPEN→LOCKED`) records a *provisional* start tick in `(start, close)` as
  `start_price` + `used_pt`. Anyone may `CORRECT-start` (`LOCKED→LOCKED`) with a strictly
  earlier tick (`start < publish_time < used_pt`), converging to the first post-start tick;
  its window is the whole LOCKED phase (deadline = `close`). RESOLVE freezes `start_price`.
- **Resolution** (`LOCKED→SETTLED`) flips `used_pt` to a *provisional* settle tick in
  `(close, void_time)`. Anyone may `CORRECT-settle` (`SETTLED→SETTLED`) with a strictly
  earlier tick (`close < publish_time < used_pt`), converging to the first post-close tick.
  Once an authentic tick proves `publish_time ≥ void_time`, anyone may `FINALIZE` (latch the
  result; no more corrections) and redemption opens.

This recovers the first-tick goal that the old strict straddle aimed at, **without** its
griefing flaw (a loser advancing a shared monotonic cell to force VOID): corrections only
move *toward* the truth, and with v3 zero-init creation anyone can mint a fresh authenticated
cell at any historical tick, so the first tick is always presentable. The residual cherry-pick
of the plain band is eliminated — a late favorable tick is always beatable by an earlier one.

### 3.2 The clock — oracle `publish_time`, not the header

The resolution phase deliberately avoids the header timestamp, which is **backward-
manipulable** (a tx author can dep any old block, so a header-`now` upper bound like
"before `void_time`" is unenforceable). The oracle's `publish_time` is authenticated and
monotone, and a tick at time `T` proves real time `≥ T` (Pyth can't sign the future). So:

- `publish_time > close_time` proves we're past close (can't resolve early).
- `publish_time ≥ void_time` proves the contest window closed — used by both `FINALIZE` and
  the no-resolution `VOID`. A griefer **cannot fast-forward** to fake this.
- The `FINALIZE` latch (authentic time) is what makes payouts safe: without it, a late
  `CORRECT` with an old header could flip the winner *after* redemptions began.

`grace` (the contest length) is still derived from duration, nothing stored:

```
grace(duration) = clamp(duration / 10, 60s, 600s)
  15m → 90s    1h → 360s    1d → 600s (capped)
```

Every activation/resolution transition uses **only** the oracle clock — no header dep — so
header manipulation can't touch any of them:

| Transition | Valid when |
|---|---|
| `ACTIVATE` (OPEN→LOCKED) | oracle `start < publish_time < close`, both sides funded |
| `CORRECT-start` (LOCKED→LOCKED) | oracle `start < publish_time < used_pt` |
| `VOID` (OPEN→VOID) | one-sided & `publish_time > start`, **or** `publish_time ≥ close` |
| `RESOLVE` (LOCKED→SETTLED) | oracle `close < publish_time < void_time` |
| `CORRECT-settle` (SETTLED→SETTLED) | oracle `close < publish_time < used_pt` |
| `VOID` (LOCKED→VOID) | oracle `publish_time ≥ void_time` (no resolution) → refund |
| `FINALIZE` (SETTLED→FINALIZED) | oracle `publish_time ≥ void_time` |

(Only `DEPOSIT` and `CLOSE` still read the header timestamp — deposit for its `now <
start_time` cutoff, see the ⚠️ below; close for the 7-day teardown grace.)

> ⚠️ **The DEPOSIT lower bound is the exception.** `DEPOSIT` requires
> `now < start_time`, but `now` is a header-dep timestamp the tx author chooses — they can
> always reference a block from *before* `start_time`, so this check passes regardless of
> real time. **The real deposit cutoff is the `OPEN→LOCKED` transition, not the clock.**
> A pool left un-activated past `start_time` can still admit (late, hindsight-informed)
> bets. Mitigation is operational: **prompt permissionless activation at `start_time`**
> locks the pool; honest winners are economically motivated to do it (a late deposit on the
> winning side dilutes them). Proving `now ≤ T` on-chain in a UTXO system is not generally
> possible (`since`/median-time only proves `now ≥ T`), so this is a liveness assumption,
> not an automatic guarantee.

---

## 4. Settler sequence (per boundary)

Two txs, since a cell can't be both a CellDep and consumed in one tx:

1. **Oracle update tx** — fetch `/v2/updates/price/{boundary}`, submit it to a lane oracle
   cell (via `lean-oracle-sdk` `pullUpdate` + `rebalanceFuel`). Creates the oracle cell
   version holding the tick.
2. **Pool transition tx** — `activate` / `resolve` / `correct` / `finalize`, depping that
   oracle cell. The whole price phase (activation included) reads the oracle `publish_time`
   only — no header dep (see §3.2).

For resolution, the canonical path is: resolve with the first post-close tick promptly (no
correction needed); otherwise contest down to it, then finalize once a `publish_time ≥
void_time` tick exists.

If step 2 misses the grace window, anyone runs the VOID transition instead and everyone
is refunded.

---

## 5. Notes

- Grace bounds **latency**, not price: the recorded price is provably the boundary tick
  regardless of lateness; grace just decides activate/resolve-vs-refund.
- `grace`'s floor (60s) covers the two-tx settler round-trip across a few CKB blocks; the
  cap (600s) keeps even daily pools from lingering unresolved.
- Tunable later: the `grace` function and lane-cell topology are the two knobs if real
  cadences need adjusting.
</content>
