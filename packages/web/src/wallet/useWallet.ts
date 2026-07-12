//! Wallet state from the CCC connector: the connected signer, the user's address +
//! lock hash (the key for "my positions"), the lock script (sent to the backend as
//! the tx-build intent), and connect/disconnect. No SDK here — the backend builds
//! transactions; this layer only connects, identifies, and (later) signs.

import { ccc } from "@ckb-ccc/connector-react";
import { useEffect, useState } from "react";

import type { Hex } from "../api/types.js";
import type { LockLike } from "../api/client.js";

export interface WalletState {
  signer: ccc.Signer | undefined;
  connected: boolean;
  address: string | undefined;
  /** blake2b hash of the wallet's recommended lock script; keys "my positions". */
  lockHash: Hex | undefined;
  /** The wallet's recommended lock script — the tx-build intent's `lock`. */
  lock: LockLike | undefined;
  open: () => void;
  disconnect: () => void;
}

export function useWallet(): WalletState {
  const { open, disconnect, wallet } = ccc.useCcc();
  const signer = ccc.useSigner();

  const [address, setAddress] = useState<string>();
  const [lockHash, setLockHash] = useState<Hex>();
  const [lock, setLock] = useState<LockLike>();

  useEffect(() => {
    let cancelled = false;
    if (!signer) {
      setAddress(undefined);
      setLockHash(undefined);
      setLock(undefined);
      return;
    }
    void (async () => {
      const [addr, { script }] = await Promise.all([
        signer.getRecommendedAddress(),
        signer.getRecommendedAddressObj(),
      ]);
      if (cancelled) return;
      setAddress(addr);
      setLockHash(script.hash() as Hex);
      setLock({
        codeHash: script.codeHash as Hex,
        hashType: script.hashType,
        args: script.args as Hex,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [signer]);

  return {
    signer,
    connected: Boolean(wallet && signer),
    address,
    lockHash,
    lock,
    open,
    disconnect,
  };
}
