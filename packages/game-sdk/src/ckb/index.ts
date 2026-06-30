//! `ckb-up-down-sdk/ckb` — low-level chain primitives the higher layers build on:
//! script derivation, the typeID, the share-amount cell codec, the oracle-identity
//! commitment, the CCC client/signer factories, and hex helpers. Import from here
//! when assembling transactions by hand or reading cells below the curated root.

export {
  poolTypeScript,
  shareScript,
  treasuryLockScript,
  poolAdminLockScript,
} from "./scripts.js";
export { computeTypeId, type FirstInputLike } from "./typeId.js";
export { encodeAmount, decodeAmount, AMOUNT_LEN } from "./cellData.js";
export { oracleCommit, type OracleIdentity } from "./oracleCommit.js";
export {
  createClient,
  createPrivateKeySigner,
  type Network,
  type DevnetSecpOverride,
} from "./client.js";
export { bytesToHex, hexToBytes } from "../internal/bytes.js";
