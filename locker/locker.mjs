// Seisin locker: pays the Zcash note that locks the newest Seisin record, on a schedule and within limits.
//
// It holds a small, separate wallet (zcash-devtool) whose seed is encrypted to an age identity supplied
// as a secret. It never decides what a record says: it pays the exact payment request the registry
// publishes, then hands the mined txid back to the registry, which checks it like any other lock.

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const env = {
  seisin: (process.env.SEISIN_URL ?? "http://localhost:8787").replace(/\/$/, ""),
  token: process.env.OPERATOR_TOKEN ?? "",
  devtool: process.env.DEVTOOL ?? "zcash-devtool",
  wallet: process.env.WALLET_DIR ?? "/wallet",
  network: process.env.LOCKER_NETWORK ?? "main",
  server: process.env.LIGHTWALLETD ?? "zecrocks",
  identity: process.env.LOCKER_AGE_IDENTITY ?? "",
  checkMinutes: Number(process.env.CHECK_MINUTES ?? 30),
  minHours: Number(process.env.MIN_HOURS_BETWEEN ?? 3),
  maxPerDay: Number(process.env.MAX_PER_DAY ?? 8),
  minBalance: Number(process.env.MIN_BALANCE_ZATS ?? 40000),
  maxMinedWaitMinutes: Number(process.env.MAX_MINED_WAIT_MINUTES ?? 60),
  inflightPollSeconds: Number(process.env.INFLIGHT_POLL_SECONDS ?? 60),
  port: Number(process.env.PORT ?? 8080),
  dryRun: process.env.DRY_RUN === "1",
  // Where to ask whether a transaction is mined (Blockchair's API shape).
  chainApi: (process.env.CHAIN_API ?? "https://api.blockchair.com/zcash").replace(/\/$/, ""),
};

if (!env.token) throw new Error("OPERATOR_TOKEN is required");
if (!/^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(env.identity)) throw new Error("LOCKER_AGE_IDENTITY must be an age secret key (AGE-SECRET-KEY-1…)");
mkdirSync(env.wallet, { recursive: true });

// The identity lives only in memory and a private temp file, never on the wallet volume.
const idFile = join(tmpdir(), `locker-age-${process.pid}.txt`);
writeFileSync(idFile, env.identity + "\n", { mode: 0o600 });

const stateFile = join(env.wallet, "locker-state.json");
const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf8"))
  : { locks: [], inflight: null, error: null, address: null, balance: null, lastCheck: null };
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
let nextCheck = null;

// The devtool's own wallet lives in a subfolder, so the locker's state file never mixes with it.
const walletDir = join(env.wallet, "devtool");

/** The lines worth showing from a failed command: no colour codes, no routine INFO logging. */
const tail = (text) =>
  text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/\bINFO\b/.test(l))
    .slice(-4)
    .join(" | ");

/**
 * Runs one devtool wallet command. Input is always given and closed: some commands read a line
 * from stdin when there is no terminal, and an open stdin would leave them waiting forever.
 */
function devtool(args, { timeoutMs = 10 * 60_000, input = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(env.devtool, ["wallet", "-w", walletDir, ...args], { timeout: timeoutMs, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${args[0]} failed: ${tail(`${stderr}\n${stdout}`) || err.message}`));
      else resolve(stdout);
    });
    child.stdin?.end(input);
  });
}

async function api(path, init) {
  const r = await fetch(env.seisin + path, init);
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(b.error ?? `${path} returned ${r.status}`), { status: r.status });
  return b;
}

// keys.toml is written last, so a wallet without it never got a seed and cannot hold funds.
const walletReady = () => existsSync(join(walletDir, "keys.toml"));

async function ensureWallet() {
  if (!walletReady()) {
    rmSync(walletDir, { recursive: true, force: true });
    console.log("creating the locker wallet");
    // An empty line asks the devtool to generate a new seed phrase, stored encrypted to the age identity.
    await devtool(["init", "--name", "seisin-locker", "-i", idFile, "-n", env.network, "-s", env.server], { input: "\n" });
  }
  if (!state.address) {
    const out = await devtool(["list-addresses", "--receiver", "orchard"]);
    const m = out.match(/Receiver\(orchard\):\s*(u\S+)/) ?? out.match(/Default Address:\s*(u\S+)/);
    if (m) state.address = m[1];
    save();
  }
}

async function balance() {
  await devtool(["sync", "-s", env.server], { timeoutMs: 20 * 60_000 });
  const j = JSON.parse((await devtool(["balance", "--json"])).trim().split("\n").pop());
  state.balance = j;
  return j;
}

/** Shielded zatoshi the wallet can spend now (`balance --json` reports each pool separately). */
function spendable(b) {
  return ["sapling_spendable", "orchard_spendable", "ironwood_spendable"].reduce((n, k) => n + (Number(b?.[k]) || 0), 0);
}

async function mined(txid) {
  const r = await fetch(`${env.chainApi}/dashboards/transaction/${txid}`).then((x) => x.json());
  const h = r?.data?.[txid]?.transaction?.block_id;
  return typeof h === "number" && h > 0 ? h : null;
}

async function finishInflight() {
  const f = state.inflight;
  if (!f) return;
  const h = await mined(f.txid);
  if (!h) {
    if (Date.now() - Date.parse(f.at) > env.maxMinedWaitMinutes * 60_000) {
      state.error = `lock ${f.txid.slice(0, 12)}… for record ${f.epoch} was not mined within ${env.maxMinedWaitMinutes} minutes; check it and record it in the Operator tab`;
      state.inflight = null;
    }
    return save();
  }
  try {
    await api("/api/operator/anchor", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.token}` }, body: JSON.stringify({ epoch: f.epoch, txid: f.txid }) });
  } catch (e) {
    // Someone already recorded this or a later lock by hand: nothing left to do.
    if (!/already anchored|anchors only move forward/.test(e.message)) throw e;
  }
  state.locks.push({ ...f, height: h, recordedAt: new Date().toISOString() });
  state.inflight = null;
  state.error = null;
  console.log(`record ${f.epoch} locked at height ${h} (${f.txid})`);
  save();
}

