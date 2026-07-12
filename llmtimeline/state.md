> llmtimeline · cross-agent work record. `state.md` is the live snapshot — rewrite it in place. `sessions/` is append-only history — never edit past files. Any agent: read this file and the newest `sessions/` entries before starting.

# Project State — updated 2026-06-30T19:14Z by codex (session 011)

## Goal
Ship **CKB Up/Down** — a parimutuel BTC-up/down prediction market on CKB. Players stake CKB
(or xUDT) on UP/DOWN for a price round; an oracle-authenticated keeper drives each round's
lifecycle; winners redeem a pro-rata share of the losing pool minus rake. "Done" = contracts +
SDK + operational backend + a player-facing web frontend, all working end-to-end on devnet and
deployable to testnet/mainnet.

## Tasks
<markers: [ ] pending · [~] in_progress · [!] blocked · [x] done · [-] abandoned>
- [x] Contracts (`crates/up_down`): pool_type, share_xudt, treasury_lock, pool_admin_lock — 85 Rust tests pass
- [x] Deployment toolbox (`deployment/`): code-deploy + promote + consistency
- [x] Deployment toolbox alignment vs lean oracle format (session 005, opus): reviewed side-by-side
  — code-deploy/promote/validate layers faithfully match the lean oracle format (data2 raw-blob,
  latestCandidate + numeric versions, promote canonicalize, validate:config, devnet KnownScript
  override); we exceed it (promote:* all 4 + validate:consistency). 12/12 tests pass. Deliberate
  divergence: NO state deployments (lean oracle's deploy:oracle/guardian-set) — our pools are
  runtime. One gap flagged: oracle binding has no canonical home in the deploy record. **User
  decision: leave it in the watcher** — deployment stays CODE-ONLY; oracle binding is watcher-owned
  (LaneConfig.oracleIdentity). No code change; only made the scope boundary explicit in
  deployment/README.md.
- [x] game-sdk (`packages/game-sdk`, `ckb-up-down-sdk`): codec, oracle commit, scripts, queries, tx builders, role-split clients — 90 fixture assertions pass
- [x] SDK ↔ contract sync (session 006, opus): DEPOSIT no longer attaches a HeaderDep (contract
  dropped the deposit clock gate in session 005 — only CLOSE reads "now"); added full WITHDRAW
  support (`tx/withdraw.ts` `buildWithdrawTx` + `initiateWithdraw` + `PlayerClient.draftWithdraw`
  + index exports) mirroring the invariant-based OPEN→OPEN redesign (burn shares, shrink totals +
  funds, share-change for partial withdrawals). 90/90 tests pass. NOT yet exposed via the watcher
  `POST /tx/*` endpoints (frontend no-SDK rule needs a `/tx/withdraw` to reach it).
- [x] SDK lean-oracle-style subpath re-layout (session 006, opus): curated root + `presets`/`tx`/
  `ckb`/`oracle` subpaths (per AskUserQuestion: curated root, that 4-subpath set). Root now exposes
  ONLY the stable consumer API (clients, constants, domain types, PoolData decode, payout, reads);
  builders/workflows/plumbing→`/tx`, scripts/typeId/codecs/oracleCommit/client→`/ckb`, config+devnet→
  `/presets`. **devnetConfig moved OFF root to `/presets`** (least-stable network — shouldn't be a
  root export; mirrors lean-oracle bundling testnet/mainnet, not devnet). 2 new barrels + package.json
  exports; tsc unchanged. All consumers updated: 10 SDK fixtures repointed (90/90), 4 watcher files
  repointed (typecheck + 55/55), README "Entry points" table added. Runtime-verified root no longer
  leaks low-level names.
- [x] SDK arg-ergonomics parity tweaks (session 006, opus): vs lean-oracle — (1) workflows now take
  one `deployment: PoolDeploymentConfig` instead of separate `deploy`+`deps` (clients pass
  `this.config.deployment`; `deploymentViews()` splits it for the pure builders); (2) all caller
  locks accept CCC `ScriptLike` (workflows + reads + DraftCreateParams; normalized once via
  `ccc.Script.from`). Pure `build*` left strict. Consumer `draft*` arg shape unchanged → watcher
  untouched. SDK 90/90, watcher typecheck + 55/55.
- [x] SDK packaging sketch (session 006, opus): `docs/sdk-packaging-sketch.md` — segment Player
  (public, drives our rake) vs Keeper (internal, operator playbook). Two-package target
  (`ckb-up-down-sdk` + internal `ckb-up-down-operator`) + lightweight `exports`-gating interim.
  DESIGN ONLY, recommend NOT NOW (keep SDK internal until courting integrators). Rake → creator on
  CLOSE is the value-capture fact underpinning it.
- [x] Losing-share burn: contract relaxation + SDK `buildBurnSharesTx`/`initiateBurnShares`/`draftBurnShares` — verified live on devnet (full lifecycle CREATE→…→REDEEM→BURN)
- [x] Watcher (`packages/watcher`): planner + indexer + executor + Fastify API + Docker — 50 tests pass; v1 oracle deferred (StubOracleSource)
- [~] Frontend (`packages/web`): Vite+React SPA, builds clean, redesigned ("The Pit" visual identity) — needs live wiring
- [x] Backend tx-build endpoints (watcher `POST /tx/{deposit,withdraw,redeem,burn}`): build unsigned tx via key-less readonly signer — 57 watcher tests pass (`/tx/withdraw` added session 006, mirrors deposit)
- [x] SDK getShareBalances/collectShareCells efficiency fix (session 006, opus): now query the
  HOLDER's cells (one lock-scoped findCells, filter by share type via `holderShareCells` helper)
  instead of scanning the pool's whole share supply + filtering by lock — O(holder) not O(all
  holders), and collapses getShareBalances' 2 type-queries into 1. SDK 90/90.
