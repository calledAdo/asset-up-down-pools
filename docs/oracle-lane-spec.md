# Dedicated oracle lane — management spec

> Confirmed decision: the game runs its **own** oracle cell(s) rather than reading the
> shared public feed (rationale in [`timing-spec.md`](timing-spec.md) §2). This spec
> covers topology, deployment, advancement, and the pool↔oracle binding.

---

## 1. Topology — one lane cell per (feed × cadence)

A **lane** = a feed and a round cadence, e.g. `(BTC/USD, 15m)`, `(BTC/USD, 1d)`. Each
lane owns **one** dedicated oracle cell for its entire life. Pools in a lane are
back-to-back: `pool_n.close_time == pool_{n+1}.start_time`, so the lane's boundary
timestamps are **strictly increasing** — the cell only ever advances forward, which the
oracle's monotonicity requires. Overlapping cadences (15m vs 1d) interleave boundaries,
so each gets its own cell.

```
lane (BTC/USD, 15m):  cell advances …→ start₁ → close₁=start₂ → close₂=start₃ →…
                       one oracle cell, forever
```

---

## 2. The back-to-back identity (close price = next open price)

For back-to-back pools, `close_n == start_{n+1}`, so an **in-band tick at that boundary**
serves both pool_n's settle price and pool_{n+1}'s start price. Consequences:

- The lane cell is advanced **once per boundary** (not 2× per pool).
- That cell version is referenced as a **CellDep** by *both* `resolve(pool_n)` and
  `activate(pool_{n+1})` — CellDeps are read-only, so multiple txs (or one combined tx)
  can dep the same live cell.
- `resolve(pool_n)` + `activate(pool_{n+1})` may be **batched into one transaction**
  (different pool cells, same oracle dep): a boundary costs 1 oracle-update tx +
  1 transition tx.
- Both transitions accept any authentic tick strictly *after* the shared boundary
  (`resolve` wants `close_n < pub`, `activate` wants `start_{n+1} < pub`, and
  `close_n == start_{n+1}`), so one post-boundary cell version satisfies both. Each side
  then converges to its own first post-boundary tick via CORRECT (see
  [`timing-spec.md`](timing-spec.md) §3.1).

This is economically correct too — the closing price of one round *is* the opening price
of the next.

---

## 3. Oracle identity is pinned per pool (type script), not by lock

Each pool stores `feed_id` (the oracle type's args, used to locate the cell) plus a single
`oracle_commit` = `H(oracle_code_hash ‖ guardian_set_type_hash ‖ emitter_chain ‖
emitter_address)` — binding the oracle type **and** its trust root (Wormhole signature root +
Pyth source) in one hash. `find_oracle` recomputes it from the dep cell and requires a match.
The type script alone is **not** enough: it is shared by every oracle cell of the feed, so an
attacker can stand up a same-type cell anchored to their own guardian set and sign fake
prices — the commitment defeats that. We still do **not** pin the oracle cell's *lock* (no
`oracle_lock_hash`):

- Cell **creation doesn't run the lock**, so a lock-hash pin is forgeable and buys nothing.
- The remaining freedom is *timing* (which in-band tick), which the **price band** bounds
  and a tight `grace` minimizes. A dedicated lane cell (§4) further limits who advances it.

So the dedicated cell is a **liveness/operational** convenience; the per-pool **type-script
pin + price band** is the safety boundary.

---

## 4. Deployment & lock — permissionless

- Deploy once per lane via `lean-oracle-sdk` `initiateOracleDeployTx`.
- **Lock: permissionless `owned_type_bind_lock`.** Anyone (in practice, the winners
  racing to claim) can advance the cell and resolve — no keeper, no liveness trust.
- **Griefing resistance comes from the band, not the lock** (see
  [`timing-spec.md`](timing-spec.md) §3.1): a loser cannot force a VOID by advancing the
  cell, because they cannot fast-forward `publish_time` past `boundary + grace` while the
  window is open, and every in-band version is resolvable by any winner.
- **Why keep a dedicated cell at all (vs the shared public cell)?** Pure operational
  hygiene: the shared feed is advanced by many unrelated parties, churning its outpoint
  and adding CellDep-invalidation noise to our resolve txs. A dedicated lane cell is
  touched only by our participants. The band would also work against the shared cell
  (it's always fresh, hence usually in-band) — the dedicated cell just reduces churn.

---

## 5. Advancement procedure (per boundary `B = close_n = start_{n+1}`)

Permissionless — any participant (typically a winner racing to claim) can do this:

1. Once real time passes `B` (so a tick > B exists, ~400ms later), call Hermes
   `GET /v2/updates/price/{B}?ids[]=<feed>` for the first tick after `B` (any later tick
   before `void_time` also resolves, then CORRECT walks it back down to this one).
2. Submit it to the lane cell (`pullUpdate` + `rebalanceFuel`), advancing `publish_time`
   past `B` (and, for resolution, below `void_time = close_n + grace`).
3. Submit the transition tx (`resolve(pool_n)` and/or `activate(pool_{n+1})`) before
   `void_time`, depping the current cell version (no header dep — the price phase reads
   only `publish_time`). If someone else advanced the cell in between, re-dep the newest
   version — any post-boundary tick is valid (and a strictly earlier one wins via CORRECT).
4. If no transition lands before `void_time` (proven by a tick `publish_time ≥ void_time`),
   anyone runs VOID → refund.

**Bootstrap (first pool):** deploy the lane cell with any initial price below `start₁`;
the first advancement lands an in-band tick at `start₁`, then `activate(pool₁)`.

---

## 6. Operational notes

- Stalled advancement degrades gracefully: a missed boundary ⇒ that pool (and the chain
  of back-to-back successors that never opened) VOID → refund. Funds are never stuck.
- No keeper needed, but the project can run watcher(s) as a liveness backstop; first valid
  advancement wins, duplicates simply become invalid (the cell already advanced).
- Lane cell capacity: top up occasionally via `rebalanceFuel`; advancement is ~1 tx per
  boundary, cheap.
</content>
