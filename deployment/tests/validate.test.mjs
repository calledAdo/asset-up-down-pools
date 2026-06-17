import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateConfigPreflight } from "../dist/validate.js";

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "up-down-validate-test-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
  return root;
}

function writeConfig(root, network, body) {
  fs.writeFileSync(path.join(root, "config", `${network}.json`), JSON.stringify(body, null, 2));
}

const VALID_BUILD = {
  target: "riscv64imac-unknown-none-elf",
  poolTypeBinaryPath: "x/pool_type",
  shareXudtBinaryPath: "x/share_xudt",
  treasuryLockBinaryPath: "x/treasury_lock",
  poolAdminLockBinaryPath: "x/pool_admin_lock",
};

test("rejects when target action is missing", () => {
  const root = makeRoot();
  try {
    const { exitCode, lines } = validateConfigPreflight({ deploymentRoot: root, argv: [], env: {} });
    assert.equal(exitCode, 2);
    assert.ok(lines.some((l) => l.startsWith("FAIL") && l.includes("missing target action")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an unknown target action", () => {
  const root = makeRoot();
  try {
    const { exitCode, lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:nope", "--network", "devnet"],
      env: { DEVNET_CKB_RPC_URL: "x", DEVNET_DEPLOYER_PRIVATE_KEY: "x" },
    });
    assert.equal(exitCode, 1);
    assert.ok(lines.some((l) => l.startsWith("FAIL") && l.includes("invalid target action")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects when network is missing on both CLI and env", () => {
  const root = makeRoot();
  try {
    const { exitCode, lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:pool-type"],
      env: {},
    });
    assert.equal(exitCode, 1);
    assert.ok(lines.some((l) => l.startsWith("FAIL") && l.includes("missing network")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects when the per-network config file does not exist", () => {
  const root = makeRoot();
  try {
    const { exitCode, lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:pool-type", "--network", "devnet"],
      env: { DEVNET_CKB_RPC_URL: "x", DEVNET_DEPLOYER_PRIVATE_KEY: "x" },
    });
    assert.equal(exitCode, 1);
    assert.ok(lines.some((l) => l.startsWith("FAIL") && l.includes("config file missing")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects when config.network does not match the selected network", () => {
  const root = makeRoot();
  try {
    writeConfig(root, "devnet", { network: "testnet", build: VALID_BUILD });
    const { exitCode, lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:pool-type", "--network", "devnet"],
      env: { DEVNET_CKB_RPC_URL: "x", DEVNET_DEPLOYER_PRIVATE_KEY: "x" },
    });
    assert.equal(exitCode, 1);
    assert.ok(lines.some((l) => l.startsWith("FAIL") && l.includes("config network mismatch")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects when required <NETWORK>_CKB_RPC_URL is missing", () => {
  const root = makeRoot();
  try {
    writeConfig(root, "devnet", { network: "devnet", build: VALID_BUILD });
    const { exitCode, lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:pool-type", "--network", "devnet"],
      env: { DEVNET_DEPLOYER_PRIVATE_KEY: "x" },
    });
    assert.equal(exitCode, 1);
    assert.ok(lines.some((l) => l.startsWith("FAIL") && l.includes("DEVNET_CKB_RPC_URL is required")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects when config.build paths are incomplete", () => {
  const root = makeRoot();
  try {
    writeConfig(root, "devnet", {
      network: "devnet",
      build: { target: "t", poolTypeBinaryPath: "x/pool_type" },
    });
    const { exitCode, lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:pool-type", "--network", "devnet"],
      env: { DEVNET_CKB_RPC_URL: "x", DEVNET_DEPLOYER_PRIVATE_KEY: "x" },
    });
    assert.equal(exitCode, 1);
    assert.ok(lines.some((l) => l.startsWith("FAIL") && l.includes("build config paths missing")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deploy:pool-type passes preflight with everything present and nudges consistency", () => {
  const root = makeRoot();
  try {
    writeConfig(root, "devnet", { network: "devnet", build: VALID_BUILD });
    const { exitCode, lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:pool-type", "--network", "devnet"],
      env: { DEVNET_CKB_RPC_URL: "x", DEVNET_DEPLOYER_PRIVATE_KEY: "x", DRY_RUN: "true" },
    });
    assert.equal(
      exitCode,
      0,
      `expected pass but saw FAIL lines:\n${lines.filter((l) => l.startsWith("FAIL")).join("\n")}`,
    );
    assert.ok(lines.some((l) => l.includes("validate:consistency")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI --network overrides env DEPLOY_NETWORK", () => {
  const root = makeRoot();
  try {
    writeConfig(root, "devnet", { network: "devnet", build: VALID_BUILD });
    writeConfig(root, "testnet", { network: "testnet", build: VALID_BUILD });
    const { lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:pool-type", "--network", "devnet"],
      env: { DEPLOY_NETWORK: "testnet", DEVNET_CKB_RPC_URL: "x", DEVNET_DEPLOYER_PRIVATE_KEY: "x" },
    });
    assert.ok(lines.some((l) => l.startsWith("OK") && l.includes("network: devnet")));
    assert.ok(!lines.some((l) => l.includes("network: testnet")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
