import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readPurchase, buyMemo, type SalesZdp } from "../src/server/sales.js";

const KEY = "ab".repeat(32);

/** A stand-in for the proof library: each note is { side, value, memo }. */
function fakeZdp(notes: { side?: string; value: number; memo: string | null }[]): SalesZdp {
  return {
    make: () => JSON.stringify(notes.map((n, i) => ({ proof: `p${i}`, side: n.side ?? "received" }))),
    check: (_hex, proof) => {
      const n = notes[Number(proof.slice(1))];
      return JSON.stringify({ value: n.value, memoText: n.memo });
    },
  };
}

test("reads a purchase: token, buyer key, and a ref that commits to the payment", () => {
  const p = readPurchase("00", "uivk", "deeds", 50000, fakeZdp([{ value: 50000, memo: buyMemo("deeds", 7, KEY) }]));
  assert.equal(p.tokenId, 7);
  assert.equal(p.to, KEY);
  assert.match(p.ref, /^[0-9a-f]{64}$/);
});

test("refuses payments that are not a valid purchase, and says why", () => {
  const read = (notes: Parameters<typeof fakeZdp>[0]) => () => readPurchase("00", "uivk", "deeds", 50000, fakeZdp(notes));
  assert.throws(read([]), /pays nothing/);
  assert.throws(read([{ value: 50000, memo: "thanks!" }]), /not a Seisin purchase/);
  assert.throws(read([{ value: 50000, memo: buyMemo("other", 7, KEY) }]), /buys from other/);
  assert.throws(read([{ value: 49999, memo: buyMemo("deeds", 7, KEY) }]), /price is 50000/);
  assert.throws(read([{ side: "sent", value: 50000, memo: buyMemo("deeds", 7, KEY) }]), /no purchase/, "an outgoing note is not a payment in");
});

test("finds the purchase among several notes", () => {
  const p = readPurchase("00", "uivk", "deeds", 50000, fakeZdp([{ value: 1000, memo: "change" }, { value: 60000, memo: buyMemo("deeds", 3, KEY) }]));
  assert.equal(p.tokenId, 3);
  assert.equal(p.value, 60000);
});

// ---- the routes, against a running registry and a stand-in chain ----

const PORT = 23000 + Math.floor(Math.random() * 500);
const CPORT = PORT + 600;
const base = `http://127.0.0.1:${PORT}`;
const TOKEN = randomBytes(16).toString("hex");
const dir = mkdtempSync(join(tmpdir(), "seisin-sales-"));
const vector = JSON.parse(readFileSync(new URL("./zdp-mainnet-vector.json", import.meta.url), "utf8"));
let proc: ChildProcess;
let chain: Server;
let mined = -1;

before(async () => {
  chain = createServer((req, res) => {
    const txid = (req.url ?? "").split("/").pop()!;
    res.writeHead(200, { "content-type": "application/json" });
    if ((req.url ?? "").includes("/raw/")) res.end(JSON.stringify({ data: { [txid]: { raw_transaction: vector.txHex } } }));
    else res.end(JSON.stringify({ data: { [txid]: { transaction: { block_id: mined } } } }));
  }).listen(CPORT);
  proc = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_PATH: join(dir, "s.db"),
      SUPPLY: "8",
      OPERATOR_TOKEN: TOKEN,
      AUTO_SEAL_MINUTES: "0",
      SALES_ADDRESS: "u1" + "s".repeat(120),
      SALES_UIVK: "uivk1" + "t".repeat(120),
      PRICE_ZATS: "50000",
      CHAIN_API: `http://127.0.0.1:${CPORT}`,
    },
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
  chain.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const buy = (txid: string) =>
  fetch(base + "/api/buy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txid }) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("lists what is for sale, leaving out tokens promised to existing holders", async () => {
  const s0 = await fetch(base + "/api/sale").then((r) => r.json());
  assert.equal(s0.available, true);
  assert.equal(s0.amount, "0.0005");
  assert.deepEqual(s0.forSale, [0, 1, 2, 3, 4, 5, 6, 7]);
  await fetch(base + "/api/operator/claims", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ rows: [{ tokenId: 5, address: "u1" + "q".repeat(120) }] }),
  });
  const s1 = await fetch(base + "/api/sale").then((r) => r.json());
  assert.ok(!s1.forSale.includes(5), "a token with an open claim code was offered for sale");
});

test("waits for the payment to be mined, then refuses a transaction the sales key cannot read", async () => {
  mined = -1;
  const early = await buy(vector.txid);
  assert.equal(early.status, 425);
  mined = 3510000;
  const r = await buy(vector.txid);
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal((await buy("zz")).status, 400);
});
