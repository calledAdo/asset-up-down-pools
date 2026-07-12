//! Wallet connect/disconnect button driven by the CCC connector.

import { useWallet } from "../wallet/useWallet.js";
import { shortId } from "../format.js";

export function ConnectButton() {
  const { connected, address, open, disconnect } = useWallet();

  if (connected && address) {
    return (
      <button className="btn" onClick={disconnect} title={address}>
        {shortId(address)} · disconnect
      </button>
    );
  }
  return (
    <button className="btn btn-primary" onClick={open}>
      Connect wallet
    </button>
  );
}
