import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { ownerKey } from "../src/core/registry.js";

// The locker's scheduling, limits and hand-off, against a real registry and a stand-in wallet tool.
const FAKE = join(resolve("."), "test/fixtures/fake-devtool.mjs");
const TOKEN = randomBytes(16).toString("hex");
const SPORT = 20000 + Math.floor(Math.random() * 500);
const CPORT = SPORT + 600;
const LPORT = SPORT + 700; // the locker the registry notifies
const seisin = `http://127.0.0.1:${SPORT}`;
const dir = mkdtempSync(join(tmpdir(), "seisin-locker-"));
const procs: ChildProcess[] = [];
let chain: Server;
let minedHeight = -1;

const until = async (f: () => Promise<boolean> | boolean, ms = 10000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
    if (await f()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

// A process stopped by a signal has a signalCode and no exitCode; either means it is already gone.
const stopAll = (p: ChildProcess) => new Promise((r) => (p.exitCode !== null || p.signalCode !== null ? r(null) : (p.once("exit", r), p.kill())));

before(async () => {
  chmodSync(FAKE, 0o755);
  chain = createServer((req, res) => {
    const txid = (req.url ?? "").split("/").pop()!;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { [txid]: { transaction: { block_id: minedHeight } } } }));
  }).listen(CPORT);
  const s = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
    env: { ...process.env, PORT: String(SPORT), DATA_PATH: join(dir, "s.db"), SUPPLY: "8", OPERATOR_TOKEN: TOKEN, AUTO_SEAL_MINUTES: "0.01", ANCHOR_ADDRESS: "u1" + "a".repeat(120), ANCHOR_UIVK: "uivk1" + "b".repeat(120), LOCKER_URL: `http://127.0.0.1:${LPORT}` },
    stdio: "ignore",
  });
  procs.push(s);
  assert.ok(await until(() => fetch(seisin + "/health").then((r) => r.ok).catch(() => false)), "registry did not start");
});

