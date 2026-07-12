# SDK packaging sketch — segmenting Player (public) vs Keeper (internal)

> Status: **design sketch, not yet implemented.** Rationale lives in
> `llmtimeline/` session 006. The point: the SDK empowers three audiences that
> pull in opposite directions — us (internal), integrators who transact on our
> rake-earning pools (good to empower), and would-be competing operators (not).
> The role-split clients already map onto that divide; this sketch turns the
> divide into a packaging boundary.

## The principle

Rake accrues to the **pool creator** on CLOSE (`distributable = loser_total −
rake`; the remainder is swept to `creatorLock`). So:

- **Transacting on existing pools** (deposit/withdraw/redeem/burn + reads) drives
  volume to pools *we* created → pays *our* rake. Safe, even desirable, to expose.
- **Creating pools + driving the lifecycle** (create/activate/resolve/finalize/
  close + oracle) is the operator playbook. Exposing it lowers the bar for someone
  to run a competing rake-earning venue on the same public contracts.

This is **friction, not secrecy** — the contracts are public on-chain, so a
determined forker rebuilds the keeper surface from them. The goal is to not *ship*
the operator playbook as a polished product, while making the player surface a
first-class integration target.

## Export buckets (every current public name)

| Bucket | Exports |
| --- | --- |
| **PUBLIC — player** | `PlayerClient`; `buildDepositTx`/`buildWithdrawTx`/`buildRedeemTx`/`buildBurnSharesTx` + their `initiate*` + param types; `redeemPayout`, `mulDivFloor` |
| **PUBLIC — reads** | `PoolReaderClient`; `getPool`, `listPools`, `getShareBalances`, `getTreasuryBalance`, `getShareSupply`, `listShareCells`, `collectShareCells`, `collectAssetCells`, `poolTypeHashOf`, `asPool`/`asShare`/`asTreasury`/`poolIdOf`, `PoolView`/`CellView` |
| **PUBLIC — neutral primitives** | constants/enums (all of `constants.ts`); domain types (`PoolData`, `Script`, `PoolDeployment`, `CellDepInfo`, `PoolCodeDeps`, `Hex`); `encode/decodePoolData`; `encodeAmount`/`decodeAmount`; script derivation (`poolTypeScript`/`shareScript`/`treasuryLockScript`/`poolAdminLockScript`); `computeTypeId`; `createClient`/`createPrivateKeySigner`; `bytesToHex`/`hexToBytes`; `resolveAssetDep`; `attach*` + `completeFeeAndChange`; the whole config/preset layer (`definePoolNetworkConfig`, `configForPoolTypeVersion`, `devnetConfig`, `DEVNET_*`) |
| **INTERNAL — keeper** | `KeeperClient` + `DraftCreateParams`; `buildCreatePoolTx`, `buildActivateTx`, `buildCorrectStartTx`, `buildResolveTx`, `buildCorrectSettleTx`, `buildFinalizeTx`, `buildCloseTx` + their `initiate*` + param types; `resolveCreateAsset` + `PoolAsset`; `OracleTick` + `assertTickForPool`; `oracleCommit` + `OracleIdentity`; `resolveOracleTick` + `OracleStateReader` (the `/oracle` adapter) |

Neutral primitives sit in the public package: withholding them protects nothing
(they're trivially re-derivable / already on-chain) and the player surface needs
them. Only the **create + lifecycle + oracle** surface is gated.

## Target: two packages

```
ckb-up-down-sdk            (PUBLIC — published to npm; audience = third-party integrators)
└── depends on @ckb-ccc/core
ckb-up-down-operator       (INTERNAL — private registry / workspace-only; audience = us)
└── depends on ckb-up-down-sdk + @ckb-ccc/core   (re-exports the public surface for convenience)
```

### `ckb-up-down-sdk` — `exports`
```jsonc
{
  ".":         "player + reads + reader/player clients + constants + types + decode + payout",
  "./presets": "config authoring + bundled devnet preset",
  "./tx":      "player builders/workflows + neutral plumbing (attach*, completeFeeAndChange) + resolveAssetDep",
  "./ckb":     "scripts, typeId, amount codec, client/signer, hex"   // NO oracleCommit
}
```

### `ckb-up-down-operator` — `exports`
```jsonc
{
  ".":         "KeeperClient (+ re-export of ckb-up-down-sdk root)",
  "./tx":      "create/lifecycle/close builders + workflows + OracleTick/assertTickForPool + resolveCreateAsset",
  "./oracle":  "resolveOracleTick + OracleStateReader",
  "./ckb":     "oracleCommit (operator-only primitive)"
}
```

So a competing operator can't `npm i ckb-up-down-sdk` and get `draftCreate` — the
keeper surface simply isn't in that package. Our own stack installs
`ckb-up-down-operator` (which pulls the public one transitively).

### Source moves (keeper-only files → operator package)
- `tx/create.ts`, `tx/close.ts`, `tx/keeperTransitions.ts`
- `client/KeeperClient.ts`
- `oracle/index.ts`
- `ckb/oracleCommit.ts`
- split `tx/asset.ts` → `resolveAssetDep` stays public, `resolveCreateAsset`+`PoolAsset` move
- split `tx/oracleTick.ts` → `OracleTick`+`assertTickForPool` move
- split `tx/workflows.ts` → player `initiate*` stay; create/lifecycle/close `initiate*` move
- the keeper builders' tests move with them

## Lightweight interim: one package, gated `exports`

If two packages is too much overhead right now, keep one source tree and gate the
published surface:

- Put keeper code behind `./keeper`, `./oracle`, and keep `oracleCommit` out of the
  public `./ckb` barrel.
- In `package.json#exports`, **omit** `./keeper` (+ `./oracle`) from the published
  map. Modern Node blocks any subpath not listed in `exports`, so external
  consumers can't import it — even though the JS is still physically in the
  tarball (friction, not secrecy).
- Our own watcher/keeper import keeper code through the workspace `file:` link,
  which bypasses the published `exports` gate, so they keep full access.

Trade-off: simpler (no second package, no source moves) but the keeper JS still
ships in the public tarball (readable, just not importable via a clean specifier).
The two-package split is the only way to actually *omit* the operator code from the
public artifact.

## What this changes for our own consumers

- **Frontend**: unaffected — it imports no SDK at all (the no-SDK rule). The public
  package's audience is explicitly *external* integrators, not our browser.
- **Watcher** (keeper + indexer + tx endpoints): switches its dependency to
  `ckb-up-down-operator` (two-package target) or keeps importing via the workspace
  link (interim). Its import specifiers change only for the gated keeper names.

## Recommendation

Not now. Ship the frontend wiring + traction first; the SDK stays an internal
package whose main consumer is the watcher. **When** there's a reason to court
integrators (bots, aggregators, alt-frontends), do the two-package split — it's the
only option that genuinely keeps the operator surface out of the published artifact,
and the role-split clients + subpaths we already have make it a packaging job, not a
rewrite. Until then, this doc is the plan of record.
