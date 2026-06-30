//! The five oracle-driven keeper transitions, mirroring `pool_type/src/main.rs`:
//!
//!   ACTIVATE       OPEN → LOCKED | VOID     (validate_activate)
//!   CORRECT-START  LOCKED → LOCKED          (validate_correct_start)
//!   RESOLVE        LOCKED → SETTLED | VOID  (validate_resolve)
//!   CORRECT-SETTLE SETTLED → SETTLED        (validate_correct_settle)
//!   FINALIZE       SETTLED → FINALIZED      (validate_finalize)
//!
//! All five hold the `phase_frozen` invariant: totals, PoolCell capacity and share
//! supply are frozen, and — since a transition moves no staked asset — the xUDT
//! TreasuryCell must stay **out of the transaction entirely** (`pool_type` rejects
//! it on either side). So these builders are variant-agnostic: just PoolCell
//! in→out + the oracle read-dep, no treasury or asset wiring. They differ only in
//! the next PoolData and the oracle band each requires. Each consumes a resolved
//! {@link OracleTick} — the SDK core never discovers or decodes an oracle cell
//! (see `ckb-up-down-sdk/oracle`); the tick's cell is attached as a read CellDep,
//! which `pool_type`'s `find_oracle` matches by feed and commitment. Drafts have
//! no fee inputs/change.

import { ccc } from "@ckb-ccc/core";

import {
  SIDE_DOWN,
  SIDE_UP,
  STATUS_FINALIZED,
  STATUS_LOCKED,
  STATUS_OPEN,
  STATUS_SETTLED,
  STATUS_VOID,
  WINNER_VOID,
  grace,
} from "../constants.js";
import { encodePoolDataHex } from "../codec/poolData.js";
import type { Hex } from "../internal/bytes.js";
import type { PoolView } from "../query/pools.js";
import type { PoolCodeDeps, PoolData, PoolDeployment } from "../types.js";
import { assertTickForPool, type OracleTick } from "./oracleTick.js";
import { attachOracleTick, attachPoolAdminDep, attachPoolTypeDep } from "./readDeps.js";

/** @public */
export interface KeeperTransitionParams {
  deploy: PoolDeployment;
  deps: PoolCodeDeps;
  /** The PoolCell to advance. */
  pool: PoolView;
  /** The resolved oracle observation backing this transition. */
  oracle: OracleTick;
}

/** settle/start-price → winner: UP if above, DOWN if below, VOID on a tie. */
function winnerFor(price: bigint, startPrice: bigint): number {
  if (price > startPrice) return SIDE_UP;
  if (price < startPrice) return SIDE_DOWN;
  return WINNER_VOID;
}

function voidTimeOf(pool: PoolData): bigint {
  return pool.closeTime + grace(pool.closeTime - pool.startTime);
}

/**
 * Shared assembly: PoolCell in→out (capacity unchanged), the next PoolData, and
 * the oracle read-dep. The treasury is never touched — `phase_frozen` forbids it
 * in a transition — so this is identical for CKB and xUDT pools.
 */
function buildTransition(p: KeeperTransitionParams, nextData: PoolData): ccc.Transaction {
  assertTickForPool(p.oracle, p.pool.data);

  const tx = ccc.Transaction.from({
    version: 0n,
    cellDeps: [],
    headerDeps: [],
    inputs: [{ previousOutput: p.pool.outPoint, since: 0n }],
    outputs: [{ lock: p.pool.lock, type: p.pool.typeScript, capacity: p.pool.capacity }],
    outputsData: [encodePoolDataHex(nextData)],
    witnesses: [],
  });

  // pool_type (PoolCell in+out), pool_admin_lock (input lock, continuation path),
  // and the oracle cell as a read dep. No treasury/asset deps: the treasury is
  // absent from a transition by design.
  attachPoolTypeDep(tx, p.deps);
  attachPoolAdminDep(tx, p.deps);
  attachOracleTick(tx, p.oracle);

  return tx;
}

