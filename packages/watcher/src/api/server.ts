//! The frontend-facing HTTP API (Fastify). Reads the SQLite projection the
//! indexer maintains and serves pools, odds, positions, and round history. All
//! bigints are serialized as decimal strings. Permissive CORS for browser use.

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";

import { STATUS_FINALIZED, STATUS_OPEN, STATUS_VOID } from "ckb-up-down-sdk";

import type { LaneConfig } from "../config.js";
import { laneKey } from "../config.js";
import type { PoolRow, WatcherDb } from "../db/db.js";
import { poolOdds } from "../odds.js";
import type { Hex, LockLike, PoolTxBuilder } from "./txBuilder.js";

/** A holder's share position in one pool, read on-demand from chain. */
export interface Position {
  poolId: Hex;
  side: number;
  amount: bigint;
}

/**
 * Reads a holder's positions on-demand from chain (not from the DB — see
 * `db/schema.ts`). `holderAddress` is the holder's CKB address (the API resolves it
 * to a lock script for the lock-scoped query). `poolId` scopes to one pool.
 */
export type PositionsReader = (holderAddress: string, poolId?: Hex) => Promise<Position[]>;

export interface ApiDeps {
  db: WatcherDb;
  lanes: LaneConfig[];
  /**
   * Optional server-side tx builder. When present, the write endpoints
   * (`POST /tx/*`) build unsigned transactions the frontend signs + submits.
   */
  txBuilder?: PoolTxBuilder;
  /**
   * Optional on-demand positions reader. When present, `/positions` and
   * `/pools/:id/positions` serve a holder's live share holdings from chain.
   */
  positions?: PositionsReader;
}

const STATUS_NAME: Record<number, string> = {
  0: "open",
  1: "locked",
  2: "settled",
  3: "closed",
  4: "void",
  5: "finalized",
};
const WINNER_NAME: Record<number, string> = { 0: "undecided", 1: "up", 2: "down", 3: "void" };

/** Reverse of STATUS_NAME, so `?status=open` (the name we serialize) filters correctly. */
const STATUS_CODE: Record<string, number> = Object.fromEntries(
  Object.entries(STATUS_NAME).map(([code, name]) => [name, Number(code)]),
);
/** Parse a `?status=` query: accepts a status name ("open") or a numeric code ("0"). */
function parseStatusQuery(s: string | undefined): number | undefined {
  if (s === undefined || s === "") return undefined;
  if (s in STATUS_CODE) return STATUS_CODE[s];
  const n = Number(s);
  return Number.isInteger(n) ? n : undefined;
}

function serializePool(p: PoolRow) {
  return {
    poolId: p.poolId,
    feedId: p.feedId,
    lane: { label: p.laneLabel, durationSecs: p.durationSecs.toString() },
    status: STATUS_NAME[p.status] ?? String(p.status),
    statusCode: p.status,
    winner: WINNER_NAME[p.winner] ?? String(p.winner),
    variant: p.variant === 1 ? "xudt" : "ckb",
    startTime: p.startTime.toString(),
    closeTime: p.closeTime.toString(),
    voidTime: p.voidTime.toString(),
    rakeBps: p.rakeBps,
    prices: { start: p.startPrice.toString(), settle: p.settlePrice.toString(), usedPt: p.usedPt.toString() },
    odds: poolOdds({ upTotal: p.upTotal, downTotal: p.downTotal, rakeBps: p.rakeBps }),
    outPoint: { txHash: p.txHash, index: p.outIndex },
    indexedAt: p.indexedAt,
  };
}

function serializePosition(p: Position) {
  return {
    poolId: p.poolId,
    side: p.side === 1 ? "up" : "down",
    sideCode: p.side,
    amount: p.amount.toString(),
  };
}

