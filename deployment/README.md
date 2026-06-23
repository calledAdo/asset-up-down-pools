# CKB Up/Down Deployment

Deployment toolbox for the four CKB Up/Down contract binaries. It publishes each
binary as a code cell and records versioned artifacts. It does **not** create
pools — pool creation is a recurring runtime action owned by the watcher/keeper,
which assembles PoolCells from the canonical promoted code versions recorded here.

- `config/` — checked-in per-network deployment intent (build paths + label)
- `.env` — operator-local RPC endpoints, keys, and controls (gitignored)
- `artifacts/` — generated deployment outputs (testnet/mainnet tracked; devnet ignored)
- `src/` — TypeScript deployment CLI

## What this toolbox does

**Code deployments** (one per binary, each with a `promote:*`):

- `deploy:share-xudt`
- `deploy:treasury-lock`
- `deploy:pool-admin-lock`
- `deploy:pool-type`

Each publishes a contract binary as a raw code blob and records it as a deployment
artifact. Artifacts support:

- `latestCandidate` — the most recently deployed code candidate
- `versions` — explicit canonical promoted versions

Promotion moves a candidate into the canonical version map:

- `promote:share-xudt`, `promote:treasury-lock`, `promote:pool-admin-lock`, `promote:pool-type`

**Pool creation is out of scope.** Creating a live PoolCell is a recurring runtime
action: the watcher/keeper selects an explicit canonical code version (never
`latestCandidate`) and assembles the PoolCell — and, for xUDT pools, its
TreasuryCell — from the artifacts published here. This toolbox stops at publishing
and promoting code.

## Script identity policy

Binaries are published as raw code blobs and referenced with `hashType: "data2"`
(CKB-VM v2), the script identity expected by the current Rust / `ckb-std` build
path. (`hashType: "data"` pins CKB-VM v0, whose memory model triggers
`MemWriteOnExecutablePage` on these binaries.) The identity is recorded in each
artifact so downstream state deployment does not guess.

## Pool script selection

`pool_type` no longer embeds the code hashes of `share_xudt` or `treasury_lock`.
Those hashes are pool config: pool creation writes `share_xudt_code_hash` into every
PoolData payload and, for xUDT pools, `treasury_lock_code_hash` as well. That lets
state deployment choose explicit canonical code versions from artifacts without
rebuilding `pool_type`.

Typical deployment order is still:

1. `deploy:share-xudt` → `promote:share-xudt`
2. `deploy:treasury-lock` → `promote:treasury-lock`
3. `deploy:pool-admin-lock` → `promote:pool-admin-lock`
4. `deploy:pool-type` → `promote:pool-type`

## Install and build

```bash
cd deployment
npm install
npm run build
```

## CLI entrypoint

```bash
node --enable-source-maps ./dist/index.js <action> --network <testnet|devnet|mainnet>
```

Examples:

```bash
node --enable-source-maps ./dist/index.js deploy:share-xudt --network testnet
node --enable-source-maps ./dist/index.js promote:share-xudt --network testnet
node --enable-source-maps ./dist/index.js validate:consistency --network testnet
node --enable-source-maps ./dist/index.js deploy:pool-type --network testnet
```

## Preflight validation

```bash
# config/env/build-path checks for a planned action (no side effects)
node --enable-source-maps ./dist/index.js validate:config deploy:pool-type --network testnet

# build the binaries and report their fresh code hashes
node --enable-source-maps ./dist/index.js validate:consistency --network testnet
```

## Environment

Copy `.env.example` to `.env`.

Required per network: `<NET>_CKB_RPC_URL`, `<NET>_DEPLOYER_PRIVATE_KEY`.

Controls: `DEPLOY_NETWORK` (default network), `DRY_RUN` (defaults `true`; set `false`
for real broadcasts), `BROADCAST` (explicit operator flag).

Devnet (offckb) also needs the local secp `KnownScript` override
(`DEVNET_SECP256K1_BLAKE160_*`) — populate from `offckb system-scripts`.

## Broadcast behavior

When `DRY_RUN=false`, the toolbox performs real chain broadcasts. Code deployment
actions build the contracts first and compute occupied capacity dynamically. Devnet
broadcast paths use an explicit fee-rate fallback.

## Artifacts

Written under `deployment/artifacts/` as `<network>.<script-family>.json` (e.g.
`testnet.pool-type.json`), carrying the `latestCandidate` + canonical `versions` map.

**testnet/mainnet artifacts are committed** (they are the canonical record of the
deployed code hashes + outpoints, which the watcher/keeper reads to create pools);
only `devnet*.json` is gitignored, since every operator regenerates devnet locally.
