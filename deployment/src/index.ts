import "dotenv/config";

import { buildContracts } from "./build.js";
import { loadDeploymentContext } from "./config.js";
import { writeDeploymentArtifact } from "./artifacts.js";
import { runDeploymentAction } from "./deploy.js";
import { validateConfigPreflight, validateConsistency } from "./validate.js";

const argv = process.argv.slice(2);
const ctx = loadDeploymentContext(argv);

if (ctx.action === "validate:config") {
  const { exitCode, lines } = validateConfigPreflight({
    deploymentRoot: ctx.paths.deploymentRoot,
    argv: argv.slice(1),
    env: process.env,
  });
  for (const line of lines) console.log(line);
  process.exitCode = exitCode;
  // No side effects for validate:config.
} else if (ctx.action === "validate:consistency") {
  // Build first so we check the embedded hashes against fresh binaries.
  await buildContracts(ctx);
  const { exitCode, lines } = validateConsistency(ctx);
  for (const line of lines) console.log(line);
  process.exitCode = exitCode;
} else {
  // Only code-deployment actions need a contract build phase (promotes don't).
  if (ctx.action.startsWith("deploy:")) {
    await buildContracts(ctx);
  }
  const result = await runDeploymentAction(ctx);
  const { artifactPath } = writeDeploymentArtifact(
    ctx.paths.deploymentRoot,
    ctx.network,
    ctx.action,
    result,
  );
  console.log(`Wrote deployment artifact: ${artifactPath}`);
}
