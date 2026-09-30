import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  genesis,
  applyEpoch,
  replay,
  ownerKey,
  signTransfer,
  proveOwnership,
  verifyOwnership,
  recordHash,
  ChangeRejected,
  type Change,
} from "../src/core/registry.js";
import { encodeMemo, decodeMemo } from "../src/core/memo.js";

const COL = "deeds";
const ref = "11".repeat(32);
const nonce = () => randomBytes(32).toString("hex");

// Three holders; alice holds tokens 0 and 1, bob holds 2, carol buys later.
const alice = randomBytes(32);
const bob = randomBytes(32);
const carol = randomBytes(32);
const k = (seed: Uint8Array, id: number, n = 0) => ownerKey(seed, COL, id, n);

function start() {
  return genesis(COL, [k(alice, 0).public, k(alice, 1).public, k(bob, 2).public, k(bob, 3).public, k(bob, 4).public]);
}

test("owner keys are unlinkable across a holder's tokens", () => {
  assert.notEqual(k(alice, 0).public, k(alice, 1).public);
  assert.notEqual(k(alice, 0, 0).public, k(alice, 0, 1).public);
});

test("an owner proves a token against the record, a stranger cannot", () => {
  const s = start();
  const n = nonce();
  const p = proveOwnership(s, 2, k(bob, 2).secret, n);
  assert.equal(verifyOwnership(p, s.record, n), null);
  assert.throws(() => proveOwnership(s, 2, k(alice, 2).secret, n), /does not hold/);
  // claim bob's token with alice's signature over the right leaf
  const forged = { ...p, sig: proveOwnership(s, 0, k(alice, 0).secret, n).sig };
  assert.equal(verifyOwnership(forged, s.record, n), "bad signature");
});

test("a proof cannot be replayed against another challenge or a later record", () => {
  let s = start();
  const n = nonce();
  const p = proveOwnership(s, 2, k(bob, 2).secret, n);
  assert.equal(verifyOwnership(p, s.record, nonce()), "proof answers a different challenge");
  const to = k(carol, 2).public;
  s = applyEpoch(s, [signTransfer(COL, 0, { tokenId: 2, from: k(bob, 2).public, to, ref }, k(bob, 2).secret)]);
  assert.match(verifyOwnership(p, s.record, n)!, /epoch 0.*epoch 1/);
});

test("a signed transfer moves a token and keeps supply fixed", () => {
  const s0 = start();
  const c = signTransfer(COL, 0, { tokenId: 1, from: k(alice, 1).public, to: k(carol, 1).public, ref }, k(alice, 1).secret);
  const s1 = applyEpoch(s0, [c]);
  assert.equal(s1.epoch, 1);
  assert.equal(s1.record.supply, s0.record.supply);
  assert.equal(s1.record.prev, recordHash(s0.record));
  assert.notEqual(s1.record.root, s0.record.root);
  const n = nonce();
  assert.equal(verifyOwnership(proveOwnership(s1, 1, k(carol, 1).secret, n), s1.record, n), null);
});

test("the operator cannot move a token without the owner's signature", () => {
  const s = start();
  const operator = randomBytes(32);
  const c = signTransfer(COL, 0, { tokenId: 2, from: k(bob, 2).public, to: k(carol, 2).public, ref }, k(operator, 2).secret);
  assert.throws(() => applyEpoch(s, [c]), (e: unknown) => e instanceof ChangeRejected && e.reason === "bad signature");
});

test("a double sale in one epoch is refused", () => {
  const s = start();
  const from = k(bob, 3);
  const a = signTransfer(COL, 0, { tokenId: 3, from: from.public, to: k(alice, 3).public, ref }, from.secret);
  const b = signTransfer(COL, 0, { tokenId: 3, from: from.public, to: k(carol, 3).public, ref }, from.secret);
  assert.throws(() => applyEpoch(s, [a, b]), /double sale/);
});

test("a stale transfer signed for an old epoch cannot be replayed", () => {
  const s0 = start();
  const from = k(bob, 4);
  const sale = signTransfer(COL, 0, { tokenId: 4, from: from.public, to: k(carol, 4).public, ref }, from.secret);
  const s1 = applyEpoch(s0, [sale]);
  // carol sells back to bob's fresh key, then the old sale is replayed
  const back = signTransfer(COL, 1, { tokenId: 4, from: k(carol, 4).public, to: k(bob, 4, 1).public, ref }, k(carol, 4).secret);
  const s2 = applyEpoch(s1, [back]);
  assert.throws(() => applyEpoch(s2, [sale]), /not the current owner/);
});

test("replaying the public log reproduces every record; a rewritten log does not", () => {
  const s0 = start();
  const c1 = signTransfer(COL, 0, { tokenId: 0, from: k(alice, 0).public, to: k(carol, 0).public, ref }, k(alice, 0).secret);
  const s1 = applyEpoch(s0, [c1]);
  const c2 = signTransfer(COL, 1, { tokenId: 0, from: k(carol, 0).public, to: k(bob, 0).public, ref }, k(carol, 0).secret);
  const s2 = applyEpoch(s1, [c2]);
  const g = s0.owners;
  const recs = replay(COL, g, [[c1], [c2]]);
  assert.deepEqual(recs.map(recordHash), [s0, s1, s2].map((s) => recordHash(s.record)));
  // dropping the middle epoch breaks the chain: c2 no longer comes from the current owner
  assert.throws(() => replay(COL, g, [[c2]]), /not the current owner/);
});

test("memo round-trips and fits in 512 bytes", () => {
  const r = start().record;
  const m = encodeMemo(r);
  assert.ok(new TextEncoder().encode(m).length <= 512);
  assert.equal(recordHash(decodeMemo(m)), recordHash(r));
  assert.throws(() => decodeMemo(m.replace("SEISIN/1", "SEISIN/2")), /not a Seisin/);
});

test("changes are bound to the record: altering one changes the hash", () => {
  const s0 = start();
  const c: Change = signTransfer(COL, 0, { tokenId: 1, from: k(alice, 1).public, to: k(carol, 1).public, ref }, k(alice, 1).secret);
  const a = applyEpoch(s0, [c]).record;
  const b = applyEpoch(s0, [{ ...c, ref: "22".repeat(32), sig: signTransfer(COL, 0, { ...c, ref: "22".repeat(32) }, k(alice, 1).secret).sig }]).record;
  assert.equal(a.root, b.root);
  assert.notEqual(a.changes, b.changes);
});
