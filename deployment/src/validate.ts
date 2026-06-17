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

  // pool-type embeds the leaf code hashes; nudge the operator to verify they
  // line up with the binaries before publishing pool-type.
  if (targetAction === "deploy:pool-type") {
    out.push(ok("reminder: run `validate:consistency` so pool-type matches the deployed leaves"));
  }

  const exitCode = out.some((l) => !l.ok) ? 1 : 0;
  return { exitCode, lines: out.map((l) => l.message) };
}

/**
 * `pool_type` hardcodes the code (data) hashes of `share_xudt` and
 * `treasury_lock` (so it can derive share-token types and identify the
 * TreasuryCell). Those constants are baked in at *build* time, so a `pool_type`
 * binary is only valid against the exact leaf binaries whose hashes it embeds.
 *
 * We verify this without parsing the binary: the 32-byte code hash of each leaf
 * must appear verbatim as a byte substring inside the `pool_type` binary. A
 * missing hash means `constants.rs` is stale relative to the built leaves and
 * `pool_type` must be regenerated/rebuilt before deployment.
 *
 * Requires the contract binaries to be built first (`make contracts-build`).
 */
export function validateConsistency(
  ctx: Pick<DeploymentContext, "config" | "paths">,
): { exitCode: number; lines: string[] } {
  const out: ResultLine[] = [];

  const poolTypePath = binaryAbsPath("pool-type", ctx);
  if (!fs.existsSync(poolTypePath) || fs.statSync(poolTypePath).size === 0) {
    out.push(fail(`pool-type binary missing or empty: ${poolTypePath} (run \`make contracts-build\`)`));
    return { exitCode: 1, lines: out.map((l) => l.message) };
  }
  const poolTypeBytes = fs.readFileSync(poolTypePath);

  const embeddedLeaves: CodeDeploymentScriptFamily[] = ["share-xudt", "treasury-lock"];
  for (const leaf of embeddedLeaves) {
    const leafPath = binaryAbsPath(leaf, ctx);
    if (!fs.existsSync(leafPath) || fs.statSync(leafPath).size === 0) {
      out.push(fail(`${leaf} binary missing or empty: ${leafPath} (run \`make contracts-build\`)`));
      continue;
    }
    const leafBytes = fs.readFileSync(leafPath);
    const codeHashHex = ccc.hashCkb(leafBytes);
    const codeHashBytes = Buffer.from(codeHashHex.slice(2), "hex");
    if (poolTypeBytes.includes(codeHashBytes)) {
      out.push(ok(`pool-type embeds ${leaf} code hash ${codeHashHex}`));
    } else {
      out.push(
        fail(
          `pool-type does NOT embed ${leaf} code hash ${codeHashHex} — constants.rs is stale; regenerate and rebuild pool-type`,
        ),
      );
    }
  }

  const exitCode = out.some((l) => !l.ok) ? 1 : 0;
  return { exitCode, lines: out.map((l) => l.message) };
}
