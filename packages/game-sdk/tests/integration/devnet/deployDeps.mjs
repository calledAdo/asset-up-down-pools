//! Test-only dep bootstrap for repeatable devnet integration tests.
//!
//! The deployment toolbox locks its code cells under the DEPLOYER's lock, so any
//! deployer-funded tx (fees, seed selection) can consume them — on a shared devnet
//! they get cannibalized between runs. To make the integration tests deterministic,
//! we (re)deploy the four contract binaries here as fresh code cells locked under
//! always_success (a lock the test's genesis funder never selects), and build the
//! SDK deployment config from them. The binaries are byte-identical to what the
//! toolbox ships, so their content-addressed `codeHash`es match the artifacts.
//!
//! This touches no production state and no Lean Oracle — it only mints dep cells on
//! the throwaway devnet.

import { ccc } from "@ckb-ccc/core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mockOracleLock } from "./mockOracle.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(here, "../../../../../crates/up_down/target/riscv64imac-unknown-none-elf/release");

// SDK deployment key -> compiled binary name.
const FAMILIES = [
  ["poolType", "pool_type"],
  ["shareXudt", "share_xudt"],
  ["treasuryLock", "treasury_lock"],
  ["poolAdminLock", "pool_admin_lock"],
];

const CKB = 100000000n;

/**
 * Deploy the four contract binaries as always_success-locked code cells in one tx,
 * funded by `funderSigner`. Returns the `deployment` block for
 * `definePoolNetworkConfig` ({ poolType, shareXudt, treasuryLock, poolAdminLock },
 * each `{ codeHash, codeDep }`).
 */
export async function deployDeps(client, funderSigner) {
  const lock = mockOracleLock(); // always_success, args 0x
  const outputs = [];
  const outputsData = [];
  const codeHashes = [];

  for (const [, bin] of FAMILIES) {
    const data = fs.readFileSync(path.join(BIN, bin));
    const dataHex = "0x" + data.toString("hex");
    codeHashes.push(ccc.hashCkb(data));
    // occupied = 8(capacity) + 33(always_success lock) + len(data); +300 CKB headroom.
    outputs.push({ lock, type: undefined, capacity: BigInt(data.length + 300) * CKB });
    outputsData.push(dataHex);
  }

  const tx = ccc.Transaction.from({
    version: 0n,
    cellDeps: [],
    headerDeps: [],
    inputs: [],
    outputs,
    outputsData,
    witnesses: [],
  });
  await tx.completeInputsByCapacity(funderSigner);
  await tx.completeFeeBy(funderSigner, 1000n);
  const txHash = await funderSigner.sendTransaction(tx);
  await client.waitTransaction(txHash, 0, 180000);

  const deployment = {};
  FAMILIES.forEach(([key], i) => {
    deployment[key] = {
      codeHash: codeHashes[i],
      codeDep: { outPoint: { txHash, index: i }, depType: "code" },
    };
  });
  return deployment;
}
