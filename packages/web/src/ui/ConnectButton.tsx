//! Wallet connect / disconnect, driven by the CCC connector.

import { useWallet } from "../wallet/useWallet.js";
import { shortId } from "../format.js";

export function ConnectButton() {
  const { connected, address, open, disconnect } = useWallet();

  if (connected && address) {
    return (
      <button className="btn btn-secondary btn-sm" onClick={disconnect} title={`${address} — click to disconnect`}>
        <span className="num">{shortId(address)}</span>
      </button>
    );
  }
  return (
    <button className="btn btn-primary btn-sm" onClick={open}>
      Connect wallet
    </button>
  );
}
