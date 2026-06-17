import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type {
  CodeDeploymentScriptFamily,
  DeploymentContext,
} from "./types.js";

/** Repo root (one level above `deployment/`). */
export function repoRoot(deploymentRoot: string): string {
  return path.resolve(deploymentRoot, "..");
}

export function binaryRelPath(
  family: CodeDeploymentScriptFamily,
  config: DeploymentContext["config"],
): string {
  switch (family) {
    case "pool-type":
      return config.build.poolTypeBinaryPath;
    case "share-xudt":
      return config.build.shareXudtBinaryPath;
    case "treasury-lock":
      return config.build.treasuryLockBinaryPath;
    case "pool-admin-lock":
      return config.build.poolAdminLockBinaryPath;
  }
}

export function binaryAbsPath(
  family: CodeDeploymentScriptFamily,
  ctx: Pick<DeploymentContext, "config" | "paths">,
): string {
  return path.resolve(repoRoot(ctx.paths.deploymentRoot), binaryRelPath(family, ctx.config));
}

const ALL_FAMILIES: CodeDeploymentScriptFamily[] = [
  "pool-type",
  "share-xudt",
  "treasury-lock",
  "pool-admin-lock",
];

/**
 * Build all four contract binaries via the repo Makefile, then assert each
 * expected output exists and is non-empty.
 */
export async function buildContracts(
  ctx: Pick<DeploymentContext, "config" | "paths">,
): Promise<void> {
  const root = repoRoot(ctx.paths.deploymentRoot);
  execSync(`make contracts-build`, { cwd: root, stdio: "inherit" });

  for (const family of ALL_FAMILIES) {
    const abs = binaryAbsPath(family, ctx);
    if (!fs.existsSync(abs)) throw new Error(`Expected build output missing: ${abs}`);
    if (fs.statSync(abs).size === 0) throw new Error(`Build output is empty: ${abs}`);
  }
}
