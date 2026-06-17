import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DeploymentAction,
  DeploymentContext,
  DeploymentNetwork,
  NetworkDeploymentConfig,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEPLOYMENT_ROOT = path.resolve(__dirname, "..");

const ACTIONS: DeploymentAction[] = [
  "deploy:pool-type",
  "deploy:share-xudt",
  "deploy:treasury-lock",
  "deploy:pool-admin-lock",
  "promote:pool-type",
  "promote:share-xudt",
  "promote:treasury-lock",
  "promote:pool-admin-lock",
  "validate:config",
  "validate:consistency",
];

function parseAction(argv: string[]): DeploymentAction {
  const action = argv[0] as DeploymentAction | undefined;
  if (!action || !ACTIONS.includes(action)) {
    throw new Error(`Unsupported or missing action: ${action ?? "<none>"}`);
  }
  return action;
}

function parseNetwork(argv: string[]): DeploymentNetwork {
  const index = argv.indexOf("--network");
  const cli = index >= 0 ? argv[index + 1] : undefined;
  const value = (cli ?? process.env.DEPLOY_NETWORK) as DeploymentNetwork | undefined;
  if (value === "testnet" || value === "mainnet" || value === "devnet") return value;
  throw new Error(
    "Missing network. Use --network <testnet|mainnet|devnet> or DEPLOY_NETWORK",
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function loadDeploymentContext(argv: string[]): DeploymentContext {
  const action = parseAction(argv);
  const network = parseNetwork(argv);
  const configPath = path.join(DEPLOYMENT_ROOT, "config", `${network}.json`);
  const raw = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(raw) as NetworkDeploymentConfig;

  if (config.network !== network) {
    throw new Error(`Config network mismatch: expected ${network}, got ${config.network}`);
  }
  if (
    !config.build?.poolTypeBinaryPath ||
    !config.build?.shareXudtBinaryPath ||
    !config.build?.treasuryLockBinaryPath ||
    !config.build?.poolAdminLockBinaryPath
  ) {
    throw new Error("config.build is missing one or more contract binary paths");
  }

  const prefix = network.toUpperCase();
  const env: DeploymentContext["env"] = {
    rpcUrl: requireEnv(`${prefix}_CKB_RPC_URL`),
    deployerPrivateKey: requireEnv(`${prefix}_DEPLOYER_PRIVATE_KEY`),
    broadcast: process.env.BROADCAST ?? "false",
    dryRun: process.env.DRY_RUN ?? "true",
    devnetSecp256k1Blake160CodeHash:
      process.env.DEVNET_SECP256K1_BLAKE160_CODE_HASH ?? "",
    devnetSecp256k1Blake160HashType:
      (process.env.DEVNET_SECP256K1_BLAKE160_HASH_TYPE as
        | DeploymentContext["env"]["devnetSecp256k1Blake160HashType"]
        | undefined) ?? "",
    devnetSecp256k1Blake160DepTxHash:
      process.env.DEVNET_SECP256K1_BLAKE160_DEP_TX_HASH ?? "",
    devnetSecp256k1Blake160DepIndex:
      process.env.DEVNET_SECP256K1_BLAKE160_DEP_INDEX ?? "",
    devnetSecp256k1Blake160DepType:
      (process.env.DEVNET_SECP256K1_BLAKE160_DEP_TYPE as
        | DeploymentContext["env"]["devnetSecp256k1Blake160DepType"]
        | undefined) ?? "",
  };

  return {
    action,
    network,
    config,
    env,
    paths: { deploymentRoot: DEPLOYMENT_ROOT },
  };
}
