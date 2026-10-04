import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ownerKey, signTransfer, proveOwnership, verifyOwnership, replay, recordHash, genesis, applyEpoch } from "../src/core/registry.js";

const PORT = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}`;
const TOKEN = randomBytes(16).toString("hex");
const DEMO = randomBytes(32);
const dir = mkdtempSync(join(tmpdir(), "seisin-"));
let proc: ChildProcess;

const get = (p: string) => fetch(base + p).then((r) => r.json());
const post = (p: string, b: unknown, auth = false) =>
  fetch(base + p, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(b),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

before(async () => {
  proc = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
    env: { ...process.env, PORT: String(PORT), DATA_PATH: join(dir, "t.db"), SUPPLY: "8", OPERATOR_TOKEN: TOKEN, ANCHOR_ADDRESS: "", ANCHOR_UIVK: "", DEMO_VAULT_BACKUP: DEMO.toString("hex"), AUTO_SEAL_MINUTES: "0" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});

after(async () => {
  // Windows keeps the database locked until the server process has exited.
  await new Promise((r) => {
    proc.once("exit", r);
    proc.kill();
  });
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("issue, seal, resell, prove, and replay the public log", async () => {
  const alice = randomBytes(32);
  const bob = randomBytes(32);
  const col = (await get("/api/registry")).collection;

  // demo issuance of token 3 to alice's fresh key
  const a3 = ownerKey(alice, col, 3, 0);
  assert.equal((await post("/api/issue", { tokenId: 3, to: a3.public })).status, 202);
  assert.equal((await post("/api/issue", { tokenId: 3, to: ownerKey(bob, col, 3, 0).public })).status, 400, "second issuance of a queued token is refused");

  // sealing needs the operator
  assert.equal((await post("/api/operator/seal", {})).status, 401);
  const sealed = await post("/api/operator/seal", {}, true);
  assert.equal(sealed.body.sealed, 1);
  assert.match(sealed.body.request.memo, /^SEISIN\/1 deeds 1 8 /);

  // alice sells to bob
  const b3 = ownerKey(bob, col, 3, 0);
  const sale = signTransfer(col, 1, { tokenId: 3, from: a3.public, to: b3.public, ref: "ab".repeat(32) }, a3.secret);
  assert.equal((await post("/api/transfers", { change: sale })).status, 202);
  assert.equal((await post("/api/transfers", { change: sale })).status, 400, "double sale refused");
  // a forged sale by someone other than the owner is refused
  const forged = signTransfer(col, 1, { tokenId: 3, from: a3.public, to: ownerKey(randomBytes(32), col, 3, 0).public, ref: "ab".repeat(32) }, randomBytes(32));
  assert.equal((await post("/api/transfers", { change: forged })).status, 400);
  await post("/api/operator/seal", {}, true);

  // anyone replays the public log and gets the operator's records
  const log = await get("/api/log");
  const reg = await get("/api/registry");
  const recs = replay(log.collection, log.genesis, log.batches);
  assert.deepEqual(recs.map(recordHash), reg.epochs.map((e: any) => e.hash));

  // bob proves token 3 against the head record without revealing anything else
  let s = genesis(log.collection, log.genesis);
  for (const b of log.batches) s = applyEpoch(s, b);
  const nonce = randomBytes(32).toString("hex");
  const proof = proveOwnership(s, 3, b3.secret, nonce);
  assert.equal(verifyOwnership(proof, reg.epochs[reg.head].record, nonce), null);

  // anchoring refuses without a configured anchor account
  assert.equal((await post("/api/operator/anchor", { epoch: 2, txid: "00".repeat(32) }, true)).status, 409);
});

test("the public demo vault can hold and prove, but not transfer", async () => {
  const col = (await get("/api/registry")).collection;
  assert.equal((await get("/api/registry")).demoVault, DEMO.toString("hex"));
  const d6 = ownerKey(DEMO, col, 6, 0);
  assert.equal((await post("/api/issue", { tokenId: 6, to: d6.public })).status, 202);
  await post("/api/operator/seal", {}, true);
  const epoch = (await get("/api/registry")).head;
  const out = signTransfer(col, epoch, { tokenId: 6, from: d6.public, to: ownerKey(randomBytes(32), col, 6, 0).public, ref: "00".repeat(32) }, d6.secret);
  const r = await post("/api/transfers", { change: out });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /demo vault/);
});