- [x] SDK operator-pool listing + read audit (session 006, opus): `listPoolsByCreator(client, deploy,
  creatorLockHash)` — LOCK-scoped search on the PoolCell's pool_admin_lock so we list only OUR pools,
  not every pool on the permissionless deployment (efficiency AND correctness: don't index/serve pools
  we can't manage). Added `operatorLockHashes?: Hex[]` to PoolNetworkConfig + `listManagedPools()`
  (union/de-dup) + exported the primitive. WIRED the watcher indexer to use it (IndexContext.creatorLockHash
  from service's creatorLock). Also `listShareCells` 2 per-side queries → 1 prefix query (indexer hot
  loop). getPool/getTreasuryBalance/collectAssetCells already optimal. SDK 91/91, watcher 57/57.
- [x] SDK query-structure refactor (session 006, opus, user-directed): (1) **pool-keyed reads** —
  getShareBalances/listShareCells/getShareSupply/getTreasuryBalance take a `PoolView` and read
  share/asset code from the POOL's own data (was using deploy default → silently misreads a pool that
  pinned a non-default share code; correctness fix). collectShareCells stays the explicit-hash
  primitive for burn-after-close. (2) dropped redundant `getPoolByTypeScript` export (inlined into
  getPool). (3) `listPools(filter?)` with `{ creator, status, feedId }` — folds in listPoolsByCreator;
  watcher indexer + listManagedPools use it. (4) `devnetConfig({ operatorLockHashes? })` threads
  operator identity into the preset. SDK 91/91, watcher 57/57.
- [x] SDK security + efficiency audit (session 007, codex): reviewed `packages/game-sdk` against
  deployment/config/scripts/artifacts, docs, fixtures, and watcher consumer tests. Fixed 3 issues:
  CREATE stopped fetching/attaching stale HeaderDep; `buildDepositTx` now rejects non-OPEN pools;
  pure xUDT `buildRedeemTx`/`buildCloseTx` now verify supplied asset type hash matches the pool.
  Query/read efficiency remains sound (exact pool, creator-scoped pool listing, holder-scoped
  shares/assets, one prefix scan for whole-pool shares). SDK, deployment, and watcher tests pass.
