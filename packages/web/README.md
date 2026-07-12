# ckb-up-down-web

Player-facing web frontend for **CKB Up/Down**. Vite + React SPA.

## Architecture — thin client, server-built transactions

CKB is a UTXO/cell chain: there's no account balance to read and no contract method to
call. The app is deliberately a **thin read/sign/submit shell** — **no project SDK ships
to the browser**. The only client-side chain library is the wallet connector (CCC),
because signing must happen where the keys live.

- **Reads → the watcher REST API.** Listings, odds, positions and history come from
  `ckb-up-down-watcher`'s Fastify+SQLite API (`src/api/`). The browser never decodes
  cells or pages CKB RPC. The watcher is treated as an **HTTP contract** — its response
  shapes are replicated in `src/api/types.ts`, never imported (the decoupling rule).
- **Writes → the watcher builds the tx; the wallet signs.** The frontend POSTs an
  *intent* (`poolId`, the wallet's lock, amounts/sides) to `POST /tx/{deposit,redeem,burn}`.
  The watcher builds a **fully-formed unsigned** transaction with the SDK (server-side)
  and returns it as molecule hex. The browser deserializes it (`ccc.Transaction.fromBytes`),
  the wallet signs, and `signer.sendTransaction` broadcasts. Keys never leave the browser;
  the SDK never enters it.

```
reads :  components → hooks (TanStack Query) → api/client → watcher GET
writes:  components → tx/actions → watcher POST /tx/* → (unsigned tx) → wallet sign + send
```

## Layout

```
src/
  config.ts          # env → watcher URL + network + RPC for the wallet client
  api/               # types (watcher contract) · client (typed fetch + POST /tx/*) · hooks
  wallet/            # CCC provider · useWallet (signer + lock hash + lock script)
  tx/actions.ts      # deposit · redeem · burnShares  (POST intent → sign → send)
  pages/             # LanesPage · PoolDetailPage · PositionsPage · HistoryPage
  ui/                # ConnectButton
  format.ts          # CKB/time/odds display helpers
```

## Run

```bash
cp .env.example .env        # set VITE_WATCHER_API_URL, network, RPC
npm install
npm run dev                 # http://localhost:5173
```

`npm run build` for a production bundle (static files), `npm run typecheck` to check types.

## Networks

`VITE_CKB_NETWORK` selects which network the wallet talks to. The watcher decides which
deployment its tx-builder targets, so the frontend just needs the API URL + the wallet's
network/RPC. Real browser wallets target **testnet/mainnet**; **devnet** is mainly for our
private-key lifecycle tests (most wallets won't reach a local node).

> Until the watcher's real `OracleSource` is wired, devnet pools stay OPEN (deposits work)
> but won't lock/settle/pay out — the read API and deposit flow are still fully exercisable.
