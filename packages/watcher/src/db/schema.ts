//! Watcher SQLite schema, embedded as a string so it bundles into `dist` (and the
//! Docker image) without a separate copy step. The chain is the source of truth;
//! these tables are a queryable projection the indexer keeps in sync, plus the
//! keeper's tx log. All bigint/u128 values are stored as TEXT (decimal) to avoid
//! JS number loss.
//!
//! Positions are deliberately NOT stored: a holder's share cells are read on-demand
//! from chain (the SDK's lock-scoped query) when the API serves `/positions`, so we
//! don't index every share cell of every holder (heavy + churns on every deposit/
//! redeem/burn). Only the pools projection + the keeper tx log are persisted.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pools (
  pool_id       TEXT PRIMARY KEY,
  feed_id       TEXT NOT NULL,
  duration_secs TEXT NOT NULL,
  lane_label    TEXT,
  status        INTEGER NOT NULL,
  winner        INTEGER NOT NULL,
  variant       INTEGER NOT NULL,
  start_time    TEXT NOT NULL,
  close_time    TEXT NOT NULL,
  void_time     TEXT NOT NULL,
  up_total      TEXT NOT NULL,
  down_total    TEXT NOT NULL,
  start_price   TEXT NOT NULL,
  settle_price  TEXT NOT NULL,
  used_pt       TEXT NOT NULL,
  rake_bps      INTEGER NOT NULL,
  oracle_commit TEXT NOT NULL,
  capacity      TEXT NOT NULL,
  tx_hash       TEXT NOT NULL,
  out_index     INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  indexed_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pools_lane ON pools (feed_id, duration_secs);
CREATE INDEX IF NOT EXISTS idx_pools_status ON pools (status);

CREATE TABLE IF NOT EXISTS tx_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id    TEXT,
  lane_key   TEXT,
  round_key  TEXT,
  action     TEXT NOT NULL,
  tx_hash    TEXT,
  status     TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txlog_pool ON tx_log (pool_id, action, status);
CREATE INDEX IF NOT EXISTS idx_txlog_round ON tx_log (round_key, status);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
