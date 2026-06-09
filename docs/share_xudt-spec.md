# `share_xudt` — UP/DOWN share token spec

> The fungible position tokens. xUDT-**data**-compatible (wallets read balances normally)
> but with custom **governance**: supply changes only when the owning PoolCell is present
> and `pool_type` approves. Companion to [`pool_type-spec.md`](pool_type-spec.md).

---

## 1. Identity

One `share_xudt` code, parameterised by `args`:

```
args = pool_type_script_hash (32 bytes)  ||  side (1 byte)     # 33 bytes
side:  1 = UP   2 = DOWN
```

`pool_type_script_hash` is the **full type-script hash of the owning PoolCell** (i.e.
`hash(pool_type_code, hash_type, pool_id)`). UP and DOWN are distinct tokens because their
`side` byte differs, so xUDT conservation sums each side independently. `share_xudt`
**rejects any `side` other than 1 or 2** (`args.len()==33 && side∈{1,2}`), so no off-side
"junk" token can exist — otherwise it would mint freely in any pool-present tx (harmless,
since REDEEM only sums sides 1/2, but it would pollute wallets).

**Cell data** is standard xUDT: amount as `u128` little-endian in the first 16 bytes
(optional extension after). So existing xUDT wallets/indexers display share balances with
no special support.

---

## 2. Three modes

`share_xudt` runs on every cell of its type and picks a mode from tx shape:

| Mode | Condition | Rule |
|---|---|---|
| **TRANSFER** | no PoolCell with type hash == `args.pool_type_script_hash` in inputs | standard xUDT: `Σ inputs(this type) == Σ outputs(this type)` (supply conserved) |
| **MINT / BURN** | such a PoolCell **is** in inputs | supply may change; **amount/side correctness is delegated to `pool_type`** |

That's the whole script: *is the owning PoolCell present? If yes, defer to it; if no,
conserve.* All value logic lives in `pool_type`, which necessarily runs because the
PoolCell is consumed.

---

## 3. Non-circular binding (important)

The two scripts reference each other **without** a code-hash cycle:

- `share_xudt` → PoolCell: by the **value** in its own `args`
  (`pool_type_script_hash`). It scans inputs for a cell whose *type-script hash* equals
  that value. It does **not** hardcode `pool_type`'s code hash.
- `pool_type` → share token: it hardcodes `SHARE_XUDT_CODE` (a deploy constant), computes
  its **own** type-script hash `H = hash(load_script())`, and derives the expected token
  type as `Script{ SHARE_XUDT_CODE, args: H || side }`.

So only `pool_type` hardcodes a cross-script code hash (→ `share_xudt`); `share_xudt`
carries the binding as data. One-directional ⇒ deployable (deploy `share_xudt` first).

**Consequence — PoolData no longer stores `up_token_args` / `down_token_args`.** They are
derivable on-chain from `H` + `side`, so the two 32-byte fields are removed from the
layout (see `pool_type-spec.md` §1). Symmetric binding is preserved: the pool computes the
token type; the token checks the pool is present.

---

## 4. Precision of the gate

- Including PoolCell **A** authorizes *only* A's tokens: token B's `share_xudt` looks for
  B's `pool_type_script_hash` in inputs, doesn't find it (only A's PoolCell is there), and
  falls to TRANSFER ⇒ B's supply can't change. No cross-pool minting.
- With A present, `share_xudt` permits *any* supply change of A's tokens — but `pool_type`
  pins the exact deltas:
  - **DEPOSIT:** exactly `D` of the chosen `side` minted to the depositor; the other side
    unchanged; `D == treasury/capacity delta`.
  - **REDEEM:** exactly `X` of the winning `side` burned; payout math enforced.
- **No PoolCell ⇒ no mint/burn.** Shares can only come into or out of existence inside a
  pool deposit/redeem; otherwise they only transfer (so the secondary market works freely).

---

## 5. Lifecycle

```
DEPOSIT  (PoolCell OPEN in inputs)   → MINT  D of side  → depositor's lock   (transferable)
… secondary trades …                 → TRANSFER          (no PoolCell needed)
REDEEM (PoolCell FINALIZED|VOID in inputs)→ BURN X of winner → payout from treasury
```

A loser's shares are simply never burned via a winning redeem; after CLOSE they are inert
(no treasury left to claim against). VOID path burns either side 1:1 for refunds.

---

## 5a. Security invariant — `pool_type` must pin supply on EVERY pool-present tx

`share_xudt` returns `0` (fully permissive — mint/burn any amount of either side)
**whenever the owning PoolCell is in inputs**. It delegates *all* supply control to
`pool_type`. The safety of the whole scheme therefore rests on one invariant:

> Every transition that puts the PoolCell in inputs must itself pin **every** share
> movement of both sides.

The PoolCell is in inputs for DEPOSIT, ACTIVATE, CORRECT-start, RESOLVE, CORRECT-settle,
FINALIZE, REDEEM, and CLOSE. DEPOSIT (`net_minted(side)==D`, other `==0`) and REDEEM
(`burned_w==X>0`, `burned_l==0`, payout pinned) constrain shares directly. **Every other
PoolCell-consuming transition moves no shares, so it must explicitly freeze supply** —
`net_minted(UP)==0 && net_minted(DOWN)==0` (`shares_frozen`, called from `phase_frozen` for
ACTIVATE/CORRECT/RESOLVE/FINALIZE and directly in CLOSE). Without that, anyone running the
permissionless RESOLVE — who already
knows the winning side, since the settling oracle price is public — could mint winning
shares from nothing in the same tx and drain the treasury. This was a real gap found in
audit and is now closed + regression-tested
(`resolve_minting_winning_shares_rejected`, `activate_minting_shares_rejected`).

CREATE is safe without a check: the new PoolCell is an *output*, so `share_xudt` is in
conserve mode (mint impossible). CLOSE's freeze is defense-in-depth — post-teardown shares
are unredeemable anyway (REDEEM needs the live PoolCell), but the invariant stays uniform.

## 6. Notes

- `share_xudt` needs no notion of time, price, or totals — it is a thin gate. This keeps
  the audit surface tiny and the heavy logic in one place (`pool_type`).
- Because the gate keys on the PoolCell's *full* type hash (which embeds the typeID
  `pool_id`), every pool's tokens are unique even across identical configs.
</content>