- [x] Session 003 handoff ingest: Codex read the handoffprotocol skill, live snapshot, and prior sessions; no product code changes
- [x] Frontend market selector: Polymarket-style horizontal asset rail above duration chips — tested, built, and visually smoked
- [x] Frontend markets hero redesign: asset variants → highest-liquidity featured square → cadence → grid; mock/dev servers left running for review
- [x] Frontend featured-card density revision (session 004, opus): removed the empty 456px featured square; added a market-stats strip + lifecycle sections (Open markets / In play); re-worded `% chance` → `UP` + pool-split legend; mock emits `locked` pools + `/pools?status=`
- [x] Pool-detail candlestick chart (session 002→004, opus): two-column event view (PriceChart + TradePanel, Pyth-feed rules); made lifecycle-aware — OPEN shows spot/context with NO price-to-beat line, LOCKED/SETTLED show the beat line
- [x] Top hero, final: a PROMOTIONAL banner carousel (session 004, opus) — `PromoSlider.tsx`, à la SportsPredict: auto-advancing image/banner slides (new listing / event / how-it-works) with CTA, arrows + dots, drop-in `image` per slide. Markets render as a card grid BELOW it. (The "big square" went: empty 456px square → 3-tile strip → single-round hero → asset-cadence hero → promo carousel — the carousel is the kept design; the market-data tile was the wrong thing for that slot.)
- [x] Wire real OracleSource into the watcher (phase 7): BUILT (discovered session 010, not in
  s009 board) — `oracle/{source,worker,liveSource,leanSource,leanNetwork}.ts`, `WATCHER_ORACLE=live`,
  lean-oracle-sdk `file:` dep, role `"oracle"` = sole cell-writer + `OracleWorker`. NOT yet verified
  live end-to-end on devnet.
- [~] Keeper redesign (clean-slate, no back-compat) — DESIGN DONE (session 010, opus):
  `docs/keeper-redesign.md`. Edge-triggered self-scheduling keeper + safety sweep. Awaiting approval
  to implement.
- [~] Backend/watcher/oracle target architecture discussion: propose first-principles structure
  for multi-asset, multi-cadence, repeating pools and oracle partition/update strategy; design-only,
  no code changes intended.
- [x] Week 4 report + staging (session 011, codex): wrote a game-sdk-only report and staged only
  `packages/game-sdk` plus that report; explicitly leave watcher and web unstaged.
- [~] Per-transition redundancy review of pool_type (session 005): CREATE done (dropped
  `used_pt!=0` + future-window checks; kept rake_bps cap as load-bearing); DEPOSIT done
  (dropped `now>=start_time` clock gate — deposits bounded by status, not clock; only CLOSE
  reads header now); DEPOSIT redesigned — invariant-based (absolute treasury==totals; unsigned
  share/capacity deltas) + WITHDRAWAL now supported (totals may fall); depositor_io removed
  (delegated to staked-asset xUDT conservation, see spec §3); 84 tests pass. ACTIVATE reviewed —
  NO changes (already tight; one-sided early-void is correct prompt teardown, self-correcting if
  the pool fills). CORRECT-settle + CORRECT-start reviewed — NO changes (both tight; their
  close/void_time band bounds already optimized out via used_pt). RESOLVE reviewed — NO changes
  (tight). FINALIZE reviewed — NO changes (tight; whole price phase done). REDEEM + CLOSE reviewed
  — NO changes (each has one redundant defense-in-depth check kept: winner_total==0 in REDEEM,
  shares_frozen in CLOSE). **FULL pool_type redundancy review COMPLETE** — only CREATE + DEPOSIT
  had checks removed. DRY refactor DONE (set_start_tick/set_settle_tick helpers shared across the
  4 price-setting txs) + error-code nit DONE (start_price freeze -> ERROR_POOL_DATA_MALFORMED in
  RESOLVE/CORRECT-settle). 84 tests pass. pool_type fully reviewed + refactored.
  FULL end-to-end security+redundancy pass: CLEAN — no flaws, no new redundancies. Verified
  cross-cutting invariants (group-based pool_id continuity, complete/closed status machine,
  overflow-safe-by-construction incl. payout=x+profit, treasury==totals induction, REDEEM no
  over-pay/hijack). ONE fairness edge flagged (NOT a bug, awaiting user decision): withdrawal lets
  a bettor EXIT on info in the tiny [start_time, ACTIVATE] window; funds conserved; rec = leave it.
  OTHER 3 SCRIPTS + shared parsers reviewed — ALL CLEAN (share_xudt, treasury_lock, pool_admin_lock,
  pool_data/oracle_read parsers): no flaws, bounds-safe parsing, error constants match, delegation
  web sound (anchored on typeID uniqueness). **FULL CONTRACT SUITE REVIEW COMPLETE.** (+ optional cross-cutting DRY refactor of the 4 price-setting
  transitions, and a cosmetic error-code nit on the start_price freeze)

