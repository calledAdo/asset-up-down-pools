export type DeploymentNetwork = "testnet" | "mainnet" | "devnet";

/**
 * Script "families" that produce code deployments/artifacts — one per contract
 * binary. `pool-type` embeds the code hashes of `share-xudt` and `treasury-lock`
 * at build time (see `validate:consistency`), so the leaves must be deployed (and
 * their constants baked into `pool_type`) before `pool-type` itself.
 */
export type CodeDeploymentScriptFamily =
  | "pool-type"
  | "share-xudt"
  | "treasury-lock"
  | "pool-admin-lock";

export type DeploymentAction =
  | "deploy:pool-type"
  | "deploy:share-xudt"
  | "deploy:treasury-lock"
  | "deploy:pool-admin-lock"
  | "promote:pool-type"
  | "promote:share-xudt"
  | "promote:treasury-lock"
  | "promote:pool-admin-lock"
  | "validate:config"
  | "validate:consistency";

export interface BuildConfig {
  target: string;
  poolTypeBinaryPath: string;
  shareXudtBinaryPath: string;
  treasuryLockBinaryPath: string;
  poolAdminLockBinaryPath: string;
}

export interface NetworkDeploymentConfig {
  network: DeploymentNetwork;
  label: string;
  build: BuildConfig;
}

export type ScriptHashType = "type" | "data" | "data1" | "data2";

/** Resolved operator env (required RPC/key + optional devnet/control overrides). */
export interface DeploymentEnv {
  rpcUrl: string;
  deployerPrivateKey: string;
  broadcast: string;
  dryRun: string;
  devnetSecp256k1Blake160CodeHash: string;
  devnetSecp256k1Blake160HashType: ScriptHashType | "";
  devnetSecp256k1Blake160DepTxHash: string;
  devnetSecp256k1Blake160DepIndex: string;
  devnetSecp256k1Blake160DepType: "code" | "depGroup" | "";
}

export interface DeploymentPaths {
  deploymentRoot: string;
}

export interface DeploymentContext {
  action: DeploymentAction;
  network: DeploymentNetwork;
  config: NetworkDeploymentConfig;
  env: DeploymentEnv;
  paths: DeploymentPaths;
}

export interface DeploymentArtifactEnvelope {
  network: DeploymentNetwork;
  action: DeploymentAction;
  generatedAt: string;
  deployment: unknown;
}

export type CanonicalCodeVersion = number;

export interface CodeDeploymentCandidate {
  mode: "dry-run" | "broadcast";
  codeHash: string;
  hashType: ScriptHashType;
  depType: "code";
  /** Capacity locked in the deployed code cell, in shannons. */
  capacity?: bigint;
  txHash?: string;
  index?: number;
}

export interface CodeDeploymentVersionRecord extends CodeDeploymentCandidate {
  version: CanonicalCodeVersion;
  promotedAt: string;
}

/**
 * Code-deployment artifact payload:
 * - `latestCandidate` is an operator-local "most recent" candidate deployment.
 * - `versions` are explicit canonical versions (numeric, stable). State actions
 *   (pool creation, in the SDK/keeper) should select an explicit version, never
 *   `latestCandidate`.
 */
export interface CodeDeploymentArtifact {
  scriptFamily: CodeDeploymentScriptFamily;
  latestCandidate?: CodeDeploymentCandidate;
  versions: Record<CanonicalCodeVersion, CodeDeploymentVersionRecord>;
}
