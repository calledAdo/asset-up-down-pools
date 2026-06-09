# DRAFT — CKB Up/Down (and the idea space around Lean Oracle)

> Status: ideation / design draft. Not a commitment. Captures project ideas that
> build on **Lean Oracle** (a Pyth/Wormhole price oracle for CKB) and a concrete
> build spec for the chosen direction: **CKB Up/Down**, a parimutuel price-
> prediction game.

---

## 0. What the oracle gives a builder

Stripped to essentials, Lean Oracle hands you **authenticated, monotonic Pyth
prices as a single addressable CKB cell** that any script can read as a cell dep.

Per feed, the oracle cell exposes (see `crates/lean_oracle/contracts/common/schemas/lean_oracle.mol`):

- `feed_id`, `guardian_set_type_hash`
- `price`, `conf`, `expo`
- `publish_time`, `prev_publish_time`
- `ema_price`, `ema_conf`
- `emitter_chain`, `emitter_address`

Three properties shape what's worth building:

1. **It's a read primitive, not a liquidity primitive.** It tells you the truth
   about a price; it holds no money. Ideal for low-bootstrap designs where users
   stake against *each other*, not against a protocol pool.
2. **It guarantees authenticity + monotonicity, not freshness.** The consumer
   contract must define *when* a price counts. Natural fit for round-based games.
3. **It's testnet and unaudited.** Which aligns with games / play-to-earn that
   don't put mainnet-equivalent value at risk on day one.

Combined with CKB-native pieces — **Spore DOBs** (on-chain generative NFTs),
**xUDT** (your platform token), **Nervos DAO** (native yield), **CCC/JoyID**
(passkey wallets) — the sweet spot is **gamified, parimutuel/skill-based,
token-incentivized** apps.

---

## 1. Idea shortlist (ranked)

### ⭐ Top pick — CKB Up/Down (parimutuel price prediction)
Round-based UP/DOWN staking settled by the oracle. Parimutuel = players fund
each other → **no protocol liquidity, no market risk**. Gamified (streaks,
leaderboards, seasons), distributes a **platform token** (predict-to-earn), and
uses the oracle for exactly what it's good at. Closest reference: PancakeSwap
Prediction, but CKB-cell-native and Pyth-secured. **This is the chosen build.**

### Strong second — Paper Trading League
Each player mints a **trader cell** with a virtual balance, opens/closes
synthetic longs/shorts marked to the oracle. Seasons + leaderboard; top traders
win the platform token + a DOB trophy. **Zero real liquidity** (positions are
virtual), great risk-free onboarding ramp, most "give tokens to users" of the set.

### Most novel — Market Mood (price-reactive dynamic DOBs)
A **Spore DOB whose on-chain traits derive live from the oracle cell** (cell dep).
A creature that's bullish/green when `ema_price` trends up, evolves at price
milestones, looks battered in drawdowns. Tiny mint cost, **no liquidity**,
inherently collectible. Strongest "only-on-CKB" demo, and a perfect **badge/NFT
layer** for the two games above.

### Honorable mentions
- **No-loss prize game (PoolTogether-style):** deposits earn **Nervos DAO**
  yield that funds a periodic prize; principal never at risk. Gamified + rewards,
  but needs deposits (liquidity) and barely uses the oracle → weaker fit.
- **Price-triggered intents / limit-order cells:** "execute when BTC < X" using
  the oracle as a trigger. Useful infra, not gamified, leans on real liquidity.

**Recommendation:** Build **CKB Up/Down** as the core, **Market Mood DOBs** as
the achievement/badge layer, and an **xUDT predict-to-earn token** across both.
Hits all four goals (low/no liquidity, gamified, distributes tokens, consumes the
oracle well) and doubles as the best live demo of the oracle.

---

## 2. CKB Up/Down — game loop

A feed (BTC/USD) runs back-to-back **rounds** of fixed length (configurable,
e.g. 1 hr). Each round has three timestamps: `open → lock → close`.

- **Open window:** players stake CKB into the **UP** or **DOWN** side.
- **Lock:** betting closes; the round records `lock_price` from the oracle.
- **Close:** round records `settle_price`; outcome = `settle_price > lock_price ? UP : DOWN`.
- **Claim:** the winning side splits the losing side's pool pro-rata to stake,
  plus their own principal back. Losers forfeit stake. Everyone who played earns
  the platform token.

Parimutuel = players fund each other, so the protocol holds **no liquidity and
takes no market risk**. Launchable with two users.

---

## 3. Cell architecture (UTXO-native — the crux)

The naive design (one shared "pool cell" updated per bet) is wrong on CKB: only
one tx can consume a given cell per block, so concurrent bettors would contend
and most txs would fail. The idiomatic fix is **independent per-bet cells**.

| Cell | Type script | Lock script | Data |
|---|---|---|---|
| **BetCell** (one per bet) | `bet_type` | `game_payout_lock` | `{round_id, side, stake, owner_lock_hash}` |
| **RoundCell** (one per round) | `round_type` | `game_admin_lock` | `{round_id, open/lock/close times, lock_price, settle_price, outcome, up_total, down_total, status}` |
| **TokenIssuerCell** | xUDT owner | — | platform-token emission accounting |