## Summary
**Session 011 (codex) — Week 4 SDK report/staging complete.** User asked to create the Week 4 report
using only what was done in `packages/game-sdk`, add `game-sdk` to git, and leave watcher/web out.
Codex wrote `reports/week4-june-2026-update-report.md` as an SDK-only report, verified
`packages/game-sdk` with `npm test` (build + all fixture suites pass), and staged only
`packages/game-sdk/**` plus the Week 4 report. `packages/watcher` and `packages/web` remain untracked
and unstaged. Timeline files were updated for continuity but intentionally left unstaged.

**Session 010 (opus) — keeper redesign (design only) + watcher reality-check.** Two things.
(1) Reading `packages/watcher/src` showed the watcher has advanced past this snapshot: the real
oracle subsystem is BUILT (`oracle/{source,worker,liveSource,leanSource,leanNetwork}.ts`, `mutex.ts`,
`odds.ts`, `actions.ts`, `lean-oracle-sdk` file: dep, a fourth role `"oracle"` = sole cell-writer
via `OracleWorker`, keeper as read-only `ReadOnlyOracleSource`). So "phase 7" is substantially done
in code (not yet verified live on devnet). (2) Designed a clean-slate keeper in
`docs/keeper-redesign.md` (no back-compat — first build stage): replace the level-triggered `plan()`
sweep with an **edge-triggered, self-scheduling** keeper — every pool/cadence carries its own
`setTimeout` to its next due moment, plus a low-frequency safety sweep backstop. The "next action" is
a pure `classify`+`decide` over `(status, time, current-oracle-tick)` — a full decision table incl.
permissionless externally-driven transitions, opportunistic CORRECT-start/settle (read the cell's
current tick, act only if in `(lower, used_pt)`, else leave — keeper stays a PURE oracle reader, no
historical mint), and VOID as the catch-up/fallback branch. Scheduler = `slots` (dueTime→{timer,
entries}) + `poolIndex`/`cadenceIndex` (one wake per entity); CLOSE de-registers (the only action
that shrinks the schedule). Wind-down is externally managed (enable/disableCreating). Fire-handlers
serialized single-flight; wallet Mutex stays as inner guard. Flagged dependencies: SDK keeper-client
needs `draftCorrectStart`/`draftCorrectSettle`/`draftVoid` (+ batch); none exist yet.

**Session 006 (opus) — SDK synced to the session-005 contract changes.** Two things: (1) DEPOSIT
stopped attaching a HeaderDep, because `validate_deposit` no longer reads the header clock (deposits
are status-gated OPEN→OPEN; only CLOSE reads "now"); `tipHeaderHash` stays for `initiateClose`.
(2) Added WITHDRAW — the inverse of DEPOSIT, exercising the invariant-based redesign that lets
OPEN→OPEN totals fall. New pure builder `packages/game-sdk/src/tx/withdraw.ts` (`buildWithdrawTx`):
burns supplied share cells, returns per-side surplus as a share-change cell, and shrinks the
PoolCell capacity by `total` (CKB) or the TreasuryCell balance by `total` + pays the staked asset
out (xUDT) — matching the contract's per-side share invariant and absolute treasury check. New
`initiateWithdraw` workflow auto-selects the withdrawer's share cells (largest-first); wired
`PlayerClient.draftWithdraw` + index exports. 7 new fixtures; full suite now 90/90. NOT yet exposed
via the watcher `POST /tx/*` endpoints — the frontend (no-SDK rule) needs a `/tx/withdraw` to use it.

**SDK re-layout (session 006, opus) — lean-oracle-style subpaths.** The package was flattened-at-root
before; it now has a **curated root** plus module subpaths, matching `lean-oracle-sdk`'s shape.
`ckb-up-down-sdk` (root) exposes only the stable consumer API: the role-split clients, constants +
domain types, `PoolData` decode, payout math, and the chain read layer. Lower layers moved to
subpaths, each a barrel: `/presets` (config authoring + the bundled **devnet** preset),
`/tx` (`build*` + `initiate*` + plumbing + asset resolution), `/ckb` (scripts, typeID, codecs,
`oracleCommit`, client/signer), `/oracle` (unchanged). **`devnetConfig` moved off the root onto
`/presets`** — answering "why is devnet a root export?": it shouldn't be, it's the least-stable
network (lean-oracle bundles testnet/mainnet, never devnet). package.json `exports` gained
`/presets`,`/tx`,`/ckb`; tsc needed no change (it already emits `dist/<area>/index.js`). All
consumers updated — 10 SDK fixtures repointed (90/90), 4 watcher files repointed (typecheck +
55/55), README gained an "Entry points" table. Runtime-verified the root no longer leaks low-level
names. The 4 devnet code hashes in `presets/devnet.ts` are still a snapshot behind HEAD (untouched).
Two follow-ons landed: (a) **efficiency** — `getShareBalances`/`collectShareCells` now query the
holder's own cells via one lock-scoped find (helper `holderShareCells`) instead of scanning the
pool's whole share supply; (b) **`POST /tx/withdraw`** added to the watcher (mirrors `/tx/deposit`)
so the frontend can reach withdraw. Testnet/mainnet presets stay blocked on a real deployment.