/**
 * ACTIVATE (OPEN → LOCKED, or OPEN → VOID). Locks a two-sided pool with a
 * provisional start tick strictly inside `(start, close)`; voids a one-sided pool
 * proven past start, or any pool whose tick reached `close` un-activated.
 */
export function buildActivateTx(p: KeeperTransitionParams): ccc.Transaction {
  const prev = p.pool.data;
  if (prev.status !== STATUS_OPEN) {
    throw new Error(`ACTIVATE requires an OPEN pool (status ${prev.status})`);
  }
  const pub = p.oracle.publishTimeUnix;
  const oneSided = prev.upTotal === 0n || prev.downTotal === 0n;

  if (!oneSided && pub >= prev.startTime && pub < prev.closeTime) {
    return buildTransition(p, {
      ...prev,
      status: STATUS_LOCKED,
      startPrice: p.oracle.price,
      usedPt: pub,
    });
  }
  if ((oneSided && pub >= prev.startTime) || pub >= prev.closeTime) {
    return buildTransition(p, {
      ...prev,
      status: STATUS_VOID,
      winner: WINNER_VOID,
      startPrice: 0n,
      settlePrice: 0n,
      usedPt: 0n,
    });
  }
  throw new Error(
    `oracle tick (publish_time ${pub}) is not in an activatable band for this pool`,
  );
}

/**
 * CORRECT-START (LOCKED → LOCKED). Replace the provisional start tick with a
 * strictly earlier in-band one (`start <= pub < used_pt`), recomputing start_price.
 */
export function buildCorrectStartTx(p: KeeperTransitionParams): ccc.Transaction {
  const prev = p.pool.data;
  if (prev.status !== STATUS_LOCKED) {
    throw new Error(`CORRECT-START requires a LOCKED pool (status ${prev.status})`);
  }
  const pub = p.oracle.publishTimeUnix;
  if (!(pub >= prev.startTime && pub < prev.usedPt)) {
    throw new Error(`oracle tick (publish_time ${pub}) is not in [start, used_pt)`);
  }
  return buildTransition(p, { ...prev, startPrice: p.oracle.price, usedPt: pub });
}

/**
 * RESOLVE (LOCKED → SETTLED, or LOCKED → VOID). A tick in `[close, void_time)`
 * settles the pool and picks the winner; a tick at/after `void_time` voids it
 * (no resolution happened in time).
 */
export function buildResolveTx(p: KeeperTransitionParams): ccc.Transaction {
  const prev = p.pool.data;
  if (prev.status !== STATUS_LOCKED) {
    throw new Error(`RESOLVE requires a LOCKED pool (status ${prev.status})`);
  }
  const pub = p.oracle.publishTimeUnix;
  const voidTime = voidTimeOf(prev);

  if (pub >= prev.closeTime && pub < voidTime) {
    return buildTransition(p, {
      ...prev,
      status: STATUS_SETTLED,
      settlePrice: p.oracle.price,
      usedPt: pub,
      winner: winnerFor(p.oracle.price, prev.startPrice),
    });
  }
  if (pub >= voidTime) {
    // start_price / settle_price / used_pt all carried through unchanged.
    return buildTransition(p, { ...prev, status: STATUS_VOID, winner: WINNER_VOID });
  }
  throw new Error(`oracle tick (publish_time ${pub}) is before close; cannot resolve yet`);
}

/**
 * CORRECT-SETTLE (SETTLED → SETTLED). Replace the recorded settle tick with a
 * strictly earlier in-band one (`close <= pub < used_pt`), recomputing the winner.
 */
export function buildCorrectSettleTx(p: KeeperTransitionParams): ccc.Transaction {
  const prev = p.pool.data;
  if (prev.status !== STATUS_SETTLED) {
    throw new Error(`CORRECT-SETTLE requires a SETTLED pool (status ${prev.status})`);
  }
  const pub = p.oracle.publishTimeUnix;
  if (!(pub >= prev.closeTime && pub < prev.usedPt)) {
    throw new Error(`oracle tick (publish_time ${pub}) is not in [close, used_pt)`);
  }
  return buildTransition(p, {
    ...prev,
    settlePrice: p.oracle.price,
    usedPt: pub,
    winner: winnerFor(p.oracle.price, prev.startPrice),
  });
}

