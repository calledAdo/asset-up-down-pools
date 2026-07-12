# `pool_type` — PoolCell layout & validation spec

> Companion to [`../ARCHITECTURE.md`](../ARCHITECTURE.md). Defines the on-chain byte
> layout of PoolCell data and the per-transition rules `pool_type` enforces. Encoding
> mirrors the oracle's `OracleData` (fixed offsets, manual little-endian).

---

## 1. PoolCell layout

`pool_id` is **not** in cell data — it is the PoolCell's **typeID**, carried in the
type-script `args`. PoolData stores the script code hashes needed to identify this
pool's share tokens, and for xUDT pools its treasury lock. The UP/DOWN share-token args
are still derived on-chain as `own_type_hash || side` (see
[`share_xudt-spec.md`](share_xudt-spec.md) §3). Everything else lives in cell data, led
by `variant`, which **determines the rest of the layout**: a CKB-variant pool omits
`asset_type_hash` and `treasury_lock_code_hash`; an xUDT-variant pool includes both.

### Fields (logical order)

| Field | Type | Class | Present | Meaning |
|---|---|---|---|---|
| `variant`         | u8   | config | always | `0` = CKB, `1` = xUDT |
| `asset_type_hash` | Byte32 | config | xUDT only | xUDT type hash of the staked asset |
| `share_xudt_code_hash` | Byte32 | config | always | code hash of this pool's UP/DOWN share xUDT script |
| `treasury_lock_code_hash` | Byte32 | config | xUDT only | code hash of this pool's TreasuryCell lock script |
| `feed_id`         | Byte32 | config | always | Pyth feed this pool prices = the oracle type's **args** (locates the cell) |
| `oracle_commit`   | Byte32 | config | always | `H(oracle_code_hash ‖ guardian_set_type_hash ‖ emitter_chain ‖ emitter_address)` — pins the oracle type + trust root in one hash |
| `start_time`      | u64  | config | always | activation boundary (unix secs) |
| `close_time`      | u64  | config | always | resolution boundary (unix secs) |
| `up_total`        | u128 | state  | always | total staked on UP (asset base units) |
| `down_total`      | u128 | state  | always | total staked on DOWN |
| `start_price`     | i64  | state  | always | oracle price at activation |
| `settle_price`    | i64  | state  | always | oracle price at (provisional) resolution |
| `used_pt`         | u64  | state  | always | `publish_time` of the tick backing the current price. In LOCKED it tracks the **start** tick (in `(start,close)`); RESOLVE flips it to the **settle** tick (in `(close,void)`). Corrections only lower it within a phase. 0 until activation |
| `rake_bps`        | u16  | config | always | treasury cut of losing pool, basis points |
| `status`          | u8   | state  | always | see §1.2 |
| `winner`          | u8   | state  | always | see §1.2 |

### Concrete offsets

**CKB variant (`variant == 0`), `POOL_LEN_CKB = 173`:**

```
0..1     variant (=0)        97..105   start_time
1..33    share_xudt_code    105..113   close_time
33..65   feed_id            113..129   up_total
65..97   oracle_commit      129..145   down_total
                            145..153   start_price
                            153..161   settle_price
                            161..169   used_pt
                            169..171   rake_bps
                            171..172   status
                            172..173   winner
```

The oracle-identity block is `feed_id ‖ oracle_commit` (64 bytes). `oracle_commit`
recombines the oracle type code hash + trust root (see §3); `find_oracle` recomputes
it from the dep cell.

**xUDT variant (`variant == 1`), `POOL_LEN_XUDT = 237`:**

```
0..1       variant (=1)              161..169   start_time
1..33      asset_type_hash           169..177   close_time
33..65     share_xudt_code_hash      177..193   up_total
65..97     treasury_lock_code_hash   193..209   down_total
97..129    feed_id                   209..217   start_price
129..161   oracle_commit             217..225   settle_price
                                      225..233   used_pt
                                      233..235   rake_bps
                                      235..236   status
                                      236..237   winner
```

### 1.2 Enums

```
status:  0 OPEN   1 LOCKED   2 SETTLED   3 CLOSED   4 VOID   5 FINALIZED
winner:  0 UNDECIDED   1 UP   2 DOWN   3 VOID
variant: 0 CKB   1 xUDT
```

`SETTLED` is *provisional* (contestable); `FINALIZED` is the latched, redeemable
result. `CLOSED` is reserved/unused: CLOSE is terminal consumption, so no output cell
ever carries status `3`. See §2 (RESOLVE/CORRECT/FINALIZE).

### 1.3 Rust shape (mirrors `oracle_data.rs`)

`asset_type_hash` and `treasury_lock_code_hash` are `Option`, set iff `variant == 1`.
`share_xudt_code_hash` is always present. `from_bytes` reads `variant` first, then
branches on length (`173` vs `237`).