The contract, SDK, and watcher layers are complete and tested. The full pool lifecycle was
verified live on a local offckb devnet using a mock oracle cell (CREATE → DEPOSIT → ACTIVATE →
RESOLVE → FINALIZE → REDEEM → BURN), payout = 496 CKB. The watcher is feature-complete for v1;
its only deferred piece is the real oracle source, which gates the backend's activate/resolve/
finalize transitions but does NOT affect the read API the frontend consumes.

**Frontend (`packages/web`)** is scaffolded as a Vite + React SPA and builds clean (tsc + vite,
672 modules). Architecture (revised per user): **thin client, server-built txs** — NO project
SDK in the browser. Reads come from the watcher REST API. Writes: the frontend POSTs an intent
to the watcher's new `POST /tx/{deposit,redeem,burn}`, which builds a fully-formed UNSIGNED tx
server-side (PlayerClient + a key-less `SignerCkbScriptReadonly` for fee/change completion) and
returns molecule hex; the browser deserializes, the wallet (CCC) signs, and broadcasts. Only
client-side chain lib is CCC (the wallet boundary). See memory [[frontend-no-sdk-rule]].

Pages built: Markets (lanes), Pool detail (odds/timing + deposit/redeem/burn actions), My
positions, History. All read hooks use TanStack Query. CCC connector wired with the full
default wallet set.

**Visual identity ("The Pit", session 002):** first cut was too minimal (generic dark dashboard).
Redesigned around one signature element — the **tug-of-war bar** (`src/ui/TugBar.tsx`): a single
split track, mint UP vs coral DOWN, fulcrum at the live implied probability, recurring at three
scales (featured hero → market rows → pool detail). Live `mm:ss` countdown (`src/ui/Countdown.tsx`,
pulses red <30s). Palette: warm near-black `#0B0A0E`, mint `#2BD9A6`, coral `#FF5D73`, sparing
Bitcoin-nod amber `#F7B23B`. Type: Space Grotesk display / JetBrains Mono for all numbers / Inter
UI. Markets leads with the soonest-to-lock pool as a hero. All in `src/styles.css` (full rewrite).
Self-critiqued via headless-chrome screenshots of the real CSS. tsc + build clean.

**Polymarket-style markets + stub backend (session 002):** the hero+list still felt minimal, so the
Markets page became a dense **card grid** (`LanesPage.tsx`) — duration filter chips, per-card asset
icon, big UP-chance %, split bar, **Buy UP / Buy DOWN** buttons (link to detail with `?side=`), vol +
live count. To view it without the real watcher, added a **zero-dep mock backend**
`packages/web/mock/server.mjs` (`npm run mock` → :8080, matches `.env`) implementing the full REST
contract with NOW-relative round timings so countdowns tick. Verified live end-to-end via headless
chrome (Markets/detail/history populated). The mock is dev-only scaffolding — NOT shipped; the real
watcher (indexer role) replaces it.
**To run the demo:** `cd packages/web && npm run mock` (one terminal) + `npm run dev` (another) →
http://localhost:5173.

**Palette pivot → "Daylight" (light/blue):** user found the dark "Pit" (black + amber) too technical
and unwelcoming; chose a light, friendly, blue-led theme. Full `styles.css` re-tokenized: soft
off-white bg `#F4F7FC`, white cards with soft shadows (elevation instead of dark borders), blue
primary `#2F6BFF` (brand/active/CTA/countdown), green UP `#16A957` / rose DOWN `#F0456B`, BTC icon
kept its real orange `#F7931A` (recognizable mark, not chrome), ETH icon indigo. Fonts/structure/
signature tug-bar unchanged. tug fulcrum is now ink with a white ring so it reads on white. tsc +
build clean; verified live via headless screenshots (markets/detail).

