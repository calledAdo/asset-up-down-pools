//! Asset resolution for the client/workflow layer. The pure builders take an
//! explicit `assetType` script + `assetTypeDep`; these helpers spare callers from
//! hand-building those for the common cases:
//!
//!   - CREATE names the staked asset via a high-level {@link PoolAsset} (there is
//!     no treasury yet to read it from). A standard xUDT needs only its `args`;
//!     the type script + code dep are resolved from the CCC client's known scripts.
//!   - Every other op reads the asset type script straight off the on-chain
//!     TreasuryCell, so callers pass nothing — see `workflows.ts`.
//!
//! The code dep auto-resolves for the standard xUDT (CCC `KnownScript.XUdt`); for
//! a non-standard token or a chain CCC doesn't know (e.g. devnet), pass `codeDep`.

import { ccc } from "@ckb-ccc/core";

import { VARIANT_CKB, VARIANT_XUDT } from "../constants.js";
import type { Hex } from "../internal/bytes.js";
import type { CellDepInfo, Script } from "../types.js";

/**
 * High-level description of a pool's staked asset, used at CREATE.
 *
 * @public
 */
export type PoolAsset =
  | { kind: "ckb" }
  | {
      kind: "xudt";
      /** Standard xUDT token args (owner/unique id); type + dep auto-resolved. */
      args?: Hex;
      /** Explicit type script (for a non-standard token); overrides `args`. */
      type?: Script;
      /** Explicit code dep; required on chains CCC can't resolve xUDT for (e.g. devnet). */
      codeDep?: CellDepInfo;
    };

/**
 * Resolve a staked asset's code dep. Returns `override` when given; otherwise
 * matches the CCC client's known xUDT and uses its cell dep. Throws (asking for an
 * explicit dep) when it can't — e.g. a non-standard token, or devnet.
 */
export async function resolveAssetDep(
  client: ccc.Client,
  assetType: Script,
  override?: CellDepInfo,
): Promise<CellDepInfo> {
  if (override) return override;
  let info: Awaited<ReturnType<ccc.Client["getKnownScript"]>> | undefined;
  try {
    info = await client.getKnownScript(ccc.KnownScript.XUdt);
  } catch {
    info = undefined;
  }
  if (
    info &&
    info.codeHash.toLowerCase() === assetType.codeHash.toLowerCase() &&
    info.cellDeps.length > 0
  ) {
    const cd = info.cellDeps[0].cellDep;
    return {
      outPoint: { txHash: cd.outPoint.txHash as Hex, index: Number(cd.outPoint.index) },
      depType: cd.depType,
    };
  }
  throw new Error(
    `could not auto-resolve a code dep for asset ${assetType.codeHash}; pass an explicit assetTypeDep (e.g. on devnet or for a non-standard token)`,
  );
}

/** The explicit pieces the pure CREATE builder needs, derived from a {@link PoolAsset}. */
export interface ResolvedCreateAsset {
  variant: number;
  assetType?: Script;
  assetTypeDep?: CellDepInfo;
}

/** Turn a high-level {@link PoolAsset} into the builder's `variant`/`assetType`/`assetTypeDep`. */
export async function resolveCreateAsset(
  client: ccc.Client,
  asset: PoolAsset,
): Promise<ResolvedCreateAsset> {
  if (asset.kind === "ckb") return { variant: VARIANT_CKB };

  let assetType: Script;
  if (asset.type) {
    assetType = asset.type;
  } else if (asset.args !== undefined) {
    const info = await client.getKnownScript(ccc.KnownScript.XUdt);
    assetType = { codeHash: info.codeHash as Hex, hashType: info.hashType, args: asset.args };
  } else {
    throw new Error("xudt asset requires either `args` (standard xUDT) or an explicit `type` script");
  }
  const assetTypeDep = await resolveAssetDep(client, assetType, asset.codeDep);
  return { variant: VARIANT_XUDT, assetType, assetTypeDep };
}
