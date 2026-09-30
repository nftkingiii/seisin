import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { tagged, u32, utf8ToBytes, bytesToHex, hex32, concatBytes } from "./bytes.js";
import { merkleRoot, merklePath, verifyPath, type MerklePath } from "./merkle.js";

/*
 * A Seisin registry is a fixed-supply list of tokens, each held by a one-time
 * owner key. The operator publishes a record per epoch; every record commits to
 * the whole list, the previous record and the batch of signed changes that
 * produced it. Anyone holding the public change log can replay the history and
 * check each anchored record. The operator cannot move a token without the
 * current owner's signature, and cannot change the supply.
 */

export const COLLECTION_RE = /^[a-z0-9-]{1,24}$/;
const ZERO32 = "0".repeat(64);

export interface RegistryRecord {
  v: 1;
  collection: string;
  epoch: number;
  prev: string; // hex hash of the previous record, zeros at genesis
  root: string; // hex Merkle root over the token leaves
  supply: number;
  changes: string; // hex hash of this epoch's change batch
}

export interface Change {
  tokenId: number;
  from: string; // hex owner key the token leaves
  to: string; // hex fresh owner key it moves to
  ref: string; // hex reference, e.g. a hash binding the shielded payment
  sig: string; // hex signature by `from` over transferMessage
}

export interface RegistryState {
  collection: string;
  epoch: number;
  owners: string[]; // hex owner key per token id
  record: RegistryRecord;
}

function checkCollection(c: string) {
  if (!COLLECTION_RE.test(c)) throw new Error("collection id must be 1-24 of a-z, 0-9, -");
}

export function leafHash(collection: string, tokenId: number, owner: string): Uint8Array {
  return tagged("seisin/leaf/1", utf8ToBytes(collection), u32(tokenId), hex32(owner, "owner key"));
}

function leaves(s: { collection: string; owners: string[] }): Uint8Array[] {
  return s.owners.map((o, i) => leafHash(s.collection, i, o));
}

export function recordHash(r: RegistryRecord): string {
  return bytesToHex(
    tagged(
      "seisin/record/1",
      utf8ToBytes(r.collection),
      u32(r.epoch),
      hex32(r.prev, "prev"),
      hex32(r.root, "root"),
      u32(r.supply),
      hex32(r.changes, "changes"),
    ),
  );
}

export function changesHash(collection: string, epoch: number, changes: Change[]): string {
  const parts = changes.flatMap((c) => [
    u32(c.tokenId),
    hex32(c.from, "from"),
    hex32(c.to, "to"),
    hex32(c.ref, "ref"),
    utf8ToBytes(c.sig),
  ]);
  return bytesToHex(tagged("seisin/changes/1", utf8ToBytes(collection), u32(epoch), ...parts));
}

export function transferMessage(collection: string, epoch: number, c: Omit<Change, "sig">): Uint8Array {
  return tagged(
    "seisin/transfer/1",
    utf8ToBytes(collection),
    u32(epoch),
    u32(c.tokenId),
    hex32(c.from, "from"),
    hex32(c.to, "to"),
    hex32(c.ref, "ref"),
  );
}

export function genesis(collection: string, owners: string[]): RegistryState {
  checkCollection(collection);
  if (owners.length === 0) throw new Error("supply must be at least one");
  if (new Set(owners).size !== owners.length) throw new Error("owner keys must be unique");
  const record: RegistryRecord = {
    v: 1,
    collection,
    epoch: 0,
    prev: ZERO32,
    root: bytesToHex(merkleRoot(leaves({ collection, owners }))),
    supply: owners.length,
    changes: changesHash(collection, 0, []),
  };
  return { collection, epoch: 0, owners: [...owners], record };
}

export class ChangeRejected extends Error {
  constructor(
    readonly change: Change,
    readonly reason: string,
  ) {
    super(`token ${change.tokenId}: ${reason}`);
  }
}

/** Checks one change against the state it would apply to. Returns the reason it is refused, or null. */
export function refuseChange(state: RegistryState, c: Change, seenTokens: Set<number>, newKeys: Set<string>): string | null {
  if (!Number.isInteger(c.tokenId) || c.tokenId < 0 || c.tokenId >= state.owners.length) return "no such token";
  if (seenTokens.has(c.tokenId)) return "token already moved in this epoch (double sale)";
  if (state.owners[c.tokenId] !== c.from) return "signer is not the current owner";
  if (c.from === c.to) return "new owner key must differ";
  if (state.owners.includes(c.to) || newKeys.has(c.to)) return "new owner key is already in use";
  let ok = false;
  try {
    ok = ed25519.verify(hex32Sig(c.sig), transferMessage(state.collection, state.epoch, c), hex32(c.from, "from"));
  } catch {
    ok = false;
  }
  return ok ? null : "bad signature";
}

