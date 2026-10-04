import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { genesis, ownerKey, proveOwnership, verifyOwnership } from "../src/core/registry.js";
import { encodeProof, decodeProof } from "../src/core/proofcode.js";

test("compact proofs round-trip, stay short, and still verify", () => {
  const seed = randomBytes(32);
  const owners = Array.from({ length: 32 }, (_, i) => ownerKey(i === 7 ? seed : randomBytes(32), "deeds", i, 0).public);
  const s = genesis("deeds", owners);
  const nonce = randomBytes(32).toString("hex");
  const p = proveOwnership(s, 7, ownerKey(seed, "deeds", 7, 0).secret, nonce);
  const code = encodeProof(p);
  const json = Buffer.from(JSON.stringify(p)).toString("base64url");
  assert.ok(code.length < json.length * 0.6, `${code.length} vs ${json.length}`);
  const back = decodeProof(`https://seisin.up.railway.app/#check=${code}`);
  assert.deepEqual(back, p);
  assert.equal(verifyOwnership(back, s.record, nonce), null);
  assert.deepEqual(decodeProof("seisin-proof:" + json), p, "older JSON proofs still read");
  assert.throws(() => decodeProof(code + "AA"), /trailing|unknown/);
});
