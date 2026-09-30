import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from "@noble/hashes/utils.js";

export { bytesToHex, hexToBytes, utf8ToBytes, concatBytes };

export function u32(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`not a u32: ${n}`);
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

/** Domain-separated hash: every part is length-prefixed so no two inputs share an encoding. */
export function tagged(tag: string, ...parts: Uint8Array[]): Uint8Array {
  const pieces: Uint8Array[] = [];
  for (const p of [utf8ToBytes(tag), ...parts]) pieces.push(u32(p.length), p);
  return sha256(concatBytes(...pieces));
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function hex32(h: string, what: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`${what} must be 32 bytes of lowercase hex`);
  return hexToBytes(h);
}
