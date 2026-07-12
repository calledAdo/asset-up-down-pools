//! The executor: turn one planned Action into a broadcast transaction. It is the
//! only component that writes to chain. Idempotency is via `tx_log` (an unfailed
//! row for the same round/pool-action blocks a re-fire), so it survives restarts.
//!
//! Per the deferred-oracle decision: CREATE and CLOSE (oracle-free) broadcast
//! live; activate/resolve/finalize resolve a tick from the `OracleSource` first
//! and are skipped (logged) when none is available yet.

import type { Hex, Script } from "ckb-up-down-sdk";
import type { OracleTick, PoolAsset, TransitionKind } from "ckb-up-down-sdk/tx";

import type { Action, TransitionAction } from "./actions.js";
import { laneOracleCommit } from "./config.js";
import type { WatcherDb } from "./db/db.js";
import { needsTick } from "./actions.js";
import type { OracleSource } from "./oracle/source.js";
import type { KeeperAction } from "./keeperCore.js";

/** Minimal tx shape the executor passes around (CCC `Transaction` satisfies it). */
export type Tx = unknown;

/** The keeper draft surface the executor needs (the SDK's `KeeperClient` fits). */
export interface KeeperLike {
  draftCreate(p: {
    seedInput: { previousOutput: { txHash: Hex; index: number }; since: bigint };
    creatorLock: Script;
    asset: PoolAsset;
    feedId: Hex;
    oracleCommit: Hex;
    startTime: bigint;
    closeTime: bigint;
    rakeBps: number;
  }): Promise<Tx>;
  draftActivate(p: { poolId: Hex; oracle: OracleTick }): Promise<Tx>;
  draftCorrectStart(p: { poolId: Hex; oracle: OracleTick }): Promise<Tx>;
  draftResolve(p: { poolId: Hex; oracle: OracleTick }): Promise<Tx>;
  draftCorrectSettle(p: { poolId: Hex; oracle: OracleTick }): Promise<Tx>;
  draftFinalize(p: { poolId: Hex; oracle: OracleTick }): Promise<Tx>;
  draftClose(p: { poolId: Hex; creatorLock: Script }): Promise<Tx>;
  /** Fold several boundary-coincident transitions (sharing an oracle cell) into one tx. */
  draftTransitionBatch(
    items: { poolId: Hex; kind: TransitionKind; oracle: OracleTick }[],
  ): Promise<Tx>;
  complete(tx: Tx, signer: SignerLike, options?: { feeRate?: bigint }): Promise<Tx>;
}

export interface SignerLike {
  sendTransaction(tx: Tx): Promise<string>;
}

export interface ClientLike {
  findCells(query: {
    script: Script;
    scriptType: "lock";
    scriptSearchMode: "exact";
    filter?: { scriptLenRange?: [number, number]; outputDataLenRange?: [number, number] };
  }): AsyncIterable<{ outPoint: { txHash: string; index: number | bigint } }>;
  waitTransaction(hash: string): Promise<unknown>;
}

export interface ExecContext {
  keeper: KeeperLike;
  signer: SignerLike;
  client: ClientLike;
  creatorLock: Script;
  oracle: OracleSource;
  db: WatcherDb;
  /**
   * Fee rate (shannons/KB) for the keeper's `complete()`. Required on devnet —
   * offckb's `get_fee_rate_statistics` returns null and CCC's `getFeeRate` throws.
   */
  feeRate?: bigint;
  /**
   * Drop cached chain reads so the next draft is built against current state. The
   * keeper doesn't cache between ticks, but a single tick may build several txs; we
   * refetch before each so a pool cell moved by a concurrent deposit/transition
   * doesn't get referenced as a spent outpoint ("Unknown OutPoint"). Wired to the
   * CCC client's `cache.clear()`.
   */
  refresh?: () => Promise<void>;
  log?: (msg: string) => void;
}

export interface ExecResult {
  action: string;
  skipped: boolean;
  reason?: string;
  txHash?: Hex;
}

