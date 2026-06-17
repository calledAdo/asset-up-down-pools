import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  writeDeploymentArtifact,
  readCodeDeploymentArtifact,
} from "../dist/artifacts.js";

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "up-down-artifacts-test-"));
  fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
  return root;
}

test("code artifacts are keyed by network + script family and round-trip", () => {
  const root = makeRoot();
  try {
    const { artifactPath } = writeDeploymentArtifact(root, "testnet", "deploy:pool-type", {
      scriptFamily: "pool-type",
      latestCandidate: { mode: "dry-run", codeHash: "0xabc", hashType: "data2", depType: "code" },
      versions: {},
    });
    assert.ok(artifactPath.endsWith(path.join("artifacts", "testnet.pool-type.json")));

    const env = readCodeDeploymentArtifact({
      deploymentRoot: root,
      network: "testnet",
      scriptFamily: "pool-type",
    });
    assert.equal(env?.network, "testnet");
    assert.equal(env?.deployment?.scriptFamily, "pool-type");
    assert.equal(env?.deployment?.latestCandidate?.codeHash, "0xabc");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("re-writing a candidate preserves previously promoted canonical versions", () => {
  const root = makeRoot();
  try {
    // First: a promoted artifact with a canonical version 1.
    writeDeploymentArtifact(root, "testnet", "promote:share-xudt", {
      scriptFamily: "share-xudt",
      latestCandidate: undefined,
      versions: { 1: { mode: "broadcast", codeHash: "0x111", hashType: "data2", depType: "code", version: 1, promotedAt: "t" } },
    });
    // Then: a new candidate deploy with an empty versions map.
    writeDeploymentArtifact(root, "testnet", "deploy:share-xudt", {
      scriptFamily: "share-xudt",
      latestCandidate: { mode: "dry-run", codeHash: "0x222", hashType: "data2", depType: "code" },
      versions: {},
    });

    const env = readCodeDeploymentArtifact({
      deploymentRoot: root,
      network: "testnet",
      scriptFamily: "share-xudt",
    });
    // Canonical v1 is preserved; the new candidate is recorded.
    assert.equal(env?.deployment?.versions?.["1"]?.codeHash, "0x111");
    assert.equal(env?.deployment?.latestCandidate?.codeHash, "0x222");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bigint capacity is serialized as a string", () => {
  const root = makeRoot();
  try {
    const { artifactPath } = writeDeploymentArtifact(root, "devnet", "deploy:treasury-lock", {
      scriptFamily: "treasury-lock",
      latestCandidate: { mode: "dry-run", codeHash: "0xabc", hashType: "data2", depType: "code", capacity: 12345n },
      versions: {},
    });
    const raw = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    assert.equal(raw.deployment.latestCandidate.capacity, "12345");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
