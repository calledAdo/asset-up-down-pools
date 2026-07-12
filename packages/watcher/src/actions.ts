//! The keeper's intended on-chain effects, as a discriminated union. The planner
//! emits these from chain state; the executor turns each into a transaction.
//! Oracle-dependent actions carry `minPublishTime` (the boundary the tick must be
//! at/after) and are skipped by the executor when no tick is available yet.

import type { Hex } from "ckb-up-down-sdk";

import type { LaneConfig } from "./config.js";

/** Mint the next round of a lane (oracle-free). */
export interface CreateAction {
  kind: "create";
  lane: LaneConfig;
  laneKey: string;
  /** Idempotency key: `<laneKey>@<startTime>`. */
  roundKey: string;
  startTime: bigint;
  closeTime: bigint;
}

/** An oracle-driven transition of an existing pool. */
export interface TransitionAction {
  kind: "activate" | "resolve" | "finalize";
  poolId: Hex;
  feedId: Hex;
  /** The tick must have `publish_time >= minPublishTime` (start/close/void boundary). */
  minPublishTime: bigint;
}

/** Tear down a drained terminal pool (oracle-free). */
export interface CloseAction {
  kind: "close";
  poolId: Hex;
}

export type Action = CreateAction | TransitionAction | CloseAction;

/** Whether an action needs an oracle tick (and is skipped without one). */
export function needsTick(action: Action): action is TransitionAction {
  return action.kind === "activate" || action.kind === "resolve" || action.kind === "finalize";
}
