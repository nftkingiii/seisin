import { tagged, equalBytes, bytesToHex, hexToBytes } from "./bytes.js";

const EMPTY = tagged("seisin/empty/1");

function node(l: Uint8Array, r: Uint8Array): Uint8Array {
  return tagged("seisin/node/1", l, r);
}

/** Levels of a fixed-size tree, padded to a power of two with a tagged empty leaf. */
function levels(leaves: Uint8Array[]): Uint8Array[][] {
  if (leaves.length === 0) throw new Error("a tree needs at least one leaf");
  let width = 1;
  while (width < leaves.length) width *= 2;
  const out: Uint8Array[][] = [[...leaves, ...Array(width - leaves.length).fill(EMPTY)]];
  while (out[out.length - 1].length > 1) {
    const prev = out[out.length - 1];
    const next: Uint8Array[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(node(prev[i], prev[i + 1]));
    out.push(next);
  }
  return out;
}

export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  const ls = levels(leaves);
  return ls[ls.length - 1][0];
}

export interface MerklePath {
  index: number;
  siblings: string[]; // hex, leaf level first
}

export function merklePath(leaves: Uint8Array[], index: number): MerklePath {
  if (index < 0 || index >= leaves.length) throw new Error("leaf index out of range");
  const ls = levels(leaves);
  const siblings: string[] = [];
  let i = index;
  for (let d = 0; d < ls.length - 1; d++) {
    siblings.push(bytesToHex(ls[d][i ^ 1]));
    i >>= 1;
  }
  return { index, siblings };
}

export function verifyPath(leaf: Uint8Array, path: MerklePath, root: Uint8Array): boolean {
  let h = leaf;
  let i = path.index;
  for (const s of path.siblings) {
    const sib = hexToBytes(s);
    h = i & 1 ? node(sib, h) : node(h, sib);
    i >>= 1;
  }
  return i === 0 && equalBytes(h, root);
}
