import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ownerKey } from "../src/core/registry.js";

// A second server with sealing every ~1.2 s, so claims and automatic sealing can be exercised together.
const PORT = 19000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}`;
const TOKEN = randomBytes(16).toString("hex");
const dir = mkdtempSync(join(tmpdir(), "seisin-claims-"));
let proc: ChildProcess;

const get = (p: string) => fetch(base + p).then((r) => r.json());
const post = (p: string, b: unknown, auth = false) =>
  fetch(base + p, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(b),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
const until = async (f: () => Promise<boolean>, ms = 8000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
    if (await f()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

before(async () => {
  proc = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
    env: { ...process.env, PORT: String(PORT), DATA_PATH: join(dir, "c.db"), SUPPLY: "8", OPERATOR_TOKEN: TOKEN, ANCHOR_ADDRESS: "", ANCHOR_UIVK: "", AUTO_SEAL_MINUTES: "0.02", PUBLIC_URL: "https://example.test" },
    stdio: "ignore",
  });
  assert.ok(await until(async () => fetch(base + "/health").then((r) => r.ok).catch(() => false)), "server did not start");
});

after(async () => {
  await new Promise((r) => {
    proc.once("exit", r);
    proc.kill();
  });
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const ADDR = "u1" + "q".repeat(120);

test("claim codes move an existing holder in, once, and records seal on their own", async () => {
  const col = (await get("/api/registry")).collection;
  assert.equal((await post("/api/operator/claims", { rows: [{ tokenId: 2, address: ADDR }] })).status, 401);
  assert.equal((await post("/api/operator/claims", { rows: [{ tokenId: 2, address: "t1abc" }] }, true)).status, 400, "transparent address refused");

  const made = await post("/api/operator/claims", { rows: [{ tokenId: 2, address: ADDR }, { tokenId: 3, address: ADDR }] }, true);
  assert.equal(made.status, 200);
  assert.match(made.body.uri, /^zcash:\?address=u1.*&address\.1=u1/);
  const link: string = made.body.claims[0].link;
  assert.match(link, /^https:\/\/example\.test\/#claim=deeds\.2\.[0-9a-f]{20}$/);
  assert.ok(made.body.claims[0].memo.length < 512);
  const code = link.split(".").pop()!;

  const me = ownerKey(randomBytes(32), col, 2, 0);
  assert.equal((await post("/api/claim", { tokenId: 2, code: "0".repeat(20), to: me.public })).status, 403, "wrong code refused");
  assert.equal((await post("/api/claim", { tokenId: 3, code, to: me.public })).status, 403, "code is bound to its token");
  assert.equal((await post("/api/claim", { tokenId: 2, code, to: me.public })).status, 202);
  assert.equal((await post("/api/claim", { tokenId: 2, code, to: ownerKey(randomBytes(32), col, 2, 0).public })).status, 409, "a code works once");

  // the claim lands in a record without anyone pressing seal
  assert.ok(await until(async () => (await get("/api/owners")).owners[2] === me.public), "claim was not sealed automatically");
  const reg = await get("/api/registry");
  assert.equal(reg.pending.length, 0);
  assert.equal(reg.autoSealMinutes, 0.02);
});
