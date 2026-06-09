# CKB Up/Down — System Architecture

> Status: architecture design (v2 — pool/treasury model). Supersedes the per-bet-cell
> sketch. Grounded in the actual Lean Oracle surfaces (on-chain `OracleData` layout,
> the `lean-oracle-sdk`, the deployment toolbox).
>
> One-line: a **parimutuel BTC up/down prediction pool**. Players deposit into an UP
> or DOWN side of a pool and receive fungible **xUDT share tokens**. The pool is
> activated at `start_time` (start price fetched from the oracle), resolved at
> `close_time` (settle price fetched from the oracle), and winners redeem their
> shares pro-rata against the losing side's funds — all enforced on-chain, no
> custodian, no protocol liquidity.

---

## 1. Core model

Each pool is **two long-lived cells** plus **two xUDT share tokens**:

| Cell | Type script | Lock script | Holds |
|---|---|---|---|
| **PoolCell** (1 per pool) | `pool_type` | `pool_admin_lock` | full pool state (below) |
| **TreasuryCell** (1 per pool, xUDT variant only) | stock `xUDT` | `treasury_lock` | the staked asset, stable typeID + lock for life |
| **UP share** | `share_xudt` (args: pool hash‖UP) | holder's own lock | fungible UP position |
| **DOWN share** | `share_xudt` (args: pool hash‖DOWN) | holder's own lock | fungible DOWN position |

