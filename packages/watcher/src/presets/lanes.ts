//! Example lane presets. Lanes are fully config-driven; these are sensible
//! defaults for a BTC/USD board (5m, 15m, 1h, 1d) using the SDK's testnet oracle
//! trust root. Override the feed id / identity for your own deployment.

import { TESTNET_ORACLE_IDENTITY, type Hex } from "ckb-up-down-sdk";
import type { OracleIdentity } from "ckb-up-down-sdk/ckb";

import type { LaneConfig } from "../config.js";

/** Pyth BTC/USD feed id (mainnet/testnet share the feed id). */
export const BTC_USD_FEED: Hex = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

const MIN = 60n;
const HOUR = 60n * MIN;

/**
 * Default BTC board: four cadences on a time grid. `createLeadSecs` is a small
 * pre-stage lead before each grid boundary (the deposit window itself is one full
 * duration). All CKB-staked at a 2% rake; swap `asset`/`rakeBps` as needed.
 */
export function defaultBtcLanes(
  feedId: Hex = BTC_USD_FEED,
  oracleIdentity: OracleIdentity = TESTNET_ORACLE_IDENTITY,
): LaneConfig[] {
  const base = {
    feedId,
    rakeBps: 200,
    asset: { kind: "ckb" } as const,
    oracleIdentity,
  };
  return [
    { ...base, label: "BTC-5m", durationSecs: 5n * MIN, createLeadSecs: 15n },
    { ...base, label: "BTC-15m", durationSecs: 15n * MIN, createLeadSecs: 30n },
    { ...base, label: "BTC-1h", durationSecs: 1n * HOUR, createLeadSecs: 60n },
    { ...base, label: "BTC-1d", durationSecs: 24n * HOUR, createLeadSecs: 5n * MIN },
  ];
}