/** Execute one action. Never throws — failures are recorded and returned. */
export async function execute(action: Action, ctx: ExecContext): Promise<ExecResult> {
  const log = ctx.log ?? (() => {});

  // 1. Idempotency guard.
  if (action.kind === "create") {
    if (ctx.db.hasOpenCreate(action.roundKey)) {
      return { action: action.kind, skipped: true, reason: "in-flight (round)" };
    }
  } else if (ctx.db.hasOpenAction(action.poolId, action.kind)) {
    return { action: action.kind, skipped: true, reason: "in-flight (pool action)" };
  }

  // 2. Oracle-dependent actions need a tick; skip (don't log a tx) when absent.
  let tick: OracleTick | null = null;
  if (needsTick(action)) {
    tick = await ctx.oracle.getTickAtOrAfter(action.feedId, action.minPublishTime);
    if (!tick) {
      log(`skip ${action.kind} ${action.poolId}: no oracle tick >= ${action.minPublishTime}`);
      return { action: action.kind, skipped: true, reason: "no tick" };
    }
  }

  // 3. Record intent (guards re-fire), then build + broadcast.
  const logId =
    action.kind === "create"
      ? ctx.db.insertTxLog({ roundKey: action.roundKey, laneKey: action.laneKey, action: "create", status: "sent" })
      : ctx.db.insertTxLog({ poolId: action.poolId, action: action.kind, status: "sent" });

  try {
    const draft = await buildDraft(action, tick, ctx);
    const completed = await ctx.keeper.complete(draft, ctx.signer, { feeRate: ctx.feeRate });
    const txHash = (await ctx.signer.sendTransaction(completed)) as Hex;
    ctx.db.updateTxLog(logId, { txHash });
    log(`sent ${action.kind} ${txHash}`);
    await ctx.client.waitTransaction(txHash);
    ctx.db.updateTxLog(logId, { status: "committed" });
    return { action: action.kind, skipped: false, txHash };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    ctx.db.updateTxLog(logId, { status: "failed", detail });
    log(`FAILED ${action.kind}: ${detail}`);
    return { action: action.kind, skipped: false, reason: detail };
  }
}

/** A transition action paired with the oracle tick that backs it. */
interface BatchItem {
  action: { kind: TransitionKind; poolId: Hex; feedId: Hex };
  tick: OracleTick;
}

/**
 * Execute several transition actions, folding the ones that share an oracle cell
 * into a single transaction. Boundary-coincident transitions (e.g. RESOLVE the
 * closing round + ACTIVATE the next + ACTIVATE another lane, all on the same tick)
 * become one tx — fewer fees, one atomic boundary. On a batch failure we fall back
 * to per-pool txs so one stale PoolCell can't sink the others, and we refetch
 * (clear cache) before every build so each attempt sees current chain state.
 *
 * Grouping by oracle cell is mandatory: `pool_type`'s `find_oracle` rejects a tx
 * that carries two same-feed oracle deps, so transitions resolving to different
 * cells must go in separate txs.
 */
export async function executeBatch(
  actions: TransitionAction[],
  ctx: ExecContext,
): Promise<ExecResult[]> {
  const log = ctx.log ?? (() => {});

  // 1. Resolve a tick per action. In-flight (idempotency) and tick-less actions are
  //    reported as skipped so the caller can retry a "no tick" soon (oracle lag).
  const items: BatchItem[] = [];
  const skipped: ExecResult[] = [];
  for (const action of actions) {
    if (ctx.db.hasOpenAction(action.poolId, action.kind)) {
      skipped.push({ action: action.kind, skipped: true, reason: "in-flight (pool action)" });
      continue;
    }
    const tick = await ctx.oracle.getTickAtOrAfter(action.feedId, action.minPublishTime);
    if (!tick) {
      log(`skip ${action.kind} ${action.poolId}: no oracle tick >= ${action.minPublishTime}`);
      skipped.push({ action: action.kind, skipped: true, reason: "no tick" });
      continue;
    }
    items.push({ action, tick });
  }
  if (items.length === 0) return skipped;

  // 2. Group by oracle cell (feed + cell outpoint). Same-feed items on different
  //    cells must not share a tx (find_oracle ambiguity).
  const groups = new Map<string, BatchItem[]>();
  for (const it of items) {
    const op = it.tick.cellDep.outPoint;
    const key = `${it.action.feedId.toLowerCase()}:${op.txHash}:${op.index}`;
    const g = groups.get(key);
    if (g) g.push(it);
    else groups.set(key, [it]);
  }

  // 3. Run each group as one tx (a singleton group is just a one-item batch).
  const results: ExecResult[] = [...skipped];
  for (const group of groups.values()) {
    results.push(...(await runBatchGroup(group, ctx)));
  }
  return results;
}

/**
 * Execute actions emitted by the new keeper decision core. Transition actions
 * already carry the exact current oracle cell chosen by `decide`, so this path
 * does not ask `OracleSource` to search by min publish time.
 */