function hex32Sig(s: string): Uint8Array {
  if (!/^[0-9a-f]{128}$/.test(s)) throw new Error("signature must be 64 bytes of hex");
  return Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
}

/** Applies a batch of changes, refusing the whole batch on the first invalid change. */
export function applyEpoch(state: RegistryState, changes: Change[]): RegistryState {
  const seen = new Set<number>();
  const keys = new Set<string>();
  const owners = [...state.owners];
  for (const c of changes) {
    const why = refuseChange(state, c, seen, keys);
    if (why) throw new ChangeRejected(c, why);
    seen.add(c.tokenId);
    keys.add(c.to);
    owners[c.tokenId] = c.to;
  }
  const epoch = state.epoch + 1;
  const record: RegistryRecord = {
    v: 1,
    collection: state.collection,
    epoch,
    prev: recordHash(state.record),
    root: bytesToHex(merkleRoot(leaves({ collection: state.collection, owners }))),
    supply: owners.length,
    changes: changesHash(state.collection, epoch, changes),
  };
  return { collection: state.collection, epoch, owners, record };
}

/** Rebuilds every record from the public genesis owners and change log. */
export function replay(collection: string, genesisOwners: string[], log: Change[][]): RegistryRecord[] {
  let s = genesis(collection, genesisOwners);
  const out = [s.record];
  for (const batch of log) {
    s = applyEpoch(s, batch);
    out.push(s.record);
  }
  return out;
}

export function sameRecord(a: RegistryRecord, b: RegistryRecord): boolean {
  return recordHash(a) === recordHash(b);
}

// ---- holder keys ----

/** One-time owner key for a token, derived from the holder's seed. `n` increments per acquisition. */
export function ownerKey(seed: Uint8Array, collection: string, tokenId: number, n: number) {
  const sk = hkdf(sha256, seed, utf8ToBytes("seisin/key/1"), concatBytes(utf8ToBytes(collection), u32(tokenId), u32(n)), 32);
  return { secret: sk, public: bytesToHex(ed25519.getPublicKey(sk)) };
}

export function signTransfer(collection: string, epoch: number, c: Omit<Change, "sig">, secret: Uint8Array): Change {
  return { ...c, sig: bytesToHex(ed25519.sign(transferMessage(collection, epoch, c), secret)) };
}

// ---- ownership proofs ----

export interface OwnershipProof {
  v: 1;
  collection: string;
  epoch: number;
  tokenId: number;
  owner: string;
  path: MerklePath;
  nonce: string; // verifier's challenge, hex
  sig: string;
}

export function ownershipMessage(collection: string, epoch: number, tokenId: number, owner: string, nonce: string): Uint8Array {
  return tagged("seisin/own/1", utf8ToBytes(collection), u32(epoch), u32(tokenId), hex32(owner, "owner"), hex32(nonce, "nonce"));
}

export function proveOwnership(state: RegistryState, tokenId: number, secret: Uint8Array, nonce: string): OwnershipProof {
  const owner = state.owners[tokenId];
  if (owner !== bytesToHex(ed25519.getPublicKey(secret))) throw new Error("this key does not hold that token");
  return {
    v: 1,
    collection: state.collection,
    epoch: state.epoch,
    tokenId,
    owner,
    path: merklePath(leaves(state), tokenId),
    nonce,
    sig: bytesToHex(ed25519.sign(ownershipMessage(state.collection, state.epoch, tokenId, owner, nonce), secret)),
  };
}

/** Checks a proof against a record the verifier trusts (normally the latest anchored one). */
export function verifyOwnership(p: OwnershipProof, record: RegistryRecord, nonce: string): string | null {
  if (p.collection !== record.collection) return "different collection";
  if (p.epoch !== record.epoch) return `proof is for epoch ${p.epoch}, anchored record is epoch ${record.epoch}`;
  if (p.nonce !== nonce) return "proof answers a different challenge";
  if (p.path.index !== p.tokenId) return "path does not point at the token";
  if (!verifyPath(leafHash(p.collection, p.tokenId, p.owner), p.path, hex32(record.root, "root"))) return "token is not held by that key in this record";
  try {
    if (!ed25519.verify(hex32Sig(p.sig), ownershipMessage(p.collection, p.epoch, p.tokenId, p.owner, nonce), hex32(p.owner, "owner")))
      return "bad signature";
  } catch {
    return "bad signature";
  }
  return null;
}