after(async () => {
  for (const p of procs) await stopAll(p);
  chain.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function locker(name: string, extra: Record<string, string> = {}, seedState?: object, fixedPort?: number) {
  const w = join(dir, name);
  if (seedState) {
    mkdirSync(w, { recursive: true });
    writeFileSync(join(w, "locker-state.json"), JSON.stringify(seedState));
  }
  const port = fixedPort ?? 21000 + Math.floor(Math.random() * 4000);
  const p = spawn(process.execPath, ["locker/locker.mjs"], {
    env: {
      ...process.env,
      SEISIN_URL: seisin,
      OPERATOR_TOKEN: TOKEN,
      DEVTOOL: FAKE,
      WALLET_DIR: w,
      LOCKER_AGE_IDENTITY: "AGE-SECRET-KEY-1" + "Q".repeat(58),
      CHECK_MINUTES: "0.01",
      MIN_HOURS_BETWEEN: "0",
      CHAIN_API: `http://127.0.0.1:${CPORT}`,
      INFLIGHT_POLL_SECONDS: "0.5",
      PORT: String(port),
      ...extra,
    },
    stdio: "ignore",
  });
  procs.push(p);
  const status = () => fetch(`http://127.0.0.1:${port}/status`).then((r) => r.json()).catch(() => null);
  const log = join(w, "devtool", "calls.log");
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  return { status, calls, stop: () => stopAll(p) };
}

const changeSomething = async () => {
  const to = ownerKey(randomBytes(32), "deeds", 0, 0).public;
  const owners = await fetch(seisin + "/api/owners").then((r) => r.json());
  const id = (owners.issuerHeld as boolean[]).findIndex(Boolean);
  await fetch(seisin + "/api/issue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenId: id, to }) });
  assert.ok(await until(async () => (await fetch(seisin + "/api/registry").then((r) => r.json())).pending.length === 0), "change was not published");
};

test("creates its wallet without waiting on input, and starts clean after a half-finished attempt", async () => {
  // a previous attempt that died before writing keys.toml
  mkdirSync(join(dir, "fresh", "devtool"), { recursive: true });
  writeFileSync(join(dir, "fresh", "devtool", "data.sqlite"), "partial");
  const l = locker("fresh");
  assert.ok(await until(async () => !!(await l.status())?.address), `no wallet; status: ${JSON.stringify(await l.status())}`);
  assert.ok(existsSync(join(dir, "fresh", "devtool", "keys.toml")));
  assert.ok(!existsSync(join(dir, "fresh", "devtool", "data.sqlite")), "leftover from the failed attempt was kept");
  await l.stop();
});

test("does nothing while there is nothing new to lock", async () => {
  const l = locker("idle");
  assert.ok(await until(async () => !!(await l.status())?.address));
  await new Promise((r) => setTimeout(r, 1500));
  assert.doesNotMatch(l.calls(), /^pay$/m);
  assert.match((await l.status()).address, /^u1fake/);
  await l.stop();
});

test("locks as soon as the registry publishes something, without waiting for its timer", async () => {
  const l = locker("notified", { CHECK_MINUTES: "60" }, undefined, LPORT);
  assert.ok(await until(async () => !!(await l.status())?.address));
  await new Promise((r) => setTimeout(r, 1000));
  assert.doesNotMatch(l.calls(), /^pay$/m, "paid before anything changed");
  await changeSomething();
  assert.ok(await until(() => /^pay$/m.test(l.calls()), 8000), `no lock after the registry published; status: ${JSON.stringify(await l.status())}`);
  await l.stop();
});

test("refuses to pay below the minimum balance, and says how to fix it", async () => {
  await changeSomething();
  const l = locker("poor", { FAKE_BALANCE: "1000", MIN_BALANCE_ZATS: "40000" });
  assert.ok(await until(async () => /balance too low/.test((await l.status())?.error ?? "")));
  assert.doesNotMatch(l.calls(), /^pay$/m);
  assert.match((await l.status()).error, /top up u1fake/);
  await l.stop();
});

test("respects the gap between locks and the daily cap", async () => {
  const recent = { locks: [{ epoch: 0, txid: "cd".repeat(32), at: new Date().toISOString(), height: 1 }], inflight: null, error: null, address: null, balance: null, lastCheck: null };
  const gap = locker("gap", { MIN_HOURS_BETWEEN: "3" }, recent);
  await until(async () => !!(await gap.status())?.lastCheck);
  await new Promise((r) => setTimeout(r, 1500));
  assert.doesNotMatch(gap.calls(), /^pay$/m, "paid inside the 3-hour gap");
  await gap.stop();

  const old = new Date(Date.now() - 4 * 3_600_000).toISOString();
  const full = { ...recent, locks: Array.from({ length: 2 }, () => ({ ...recent.locks[0], at: old })) };
  const cap = locker("cap", { MAX_PER_DAY: "2", MIN_HOURS_BETWEEN: "3" }, full);
  assert.ok(await until(async () => /daily limit/.test((await cap.status())?.error ?? "")));
  assert.doesNotMatch(cap.calls(), /^pay$/m);
  await cap.stop();
});

test("a lock held back by the gap goes out when the gap ends, not on the next timer", async () => {
  const now = { locks: [{ epoch: 0, txid: "ef".repeat(32), at: new Date().toISOString(), height: 1 }], inflight: null, error: null, address: null, balance: null, lastCheck: null };
  const l = locker("gapend", { CHECK_MINUTES: "60", MIN_HOURS_BETWEEN: "0.001" }, now); // a 3.6 s gap
  assert.ok(await until(async () => !!(await l.status())?.lastCheck));
  assert.doesNotMatch(l.calls(), /^pay$/m, "paid inside the gap");
  assert.ok(await until(() => /^pay$/m.test(l.calls()), 10000), "did not lock when the gap ended");
  await l.stop();
});

test("dry run checks everything but pays nothing", async () => {
  const l = locker("dry", { DRY_RUN: "1" });
  assert.ok(await until(() => /^sync$/m.test(l.calls())));
  await new Promise((r) => setTimeout(r, 1500));
  assert.doesNotMatch(l.calls(), /^pay$/m);
  assert.equal((await l.status()).dryRun, true);
  await l.stop();
});

test("pays the registry's own request for the newest record once, then hands the mined txid back", async () => {
  minedHeight = -1;
  await changeSomething();
  const reg = await fetch(seisin + "/api/registry").then((r) => r.json());
  const want = await fetch(`${seisin}/api/anchor-request/${reg.head}`).then((r) => r.json());
  const l = locker("pays");
  assert.ok(await until(async () => !!(await l.status())?.inflight));
  const st = await l.status();
  assert.equal(st.inflight.epoch, reg.head);
  assert.equal(st.inflight.txid, "ab".repeat(32));
  assert.ok(l.calls().includes("uri " + want.uri), "paid something other than the registry's request");
  assert.equal(l.calls().match(/^pay$/gm)?.length, 1);

  // Once mined, the txid goes to the registry, which checks it against mainnet itself.
  // This fake txid is not on mainnet, so the registry refuses it and the locker reports that.
  minedHeight = 3510001;
  const handed = await until(async () => /not found|no note|transaction/i.test((await l.status())?.error ?? ""), 20000);
  assert.ok(handed, `did not hand the mined txid to the registry; locker status: ${JSON.stringify(await l.status())}`);
  assert.equal(l.calls().match(/^pay$/gm)?.length, 1, "paid again while a lock was still in flight");
  await l.stop();
});