```rust
pub struct PoolData {
    pub variant: u8,
    pub asset_type_hash: Option<[u8; 32]>, // Some iff variant == 1
    pub share_xudt_code_hash: [u8; 32],
    pub treasury_lock_code_hash: Option<[u8; 32]>, // Some iff variant == 1
    pub feed_id: [u8; 32],
    pub oracle_commit: [u8; 32], // H(code_hash ‖ guardian_set_type_hash ‖ emitter_chain ‖ emitter_address)
    pub start_time: u64,
    pub close_time: u64,
    pub up_total: u128,
    pub down_total: u128,
    pub start_price: i64,
    pub settle_price: i64,
    pub used_pt: u64, // publish_time backing settle_price (corrections lower it)
    pub rake_bps: u16,
    pub status: u8,
    pub winner: u8,
}

impl PoolData {
    pub fn from_bytes(d: &[u8]) -> Option<Self> { /* peek variant, branch on len 173/237 */ }
    pub fn to_bytes(&self) -> Vec<u8> { /* variant, script config, oracle config, tail */ }
    pub fn config_unchanged(&self, o: &Self) -> bool {
        self.variant == o.variant
            && self.asset_type_hash == o.asset_type_hash
            && self.share_xudt_code_hash == o.share_xudt_code_hash
            && self.treasury_lock_code_hash == o.treasury_lock_code_hash
            && self.feed_id == o.feed_id
            && self.oracle_commit == o.oracle_commit
            && self.start_time == o.start_time
            && self.close_time == o.close_time
            && self.rake_bps == o.rake_bps
    }
}
```

`config` fields are immutable after CREATE; only `up_total`, `down_total`,
`start_price`, `settle_price`, `used_pt`, `status`, `winner` ever change.

---

## 2. Transitions

`pool_type` detects the transition from `(input_status → output_status)` and tx shape.
The **price phase (ACTIVATE → … → FINALIZE) runs on the oracle's authenticated
`publish_time`**, not the header timestamp; only CLOSE (duration-proportional teardown grace)
reads the header clock (see [`timing-spec.md`](timing-spec.md) §3.2). DEPOSIT no longer reads
it — it is bounded by status (`OPEN→OPEN` only).
`config_unchanged` is implied wherever the PoolCell is both consumed and recreated.
**The grace/contest length is derived on-chain** — `grace = clamp(duration/10, 60s, 600s)`,
giving `void_time = close_time + grace` — not stored per-pool.

### CREATE — (no input pool) → output `OPEN`

- `status == OPEN`, `winner == UNDECIDED`, `up_total == down_total == 0`
- `start_price == settle_price == 0`
- `share_xudt_code_hash != 0`
- `start_time < close_time`; `rake_bps ≤ 10_000`. The window is **not** required to be
  in the future — a past window is self-punishing (ACTIVATE routes to VOID), so CREATE
  reads no header clock. `rake_bps ≤ 10_000` is load-bearing (prevents a u128 underflow
  in REDEEM's `distributable`), not a redundant sanity check. `used_pt` is unchecked —
  ACTIVATE overwrites any seeded value before it can be read.
- typeID `args` correctly seeded (`hash(first_input, out_idx)`)
- variant `0`: no TreasuryCell. PoolCell capacity above the occupied base is not
  enforced to be zero — any surplus is creator-supplied and is reclaimed by the
  creator at CLOSE; payouts are bounded by the parimutuel math, not capacity, so a
  surplus can't be over-redeemed.
- variant `1`: `asset_type_hash != 0` and `treasury_lock_code_hash != 0`; **enforced** —
  exactly one TreasuryCell is created with type==asset xUDT,
  lock==`Script{treasury_lock_code_hash, args: pool_type_hash}`, balance `0`. This makes
  the pool depositable (the first deposit has an input treasury to grow) and prevents
  seeding treasury value the totals don't reflect.
- Authorization: creator's lock (anyone may create pools)

### DEPOSIT / WITHDRAW — `OPEN → OPEN`

`OPEN→OPEN` covers **both** staking and un-staking. Correctness is enforced as a standing
**invariant on the output**, not as a signed delta — so totals may rise OR fall on either side
(deposit, withdraw, or rebalance) before the round locks. Anchored at CREATE's zero state, the
invariant holds inductively across every `OPEN→OPEN`.

- `config_unchanged`; `start_price/settle_price/used_pt/winner` unchanged. **No header-clock
  gate:** deposits are bounded by status, not time — a deposit only validates `OPEN→OPEN`, and
  ACTIVATE leaves OPEN the instant `start_price` is set, so "start price set" and "deposits
  closed" are one event. (Residual: deposits remain possible in the `[start_time, ACTIVATE]`
  gap while the pool is still OPEN; relies on prompt activation, funds conserved regardless.)
