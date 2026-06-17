import { ccc } from "@ckb-ccc/core";
import { cccA } from "@ckb-ccc/core/advanced";

import type { DeploymentContext, DeploymentNetwork } from "./types.js";

// CCC signer helpers may probe multiple KnownScript entries. For devnet we start
// from CCC's testnet script table and override entries that differ on offckb.
// This is intentionally devnet-only and does not configure any public RPC fallbacks.

class ClientDevnet extends ccc.ClientJsonRpc {
  constructor(
    url: string,
    private readonly scripts_: Record<ccc.KnownScript, any>,
  ) {
    super(url);
  }

  get addressPrefix(): string {
    // offckb devnet uses testnet-style addresses.
    return "ckt";
  }

  async getKnownScript(script: ccc.KnownScript) {
    const found = this.scripts_[script];
    if (!found) {
      throw new Error(`No script information was found for ${script} on ${this.addressPrefix}`);
    }
    return ccc.ScriptInfo.from(found);
  }

  get scripts() {
    return this.scripts_;
  }
}

function requireDevnetSecpConfig(env: DeploymentContext["env"]) {
  const missing: string[] = [];
  if (!env.devnetSecp256k1Blake160CodeHash) {
    missing.push("DEVNET_SECP256K1_BLAKE160_CODE_HASH");
  }
  if (!env.devnetSecp256k1Blake160HashType) {
    missing.push("DEVNET_SECP256K1_BLAKE160_HASH_TYPE");
  }
  if (!env.devnetSecp256k1Blake160DepTxHash) {
    missing.push("DEVNET_SECP256K1_BLAKE160_DEP_TX_HASH");
  }
  if (!env.devnetSecp256k1Blake160DepIndex) {
    missing.push("DEVNET_SECP256K1_BLAKE160_DEP_INDEX");
  }
  if (!env.devnetSecp256k1Blake160DepType) {
    missing.push("DEVNET_SECP256K1_BLAKE160_DEP_TYPE");
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required devnet secp KnownScript env vars: ${missing.join(", ")}`,
    );
  }

  const depIndex = Number(env.devnetSecp256k1Blake160DepIndex);
  if (!Number.isInteger(depIndex) || depIndex < 0) {
    throw new Error("DEVNET_SECP256K1_BLAKE160_DEP_INDEX must be a non-negative integer");
  }

  return {
    codeHash: env.devnetSecp256k1Blake160CodeHash,
    hashType: env.devnetSecp256k1Blake160HashType,
    depTxHash: env.devnetSecp256k1Blake160DepTxHash,
    depIndex,
    depType: env.devnetSecp256k1Blake160DepType,
  };
}

export function createCccClient(
  network: DeploymentNetwork,
  rpcUrl: string,
  env?: DeploymentContext["env"],
) {
  if (network === "mainnet") {
    return new ccc.ClientPublicMainnet({ url: rpcUrl });
  }

  if (network === "devnet") {
    if (!env) {
      throw new Error("createCccClient(devnet) requires deployment env for KnownScript overrides");
    }
    const secp = requireDevnetSecpConfig(env);

    // offckb devnet uses local system-scripts, not public testnet defaults.
    // Provide only the secp override the deployment flow actually needs, via env,
    // so the setup is reproducible on any machine.
    const overrides: Partial<Record<ccc.KnownScript, any>> = {
      [ccc.KnownScript.Secp256k1Blake160]: {
        codeHash: secp.codeHash,
        hashType: secp.hashType,
        cellDeps: [
          {
            cellDep: {
              outPoint: {
                txHash: secp.depTxHash,
                index: secp.depIndex,
              },
              depType: secp.depType,
            },
          },
        ],
      },
    } as const;

    // Preserve the full testnet known-script table (needed by CCC internals),
    // but override entries that differ on the local offckb devnet.
    // This client talks ONLY to the provided devnet RPC URL (no public fallbacks).
    const scripts = { ...(cccA.TESTNET_SCRIPTS as any), ...overrides } as any;
    return new ClientDevnet(rpcUrl, scripts);
  }

  return new ccc.ClientPublicTestnet({ url: rpcUrl });
}

export function createPrivateKeySigner(client: unknown, privateKey: string) {
  // CCC signer expects a client instance; keep the type deployment-local.
  return new ccc.SignerCkbPrivateKey(client as never, privateKey);
}
