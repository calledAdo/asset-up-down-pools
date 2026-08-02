//! Typed client over the watcher REST API — the ONLY backend the frontend talks
//! to. Reads (GET) return projections; writes (POST /tx/*) return an UNSIGNED tx
//! (molecule hex) that the wallet signs + the frontend submits. No cell decoding
//! or tx building happens in the browser.

import { WATCHER_API_URL } from "../config.js";
import type { Health, Hex, Lane, Pool, PoolStatus, Position } from "./types.js";

/** A lock script in the shape the backend tx-builder expects (the intent's owner). */
export interface LockLike {
  codeHash: Hex;
  hashType: "type" | "data" | "data1" | "data2";
  args: Hex;
}

async function get<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  const url = new URL(WATCHER_API_URL + path);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw await asError(res, `GET ${path}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(WATCHER_API_URL + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await asError(res, `POST ${path}`);
  return res.json() as Promise<T>;
}

async function asError(res: Response, what: string): Promise<Error> {
  const body = await res.json().catch(() => null);
  const detail = body?.error ?? (await res.text().catch(() => "")) ?? "";
  return new Error(`${what} → ${res.status}${detail ? `: ${detail}` : ""}`);
}

export const api = {
  // reads
  health: () => get<Health>("/health"),
  lanes: () => get<Lane[]>("/lanes"),
  pools: (filter?: { status?: PoolStatus | number; lane?: string }) =>
    get<Pool[]>("/pools", {
      status: filter?.status !== undefined ? String(filter.status) : undefined,
      lane: filter?.lane,
    }),
  pool: (poolId: Hex) => get<Pool>(`/pools/${poolId}`),
  // Positions are looked up by the holder's CKB address; the watcher resolves it to a
  // lock script for the on-chain query (a lock *hash* can't be reversed into a script).
  poolPositions: (poolId: Hex, address: string) => get<Position[]>(`/pools/${poolId}/positions`, { address }),
  positions: (address: string) => get<Position[]>("/positions", { address }),
  history: (lane?: string) => get<Pool[]>("/history", { lane }),

  // writes — return an unsigned tx (molecule hex) to sign + submit
  buildDeposit: (i: { poolId: Hex; lock: LockLike; up?: string; down?: string }) =>
    post<{ tx: Hex }>("/tx/deposit", i),
  buildWithdraw: (i: { poolId: Hex; lock: LockLike; up?: string; down?: string }) =>
    post<{ tx: Hex }>("/tx/withdraw", i),
  buildRedeem: (i: { poolId: Hex; lock: LockLike }) => post<{ tx: Hex }>("/tx/redeem", i),
  buildBurn: (i: { poolId: Hex; lock: LockLike; sides?: number[] }) =>
    post<{ tx: Hex }>("/tx/burn", i),
};
