//! Startup reconciliation. A `tx_log` row is set to `sent` *before* broadcast and
//! flipped to `committed`/`failed` after. A crash in that window leaves a dangling
//! `sent` row that would permanently block its action's idempotency guard. On
//! boot, we resolve each dangling row against the chain so the guard is accurate:
//!
//!   - no tx hash (crashed before/at send) -> failed (never broadcast; safe to retry)
//!   - tx committed                          -> committed
//!   - tx rejected / not found               -> failed (planner will re-propose)
//!   - still pending/proposed                -> left as sent (genuinely in flight)

import type { WatcherDb } from "./db/db.js";

/** Minimal client surface: look up a transaction's status by hash. */
export interface TxStatusClient {
  getTransaction(hash: string): Promise<{ status: string } | undefined | null>;
}

export interface ReconcileResult {
  committed: number;
  failed: number;
  pending: number;
}

/** Resolve dangling `sent` tx_log rows against the chain. Call once at startup. */
export async function reconcile(
  db: WatcherDb,
  client: TxStatusClient,
  log: (msg: string) => void = () => {},
): Promise<ReconcileResult> {
  const result: ReconcileResult = { committed: 0, failed: 0, pending: 0 };

  for (const row of db.openSentTxLogs()) {
    if (!row.txHash) {
      db.updateTxLog(row.id, { status: "failed", detail: "reconcile: no tx hash (pre-send crash)" });
      result.failed++;
      continue;
    }
    let status: string | undefined;
    try {
      const tx = await client.getTransaction(row.txHash);
      status = tx?.status;
    } catch (err) {
      log(`reconcile: lookup failed for ${row.txHash}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (status === "committed") {
      db.updateTxLog(row.id, { status: "committed" });
      result.committed++;
    } else if (status === "pending" || status === "proposed" || status === "sent") {
      result.pending++; // genuinely in flight — leave as sent
    } else {
      db.updateTxLog(row.id, { status: "failed", detail: `reconcile: tx ${status ?? "not found"}` });
      result.failed++;
    }
  }

  if (result.committed || result.failed || result.pending) {
    log(`reconciled tx_log: ${result.committed} committed, ${result.failed} failed, ${result.pending} pending`);
  }
  return result;
}
