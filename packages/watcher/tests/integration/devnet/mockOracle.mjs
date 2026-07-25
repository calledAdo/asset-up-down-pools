//! Mode-A mock oracle: an `OracleSource` the watcher service wires as BOTH the
//! keeper's read source (`oracle`) and, when auto, the OracleWorker's advancer
//! (`oracleAdvancer`). Every other piece of the service — Keeper, Timeline,
//! executor, reconciler — is the real production code; only the price + publish
//! time are ours.
//!
//! Two modes:
//!   - MANUAL (auto=false, the default here): the test calls `publish(feed, pt,
//!     price)` to advance the feed's cell one step at a time — the deterministic
//!     way to drive activate → resolve → finalize, and to force VOID (never
//!     publish), CORRECT (worse then better), or a lagging tick (publish late).
//!   - AUTO (auto=true): `getTickAtOrAfter(feed, minPt)` mints a cell itself, so a
//!     real OracleWorker can drive it at grid boundaries (used by the batching /
//!     real-timing scenarios).
//!
//! One cell per feed is tracked in memory with its real on-chain outpoint, so all
//! lanes of a feed read the SAME `cellDep` at a coincident boundary and the executor
//! batches them. Old cells linger harmlessly (nobody reads them). The cells are
//! always-success-locked, so the keeper's fee funding never consumes them.

import { mintMockOracleCells } from "../../../../game-sdk/tests/integration/devnet/mockOracle.mjs";

export class MockOracle {
  /**
   * @param {object} deps
   * @param {import("@ckb-ccc/core").ccc.Client} deps.client
   * @param {import("@ckb-ccc/core").ccc.Signer} deps.signer  own wallet (no keeper contention)
   * @param {(feedId: string, pt: bigint) => bigint} [deps.priceFn]  default monotone-in-time ⇒ UP wins
   * @param {boolean} [deps.auto]  true ⇒ getTickAtOrAfter mints (drive by a real OracleWorker)
   * @param {(m: string) => void} [deps.log]
   */
  constructor({ client, signer, priceFn, auto = false, log }) {
    this.client = client;
    this.signer = signer;
    this.priceFn = priceFn ?? ((_feed, pt) => pt); // later publish_time ⇒ higher price ⇒ UP wins
    this.auto = auto;
    this.log = log ?? (() => {});
    this.current = new Map(); // feedLower -> OracleTick
    this.published = []; // audit trail: { feedId, publishTime, price }
  }

  #key(feedId) {
    return feedId.toLowerCase();
  }

  /** Mint a mock cell at (feedId, publishTime[, price]) and make it the feed's current tick. */
  async publish(feedId, publishTime, price) {
    const pt = BigInt(publishTime);
    const p = price === undefined ? BigInt(this.priceFn(feedId, pt)) : BigInt(price);
    const [tick] = await mintMockOracleCells(this.client, this.signer, [
      { feedId, price: Number(p), publishTime: Number(pt) },
    ]);
    this.current.set(this.#key(feedId), tick);
    this.published.push({ feedId, publishTime: pt, price: p });
    this.log(`mock oracle ${feedId.slice(0, 10)} @ pt=${pt} price=${p}`);
    return tick;
  }

  // --- OracleSource ---------------------------------------------------------

  /** ADVANCER path (OracleWorker). In auto mode mint a boundary tick; else no-op. */
  async getTickAtOrAfter(feedId, minPublishTime) {
    if (this.auto) return this.publish(feedId, minPublishTime);
    return this.readCurrentTick(feedId); // manual: the test owns advancing
  }

  /** READER path (keeper): the feed's current tick, or null if none published yet. */
  async readCurrentTick(feedId) {
    return this.current.get(this.#key(feedId)) ?? null;
  }
}