export async function executeDecisions(
  actions: KeeperAction[],
  ctx: ExecContext,
): Promise<ExecResult[]> {
  const transitions: BatchItem[] = [];
  const results: ExecResult[] = [];

  for (const action of actions) {
    if (action.kind === "close") {
      results.push(await execute(action, ctx));
      continue;
    }
    if (ctx.db.hasOpenAction(action.poolId, action.kind)) {
      results.push({ action: action.kind, skipped: true, reason: "in-flight (pool action)" });
      continue;
    }
    transitions.push({
      action: { kind: action.kind, poolId: action.poolId, feedId: action.feedId },
      tick: action.oracle,
    });
  }

  const groups = new Map<string, BatchItem[]>();
  for (const it of transitions) {
    const op = it.tick.cellDep.outPoint;
    const key = `${it.action.feedId.toLowerCase()}:${op.txHash}:${op.index}`;
    const group = groups.get(key);
    if (group) group.push(it);
    else groups.set(key, [it]);
  }

  for (const group of groups.values()) {
    results.push(...(await runBatchGroup(group, ctx)));
  }
  return results;
}

/** Build + broadcast one group as a single tx; on failure, split into singletons. */
async function runBatchGroup(group: BatchItem[], ctx: ExecContext): Promise<ExecResult[]> {
  const log = ctx.log ?? (() => {});
  // Record intent for every pool in the batch (guards re-fire), keyed per pool action.
  const logIds = group.map((it) =>
    ctx.db.insertTxLog({ poolId: it.action.poolId, action: it.action.kind, status: "sent" }),
  );

  try {
    await ctx.refresh?.(); // refetch: draft against current chain state
    const draft = await ctx.keeper.draftTransitionBatch(
      group.map((it) => ({ poolId: it.action.poolId, kind: it.action.kind, oracle: it.tick })),
    );
    const completed = await ctx.keeper.complete(draft, ctx.signer, { feeRate: ctx.feeRate });
    const txHash = (await ctx.signer.sendTransaction(completed)) as Hex;
    for (const id of logIds) ctx.db.updateTxLog(id, { txHash });
    log(group.length > 1 ? `sent batch[${group.length}] ${txHash}` : `sent ${group[0].action.kind} ${txHash}`);
    await ctx.client.waitTransaction(txHash);
    for (const id of logIds) ctx.db.updateTxLog(id, { status: "committed" });
    return group.map((it) => ({ action: it.action.kind, skipped: false, txHash }));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    for (const id of logIds) ctx.db.updateTxLog(id, { status: "failed", detail });
    log(`FAILED ${group.length > 1 ? `batch[${group.length}]` : group[0].action.kind}: ${detail}`);
    // A singleton has nothing to isolate — surface it. The failed tx_log row leaves
    // the action re-fireable on the next tick (refetched), per the user's request.
    if (group.length === 1) {
      return [{ action: group[0].action.kind, skipped: false, reason: detail }];
    }
    log(`falling back to ${group.length} individual transitions`);
    const out: ExecResult[] = [];
    for (const it of group) out.push(...(await runBatchGroup([it], ctx)));
    return out;
  }
}

async function buildDraft(action: Action, tick: OracleTick | null, ctx: ExecContext): Promise<Tx> {
  switch (action.kind) {
    case "create": {
      const seedInput = await pickSeedInput(ctx);
      return ctx.keeper.draftCreate({
        seedInput,
        creatorLock: ctx.creatorLock,
        asset: action.lane.asset,
        feedId: action.lane.feedId,
        oracleCommit: laneOracleCommit(action.lane),
        startTime: action.startTime,
        closeTime: action.closeTime,
        rakeBps: action.lane.rakeBps,
      });
    }
    case "activate":
      return ctx.keeper.draftActivate({ poolId: action.poolId, oracle: tick! });
    case "correct-start":
      return ctx.keeper.draftCorrectStart({ poolId: action.poolId, oracle: tick! });
    case "resolve":
      return ctx.keeper.draftResolve({ poolId: action.poolId, oracle: tick! });
    case "correct-settle":
      return ctx.keeper.draftCorrectSettle({ poolId: action.poolId, oracle: tick! });
    case "finalize":
      return ctx.keeper.draftFinalize({ poolId: action.poolId, oracle: tick! });
    case "close":
      return ctx.keeper.draftClose({ poolId: action.poolId, creatorLock: ctx.creatorLock });
  }
}

/** A live creator-locked cell to seed a CREATE's typeID. */
async function pickSeedInput(
  ctx: ExecContext,
): Promise<{ previousOutput: { txHash: Hex; index: number }; since: bigint }> {
  for await (const cell of ctx.client.findCells({
    script: ctx.creatorLock,
    scriptType: "lock",
    scriptSearchMode: "exact",
    // PLAIN cells only (no type, empty data) — never seed a CREATE from a code/oracle
    // cell that happens to share the creator lock (would fail to resolve on-chain).
    filter: { scriptLenRange: [0, 1], outputDataLenRange: [0, 1] },
  })) {
    return {
      previousOutput: { txHash: cell.outPoint.txHash as Hex, index: Number(cell.outPoint.index) },
      since: 0n,
    };
  }
  throw new Error("creator has no live cell to seed a CREATE");
}
