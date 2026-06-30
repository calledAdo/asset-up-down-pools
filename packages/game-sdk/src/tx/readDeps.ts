//! Cell-dep wiring. Every pool transaction must reference the code cells of the
//! scripts it invokes (`pool_type`, and as needed `share_xudt`, `treasury_lock`,
//! `pool_admin_lock`), and the oracle-driven transitions must additionally
//! reference the live oracle cell. These helpers push those deps onto a CCC
//! `Transaction`, de-duplicating (CCC's `addCellDeps` is add-if-absent).

import { ccc } from "@ckb-ccc/core";

import type { CellDepInfo, PoolCodeDeps } from "../types.js";
import type { OracleTick } from "./oracleTick.js";

function toCellDep(dep: CellDepInfo): ccc.CellDepLike {
  return {
    outPoint: { txHash: dep.outPoint.txHash, index: dep.outPoint.index },
    depType: dep.depType,
  };
}

/** Attach one code cell-dep (idempotent). */
export function attachCodeDep(tx: ccc.Transaction, dep: CellDepInfo): void {
  tx.addCellDeps(toCellDep(dep));
}

/** Attach the `pool_type` code cell-dep — required by every pool transaction. */
export function attachPoolTypeDep(tx: ccc.Transaction, deps: PoolCodeDeps): void {
  attachCodeDep(tx, deps.poolType);
}

/** Attach the `share_xudt` code cell-dep (DEPOSIT / REDEEM, which move shares). */
export function attachShareDep(tx: ccc.Transaction, deps: PoolCodeDeps): void {
  attachCodeDep(tx, deps.shareXudt);
}

/** Attach the `treasury_lock` code cell-dep. Throws if the deployment omits it. */
export function attachTreasuryDep(tx: ccc.Transaction, deps: PoolCodeDeps): void {
  if (!deps.treasuryLock) {
    throw new Error("deployment has no treasuryLock code dep (required for xUDT pools)");
  }
  attachCodeDep(tx, deps.treasuryLock);
}

/** Attach the `pool_admin_lock` code cell-dep. Throws if the deployment omits it. */
export function attachPoolAdminDep(tx: ccc.Transaction, deps: PoolCodeDeps): void {
  if (!deps.poolAdminLock) {
    throw new Error("deployment has no poolAdminLock code dep");
  }
  attachCodeDep(tx, deps.poolAdminLock);
}

/**
 * Attach an {@link OracleTick}'s oracle cell as a read `CellDep`. `pool_type`
 * scans all cell-deps for the one whose type args match the pool feed and whose
 * commitment matches `oracle_commit`, so the order this is added in is irrelevant.
 */
export function attachOracleTick(tx: ccc.Transaction, tick: OracleTick): void {
  attachCodeDep(tx, tick.cellDep);
}
