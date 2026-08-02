# Builder Track Weekly Report — July 2026 (Week 4)

**Name:** Adokiye
**Project:** CKB Up/Down — asset up/down prediction pools
**Repository:** https://github.com/calledAdo/asset-up-down-pools
**Builds on:** [Lean Oracle](https://github.com/calledAdo/lean-oracle)

> Every prior week ended on the same caveat: the keeper and the oracle subsystem were unit-tested
> but had **never run against a live chain**. Week 4 removed that caveat. The redesigned keeper,
> the oracle worker, and — for the first time — the **real Lean Oracle path** (real Pyth BTC/USD
> from Hermes, verified on-chain against the Wormhole guardian set) were all driven end-to-end on
> a live offckb devnet. This report covers the live devnet validation.

## ✅ Completed Tasks

### Repaired the integration harness

- Brought the opt-in devnet integration harness back in step with the SDK's subpath re-layout so
  it builds and runs, then structured it as a small board of scenarios sharing one bootstrap
  (fresh deps, funded keeper/oracle/player wallets, isolated per-run creator lock).

### Mode-A — the keeper runtime, live, on a mock oracle

Drove the **production** keeper runtime (service + `Keeper` + `Timeline` + executor + reconciler),
not the SDK builders directly, against a live node with a manually-published mock oracle cell so
each transition's exact input tick is controlled:

- **Full lifecycle** — one pool taken CREATE → DEPOSIT → ACTIVATE → RESOLVE → FINALIZE → REDEEM →
  BURN unattended, on the keeper's own timers; verified stamped start/settle prices, the winner,
  the pro-rata payout (496 CKB), and share burns.
- **Batching** — two coincident same-feed pools folded into one transaction (`batch[2]`).
- **VOID collapse** — a one-sided / lagging pool routed to a VOID output through the ordinary
  `activate`/`resolve` builders, matching the contract's own routing.
- **Lagging-tick retry** — when the oracle cell hadn't advanced past a boundary, the keeper backed
  off on the shared grid and retried without spinning the node.
- **Restart recovery** — a keeper stopped mid-round and restarted picked the pool back up from
  chain truth and finished it, with no stored action.
- **Lane scope** — a keeper ignored a pool of an unconfigured duration under its own lock.

### A shutdown fix found by running it

- Running the restart scenarios surfaced a real defect: `stop()` returned while wakes were still
  in flight. Fixed the keeper/watcher to **drain in-flight wakes on `stop()`** for a clean
  shutdown, so a restart never races a half-finished transition.

### Mode-B — the REAL Lean Oracle, end-to-end

The one subsystem never exercised live. No mock cell — instead the production `OracleWorker` (the
sole cell writer) advanced a live Lean Oracle cell by pulling **real Pyth BTC/USD updates from
Hermes on-chain**, each a Wormhole VAA verified against the guardian set, while the keeper read
that cell through the read-only source and drove a full round off real prices:

- Minted our own permissionless oracle cell for the feed (the canonical cell is under an
  owner-bind lock we don't hold) — sound because `oracle_commit` is **identity-only** (oracle-type
  code hash ‖ guardian-set type hash ‖ emitter), independent of the cell instance or its lock, so
  pools bind the same commit and the contract's `find_oracle` accepts our cell.
- **Unblocked a stale deployment.** The devnet deploy's guardian set (index 6) had gone stale when
  Wormhole rotated to index 7 with changed membership, so a set-6 cell fails on-chain verification.
  Recovered the real current set by **reconstructing it from live VAA signatures** — `ecrecover`
  over each Hermes update's Wormhole signatures yields each signer's address at its guardian index;
  unioning a batch of recent updates reconstructs the active set — then deployed a fresh
  guardian-set cell and bound the pool to that identity. The on-chain verification stayed fully
  genuine throughout.
- Result, verified live: a round settled entirely off real oracle reads — start price ~$64,286,
  settle price ~$64,291, winner UP, payout 496 CKB, every advance a real on-chain Hermes pull.

---

## 📚 Key Learning Areas

### 1. "Unit-tested" and "works live" are different claims

Several defects only appeared once the code ran against a real node on real timers — most sharply
the `stop()`-during-in-flight-wake race, which no fixture had caught. Live validation is not a
formality after unit tests; it tests the parts unit tests structurally can't.

### 2. Identity-only commitments are an escape hatch

Because a pool commits to the oracle's *identity*, not to a specific cell or lock, a fresh
personal cell of the same identity is fully substitutable for a canonical cell whose key is
unavailable. Designing the commitment to exclude instance/lock is what made the whole Mode-B run
possible without the original deployer's key.

### 3. A rotated guardian set is recoverable from the data itself

An external dependency (Wormhole) rotated its guardian set out from under a pinned deployment. The
current set didn't need to be trusted from a third party — it's derivable by `ecrecover` from the
signatures already present in every live price update. The trust root stayed the on-chain
verification.

---

## 🛑 Constraints / Risks Acknowledged

- **Guardian rotation was worked around, not solved (at week's end).** The ecrecover
  reconstruction is a harness technique; a durable fix belongs in the oracle layer. (This drove
  the lean-oracle upgrade that followed into the next month.)
- **Personal-cell path only.** The canonical oracle cell stays under an owner-bind lock the
  operator doesn't hold; Mode-B deliberately uses its own cell.
- **Devnet, not testnet.** Most browser wallets can't reach a local devnet node, so a real
  wallet round-trip still wants a testnet deployment.

---

## 🔜 Next Steps

- Fold the guardian-rotation handling into the oracle layer so the reconstruction workaround is no
  longer needed.
- Wire the remaining independent frontend items (positions query contract, withdraw action).
- Stand up a testnet deployment so a real wallet can round-trip a deposit.

---

## 🧪 Commands / checks (typical for this week)

```bash
# Requires a running offckb devnet + funded deployer key.
cd packages/watcher
npm run build
node --env-file=../../deployment/.env tests/integration/devnet/keeper-lifecycle.test.mjs        # Mode-A
node --env-file=../../deployment/.env tests/integration/devnet/keeper-lean-lifecycle.test.mjs    # Mode-B
```
