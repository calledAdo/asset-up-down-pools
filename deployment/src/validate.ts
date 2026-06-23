import fs from "node:fs";
import path from "node:path";

import { ccc } from "@ckb-ccc/core";

import { binaryAbsPath } from "./build.js";
import type {
  CodeDeploymentScriptFamily,
  DeploymentContext,
  DeploymentNetwork,
} from "./types.js";

type ResultLine = { ok: boolean; message: string };

function ok(message: string): ResultLine {
  return { ok: true, message: `OK   ${message}` };
}
function fail(message: string): ResultLine {
  return { ok: false, message: `FAIL ${message}` };
}

const DEPLOY_TARGETS = new Set([
  "deploy:pool-type",
  "deploy:share-xudt",
  "deploy:treasury-lock",
  "deploy:pool-admin-lock",
]);

export function validateConfigPreflight(args: {
  deploymentRoot: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
}): { exitCode: number; lines: string[] } {
  const out: ResultLine[] = [];

  const targetAction = args.argv[0];
  if (!targetAction) {
    out.push(
      fail(
        "missing target action. Usage: validate:config <target-action> --network <testnet|mainnet|devnet>",
      ),
    );
    return { exitCode: 2, lines: out.map((l) => l.message) };
  }

  if (!DEPLOY_TARGETS.has(targetAction)) {
    out.push(fail(`invalid target action: ${targetAction}`));
  } else {
    out.push(ok(`target action: ${targetAction}`));
  }

  const idx = args.argv.indexOf("--network");
  const cliNetwork = idx >= 0 ? args.argv[idx + 1] : undefined;
  const network = (cliNetwork ?? args.env.DEPLOY_NETWORK) as DeploymentNetwork | undefined;
  if (network !== "testnet" && network !== "mainnet" && network !== "devnet") {
    out.push(fail("missing network. Use --network <testnet|mainnet|devnet> or DEPLOY_NETWORK"));
  } else {
    out.push(ok(`network: ${network}`));
  }

  const configPath =
    network === "testnet" || network === "mainnet" || network === "devnet"
      ? path.join(args.deploymentRoot, "config", `${network}.json`)
      : null;
  if (!configPath || !fs.existsSync(configPath)) {
    out.push(fail(`config file missing: ${configPath ?? "<unknown>"}`));
  } else {
    out.push(ok(`config file exists: ${path.relative(args.deploymentRoot, configPath)}`));
  }

  const prefix = network ? network.toUpperCase() : "<missing>";
  const rpc = network ? args.env[`${prefix}_CKB_RPC_URL`] : undefined;
  const pk = network ? args.env[`${prefix}_DEPLOYER_PRIVATE_KEY`] : undefined;
  if (!rpc) out.push(fail(`${prefix}_CKB_RPC_URL is required`));
  else out.push(ok(`${prefix}_CKB_RPC_URL present`));
  if (!pk) out.push(fail(`${prefix}_DEPLOYER_PRIVATE_KEY is required`));
  else out.push(ok(`${prefix}_DEPLOYER_PRIVATE_KEY present`));

  const dryRun = args.env.DRY_RUN ?? "true";
  out.push(ok(`DRY_RUN=${dryRun}`));

  let config: any = null;
  if (configPath && fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (network && config.network !== network) {
        out.push(fail(`config network mismatch: expected ${network}, got ${config.network}`));
      } else if (network) {
        out.push(ok("config network matches selected network"));
      }
    } catch (e) {
      out.push(fail(`failed to parse config JSON: ${(e as Error).message}`));
    }
  }

  if (DEPLOY_TARGETS.has(targetAction ?? "")) {
    if (
      config?.build?.poolTypeBinaryPath &&
      config?.build?.shareXudtBinaryPath &&
      config?.build?.treasuryLockBinaryPath &&
      config?.build?.poolAdminLockBinaryPath
    ) {
      out.push(ok("build config paths present in config.build"));
    } else {
      out.push(fail("build config paths missing in config.build"));
    }
  }

  // Nudge the operator to record fresh code hashes before publishing pool-type.
  // Pool creation stores share/treasury hashes in PoolData, so this is a
  // visibility check rather than a pool-type rebuild coupling check.
  if (targetAction === "deploy:pool-type") {
    out.push(ok("reminder: run `validate:consistency` to report fresh contract code hashes"));
  }

  const exitCode = out.some((l) => !l.ok) ? 1 : 0;
  return { exitCode, lines: out.map((l) => l.message) };
}

/**
 * Build-output consistency check. `pool_type` no longer embeds the code hashes of
 * `share_xudt` or `treasury_lock`; pool creation stores those hashes in PoolData.
 * This command therefore verifies that every configured binary exists and reports
 * each fresh code hash for artifact/state-deployment review.
 *
 * Requires the contract binaries to be built first (`make contracts-build`).
 */
export function validateConsistency(
  ctx: Pick<DeploymentContext, "config" | "paths">,
): { exitCode: number; lines: string[] } {
  const out: ResultLine[] = [];

  const families: CodeDeploymentScriptFamily[] = [
    "pool-type",
    "share-xudt",
    "treasury-lock",
    "pool-admin-lock",
  ];
  for (const family of families) {
    const binaryPath = binaryAbsPath(family, ctx);
    if (!fs.existsSync(binaryPath) || fs.statSync(binaryPath).size === 0) {
      out.push(fail(`${family} binary missing or empty: ${binaryPath} (run \`make contracts-build\`)`));
      continue;
    }
    const bytes = fs.readFileSync(binaryPath);
    out.push(ok(`${family} code hash ${ccc.hashCkb(bytes)}`));
  }

  const exitCode = out.some((l) => !l.ok) ? 1 : 0;
  return { exitCode, lines: out.map((l) => l.message) };
}
