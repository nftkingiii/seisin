import { bytesToHex, hexToBytes, u32, utf8ToBytes, concatBytes } from "./bytes.js";
import type { OwnershipProof } from "./registry.js";

// Compact ownership proofs: about half the size of JSON, so proof links and QR codes stay small.

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export function encodeProof(p: OwnershipProof): string {
  const col = utf8ToBytes(p.collection);
  const bytes = concatBytes(
    Uint8Array.of(2, col.length),
    col,
    u32(p.epoch),
    u32(p.tokenId),
    hexToBytes(p.owner),
    hexToBytes(p.nonce),
    hexToBytes(p.sig),
    ...p.path.siblings.map((h) => hexToBytes(h)),
  );
  return "p2." + b64u(bytes);
}

/** Reads a proof from a link, a compact code, or the older JSON form. */
export function decodeProof(input: string): OwnershipProof {
  let t = input.trim();
  const hash = t.indexOf("#check=");
  if (hash >= 0) t = t.slice(hash + 7);
  t = t.replace(/^seisin-proof:/, "");
  if (t.startsWith("p2.")) {
    const b = unb64u(t.slice(3));
    const dv = new DataView(b.buffer);
    if (b[0] !== 2) throw new Error("unknown proof version");
    const n = b[1];
    const collection = new TextDecoder().decode(b.slice(2, 2 + n));
    let o = 2 + n;
    const epoch = dv.getUint32(o);
    const tokenId = dv.getUint32(o + 4);
    o += 8;
    const take = (k: number) => bytesToHex(b.slice(o, (o += k)));
    const owner = take(32), nonce = take(32), sig = take(64);
    const siblings: string[] = [];
    while (o + 32 <= b.length) siblings.push(take(32));
    if (o !== b.length) throw new Error("proof has trailing bytes");
    return { v: 1, collection, epoch, tokenId, owner, path: { index: tokenId, siblings }, nonce, sig };
  }
  return JSON.parse(atob(t.replace(/-/g, "+").replace(/_/g, "/")));
}