- **No direction constraint** on the totals. (A withdrawer must own — and burn — the shares,
  so they cannot pull out more than they put in; the share invariant below enforces it.)
- **Funds rhyme with totals:**
  - xUDT — `treasury_out_balance == up_total + down_total` (**absolute**; one fully-visible
    TreasuryCell), and the PoolCell's own capacity is unchanged. Funding *provenance* is NOT
    re-checked here — the staked asset's own xUDT type script already conserves its supply, so a
    correct treasury balance implies the matching asset really moved to/from a holder cell (see
    §3). The old per-depositor `depositor_io` sum was redundant with that and is removed.
  - CKB — `out_cap + (prev.up+prev.down) == in_cap + (next.up+next.down)` (the unsigned,
    no-subtraction form of `Δcapacity == Δtotal`, valid for deposit and withdraw). Capacity is
    *not* checked absolutely because it carries the cell's occupied base + creator surplus.
- **Shares rhyme with totals, per side:** `side_out + prev.side_total == side_in + next.side_total`
  (the unsigned form of `Δshares == Δtotal`, valid for mint **and** burn). The expected token is
  `Script{share_xudt_code_hash, args: own_type_hash || side}`. `share_xudt` gates mint/burn on
  PoolCell presence; `pool_type` pins the side and amount. (Shares cannot be checked *absolutely*
  — the script can't see global supply — but delta + CREATE anchor ⇒ `side_supply == side_total`
  inductively.)
- Permissionless (continuation: output carries same `pool_id`)

### ACTIVATE — `OPEN → LOCKED` (provisional start) or `OPEN → VOID`

The start price is a contest too, symmetric to resolution and on the **same oracle clock**
— its window is `(start_time, close_time)` (the whole LOCKED phase; there is no separate
`void_time` for the start price — `close_time` is the deadline). The oracle CellDep is
pinned by `oracle_commit` exactly as elsewhere (`find_oracle`). All branches freeze
totals/funds/capacity and share supply (`inputs == outputs` for both share sides).

> **xUDT treasury — excluded, not conserved.** A transition moves no staked asset, so
> `phase_frozen` forbids the TreasuryCell from the transaction on **both** sides: not in
> inputs (its `treasury_lock` is permissive while the PoolCell is in inputs, so it could be
> drained), and not in outputs (a phantom second treasury would later break redeem/close,
> which require exactly one). The treasury persists untouched as a live singleton between
> transitions, changing only on DEPOSIT/REDEEM (and swept at CLOSE). This applies uniformly
> to ACTIVATE/CORRECT-start/RESOLVE/CORRECT/FINALIZE.

- **LOCKED (provisional):** require both sides funded (`up_total>0 && down_total>0`), and an
  oracle tick with `start_time < publish_time < close_time`. Set `start_price = price`,
  `used_pt = publish_time`, `winner = UNDECIDED`, `settle_price = 0`.
- **VOID:** one-sided (`up_total==0 || down_total==0`) proven past start
  (`publish_time > start_time`), **or** never-activated (`publish_time ≥ close_time`). Set
  `winner = VOID`; `start_price/settle_price/used_pt = 0`.

#### CORRECT-start — `LOCKED → LOCKED`

- Require an oracle tick with `start_time < publish_time < used_pt` — strictly **earlier**
  than the recorded start tick. Recompute `start_price`, `used_pt`. `settle_price`/`winner`
  stay empty. Converges to the first post-start tick; permissionless.
- RESOLVE later **flips** `used_pt` from the start tick `(start, close)` to the settle tick
  `(close, void_time)` and freezes `start_price`.

### Resolution phase — the oracle `publish_time` is the clock

Resolution does **not** use the header timestamp. The oracle's authenticated
`publish_time` both prices the pool and bounds real time (Pyth can't sign a future tick,
and v3 zero-init creation means a nonzero `publish_time` ⟹ the price was VAA-verified). Let
`void_time = close_time + grace`. The oracle CellDep is pinned exactly as in ACTIVATE
(`feed_id` + `oracle_commit`). All of RESOLVE/CORRECT/FINALIZE freeze totals, funds,
`start_price`, capacity, and share supply (`inputs == outputs` for both share sides).

`winner(price) = price > start_price ? UP : price < start_price ? DOWN : VOID` (a tie is
`winner = VOID` while staying **SETTLED**, so a correction can still adjust it).

#### RESOLVE — `LOCKED → SETTLED` (provisional) or `LOCKED → VOID`

- **SETTLED:** require an oracle tick with `close_time < publish_time < void_time`. Set
  `settle_price = price`, `used_pt = publish_time`, `winner = winner(price)`.
- **VOID** (no resolution happened): require an oracle tick with `publish_time ≥ void_time`
  (authentic proof the window closed). Set `winner = VOID`; `settle_price`/`used_pt` stay 0.
