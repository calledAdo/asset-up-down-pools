//! Contract guard for the positions query param. The watcher's /positions and
//! /pools/:id/positions routes require `?address=<CKB address>` (it resolves the
//! address to a lock script for the on-chain query) and 400 on anything else — see
//! packages/watcher/src/api/server.ts. The decoupling rule forbids importing the
//! watcher here, and the web client can't be imported under the plain-node runner
//! (its `.js` import specifiers don't resolve to the `.ts` sources), so this asserts
//! at the source level: the two positions client methods must send `address`, never
//! the old, silently-400ing `lock` param. If the client drifts back to `lock`, or a
//! caller passes a lock hash again, this fails.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const clientSrc = readFileSync(
  fileURLToPath(new URL("../src/api/client.ts", import.meta.url)),
  "utf8",
);

// The two positions request builders, extracted from the client source.
const positionsLine = clientSrc.match(/positions:\s*\(.*?\)\s*=>\s*get<[^>]+>\("\/positions",\s*\{([^}]*)\}\)/);
const poolPositionsLine = clientSrc.match(/poolPositions:\s*\(.*?\)\s*=>\s*get<[^>]+>\(`\/pools\/\$\{poolId\}\/positions`,\s*\{([^}]*)\}\)/);

assert.ok(positionsLine, "could not find the `positions:` request builder in client.ts");
assert.ok(poolPositionsLine, "could not find the `poolPositions:` request builder in client.ts");

for (const [name, m] of [["positions", positionsLine], ["poolPositions", poolPositionsLine]]) {
  const params = m[1];
  assert.match(params, /\baddress\b/, `${name} must send the { address } query param`);
  assert.doesNotMatch(params, /\block\b/, `${name} must NOT send { lock } (the watcher 400s on it)`);
}

console.log("positionsContract: ok — web client sends ?address= on both positions routes");