/**
 * FINALIZE (SETTLED → FINALIZED). Latch the result once an authentic tick proves
 * real time reached `void_time`. Only `status` changes.
 */
export function buildFinalizeTx(p: KeeperTransitionParams): ccc.Transaction {
  const prev = p.pool.data;
  if (prev.status !== STATUS_SETTLED) {
    throw new Error(`FINALIZE requires a SETTLED pool (status ${prev.status})`);
  }
  const pub = p.oracle.publishTimeUnix;
  const voidTime = voidTimeOf(prev);
  if (pub < voidTime) {
    throw new Error(`oracle tick (publish_time ${pub}) has not reached void_time ${voidTime}`);
  }
  return buildTransition(p, { ...prev, status: STATUS_FINALIZED });
}

// ---- batching ------------------------------------------------------------

/** A keeper transition kind that a single builder produces (1 PoolCell in→out). */
export type TransitionKind =
  | "activate"
  | "correct-start"
  | "resolve"
  | "correct-settle"
  | "finalize";

const TRANSITION_BUILDERS: Record<TransitionKind, (p: KeeperTransitionParams) => ccc.Transaction> = {
  activate: buildActivateTx,
  "correct-start": buildCorrectStartTx,
  resolve: buildResolveTx,
  "correct-settle": buildCorrectSettleTx,
  finalize: buildFinalizeTx,
};

/** @public */
export interface BatchTransitionItem extends KeeperTransitionParams {
  kind: TransitionKind;
}

/**
 * Fold several boundary-coincident transitions into ONE transaction. This is sound
 * because each PoolCell is its own `pool_type` script group (args = unique
 * `pool_id`), validated independently — so the pools cannot interfere — and
 * `pool_admin_lock` checks continuation **group-wide** (every PoolCell input must
 * recreate its typeID under the same lock). They share only read-only cell-deps
 * (`pool_type` code, `pool_admin_lock` code, the oracle cell), which de-duplicate.
 * Transitions carry no header dep and no witness (the continuation path needs
 * neither), so merging is concatenation of inputs/outputs + a union of cell-deps;
 * fee inputs/change are added later by the caller, exactly as for one transition.
 *
 * Guard: within a feed every item must resolve to the **same** oracle cell —
 * otherwise the merged tx would carry two same-feed oracle deps and `find_oracle`
 * rejects it as ambiguous (`pool_type/src/main.rs`). Callers (the watcher) group by
 * oracle cell so this never trips; the check turns a silent on-chain failure into a
 * clear build-time error.
 */
export function buildTransitionBatch(items: BatchTransitionItem[]): ccc.Transaction {
  if (items.length === 0) {
    throw new Error("buildTransitionBatch: empty batch");
  }
  const byFeed = new Map<string, string>();
  for (const it of items) {
    const feed = (it.pool.data.feedId as string).toLowerCase();
    const op = it.oracle.cellDep.outPoint;
    const cell = `${op.txHash}:${op.index}`;
    const seen = byFeed.get(feed);
    if (seen !== undefined && seen !== cell) {
      throw new Error(
        `buildTransitionBatch: feed ${feed} references two oracle cells (${seen} vs ${cell}); ` +
          `pool_type's find_oracle would reject the batch as ambiguous`,
      );
    }
    byFeed.set(feed, cell);
  }

  const parts = items.map((it) => TRANSITION_BUILDERS[it.kind](it));
  const tx = parts[0];
  for (let k = 1; k < parts.length; k++) {
    const part = parts[k];
    for (let i = 0; i < part.inputs.length; i++) {
      tx.inputs.push(part.inputs[i]);
      tx.outputs.push(part.outputs[i]);
      tx.outputsData.push(part.outputsData[i]);
    }
    for (const dep of part.cellDeps) {
      tx.addCellDeps(dep);
    }
  }
  return tx;
}