/** Build the Fastify instance (call `.listen` to run, or `.inject` in tests). */
export function buildServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  // Permissive CORS (no extra plugin dep). GETs are reads; POST /tx/* return an
  // unsigned tx for the caller's own wallet to sign — no secrets are served.
  app.addHook("onRequest", async (req, reply) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
    reply.header("access-control-allow-headers", "content-type");
  });
  app.options("/*", async (_req, reply) => reply.code(204).send());

  app.get("/health", async () => ({ ok: true, lastIndexedAt: deps.db.getMeta("lastIndexedAt") }));

  app.get("/lanes", async () => {
    return deps.lanes.map((l) => {
      const key = laneKey(l.feedId, l.durationSecs);
      const pools = deps.db.listPools({ laneKey: key });
      const open = pools.find((p) => p.status === STATUS_OPEN) ?? null;
      return {
        label: l.label,
        feedId: l.feedId,
        durationSecs: l.durationSecs.toString(),
        rakeBps: l.rakeBps,
        createLeadSecs: l.createLeadSecs.toString(),
        currentOpenPool: open ? serializePool(open) : null,
        livePoolCount: pools.length,
      };
    });
  });

  app.get<{ Querystring: { status?: string; lane?: string } }>("/pools", async (req) => {
    const filter: { status?: number; laneKey?: string } = {};
    const st = parseStatusQuery(req.query.status);
    if (st !== undefined) filter.status = st;
    if (req.query.lane) filter.laneKey = req.query.lane;
    return deps.db.listPools(filter).map(serializePool);
  });

  app.get<{ Params: { poolId: string } }>("/pools/:poolId", async (req, reply) => {
    const pool = deps.db.getPool(req.params.poolId as `0x${string}`);
    if (!pool) return reply.code(404).send({ error: "pool not found" });
    return serializePool(pool);
  });

  // Positions are read on-demand from chain (the holder's share cells), not stored.
  // The frontend passes its CKB `address`; the reader resolves it to a lock script.
  const readPositions = async (
    reply: FastifyReply,
    address: string | undefined,
    poolId?: Hex,
  ) => {
    if (!deps.positions) return reply.code(501).send({ error: "positions reader not configured" });
    if (!address) return reply.code(400).send({ error: "address (holder CKB address) is required" });
    try {
      const positions = await deps.positions(address, poolId);
      return positions.map(serializePosition);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  app.get<{ Params: { poolId: string }; Querystring: { address?: string } }>(
    "/pools/:poolId/positions",
    (req, reply) => readPositions(reply, req.query.address, req.params.poolId as Hex),
  );

  app.get<{ Querystring: { address?: string } }>("/positions", (req, reply) =>
    readPositions(reply, req.query.address),
  );

  app.get<{ Querystring: { lane?: string } }>("/history", async (req) => {
    const lane = req.query.lane;
    const settled = [STATUS_FINALIZED, STATUS_VOID].flatMap((s) =>
      deps.db.listPools({ status: s, ...(lane ? { laneKey: lane } : {}) }),
    );
    settled.sort((a, b) => Number(b.closeTime - a.closeTime));
    return settled.map(serializePool);
  });

  // ---- write endpoints: build an UNSIGNED tx for the caller's wallet ----
  // Each returns { tx } as molecule hex. The frontend deserializes
  // (ccc.Transaction.fromBytes), signs with the wallet, and broadcasts.
  if (deps.txBuilder) {
    const builder = deps.txBuilder;

    const validateBase = (body: TxBody | undefined, reply: FastifyReply): { poolId: Hex; lock: LockLike } | null => {
      if (!body?.poolId || !body.poolId.startsWith("0x")) {
        reply.code(400).send({ error: "poolId (0x-hex) is required" });
        return null;
      }
      const lock = body.lock;
      if (!lock?.codeHash || !lock.hashType || lock.args === undefined) {
        reply.code(400).send({ error: "lock { codeHash, hashType, args } is required" });
        return null;
      }
      return { poolId: body.poolId as Hex, lock: lock as LockLike };
    };

    const handle = async (reply: FastifyReply, fn: () => Promise<Hex>) => {
      try {
        return { tx: await fn() };
      } catch (err) {
        return reply.code(422).send({ error: err instanceof Error ? err.message : String(err) });
      }
    };

    app.post<{ Body: TxBody & { up?: string; down?: string } }>("/tx/deposit", async (req, reply) => {
      const base = validateBase(req.body, reply);
      if (!base) return reply;
      const upAmount = BigInt(req.body.up ?? "0");
      const downAmount = BigInt(req.body.down ?? "0");
      if (upAmount <= 0n && downAmount <= 0n) {
        return reply.code(400).send({ error: "at least one of up/down must be > 0" });
      }
      return handle(reply, () => builder.deposit({ ...base, upAmount, downAmount }));
    });

    app.post<{ Body: TxBody & { up?: string; down?: string } }>("/tx/withdraw", async (req, reply) => {
      const base = validateBase(req.body, reply);
      if (!base) return reply;
      const upAmount = BigInt(req.body.up ?? "0");
      const downAmount = BigInt(req.body.down ?? "0");
      if (upAmount <= 0n && downAmount <= 0n) {
        return reply.code(400).send({ error: "at least one of up/down must be > 0" });
      }
      return handle(reply, () => builder.withdraw({ ...base, upAmount, downAmount }));
    });

    app.post<{ Body: TxBody }>("/tx/redeem", async (req, reply) => {
      const base = validateBase(req.body, reply);
      if (!base) return reply;
      return handle(reply, () => builder.redeem(base));
    });

    app.post<{ Body: TxBody & { sides?: number[] } }>("/tx/burn", async (req, reply) => {
      const base = validateBase(req.body, reply);
      if (!base) return reply;
      return handle(reply, () => builder.burn({ ...base, sides: req.body.sides }));
    });
  }

  return app;
}

interface TxBody {
  poolId?: string;
  lock?: LockLike;
}