**Themeable (3 palettes + live switcher):** fully tokenized `styles.css` — every tint now derives
from a CSS custom property via `color-mix()` (no literal rgba), so a theme = ~18 token overrides.
Three themes: `:root` Daylight (light/blue), `[data-theme="ocean"]` Deep Ocean (navy/teal/coral),
`[data-theme="twilight"]` Indigo Twilight (violet/mint/pink). `ThemeSwitcher.tsx` (3 swatches in the
topbar) flips `document.documentElement.dataset.theme` + persists to localStorage; an inline script
in `index.html` sets it pre-paint (no flash) and honours `?theme=` for shareable previews. Decided
AGAINST a Tailwind migration — portability comes from tokens, not Tailwind; CCC stays the only heavy
dep. Verified all 3 live in the real app via `?theme=` headless screenshots. **User picked Deep Ocean as
the default** (index.html pre-paint script + ThemeSwitcher fallback default to `ocean`; theme-color
meta → `#0C1426`); switcher stays so Daylight is one click away. Indigo Twilight was removed entirely per user (token
block + switcher entry deleted) — two themes remain: Deep Ocean (default) + Daylight.

**Product named "Tilt"** (user pick): wordmark = the tug-of-war mark (split teal/coral pill + fulcrum,
token-driven) + "Tilt", in `src/ui/Brand.tsx`. Replaced the old "CKB ↑↓" brand. Added matching
`public/favicon.svg` (tug mark on navy squircle) + `<title>Tilt · up/down markets on CKB</title>`.
The temporary brand-candidate picker (Tilt/Tilt·bar/Sway/Sway·wave) was removed after the decision.

**Session 003 (Codex):** handoffprotocol was ingested and the current timeline was read. No product
code was changed; this entry only records continuity for the next task.

**Market selector polish (session 003):** Markets now use a visible Polymarket-style selector:
asset rail first (`All`, `BTC/USD`, `ETH/USD`, ...), duration rail second (`All rounds`, `1m`,
`5m`, ...). Implementation is split through `packages/web/src/pages/marketFilters.ts` and
`LanesPage.tsx`, with CSS in `styles.css`. Added `packages/web/tests/marketFilters.test.mjs`.
Verified with `node packages/web/tests/marketFilters.test.mjs`, `npm run typecheck`, `npm run build`,
and a headless screenshot at `/tmp/tilt-market-selector.png`.

**Markets hero redesign (session 003):** user rejected the small text intro/filter placement.
Markets now lead with asset variants, then a large featured square/card for the highest-liquidity
current open pool, then time cadence chips, then the market grid. Highest liquidity is selected via
`featuredLane()` in `packages/web/src/pages/marketFilters.ts` using `pool.odds.total`; the featured
lane is excluded from the grid. Verified with the focused test, `npm run typecheck`, `npm run build`,
and a live screenshot at `/tmp/tilt-market-redesign.png`. Mock API and Vite dev server are currently
running for review: mock `http://127.0.0.1:8080`, app `http://127.0.0.1:5173/`.

**Markets density + lifecycle rework (session 004, opus):** acted on the pending decision. Critique:
the 456px featured square wasted ~60% of the row and only duplicated a grid card at 3× — it *was* the
"empty" feeling; "UP CHANCE" overstated certainty; no lifecycle separation. Rework (`LanesPage.tsx`):
removed the featured square; lead with a **market-stats strip** (Open rounds · Total liquidity ·
Next-lock countdown); **Open markets** grid (highest-liquidity lane gets a small "Most liquidity"
corner tag via `featuredLane()`, not a hero square); **In play** section (locked rounds: frozen/dimmed
split, "settles <countdown>", "In play" pill, no buy buttons); `% chance` → `UP` + section legend
"% = share of the pool on each side". Settled stays on History. Mock (`mock/server.mjs`) now emits 3
`locked` pools and honours `/pools?status=` (maps 1:1 to the real watcher); detail route includes
locked pools. Verified: tsc + build clean, `tests/marketFilters.test.mjs` exit 0, no dangling
featured/fm/board CSS refs, live screenshots `/tmp/rework-markets.png` + `/tmp/rework-top.png`.

