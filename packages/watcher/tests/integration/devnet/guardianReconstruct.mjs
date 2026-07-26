//! Reconstruct the CURRENT Wormhole/Pyth guardian set from live Hermes VAAs.
//!
//! The lean_oracle devnet deploy pinned guardian set index 6; Wormhole has since
//! rotated to index 7 with changed membership, so the deployed cell no longer
//! verifies live VAAs (oracle error 17→22). Rather than depend on an external
//! set-7 address list, we recover the real current members cryptographically: every
//! Hermes price update embeds a Wormhole VAA signed by a quorum-subset of the set,
//! and `ecrecover` over the VAA's double-keccak body hash yields each signer's
//! Ethereum address at its guardian index. Unioning a batch of recent updates
//! covers the active guardians; any guardian that never signs in the window is
//! inactive and its slot is a harmless placeholder (the contract only checks the
//! guardians that actually signed a given VAA).
//!
//! The result is the REAL current set — the on-chain Wormhole verification the
//! oracle performs against live VAAs remains fully genuine; we only supply the
//! reference cell the deployment operator would otherwise have refreshed.

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

// Distinct dummy for a guardian that never signs in the sampling window. The
// guardian_set_type contract rejects duplicate addresses, and verification only ever
// checks the guardians that actually signed a VAA — so an unreferenced slot only
// needs to be unique and non-colliding with a real 20-byte guardian address.
const placeholderAddr = (i) => "0x" + (i + 1).toString(16).padStart(40, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function vaaFromPnau(b) {
  let o = 4 + 1 + 1; // magic(4) major(1) minor(1)
  const trailing = b[o]; o += 1 + trailing;
  o += 1; // proofType(1)
  const vaaLen = b.readUInt16BE(o); o += 2;
  return b.subarray(o, o + vaaLen);
}

function parseVaa(vaa) {
  const guardianSetIndex = vaa.readUInt32BE(1);
  const numSigs = vaa[5];
  let o = 6;
  const sigs = [];
  for (let i = 0; i < numSigs; i++) {
    sigs.push({ gi: vaa[o], r: vaa.subarray(o + 1, o + 33), s: vaa.subarray(o + 33, o + 65), v: vaa[o + 65] });
    o += 66;
  }
  const bodyHash = keccak_256(keccak_256(vaa.subarray(o)));
  return { guardianSetIndex, sigs, bodyHash };
}

function recoverAddr(bodyHash, { r, s, v }) {
  const compact = new Uint8Array(64);
  compact.set(r, 0); compact.set(s, 32);
  const pub = secp256k1.Signature.fromCompact(compact).addRecoveryBit(v).recoverPublicKey(bodyHash).toRawBytes(false);
  return "0x" + Buffer.from(keccak_256(pub.subarray(1)).subarray(12)).toString("hex");
}

async function fetchVaaBlob(hermesBaseUrl, feedId, t) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${hermesBaseUrl}/v2/updates/price/${t}?ids[]=${feedId}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const hex = (await res.json()).binary?.data?.[0];
      return hex ? Buffer.from(hex, "hex") : null;
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
}

/**
 * Reconstruct the live guardian set. Samples `samples` recent Hermes updates
 * (stepping `stepSecs` back each time, paced so Hermes doesn't drop the socket).
 * Returns `{ setIndex, quorum, guardianAddresses }` in guardian-index order, with
 * placeholders for any guardian that never signed in the window.
 *
 * @param {object} o
 * @param {string} o.hermesBaseUrl
 * @param {string} o.feedId
 * @param {number} [o.samples]
 * @param {number} [o.stepSecs]
 * @param {(m: string) => void} [o.log]
 */
export async function reconstructGuardianSet({ hermesBaseUrl, feedId, samples = 20, stepSecs = 13, log = () => {} }) {
  const now = Math.floor(Date.now() / 1000);
  const byIndex = new Map(); // gi -> address
  let setIndex, quorum = 0, got = 0;
  for (let i = 0; i < samples; i++) {
    const blob = await fetchVaaBlob(hermesBaseUrl, feedId, now - 30 - i * stepSecs);
    if (!blob) { await sleep(150); continue; }
    const { guardianSetIndex, sigs, bodyHash } = parseVaa(vaaFromPnau(blob));
    setIndex = guardianSetIndex;
    quorum = Math.max(quorum, sigs.length);
    got++;
    for (const sig of sigs) if (!byIndex.has(sig.gi)) byIndex.set(sig.gi, recoverAddr(bodyHash, sig));
    await sleep(150);
  }
  if (setIndex === undefined) throw new Error("guardian-set reconstruction: no Hermes VAAs fetched");
  const maxIndex = Math.max(...byIndex.keys());
  const guardianAddresses = [];
  const gaps = [];
  for (let i = 0; i <= maxIndex; i++) {
    if (byIndex.has(i)) guardianAddresses.push(byIndex.get(i));
    else { guardianAddresses.push(placeholderAddr(i)); gaps.push(i); }
  }
  log(`guardian set ${setIndex}: ${got} VAAs, ${guardianAddresses.length} slots, quorum ${quorum}, inactive ${gaps.length ? gaps.join(",") : "none"}`);
  return { setIndex, quorum, guardianAddresses };
}
