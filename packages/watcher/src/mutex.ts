//! A minimal async mutex (serial queue). Used to serialize every wallet-spending
//! operation on a single keeper wallet — pool transitions AND oracle-cell advances
//! share one wallet + CCC client, so running them concurrently makes their cell
//! selection (`completeInputsByCapacity` / `rebalanceFuel`) pick the same cells and
//! one tx ends up referencing the other's unconfirmed output. Funnelling each
//! build+fund+send+commit through `run()` makes cell selection always see the
//! previous tx's committed state.

export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  /** Run `fn` after all previously-queued work, regardless of their outcome. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Keep the chain alive even if `fn` rejects (errors propagate to the caller).
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** A no-op lock (runs immediately) for tests / single-actor setups. */
export const noopMutex: Pick<Mutex, "run"> = { run: (fn) => fn() };