**Pool-detail event view + lifecycle correctness (session 002→004, opus):** PoolDetailPage is a
two-column Polymarket-style event view: left = `PriceChart.tsx` (hand-rolled SVG candlesticks +
last-price marker, fed by `pool.priceSeries`) above the outcomes tug bar, plus Round-details + a
"How it resolves" panel referencing the **Pyth** feed + oracle `publish_time` (NOT Chainlink); right
= sticky `TradePanel` (UP/DOWN toggle, amount, live parimutuel payout/profit estimate, Buy). Pool type
has optional `priceSeries?: Candle[]`. **Lifecycle correctness (user catch):** the price-to-beat is
captured at LOCK, so an OPEN round has none — the dashed beat line + "Price to beat" now render ONLY
for locked/settled; OPEN shows "Spot price" + recent candles as context (no line) + a note that the
beat is set at lock. `ChartHead` switches label/delta by status; `ChartNote` explains each state. Mock
no longer stamps a start price on open pools.

**Top hero — FINAL: promotional banner carousel (session 004, opus).** The "big square" iterated a
lot (empty 456px square → 3-tile stats strip → single-round hero → asset-cadence hero) before the
user clarified its PURPOSE: it should be a **promotional surface** (new listings, events,
how-it-works) — a picture/banner slider like SportsPredict's home carousel — NOT market data. So
`src/ui/PromoSlider.tsx` now sits at the top of Markets: full-width banner slides (translateX track),
auto-advance every 6s (paused for reduced-motion), prev/next arrows + dots, each slide = eyebrow +
title + subtitle + white CTA on a themed gradient, with a drop-in `image` per slide (shows a dashed
"Banner image" placeholder until set). Edit slides in PromoSlider's `SLIDES` array. The actual markets
render BELOW as the card grid (filters → "Open markets" `MarketCard` grid → "In play"). The
asset-cadence hero (AssetHero/CadenceRow) was removed from the page; `featuredAsset()` and
`Sparkline.tsx` remain in the tree (orphaned-but-harmless, reusable). CSS `.promo*`.

## Next
If pushing this slice: commit the current staged set only (`packages/game-sdk/**` and
`reports/week4-june-2026-update-report.md`) and push. Do not add `packages/watcher` or
`packages/web` unless the user explicitly changes scope.

Keeper redesign — `docs/keeper-redesign.md` is written and approved-in-principle; awaiting the
go to implement. Suggested order when implementing (clean-slate, replace `planner.ts` + the
`service.ts` keeper loop):
1. `Cadence` value object (grid math: `nextBoundary`, `roundStartFor`) + `Timeline` scheduler
   (`slots`/`poolIndex`/`cadenceIndex`, `schedulePool`/`scheduleCreate`/`removePool`/`cancelAll`).
2. Pure `classify(pool, now)` + `decide(pool, now, currentTick)` — unit-test the whole
   status×time×tick matrix (this is the heart; mirror the doc §3 decision table exactly).
3. `Keeper` class (start/stop/enable-disableCreating, onWake serialized single-flight, onSweep).
4. SDK keeper-client builders `draftCorrectStart`/`draftCorrectSettle`/`draftVoid` (+ extend
   `draftTransitionBatch`) — these DO NOT EXIST yet; the executor today only has activate/resolve/
   finalize/close/create. Executor grows `correctStart`/`correctSettle`/`void` action handling.
5. Rewire `service.ts` to construct the new `Keeper` (slim `OracleSource` = `readCurrentTick`);
   keep `executor.ts` (batch-by-cell + fallback), `reconcile.ts`, `mutex.ts`, `config.ts` helpers.
Then: verify the BUILT oracle subsystem (phase 7) live on devnet end-to-end (it has never run
against a live node — see the oracle task above).

Prior design discussion (superseded by the doc above for the keeper; backend/oracle target still
in the session-008 note under Notes):

SDK follow-ons remaining after session 006:
- **BLOCKED** — Bundle `testnetConfig`/`mainnetConfig` presets under `ckb-up-down-sdk/presets`: needs
  an actual testnet/mainnet deployment first (a preset is a copy of real artifacts; none exist yet).
  The curated `/presets` structure is ready for them; devnet is the only bundled preset today.
- Frontend withdraw action: a button in `packages/web` pool detail that POSTs `/tx/withdraw`
  (endpoint now exists on the watcher; web mock already stubs `/tx/*`). Consumer-side only.
- Refresh `packages/game-sdk/src/presets/devnet.ts` (+ `deployment/artifacts/devnet.pool-type.json`)
  after the next devnet redeploy — the pool_type hash there is still a snapshot behind HEAD
  (rebuilt in session 005). A live deposit/withdraw round-trip needs that redeploy first.
