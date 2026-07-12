//! Runtime configuration, all from Vite env (`VITE_*`). The frontend ships NO
//! project SDK: reads come from the watcher API, and the watcher also builds the
//! write transactions, so the browser only needs the API URL + which network the
//! wallet talks to. (CCC, the wallet connector, is the only chain library here —
//! signing must happen client-side where the keys live.)

export type NetworkName = "devnet" | "testnet" | "mainnet";

const env = import.meta.env;

export const WATCHER_API_URL: string =
  (env.VITE_WATCHER_API_URL as string | undefined)?.replace(/\/$/, "") ?? "http://127.0.0.1:8080";

export const NETWORK: NetworkName = (env.VITE_CKB_NETWORK as NetworkName | undefined) ?? "devnet";

/** CKB JSON-RPC URL for the wallet client (devnet points at the local node). */
export const CKB_RPC_URL: string | undefined = env.VITE_CKB_RPC_URL as string | undefined;