**PoolCell data** — minimal, manual little-endian, led by `variant` (which decides
whether `asset_type_hash` is present). `pool_id` lives in the type-script `args`
(it's the typeID), not in data. Full byte offsets in
[`docs/pool_type-spec.md`](docs/pool_type-spec.md).

```
variant                       # 0 = CKB, 1 = xUDT — determines remaining layout
asset_type_hash               # xUDT type hash of staked asset (xUDT variant only)
feed_id                       # oracle feed (e.g. BTC/USD) = the oracle type's args
oracle_commit                 # H(oracle_code_hash ‖ guardian_set_type_hash ‖ emitter_chain ‖ emitter_address)
start_time, close_time
up_total, down_total          # maintained live on every deposit
start_price, settle_price     # written from the oracle at activation / resolution
used_pt                       # publish_time backing the current price; LOCKED→start tick, SETTLED→settle tick (corrections lower it)
rake_bps                      # treasury cut of the losing pool
status                        # OPEN → LOCKED → SETTLED → FINALIZED → CLOSED, or … → VOID
winner                        # UNDECIDED | UP | DOWN | VOID
```

The UP/DOWN share-token identities are **not** stored — they're derived on-chain as
`Script{SHARE_XUDT_CODE, args: own_type_hash || side}`.

### Two variants, one script set

A single `variant` flag (fixed at creation, immutable after) selects how funds are held:

- **CKB variant (`0`):** no TreasuryCell. The **PoolCell's own capacity** is the
  treasury. `pool_type` treats `funds = capacity − occupied_base` so the cell's own
  byte cost never drifts into the accounting.
- **xUDT variant (`1`):** a separate **TreasuryCell** holds the staked xUDT. Its
  `treasury_lock` is a thin guard: *spendable only in a tx that also contains the
  PoolCell* (matched by the pool's typeID). All value logic stays in `pool_type` —
  the lock never duplicates it.

### Shares are fungible xUDT

Each pool has two `share_xudt` tokens (`args = pool_type_script_hash || side`), xUDT-data
compatible so wallets read balances normally. The binding is symmetric and non-circular
(see [`docs/share_xudt-spec.md`](docs/share_xudt-spec.md)):

- `pool_type` derives the expected token type from its own hash + side, and authorizes the
  mint (correct side, correct amount).
- `share_xudt` only permits minting/burning **when the owning PoolCell is present**
  (else it conserves supply like normal xUDT) — no deposit, no shares.

Because positions are fungible xUDT, a holder can **transfer or sell their UP/DOWN
shares before resolution** — you get a secondary prediction market for free.

---

## 2. Lifecycle & transaction flows

```
  deposit (open)   activate (provisional)   resolve (provisional)  finalize   redeem
       │                 │                       │                     │         │
  OPEN ─┼─ … ─► LOCKED ⇄ CORRECT-start ─► SETTLED ⇄ CORRECT-settle ─► FINALIZED ─► CLOSED
       │ shares 1:1   start_price +          settle_price +           latch     burn shares,
       │ funds→treas  used_pt; contest       used_pt (flipped);       once      pay pro-rata
       │              to first post-start    contest to first         pub≥void
       │              tick (start,close)     post-close tick
```

The whole price machinery runs on the oracle's authenticated `publish_time` (§3), reusing
one `used_pt` field per phase. **Both** the start and settle prices are contests: a
provisional value can be replaced by a strictly *earlier* authentic tick (converging to the
first tick after the boundary), so a griefer can only push toward the truth. The start
contest runs over `(start, close)`; RESOLVE flips `used_pt` and freezes `start_price`; the
settle contest runs over `(close, void_time = close + grace)`; FINALIZE (proven by a
`publish_time ≥ void_time` tick) latches the result and opens redemption. A never-activated
or never-resolved pool goes to `VOID`.

### 2.1 Deposit (open window: `now < start_time`, status OPEN)

**xUDT variant:**
```
inputs:  [ PoolCell, TreasuryCell(bal=T), depositor_xUDT(=D+change) ]
outputs: [ PoolCell',                 # up_total or down_total += D
           TreasuryCell(bal=T+D),     # same lock + type, balance up by D
           ShareCell(UP|DOWN, amount=D → depositor's lock),
           depositor_change_xUDT ]
```
**CKB variant:** no TreasuryCell; depositor's CKB raises the PoolCell capacity by `D`.

`pool_type` enforces, in one conservation-checked tx:
- treasury delta (or capacity delta) `== D == minted_shares`
- shares are the **side** the depositor selected, sent to the depositor's lock
- input asset type **matches** `asset_type_hash` (xUDT variant) — no worthless-token mint
- `now < start_time` and status `OPEN`

### 2.2 Activation — provisional start price, then contest (permissionless)

- **ACTIVATE** (OPEN → LOCKED): record an oracle tick with `start < publish_time < close` as
  `start_price` + `used_pt`; requires both sides funded. After this, deposits are rejected.
- **CORRECT-start** (LOCKED → LOCKED): replace it with a strictly **earlier** tick
  (`start < publish_time < used_pt`), converging to the first post-start tick.
- A one-sided pool (proven past `start`) or a never-activated pool (tick `publish_time ≥
  close`) goes **OPEN → VOID** → refund.

RESOLVE (§2.3) freezes `start_price` and flips `used_pt` to the settle phase.

### 2.3 Resolution — provisional, then contest, then finalize (permissionless)

The oracle's authenticated `publish_time` is the clock; `void_time = close_time + grace`.

- **RESOLVE** (LOCKED → SETTLED): record an oracle tick with `close < publish_time <
  void_time` as `settle_price` + `used_pt`; `winner = settle_price ⋛ start_price`
  (tie ⇒ `winner = VOID`, still SETTLED).
- **CORRECT** (SETTLED → SETTLED): replace it with a strictly **earlier** in-band tick
  (`close < publish_time < used_pt`), recomputing the winner. Converges to the canonical
  first post-close tick; a griefer can only push toward the truth.
- **FINALIZE** (SETTLED → FINALIZED): once an authentic tick proves `publish_time ≥
  void_time`, latch the result. No more corrections; redemption opens.
- A never-resolved pool: **LOCKED → VOID** (also proven by a `publish_time ≥ void_time`
  tick) ⇒ refund.

### 2.4 Redeem / claim (status FINALIZED, or VOID)

Winner **burns X winning shares** and withdraws from the treasury:
```
payout(X) = X + (X / winner_total) × (loser_total × (1 − rake))
```
All inputs (`winner_total`, `loser_total`, `rake`) are already fixed in the PoolCell —
totals were maintained live during deposits, so **no consolidation step is needed**.
A finalized tie (`winner = VOID`) or a no-resolution VOID ⇒ each share redeems 1:1
(refund). Rake → treasury/DAO.

---

## 3. Oracle integration — the publish_time contest

The oracle cell is a fixed **152-byte `OracleData`** read by `pool_type` as a
**CellDep** (never spent by the game). It guarantees **authenticity + monotonicity,
not freshness** — so freshness/timing is *our* job.

The oracle's authenticated **`publish_time` is the clock** for the whole price phase, not
the header timestamp (which a tx author can set backward by depping an old block). A signed
tick at time `T` proves both the price *and* that real time ≥ `T` (Pyth can't sign the
future), and v3 zero-init creation means a nonzero `publish_time` ⟹ the price was
VAA-verified. So instead of a one-shot band we run a **contest** that converges to the
canonical first tick after each boundary (full rules: [`docs/timing-spec.md`](docs/timing-spec.md) §3):

```
activate:  start < publish_time < close       ⇒ provisional start_price (CORRECT-start lowers it)
resolve:   close < publish_time < void_time    ⇒ provisional settle_price (CORRECT-settle lowers it)
finalize:  publish_time ≥ void_time            ⇒ latch the result          (void_time = close + grace)
```

A provisional value can be replaced only by a strictly **earlier** authentic tick, so it
walks down to the first tick past the boundary — a griefer can only push *toward* the truth
(this is why we dropped the old strict-straddle / one-shot-band designs: under the
permissionless oracle lock a loser could otherwise advance the monotonic cell one tick past
close to force a VOID). The FINALIZE latch uses authentic oracle time, so a late correction
can't flip the winner after payouts begin.

`pool_type` locates the oracle cell by **feed_id** (its type args), then pins identity with a
single stored **`oracle_commit`** = `H(oracle_code_hash ‖ guardian_set_type_hash ‖
emitter_chain ‖ emitter_address)`, recomputed from the dep cell. The type script alone is
shared by every oracle cell of a feed, so an attacker could otherwise stand up a same-type
cell with their own guardians; the commitment binds the deployed oracle code **and** the
trust root (Wormhole signature root + Pyth source) in one hash, keeping config slim. On-chain
decode reuses the oracle's field offsets (`price` i64 LE, `publish_time` u64, `emitter_chain`
u32, 32-byte hashes).

**Liveness:** resolution needs a boundary-crossing oracle update to exist; anyone can
push one via `lean-oracle-sdk` (`pullUpdate` + `rebalanceFuel`) and earn the settler
fee. If none lands before `void_time = close_time + grace`, the pool **VOIDs and
refunds** — funds never stick.

---

## 4. Throughput: contention today, intents tomorrow

Every deposit/redeem consumes the shared PoolCell (+ TreasuryCell), so per a single
pool these **serialize to one tx per block**. Accepted tradeoff — it buys live totals
(no sum-all-cells problem) and per-tx auditability. Mitigations, in order of effort:

1. **Parallel pools** — contention is per-pool; N pools = N× throughput.
2. **Pool sharding** — split a hot pool into sub-pools summed at settle (add only if needed).
3. **Intent + solver (the scaling path).** Depositors don't submit their own pool-
   mutating tx; they publish an **intent cell** ("deposit D into side S of pool P,
   minted to lock L"). A permissionless **solver** collects many intents and folds
   them into **one** tx that consumes the PoolCell + TreasuryCell once and applies the
   whole batch — moving contention off users entirely while keeping the clean
   single-treasury accounting. `pool_type` verifies the batched conservation
   (Σ intents == treasury delta == Σ minted shares); solver earns a fee. This is the
   intended path once throughput matters.

---

## 5. On-chain components

```text
crates/up_down/
  contracts/
    common/            PoolData layout + reused oracle field offsets
    pool_type/         pool state machine, conservation checks, oracle boundary proof
    share_xudt/        UP/DOWN xUDT governance (mint gated on PoolCell approval)
    treasury_lock/     guard lock: spendable only with PoolCell present (xUDT variant)
    pool_admin_lock/   pool-cell spend/authorization rule
  tests/               host + ckb-testtool integration
deployment/            versioned-promote toolbox (clone of the oracle's pattern)
packages/game-sdk/     placeBet / createPool / activate / resolve / redeem
apps/web/              thin CCC / JoyID UI
```

Mirrors the Lean Oracle repo: Rust workspace, shared `common` crate, one crate per
script, `ckb-testtool` integration, versioned-promote deployment (`deploy:* →
promote:* → deploy:cell`). Staked-asset xUDT and share tokens use **stock xUDT** with
governance pinned to `pool_type`; no custom token VM logic beyond the mint gate.

---

## 6. Off-chain components

- **`game-sdk` (TS, wraps `lean-oracle-sdk`):** `createPool`, `deposit`, `activate`,
  `resolve`, `redeem`, `getPool`, `listShares`. Uses
  `LeanOracleTestnetClient.getOracleCellState({feedId})` for the oracle CellDep and
  `pullUpdate` + `rebalanceFuel` to freshen the price before activation/resolution.
- **Keeper / settler bot:** permissionless; watches pools, pushes the boundary oracle
  update, submits activation/resolution, earns the fee. (Later: also the **solver**
  for batched intents — §4.)
- **Web UI:** CCC / JoyID passkey — connect, deposit UP/DOWN, watch start→settle,
  redeem, view share balances.

---

## 7. Edge cases

- **One-sided pool** (no opposing side): VOID → refund principal.
- **Tie** (`settle == start`): VOID → refund.
- **No boundary oracle update in grace window:** VOID → refund.
- **Unclaimed winnings** past grace: dust → treasury/next pool.
- **Asset mismatch on deposit:** rejected by `pool_type` (`asset_type_hash` check).

---

## 8. Deployment posture

Testnet-only at launch — the oracle is unaudited testnet, so the pool runs as a
play-to-earn with **no mainnet-equivalent value at risk**. Pins the testnet oracle
deployment (`oracle_type` v2 `0x10c9…58ec`, BTC/USD feed `0xe62df6…415b43`). Build via
`make contracts-build` / `make contracts-test`.

---

## 9. Build order (de-risk first)

1. **`pool_type` + oracle boundary proof** — `ckb-testtool` against a mock/real oracle
   cell. Proves the core novelty (start/settle pricing).
2. Deposit conservation + `share_xudt` mint gate + `treasury_lock` (xUDT variant) and
   the CKB-variant capacity path.
3. Redeem / pro-rata payout + rake + VOID refunds.
4. `game-sdk` (`createPool/deposit/activate/resolve/redeem`).
5. Thin CCC/JoyID web UI.
6. **Intent cell + solver** batching (§4) — the throughput upgrade.
7. (Optional) Market-Mood DOB badge layer for gamification.
```
