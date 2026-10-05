import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ownerKey, proveOwnership, genesis, applyEpoch, type Change } from "../src/core/registry.js";
import { encodeProof } from "../src/core/proofcode.js";

// The token gate: challenges bound to the site that asked, one use each, checked server-side.
const PORT = 22000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}`;
const TOKEN = randomBytes(16).toString("hex");
const dir = mkdtempSync(join(tmpdir(), "seisin-gate-"));
const SITE = "https://lounge.example";
let proc: ChildProcess;

const call = (path: string, body: unknown, origin?: string, auth = false) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}), ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json(), headers: r.headers }));

before(async () => {
  proc = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
    env: { ...process.env, PORT: String(PORT), DATA_PATH: join(dir, "g.db"), SUPPLY: "8", OPERATOR_TOKEN: TOKEN, AUTO_SEAL_MINUTES: "0", GATE_ALLOW_UNLOCKED: "1", ANCHOR_ADDRESS: "", ANCHOR_UIVK: "" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(base + "/health").then((r) => r.ok).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});

after(async () => {
  await new Promise((r) => (proc.exitCode !== null || proc.signalCode !== null ? r(null) : (proc.once("exit", r), proc.kill())));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** A holder of a token in the newest record. */
async function holder(id: number) {
  const seed = randomBytes(32);
  const key = ownerKey(seed, "deeds", id, 0);
  assert.equal((await call("/api/issue", { tokenId: id, to: key.public })).status, 202);
  assert.equal((await call("/api/operator/seal", {}, undefined, true)).status, 200);
  const log = await fetch(base + "/api/log").then((r) => r.json());
  let s = genesis(log.collection, log.genesis);
  for (const b of log.batches as Change[][]) s = applyEpoch(s, b);
  return { raw: (nonce: string) => proveOwnership(s, id, key.secret, nonce), prove: (nonce: string) => encodeProof(proveOwnership(s, id, key.secret, nonce)) };
}

test("a gate challenge is bound to the site that asked, and its proof works once, only there", async () => {
  const pre = await fetch(base + "/api/gate/verify", { method: "OPTIONS", headers: { origin: SITE, "access-control-request-method": "POST" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), SITE);

  assert.equal((await call("/api/gate/challenge", { returnUrl: "https://elsewhere.example/x" }, SITE)).status, 400, "returnUrl on another site refused");

  const c = await call("/api/gate/challenge", { returnUrl: `${SITE}/members#old` }, SITE);
  assert.equal(c.status, 200);
  assert.match(c.body.proveUrl, /#prove=deeds\.[0-9a-f]{64}&return=https%3A%2F%2Flounge\.example%2Fmembers$/);

  const h = await holder(2);
  const proof = h.prove(c.body.nonce);

  const other = await call("/api/gate/verify", { proof }, "https://evil.example");
  assert.equal(other.status, 403, "relayed to another site");
  assert.match(other.body.error, /different site/);

  const ok = await call("/api/gate/verify", { proof }, SITE);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.tokenId, 2);
  assert.equal(ok.body.collection, "deeds");
  assert.equal(ok.headers.get("access-control-allow-origin"), SITE);

  const again = await call("/api/gate/verify", { proof }, SITE);
  assert.equal(again.status, 409, "replayed");

  const forged = await call("/api/gate/verify", { proof: h.prove(randomBytes(32).toString("hex")) }, SITE);
  assert.equal(forged.status, 403, "challenge Seisin never issued");
});

test("a proof signed by a key that does not hold the token is refused", async () => {
  const c = await call("/api/gate/challenge", { returnUrl: `${SITE}/members` }, SITE);
  const h = await holder(4);
  const p = h.raw(c.body.nonce);
  const swapped = encodeProof({ ...p, owner: ownerKey(randomBytes(32), "deeds", 4, 0).public });
  const r = await call("/api/gate/verify", { proof: swapped }, SITE);
  assert.equal(r.status, 403);
  // the challenge was not used up by the failed attempt, so the real holder can still answer it
  assert.equal((await call("/api/gate/verify", { proof: encodeProof(p) }, SITE)).status, 200);
});
