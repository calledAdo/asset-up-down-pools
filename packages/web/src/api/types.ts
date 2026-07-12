//! The watcher HTTP API contract, replicated here as the decoupling rule requires
//! (no import of the watcher package). These mirror `serializePool` /
//! `serializePosition` / `poolOdds` in packages/watcher/src/api/server.ts +
//! odds.ts. All on-chain integers arrive as decimal STRINGS (bigint-safe JSON).
//! Keep this in sync if the watcher's serializers change.

export type Hex = `0x${string}`;

export type PoolStatus = "open" | "locked" | "settled" | "closed" | "void" | "finalized";
export type WinnerName = "undecided" | "up" | "down" | "void";
export type Variant = "ckb" | "xudt";

export interface SideOdds {
  /** Staked on this side (decimal string, shannons or xUDT base units). */
  pool: string;
  /** Market-implied probability this side wins. */
  impliedProb: number;
  /** Payout per 1 unit staked if this side wins; null if the side is empty. */
  payoutMultiple: number | null;
}

export interface PoolOdds {
  up: SideOdds;
  down: SideOdds;
  total: string;
  rakeIfUpWins: string;
  rakeIfDownWins: string;
}

export interface OutPoint {
  txHash: Hex;
  index: number;
}

/** One OHLC candle of the feed price. Times are unix-seconds strings; prices are
 *  decimal strings in the feed's quote unit (e.g. USD). Indexer-provided (the mock
 *  supplies it today; the real watcher would expose feed candles from oracle ticks). */
export interface Candle {
  t: string;
  o: string;
  h: string;
  l: string;
  c: string;
}

export interface Pool {
  poolId: Hex;
  feedId: Hex;
  lane: { label: string; durationSecs: string };
  status: PoolStatus;
  statusCode: number;
  winner: WinnerName;
  variant: Variant;
  startTime: string;
  closeTime: string;
  voidTime: string;
  rakeBps: number;
  prices: { start: string; settle: string; usedPt: string };
  odds: PoolOdds;
  outPoint: OutPoint;
  indexedAt: string;
  /** Recent feed candles for the round's chart; present on pool-detail reads. */
  priceSeries?: Candle[];
}

export interface Lane {
  label: string;
  feedId: Hex;
  durationSecs: string;
  rakeBps: number;
  createLeadSecs: string;
  currentOpenPool: Pool | null;
  livePoolCount: number;
}

export interface Position {
  poolId: Hex;
  side: "up" | "down";
  sideCode: number;
  amount: string;
  holderLockHash: Hex;
  outPoint: OutPoint;
}

export interface Health {
  ok: boolean;
  lastIndexedAt: string | null;
}
