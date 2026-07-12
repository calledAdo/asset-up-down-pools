//! Wraps the app in CCC's connector provider, which supplies the wallet modal and
//! the connected `ccc.Signer`. The signer's client is what the tx builders use to
//! resolve fee cells + broadcast, so we point CCC at the configured network.
//!
//! Note: real wallets (JoyID, MetaMask, …) target testnet/mainnet; a local devnet
//! is reachable only by clients that explicitly point at its RPC, so devnet is
//! primarily for our private-key lifecycle tests, not browser wallets.

import { ccc } from "@ckb-ccc/connector-react";
import type { ReactNode } from "react";

import { CKB_RPC_URL, NETWORK } from "../config.js";

function defaultClient(): ccc.Client {
  if (NETWORK === "mainnet") return new ccc.ClientPublicMainnet();
  if (NETWORK === "testnet") return new ccc.ClientPublicTestnet();
  // devnet: a testnet-flavoured client pointed at the local RPC.
  return new ccc.ClientPublicTestnet({ url: CKB_RPC_URL ?? "http://127.0.0.1:8114" });
}

export function WalletProvider({ children }: { children: ReactNode }) {
  return <ccc.Provider defaultClient={defaultClient()}>{children}</ccc.Provider>;
}
