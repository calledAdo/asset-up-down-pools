//! SQLite access: open the file, apply the schema, and expose a small typed repo.
//! bigints cross the boundary as decimal TEXT (see schema.ts). Synchronous
//! better-sqlite3 fits the single-process model — no connection pool, no await.

import Database from "better-sqlite3";

import { SCHEMA_SQL } from "./schema.js";

export type Hex = `0x${string}`;

/** A pool row, decoded (bigints as bigint, not TEXT). */
export interface PoolRow {
  poolId: Hex;
  feedId: Hex;
  durationSecs: bigint;
  laneLabel: string | null;
  status: number;
  winner: number;
  variant: number;
  startTime: bigint;
  closeTime: bigint;
  voidTime: bigint;
  upTotal: bigint;
  downTotal: bigint;
  startPrice: bigint;
  settlePrice: bigint;
  usedPt: bigint;
  rakeBps: number;
  oracleCommit: Hex;
  capacity: bigint;
  txHash: Hex;
  outIndex: number;
  createdAt: number;
  indexedAt: number;
}

export interface TxLogRow {
  id: number;
  poolId: Hex | null;
  laneKey: string | null;
  roundKey: string | null;
  action: string;
  txHash: Hex | null;
  status: "sent" | "committed" | "failed";
  detail: string | null;
  createdAt: number;
  updatedAt: number;
}

interface PoolDbRow {
  pool_id: string;
  feed_id: string;
  duration_secs: string;
  lane_label: string | null;
  status: number;
  winner: number;
  variant: number;
  start_time: string;
  close_time: string;
  void_time: string;
  up_total: string;
  down_total: string;
  start_price: string;
  settle_price: string;
  used_pt: string;
  rake_bps: number;
  oracle_commit: string;
  capacity: string;
  tx_hash: string;
  out_index: number;
  created_at: number;
  indexed_at: number;
}

function decodePool(r: PoolDbRow): PoolRow {
  return {
    poolId: r.pool_id as Hex,
    feedId: r.feed_id as Hex,
    durationSecs: BigInt(r.duration_secs),
    laneLabel: r.lane_label,
    status: r.status,
    winner: r.winner,
    variant: r.variant,
    startTime: BigInt(r.start_time),
    closeTime: BigInt(r.close_time),
    voidTime: BigInt(r.void_time),
    upTotal: BigInt(r.up_total),
    downTotal: BigInt(r.down_total),
    startPrice: BigInt(r.start_price),
    settlePrice: BigInt(r.settle_price),
    usedPt: BigInt(r.used_pt),
    rakeBps: r.rake_bps,
    oracleCommit: r.oracle_commit as Hex,
    capacity: BigInt(r.capacity),
    txHash: r.tx_hash as Hex,
    outIndex: r.out_index,
    createdAt: r.created_at,
    indexedAt: r.indexed_at,
  };
}

export type Db = Database.Database;