- Betting creates **independent** BetCells → **zero contention** in the hot path.
  Each carries `stake + min capacity`, all under the same `game_payout_lock`.
- The RoundCell is the only shared cell, touched only at lock/settle (twice per
  round) — no contention with bettors.

---

## 4. Oracle integration — the elegant part (`prev_publish_time` boundary proof)

The oracle guarantees authenticity + monotonicity, not freshness, and a
submitter could *choose* which update to lock with. Close that hole using a field
the oracle already stores: **`prev_publish_time`**.

To record `lock_price`, the `round_type` script requires the referenced oracle
cell satisfy:

```
prev_publish_time < lock_time ≤ publish_time
```

That proves the chosen update is **exactly the boundary-crossing one** — the
first price at/after `lock_time` — so the submitter can't cherry-pick a stale or
favorable tick. Same check for `settle_price` against `close_time`. The RoundCell
stores the oracle `outPoint` + `publish_time` used, so settlement is fully
auditable. Because prices are Pyth/Wormhole-signed, no one can forge a value; the
only thing to constrain is *timing*, and `prev_publish_time` does it.

`game_admin_lock` here means "anyone can finalize, but only with a valid
boundary-crossing oracle proof" — settling stays **permissionless** (matches the
oracle's own ethos), and the settler earns a small fee for doing the work.

---

## 5. Transaction flows

1. **Open bet** — `inputs: user CKB → outputs: BetCell`. `bet_type` checks: round
   is in open window (RoundCell as cell dep), side ∈ {UP, DOWN}, stake ≥ min,
   `owner_lock_hash` set.
2. **Lock** — consume RoundCell, set `lock_price` via the oracle proof above;
   status `OPEN → LOCKED`.
3. **Settle** — consume RoundCell after close, set `settle_price` + `outcome`;
   status `LOCKED → SETTLED`.
4. **Claim / sweep** — a settler consumes a batch of the round's BetCells,
   references the SETTLED RoundCell (cell dep), and produces **payout cells locked
   to each winner's `owner_lock_hash`**. `bet_type` enforces the parimutuel math;
   losers' capacity flows to winners. Batched for scale, with a running tally in
   the RoundCell if a round is huge.

---

## 6. Parimutuel math & edge cases

- Winner payout = `principal + (stake / winning_total) × (losing_total − rake)`.
- **Rake:** 1–2% of the losing pool → treasury (funds token buyback / DAO). Keep
  small to stay fair.
- **One-sided round** (no losers): void → refund all principal.
- **Tie** (`settle == lock`): void → refund.
- **No-show winners** (unclaimed after a grace period): roll to treasury or next
  round.

---

## 7. Platform token (xUDT — working name "PRDT")

- **Emission:** each settled round mints a decaying amount, split among that
  round's bettors **pro-rata to stake** (so sybil-splitting gains nothing; pairs
  with a min-stake floor).
- **Utility:** governance over round length / rake / feeds, fee discounts,
  boosted emissions, and **minting Market-Mood DOB badges** (achievement layer).
- **Distribution:** minted at claim time alongside payouts — no separate airdrop
  machinery.

---

## 8. Trust & security notes (stated honestly)

- Inherits the oracle's trust model (Wormhole quorum + Pyth emitter); the oracle
  is **unaudited testnet**, so this launches as a **testnet game with no
  mainnet-equivalent value at risk** — the right posture for a play-to-earn launch.
- Settlement liveness depends on *someone* pushing the boundary update; the
  settler fee is the incentive. If no update lands in the grace window, the round
  voids and refunds.
- All value movement is enforced by `bet_type` math, not a custodian.

---

## 9. What to reuse from this repo

- `lean-oracle-sdk` → read oracle state, draft the lock/settle update txs
  (`getOracleCellState`, the update + `rebalanceFuel` helpers).
- The `common` crate's `oracle_data` layout → decode `price` / `publish_time` /
  `prev_publish_time` **on-chain** in `bet_type` / `round_type` (reference the
  oracle cell as a cell dep, decode with the shared layout).
- Deployment toolbox pattern → ship `bet_type`, `round_type`, `game_payout_lock`
  with the same versioned-promote flow.

---

## 10. MVP milestones

1. `round_type` + oracle boundary-proof (the core novelty) — host tests with
   `ckb-testtool`. **Prototype this first to de-risk the whole design.**
2. `bet_type` + `game_payout_lock` + parimutuel claim math.
3. xUDT emission hook + min-stake / anti-sybil.
4. SDK helpers (`placeBet`, `lockRound`, `settleRound`, `claim`) mirroring the
   existing SDK style.
5. Thin web UI (CCC / JoyID passkey login) — bet, watch the round, claim.
6. DOB badge minting as the gamification layer.

---

## 11. Open questions / decisions to make

- Round length(s): single fixed cadence vs. multiple parallel cadences (5m / 1h / 1d)?
- Settle incentive: fixed settler fee vs. share of rake?
- Emission curve: flat, linear decay, or halving epochs?
- Anti-sybil floor: min stake amount and/or min round participants for emissions?
- Which feeds at launch (BTC/USD only, or add ETH/SOL once hosted)?
- Treasury governance: multisig vs. token-vote DAO from day one?