async function tick() {
  state.lastCheck = new Date().toISOString();
  try {
    await ensureWallet();
    await finishInflight();
    if (state.inflight) return;

    const reg = await api("/api/registry");
    const head = reg.epochs[reg.epochs.length - 1];
    const lockedUpTo = reg.latestAnchored ?? -1;
    const changesSinceLock = reg.epochs.filter((e) => e.epoch > lockedUpTo).reduce((n, e) => n + e.changes, 0);
    if (head.anchor || changesSinceLock === 0) return save();

    const last = state.locks.at(-1);
    if (last && Date.now() - Date.parse(last.at) < env.minHours * 3_600_000) return save();
    const today = state.locks.filter((l) => Date.now() - Date.parse(l.at) < 86_400_000).length;
    if (today >= env.maxPerDay) {
      state.error = `daily limit of ${env.maxPerDay} locks reached`;
      return save();
    }

    const b = await balance();
    if (spendable(b) < env.minBalance) {
      state.error = `balance too low to lock (${spendable(b)} zat spendable, needs ${env.minBalance}); top up ${state.address}`;
      return save();
    }

    const req = await api(`/api/anchor-request/${head.epoch}`);
    if (!req.uri) throw new Error("the registry has no lock address configured");
    if (env.dryRun) {
      console.log(`dry run: would pay ${req.uri.slice(0, 60)}…`);
      return save();
    }
    const out = await devtool(["pay", "-i", idFile, "--payment-uri", req.uri, "--disable-confirmation", "-s", env.server]);
    const txid = out.trim().split("\n").pop().trim();
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error(`pay did not return a txid: ${out.slice(-200)}`);
    state.inflight = { epoch: head.epoch, txid, at: new Date().toISOString() };
    state.error = null;
    console.log(`paid the lock for record ${head.epoch}: ${txid}`);
    save();
  } catch (e) {
    state.error = e.message;
    console.error("locker:", e.message);
    save();
  }
}

// While a lock is waiting to be mined, check every minute or so; otherwise on the normal cadence.
async function loop() {
  await tick();
  const ms = state.inflight ? env.inflightPollSeconds * 1000 : env.checkMinutes * 60_000;
  nextCheck = new Date(Date.now() + ms).toISOString();
  setTimeout(loop, ms);
}

createServer((req, res) => {
  if (req.url !== "/status" && req.url !== "/health") {
    res.writeHead(404).end();
    return;
  }
  const today = state.locks.filter((l) => Date.now() - Date.parse(l.at) < 86_400_000).length;
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(
    JSON.stringify({
      ok: !state.error,
      address: state.address,
      spendableZats: state.balance ? spendable(state.balance) : null,
      lastCheck: state.lastCheck,
      nextCheck,
      lastLock: state.locks.at(-1) ?? null,
      inflight: state.inflight,
      error: state.error,
      locksToday: today,
      limits: { checkMinutes: env.checkMinutes, minHoursBetween: env.minHours, maxPerDay: env.maxPerDay, minBalanceZats: env.minBalance },
      dryRun: env.dryRun,
    }),
  );
}).listen(env.port, () => console.log(`seisin locker on :${env.port}, watching ${env.seisin}`));

loop();