- Permissionless.

#### CORRECT — `SETTLED → SETTLED` (the contest)

- Require an oracle tick with `close_time < publish_time < used_pt` — strictly **earlier**
  than the recorded one (monotone-down; floor is the first post-close tick).
- Recompute `settle_price = price`, `used_pt = publish_time`, `winner = winner(price)`.
- Permissionless; converges to the canonical first tick, so a griefer can only push toward
  the truth.

#### FINALIZE — `SETTLED → FINALIZED` (the latch)

- Require an oracle tick with `publish_time ≥ void_time` (authentic proof the contest
  window closed). **Nothing but `status` changes.**
- After this, no CORRECT is possible (status ≠ SETTLED) and redemption opens. The latch
  uses authentic oracle time, not the (backward-manipulable) header — otherwise a late
  CORRECT could flip the winner after payouts began.

### REDEEM — `FINALIZED → FINALIZED` (winner) / `VOID → VOID` (refund)

Let `winner_total = (winner==UP ? up_total : down_total)`,
`loser_total = (winner==UP ? down_total : up_total)`.

- **FINALIZED, winner ∈ {UP,DOWN}:** burner inputs `X > 0` of the **winning** token; burned.
  ```
  distributable = loser_total − floor(loser_total × rake_bps / 10_000)
  payout        = X + floor(X × distributable / winner_total)   # principal + share
  ```
  treasury/capacity −`payout`, routed to the burner's lock.
- **FINALIZED, winner == VOID (tie) or VOID (no-resolution):** burner inputs `X` of either
  token; burned; `payout = X` (1:1 refund).
- PoolCell state **unchanged** (`settle_price`/`used_pt`/`winner`/totals frozen).
- Permissionless (continuation).

### CLOSE / sweep — `FINALIZED|VOID → (consumed, no output)`

> Terminal consumption (1→0): the PoolCell is destroyed, not rewritten to a
> "CLOSED" status. (`STATUS_CLOSED = 3` is a reserved, unused enum value.)

- `now > close_time + close_grace(duration)` where `close_grace = clamp(duration·8, 1h, 7d)`;
  only a **FINALIZED** or **VOID** pool may be swept (never a still-contestable SETTLED).
- **Shares frozen:** share inputs equal share outputs for both sides (defense-in-depth).
- residual dust → treasury/DAO fee lock; authorization is the lock's concern (not continuation).

---

## 3. Out of scope for `pool_type` (delegated)

- **`share_xudt`** — UP/DOWN mint/burn only when the owning PoolCell is present (binds via
  `args = pool_type_script_hash || side`; `pool_type` derives the expected token type from
  its own hash). See [`share_xudt-spec.md`](share_xudt-spec.md).
- **`treasury_lock`** — thin guard: TreasuryCell spendable only with a PoolCell of
  matching `pool_id` in inputs.
- **staked-asset xUDT** — conserves its own supply (`Σ inputs == Σ outputs` of `asset_type_hash`).
  `pool_type` relies on this for DEPOSIT/WITHDRAW funding provenance: it pins only the treasury
  balance (`== up_total + down_total`) and trusts the asset script for where the asset came
  from/went. A pool configured with a non-conserving asset is worthless GIGO (same class as a
  bad `share_xudt_code_hash`), so this delegation adds no real-world attack surface.
- **`pool_admin_lock`** — spend on continuation (same `pool_id` in outputs) for
  permissionless activate/resolve/correct/finalize/redeem; creator/treasury auth for CLOSE.
- **Oracle authenticity** — Lean Oracle's job (incl. v3 zero-init creation, so a nonzero
  `publish_time` ⟹ VAA-verified); `pool_type` constrains only *timing* (the contest window)
  and *identity* (`oracle_commit`).

---

## 4. Invariants (test in `ckb-testtool`)

1. Funds conserved: `Δtreasury == Δ(up_total + down_total)` on deposit; `== −payout` on
   redeem.
2. Shares outstanding per side `==` that side's total until settlement.
3. `Σ payouts ≤ up_total + down_total` (bounded by share supply; equals total minus rake
   at full redemption).
4. `config` fields never change after CREATE.
5. `start_price` is an authentic tick with `start < publish_time < close`, refined by
   CORRECT-start toward the first post-start tick, frozen at RESOLVE. `settle_price` is an
   authentic tick with `close < publish_time < void_time`, refined by CORRECT-settle toward
   the first post-close tick, frozen at FINALIZE. (`used_pt` is monotone-decreasing within
   each phase; RESOLVE flips it between phases.)
6. Status only advances `OPEN → LOCKED → SETTLED → FINALIZED` or `… → VOID`; CLOSE is
   terminal consumption. `LOCKED→LOCKED` / `SETTLED→SETTLED` corrections lower `used_pt`
   only; no reversal.
</content>