- Two-package SDK split (Player public / Keeper internal) only if/when courting integrators — plan
  of record is `docs/sdk-packaging-sketch.md`.
- Watcher: if going "one keeper key per cadence", pin `creatorLock` per `LaneConfig` so each worker
  only ever touches its own cadence's pools (SDK already unions N operator hashes via listManagedPools).

Live end-to-end wiring + polish:
- Run the watcher locally (indexer role, `POST /tx/*` live) against devnet + point the web app at
  it (`VITE_WATCHER_API_URL`); verify Markets/positions render and a deposit round-trips
  (intent → unsigned tx → wallet sign → broadcast). Note: most browser wallets can't reach a
  local devnet node, so a real wallet test wants testnet (needs a testnet deployment + SDK
  preset first).
- Consider a tiny e2e/smoke for the tx endpoints against the live lifecycle (reuse the
  mock-oracle devnet flow): POST /tx/deposit → sign with a private-key signer → assert shares.
- Frontend Markets + pool-detail are in a good place (session 004): featured hero, lifecycle
  sections, and a lifecycle-correct chart all verified live. Remaining optional polish: code-split
  CCC (~553 KB chunk), History lane filter, a richer In-play card (spot vs beat shading), and a
  themed pass over the new hero/chart in Daylight (verified in Deep Ocean).
- The real-watcher swap is the big remaining frontend dependency: point `VITE_WATCHER_API_URL` at a
  live indexer; the mock's shapes (incl. `/pools?status=`, detail `priceSeries`) match the contract.
- Independent: wire the watcher's real OracleSource (phase 7) so devnet pools actually advance.

## Notes
- **Read/write split (CKB dApp pattern):** the watcher API is the source for listings/odds; the
  chain (via game-sdk + wallet) is the source for writes. The frontend never decodes cells per
  page load.
- **Wallet:** CCC (`@ckb-ccc/connector-react`) provides a `ccc.Signer` compatible with the
  game-sdk's `complete(tx, signer)` — this is the key integration seam. PlayerClient drafts are
  fee-less; the wallet signer completes fees + change + signs.
- **Positions are keyed by holder lock hash.** Frontend derives the connected wallet's lock hash
  and queries `/positions?lock=<lockHash>`.
- **Network config:** SDK ships `devnetConfig` / `definePoolNetworkConfig` presets for devnet/
  testnet/mainnet — the frontend selects per env.
- **Decoupling rule (memory):** no cross-package source imports between sdk/deployment/watcher/
  web; replicate shared shapes. Frontend treats the watcher as an HTTP contract.
- **Oracle deferral:** until the real OracleSource lands, devnet pools stay OPEN (mint + accept
  deposits) but won't LOCK/SETTLE/pay out. The frontend can still be built against the live API;
  full-lifecycle data needs the oracle or the mock-oracle path used in the lifecycle test.
- **CONVERGED BACKEND ARCHITECTURE (session 008, opus — cross-agent compare, decided):** target
  design for the watcher/backend, agreed via two independent proposals + 2 user picks. FOUR partition
  axes — oracle→FEED, lifecycle→LANE, execution→WALLET, indexer→NETWORK; API stateless. Scheduler =
  level-triggered reconciler that RECOMPUTES desired state from lane config + chain each sweep (NO
  durable jobs table for lifecycle; only `tx_log` persists in-flight tx), waking at the nearest grid
  boundary. Lane = independent planner unit; wallets grouped BY CADENCE at first, fanning into a
  per-wallet serialized executor queue. Oracle = one publisher per feed cell, rolling HISTORY-WINDOW
  cell, adaptive/boundary-aware publish, store+gate Pyth `confidence`, feed-health circuit-breaker
  gates CREATE; `publish_time` is the price-phase clock (chain `now` only gates CLOSE grace); contract
  verifies EARLIEST qualifying tick. `rounds`=derived log (not truth) vs `pools`=chain projection;
  DB-backed config registry. Full rationale + adopted/rejected items in `sessions/008-2026-06-24-opus.md`.
  STATUS: design only — existing packages/watcher partially diverges; not yet reconciled/implemented.
- **Devnet node:** run directly via `~/.local/share/offckb-nodejs/bins/0.205.0/ckb run -C
  ~/.local/share/offckb-nodejs/devnet` (+ `ckb miner …`); `offckb node` fails with "Not a CKB
  directory". RPC at http://127.0.0.1:8114.
