import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initSync, check, addressHasReceiver } from "../vendor/zcash-delivery-proof/zcash_delivery_proof_wasm.js";
import { checkAnchor, blockchair, type ChainSource } from "../src/core/anchor.js";

initSync({ module: readFileSync(new URL("../vendor/zcash-delivery-proof/zcash_delivery_proof_wasm_bg.wasm", import.meta.url)) });
const zdp = { check, addressHasReceiver };

// A real Ironwood payment on mainnet (upstream test vector). Its memo is not a Seisin record,
// so a correct pipeline verifies the note and then refuses the memo.
const v = JSON.parse(readFileSync(new URL("./zdp-mainnet-vector.json", import.meta.url), "utf8"));
const fixed: ChainSource = { tx: async () => ({ hex: v.txHex, height: v.height }) };

test("keyless check reaches the memo of a real mainnet note, then refuses a non-Seisin memo", async () => {
  await assert.rejects(checkAnchor({ txid: v.txid, proof: v.proof }, v.address, fixed, zdp), /not a Seisin anchor memo/);
});

test("a note paid to another address is not an anchor", async () => {
  const other = "u1" + "q".repeat(20);
  await assert.rejects(checkAnchor({ txid: v.txid, proof: v.proof }, other, fixed, zdp), /anchor address|receiver|address/i);
});

test("a tampered proof is refused", async () => {
  await assert.rejects(checkAnchor({ txid: v.txid, proof: v.proof.slice(0, -2) + "AA" }, v.address, fixed, zdp), /does not match/);
});

test("an unmined transaction is not an anchor", async () => {
  const pending: ChainSource = { tx: async () => ({ hex: v.txHex, height: null }) };
  await assert.rejects(checkAnchor({ txid: v.txid, proof: v.proof }, v.address, pending, zdp), /not mined/);
});

test("live: same result with bytes fetched from mainnet", { skip: !process.env.LIVE }, async () => {
  await assert.rejects(checkAnchor({ txid: v.txid, proof: v.proof }, v.address, blockchair(), zdp), /not a Seisin anchor memo/);
});