export interface WatcherDb {
  raw: Db;
  upsertPool(row: Omit<PoolRow, "createdAt" | "indexedAt">, now: number): void;
  getPool(poolId: Hex): PoolRow | null;
  listPools(filter?: { status?: number; laneKey?: string }): PoolRow[];
  latestPoolForLane(feedId: Hex, durationSecs: bigint): PoolRow | null;
  insertTxLog(row: {
    poolId?: Hex | null;
    laneKey?: string | null;
    roundKey?: string | null;
    action: string;
    txHash?: Hex | null;
    status: TxLogRow["status"];
    detail?: string | null;
  }): number;
  updateTxLog(id: number, patch: { txHash?: Hex | null; status?: TxLogRow["status"]; detail?: string | null }): void;
  /** Is there an unfailed (sent or committed) tx_log row for this round CREATE? */
  hasOpenCreate(roundKey: string): boolean;
  /** Is there an unfailed tx_log row for this pool action? */
  hasOpenAction(poolId: Hex, action: string): boolean;
  /** All `sent` tx_log rows — broadcast-but-unconfirmed, for startup reconciliation. */
  openSentTxLogs(): TxLogRow[];
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

/** Open (or create) the SQLite DB and apply the schema. */
export function openDb(path: string): WatcherDb {
  const raw = new Database(path);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.exec(SCHEMA_SQL);
  return makeRepo(raw);
}

function makeRepo(raw: Db): WatcherDb {
  const upsertPoolStmt = raw.prepare(`
    INSERT INTO pools (pool_id, feed_id, duration_secs, lane_label, status, winner, variant,
      start_time, close_time, void_time, up_total, down_total, start_price, settle_price,
      used_pt, rake_bps, oracle_commit, capacity, tx_hash, out_index, created_at, indexed_at)
    VALUES (@pool_id, @feed_id, @duration_secs, @lane_label, @status, @winner, @variant,
      @start_time, @close_time, @void_time, @up_total, @down_total, @start_price, @settle_price,
      @used_pt, @rake_bps, @oracle_commit, @capacity, @tx_hash, @out_index, @now, @now)
    ON CONFLICT(pool_id) DO UPDATE SET
      status=@status, winner=@winner, start_time=@start_time, close_time=@close_time,
      void_time=@void_time, up_total=@up_total, down_total=@down_total, start_price=@start_price,
      settle_price=@settle_price, used_pt=@used_pt, capacity=@capacity, tx_hash=@tx_hash,
      out_index=@out_index, lane_label=@lane_label, indexed_at=@now
  `);

  const getPoolStmt = raw.prepare(`SELECT * FROM pools WHERE pool_id = ?`);
  const latestLaneStmt = raw.prepare(
    `SELECT * FROM pools WHERE feed_id = ? AND duration_secs = ? ORDER BY CAST(start_time AS INTEGER) DESC LIMIT 1`,
  );

  const insTxLogStmt = raw.prepare(`
    INSERT INTO tx_log (pool_id, lane_key, round_key, action, tx_hash, status, detail, created_at, updated_at)
    VALUES (@pool_id, @lane_key, @round_key, @action, @tx_hash, @status, @detail, @now, @now)
  `);

  const getMetaStmt = raw.prepare(`SELECT value FROM meta WHERE key = ?`);
  const setMetaStmt = raw.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  return {
    raw,

    upsertPool(row, now) {
      upsertPoolStmt.run({
        pool_id: row.poolId,
        feed_id: row.feedId,
        duration_secs: row.durationSecs.toString(),
        lane_label: row.laneLabel,
        status: row.status,
        winner: row.winner,
        variant: row.variant,
        start_time: row.startTime.toString(),
        close_time: row.closeTime.toString(),
        void_time: row.voidTime.toString(),
        up_total: row.upTotal.toString(),
        down_total: row.downTotal.toString(),
        start_price: row.startPrice.toString(),
        settle_price: row.settlePrice.toString(),
        used_pt: row.usedPt.toString(),
        rake_bps: row.rakeBps,
        oracle_commit: row.oracleCommit,
        capacity: row.capacity.toString(),
        tx_hash: row.txHash,
        out_index: row.outIndex,
        now,
      });
    },

    getPool(poolId) {
      const r = getPoolStmt.get(poolId) as PoolDbRow | undefined;
      return r ? decodePool(r) : null;
    },

    listPools(filter) {
      const clauses: string[] = [];
      const args: unknown[] = [];
      if (filter?.status !== undefined) {
        clauses.push("status = ?");
        args.push(filter.status);
      }
      if (filter?.laneKey) {
        const [feed, dur] = filter.laneKey.split(":");
        clauses.push("feed_id = ? AND duration_secs = ?");
        args.push(feed, dur);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = raw
        .prepare(`SELECT * FROM pools ${where} ORDER BY CAST(start_time AS INTEGER) DESC`)
        .all(...args) as PoolDbRow[];
      return rows.map(decodePool);
    },

    latestPoolForLane(feedId, durationSecs) {
      const r = latestLaneStmt.get(feedId, durationSecs.toString()) as PoolDbRow | undefined;
      return r ? decodePool(r) : null;
    },

    insertTxLog(row) {
      const now = Date.now();
      const info = insTxLogStmt.run({
        pool_id: row.poolId ?? null,
        lane_key: row.laneKey ?? null,
        round_key: row.roundKey ?? null,
        action: row.action,
        tx_hash: row.txHash ?? null,
        status: row.status,
        detail: row.detail ?? null,
        now,
      });
      return Number(info.lastInsertRowid);
    },

    updateTxLog(id, patch) {
      const sets: string[] = ["updated_at = @now"];
      const args: Record<string, unknown> = { id, now: Date.now() };
      if (patch.txHash !== undefined) {
        sets.push("tx_hash = @tx_hash");
        args.tx_hash = patch.txHash;
      }
      if (patch.status !== undefined) {
        sets.push("status = @status");
        args.status = patch.status;
      }
      if (patch.detail !== undefined) {
        sets.push("detail = @detail");
        args.detail = patch.detail;
      }
      raw.prepare(`UPDATE tx_log SET ${sets.join(", ")} WHERE id = @id`).run(args);
    },

    hasOpenCreate(roundKey) {
      const r = raw
        .prepare(`SELECT 1 FROM tx_log WHERE round_key = ? AND action = 'create' AND status != 'failed' LIMIT 1`)
        .get(roundKey);
      return r !== undefined;
    },

    hasOpenAction(poolId, action) {
      const r = raw
        .prepare(`SELECT 1 FROM tx_log WHERE pool_id = ? AND action = ? AND status != 'failed' LIMIT 1`)
        .get(poolId, action);
      return r !== undefined;
    },

    openSentTxLogs() {
      const rows = raw.prepare(`SELECT * FROM tx_log WHERE status = 'sent'`).all() as {
        id: number;
        pool_id: string | null;
        lane_key: string | null;
        round_key: string | null;
        action: string;
        tx_hash: string | null;
        status: TxLogRow["status"];
        detail: string | null;
        created_at: number;
        updated_at: number;
      }[];
      return rows.map((r) => ({
        id: r.id,
        poolId: r.pool_id as Hex | null,
        laneKey: r.lane_key,
        roundKey: r.round_key,
        action: r.action,
        txHash: r.tx_hash as Hex | null,
        status: r.status,
        detail: r.detail,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
    },

    getMeta(key) {
      const r = getMetaStmt.get(key) as { value: string } | undefined;
      return r ? r.value : null;
    },

    setMeta(key, value) {
      setMetaStmt.run(key, value);
    },
  };
}
