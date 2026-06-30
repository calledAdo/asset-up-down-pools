//! `ckb-up-down-sdk/tx` — transaction authoring below the clients. Holds the pure
//! builders (`build*`, no chain reads), the client-resolving workflows
//! (`initiate*`), the shared plumbing (`attach*` cell deps, `completeFeeAndChange`,
//! the `OracleTick` read input), and staked-asset resolution. The role-split
//! clients at the package root wrap these; reach in here for custom assembly.

// ---- pure builders ----
export { buildCreatePoolTx, type BuildCreatePoolParams } from "./create.js";
export {
  buildDepositTx,
  type BuildDepositParams,
  type AssetInputCell,
  type TreasuryCellRef,
} from "./deposit.js";
export { buildWithdrawTx, type BuildWithdrawParams } from "./withdraw.js";
export { buildRedeemTx, type BuildRedeemParams, type ShareInputCell } from "./redeem.js";
export { buildBurnSharesTx, type BuildBurnSharesParams } from "./burnShares.js";
export { buildCloseTx, type BuildCloseParams } from "./close.js";
export {
  buildActivateTx,
  buildCorrectStartTx,
  buildResolveTx,
  buildCorrectSettleTx,
  buildFinalizeTx,
  buildTransitionBatch,
  type KeeperTransitionParams,
  type BatchTransitionItem,
  type TransitionKind,
} from "./keeperTransitions.js";

// ---- client-resolving workflows ----
export {
  initiateCreatePool,
  initiateDeposit,
  initiateWithdraw,
  initiateRedeem,
  initiateBurnShares,
  initiateClose,
  initiateActivate,
  initiateCorrectStart,
  initiateResolve,
  initiateCorrectSettle,
  initiateFinalize,
  type InitiateDepositParams,
  type InitiateWithdrawParams,
  type InitiateRedeemParams,
  type InitiateBurnSharesParams,
  type InitiateCloseParams,
  type InitiateKeeperTransitionParams,
} from "./workflows.js";

// ---- staked-asset resolution ----
export {
  type PoolAsset,
  resolveCreateAsset,
  resolveAssetDep,
  type ResolvedCreateAsset,
} from "./asset.js";

// ---- shared plumbing ----
export { completeFeeAndChange, type CompleteFeeOptions } from "./fees.js";
export {
  attachCodeDep,
  attachPoolTypeDep,
  attachShareDep,
  attachTreasuryDep,
  attachPoolAdminDep,
  attachOracleTick,
} from "./readDeps.js";
export { type OracleTick, assertTickForPool } from "./oracleTick.js";
