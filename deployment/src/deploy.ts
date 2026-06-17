import type {
  CodeDeploymentArtifact,
  CodeDeploymentScriptFamily,
  DeploymentAction,
  DeploymentContext,
} from "./types.js";
import { deployCodeScript } from "./codeDeploy.js";
import { readCodeDeploymentArtifact } from "./artifacts.js";

const DEPLOY_FAMILY: Record<string, CodeDeploymentScriptFamily> = {
  "deploy:pool-type": "pool-type",
  "deploy:share-xudt": "share-xudt",
  "deploy:treasury-lock": "treasury-lock",
  "deploy:pool-admin-lock": "pool-admin-lock",
};

const PROMOTE_FAMILY: Record<string, CodeDeploymentScriptFamily> = {
  "promote:pool-type": "pool-type",
  "promote:share-xudt": "share-xudt",
  "promote:treasury-lock": "treasury-lock",
  "promote:pool-admin-lock": "pool-admin-lock",
};

export async function runDeploymentAction(
  ctx: Pick<DeploymentContext, "action" | "network" | "config" | "env" | "paths">,
): Promise<unknown> {
  const mode = ctx.env.dryRun !== "false" ? "dry-run" : "broadcast-pending";

  const deployFamily = DEPLOY_FAMILY[ctx.action];
  if (deployFamily) {
    return {
      mode,
      network: ctx.network,
      scriptFamily: deployFamily,
      latestCandidate: await deployCodeScript({ ctx, scriptFamily: deployFamily }),
      versions: {},
    } satisfies CodeDeploymentArtifact & { mode: string; network: string };
  }

  const promoteFamily = PROMOTE_FAMILY[ctx.action];
  if (promoteFamily) {
    return promoteCodeDeployment(ctx, promoteFamily);
  }

  throw new Error(`runDeploymentAction: unhandled action ${ctx.action as DeploymentAction}`);
}

function promoteCodeDeployment(
  ctx: Pick<DeploymentContext, "paths" | "network">,
  scriptFamily: CodeDeploymentScriptFamily,
): CodeDeploymentArtifact {
  const existing = readCodeDeploymentArtifact({
    deploymentRoot: ctx.paths.deploymentRoot,
    network: ctx.network,
    scriptFamily,
  });
  const deployment = existing?.deployment;
  if (!deployment || typeof deployment !== "object") {
    throw new Error(`Missing code deployment artifact for ${ctx.network}.${scriptFamily}`);
  }
  const artifact = deployment as CodeDeploymentArtifact;
  if (!artifact.latestCandidate) {
    throw new Error(`No latestCandidate to promote for ${ctx.network}.${scriptFamily}`);
  }

  const versions = artifact.versions ?? {};
  const existingVersions = Object.keys(versions)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n >= 0);
  const nextVersion = (existingVersions.length ? Math.max(...existingVersions) : 0) + 1;

  return {
    scriptFamily,
    latestCandidate: undefined,
    versions: {
      ...versions,
      [nextVersion]: {
        ...artifact.latestCandidate,
        version: nextVersion,
        promotedAt: new Date().toISOString(),
      },
    },
  };
}
