import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { dirname, join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initSync, check, make, addressHasReceiver } from "../../vendor/zcash-delivery-proof/zcash_delivery_proof_wasm.js";
import { Store } from "./store.js";
import { ownerKey, signTransfer, recordHash, verifyOwnership, type Change } from "../core/registry.js";
import { decodeProof } from "../core/proofcode.js";
import { readPurchase } from "./sales.js";
import { encodeMemo } from "../core/memo.js";
import { checkAnchor, blockchair } from "../core/anchor.js";
import { hexToBytes } from "../core/bytes.js";

// The project root: two levels up from src/server when run from source, one level up from dist/ when bundled.
const here = dirname(fileURLToPath(import.meta.url));
const root = existsSync(join(here, "../package.json")) ? resolve(here, "..") : resolve(here, "../..");
initSync({ module: readFileSync(join(root, "vendor/zcash-delivery-proof/zcash_delivery_proof_wasm_bg.wasm")) });
const zdp = { check, addressHasReceiver };

const env = {
  port: Number(process.env.PORT ?? 8787),
  data: process.env.DATA_PATH ?? (process.env.RAILWAY_VOLUME_MOUNT_PATH ? join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "seisin.db") : join(root, "data/seisin.db")),
  collection: process.env.COLLECTION ?? "deeds",
  supply: Number(process.env.SUPPLY ?? 32),
  operatorToken: process.env.OPERATOR_TOKEN ?? "",
  anchorAddress: process.env.ANCHOR_ADDRESS ?? "",
  anchorUivk: process.env.ANCHOR_UIVK ?? "",
  // The lock note only carries the memo; its value can be tiny.
  anchorZats: Number(process.env.ANCHOR_ZATS ?? 1000),
  // The locker service, if one runs beside this registry.
  lockerUrl: (process.env.LOCKER_URL ?? "").replace(/\/$/, ""),
  demoIssuance: process.env.DEMO_ISSUANCE !== "off",
  // Signed changes are sealed into a new record on this cadence; 0 leaves sealing to the operator.
  autoSealMinutes: Number(process.env.AUTO_SEAL_MINUTES ?? 5),
  // Used to build claim links; falls back to the request's own host.
  publicUrl: (process.env.PUBLIC_URL ?? "").replace(/\/$/, ""),
  // A deliberately public vault backup, so anyone can try a proof against an anchored record.
  // Gate checks normally need a record locked on Zcash; local development can accept an unlocked one.
  gateAllowUnlocked: process.env.GATE_ALLOW_UNLOCKED === "1",
  // Paid first sales. The viewing key is secret: it reads which key each payment was for.
  salesAddress: process.env.SALES_ADDRESS ?? "",
  salesUivk: process.env.SALES_UIVK ?? "",
  priceZats: Number(process.env.PRICE_ZATS ?? 50000),
  // Where transactions are fetched from (Blockchair's API shape); tests point it at a stand-in.
  chainApi: (process.env.CHAIN_API ?? "https://api.blockchair.com/zcash").replace(/\/$/, ""),
  demoVault: /^[0-9a-f]{64}$/.test(process.env.DEMO_VAULT_BACKUP ?? "") ? process.env.DEMO_VAULT_BACKUP! : "",
  commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.COMMIT ?? "local",
};

// On a host with a mounted volume, the database must live on it, or every deploy silently starts a new registry.
const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (mount && !resolve(env.data).startsWith(resolve(mount) + "/") && !resolve(env.data).startsWith(resolve(mount) + "\\"))
  throw new Error(`DATA_PATH (${env.data}) is not on the mounted volume (${mount}); refusing to start a registry that a redeploy would erase`);

// Catch a pasted transparent address or a spending key before anything is published.
if (env.anchorAddress && !/^u1[0-9a-z]{100,}$/.test(env.anchorAddress))
  throw new Error("ANCHOR_ADDRESS must be a mainnet unified address starting with u1 (not a t1 transparent address)");
if (env.anchorUivk && !/^(uivk1|uview1)[0-9a-z]{100,}$/.test(env.anchorUivk))
  throw new Error("ANCHOR_UIVK must be a mainnet viewing key starting with uivk1 or uview1; never a spending key or seed phrase");

mkdirSync(dirname(env.data), { recursive: true });

/*
 * Unsold inventory is held by the issuer's own one-time keys, so the first
 * sale of a token is an ordinary owner-signed transfer. In production the seed
 * comes from ISSUER_SEED; locally it is created once beside the database.
 */
function issuerSeed(): Uint8Array {
  if (process.env.ISSUER_SEED) return hexToBytes(process.env.ISSUER_SEED);
  const f = join(dirname(env.data), "issuer.seed");
  if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString("hex"), { mode: 0o600 });
  return hexToBytes(readFileSync(f, "utf8").trim());
}
const issuer = issuerSeed();

// Locally, an operator token is created once beside the database; production sets OPERATOR_TOKEN.
if (!env.operatorToken && !process.env.RAILWAY_ENVIRONMENT) {
  const f = join(dirname(env.data), "operator.token");
  if (!existsSync(f)) writeFileSync(f, randomBytes(24).toString("hex"), { mode: 0o600 });
  env.operatorToken = readFileSync(f, "utf8").trim();
}
const issuerKey = (id: number) => ownerKey(issuer, env.collection, id, 0);

// Keys of the public demo vault may prove, but never transfer: anyone can restore it.
const demoKeys = new Set<string>();
if (env.demoVault)
  for (let id = 0; id < env.supply; id++) for (let n = 0; n < 16; n++) demoKeys.add(ownerKey(hexToBytes(env.demoVault), env.collection, id, n).public);

const store = new Store(env.data);
if (!store.initialized()) {
  store.init(env.collection, Array.from({ length: env.supply }, (_, i) => issuerKey(i).public));
  console.log(`created registry "${env.collection}" with supply ${env.supply}`);
}

// ---- telling the locker ----

/** Lets the locker know there is a new record, so it can lock it now instead of on its next check. */
function notifyLocker() {
  if (!env.lockerUrl) return;
  fetch(env.lockerUrl + "/notify", { method: "POST", signal: AbortSignal.timeout(3000) }).catch(() => {});
}

const GATE_TTL = 10 * 60_000;

// ---- automatic sealing ----

let nextSealAt: number | null = null;
if (env.autoSealMinutes > 0) {
  const every = env.autoSealMinutes * 60_000;
  nextSealAt = Date.now() + every;
  setInterval(() => {
    nextSealAt = Date.now() + every;
    if (store.pending().length === 0) return;
    try {
      const row = store.seal();
      notifyLocker();
      console.log(`sealed epoch ${row.record.epoch} automatically (${row.changes.length} change${row.changes.length === 1 ? "" : "s"})`);
    } catch (e) {
      console.error("automatic seal failed:", (e as Error).message);
    }
  }, every).unref();
}

// ---- helpers ----

class HttpError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > 16_384) throw new HttpError(413, "body too large");
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

function requireOperator(req: IncomingMessage) {
  const got = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
  const want = Buffer.from(env.operatorToken);
  if (!env.operatorToken || got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, "operator token required");
}

function isChange(c: any): c is Change {
  return (
    c &&
    Number.isInteger(c.tokenId) &&
    [c.from, c.to, c.ref].every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) &&
    typeof c.sig === "string" &&
    /^[0-9a-f]{128}$/.test(c.sig)
  );
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function anchorRequest(n: number) {
  const row = store.epochs()[n];
  if (!row) throw new HttpError(404, "no such epoch");
  const memo = encodeMemo(row.record);
  const amount = (env.anchorZats / 1e8).toFixed(8).replace(/0+$/, "");
  const uri = env.anchorAddress ? `zcash:${env.anchorAddress}?amount=${amount}&memo=${b64url(memo)}` : null;
  return { epoch: n, memo, amount, uri };
}

function registryView() {
  const rows = store.epochs();
  const anchored = rows.filter((r) => r.anchor).pop();
  return {
    collection: store.collection(),
    supply: rows[0].record.supply,
    anchorAddress: env.anchorAddress || null,
    anchorUivk: env.anchorUivk || null,
    demoIssuance: env.demoIssuance,
    demoVault: env.demoVault || null,
    autoSealMinutes: env.autoSealMinutes,
    autoLock: !!env.lockerUrl,
    nextSealAt: nextSealAt ? new Date(nextSealAt).toISOString() : null,
    head: rows[rows.length - 1].record.epoch,
    latestAnchored: anchored ? anchored.record.epoch : null,
    epochs: rows.map((r) => ({
      epoch: r.record.epoch,
      hash: r.hash,
      record: r.record,
      memo: encodeMemo(r.record),
      changes: r.changes.length,
      anchor: r.anchor,
      sealedAt: r.sealedAt,
    })),
    pending: store.pending().map((p) => ({ tokenId: p.change.tokenId, note: p.note, at: p.at })),
  };
}

// Checks a mined transaction for the epoch's anchor note, with the registry's viewing key, then records it.
async function recordAnchor(epoch: unknown, txid: unknown) {
  if (!env.anchorAddress || !env.anchorUivk) throw new HttpError(409, "ANCHOR_ADDRESS and ANCHOR_UIVK are not configured");
  const row = typeof epoch === "number" ? store.epochs()[epoch] : undefined;
  if (!row) throw new HttpError(404, "no such epoch");
  if (typeof txid !== "string" || !/^[0-9a-f]{64}$/.test(txid)) throw new HttpError(400, "txid must be 32 bytes of hex");
  const chain = blockchair(fetch, env.chainApi);
  const { hex } = await chain.tx(txid);
  const found = JSON.parse(make(hex, env.anchorUivk)) as { proof: string }[];
  const errors: string[] = [];
  for (const f of found) {
    try {
      const a = await checkAnchor({ txid, proof: f.proof }, env.anchorAddress, chain, zdp);
      if (recordHash(a.record) !== row.hash) {
        errors.push(`memo is epoch ${a.record.epoch} with a different hash`);
        continue;
      }
      store.setAnchor(epoch as number, { txid, proof: f.proof, height: a.height });
      return { anchored: epoch as number, txid, height: a.height, proof: f.proof };
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  throw new HttpError(422, found.length ? `no matching anchor note: ${errors.join("; ")}` : "the anchor key sees no note in that transaction");
}

// ---- routes ----

async function api(req: IncomingMessage, res: ServerResponse, path: string) {
  const m = req.method ?? "GET";

  if (m === "GET" && path === "/api/registry") return send(res, 200, registryView());

  // The locker's status, for the Operator tab. Public on purpose: it holds an address and counts, no secrets.
  if (m === "GET" && path === "/api/locker") {
    if (!env.lockerUrl) return send(res, 200, { available: false });
    try {
      const r = await fetch(env.lockerUrl + "/status", { signal: AbortSignal.timeout(3000) });
      return send(res, 200, { available: true, ...(await r.json()) });
    } catch {
      return send(res, 200, { available: true, reachable: false });
    }
  }

  if (m === "GET" && path === "/api/log")
    return send(res, 200, { collection: store.collection(), genesis: store.genesisOwners(), batches: store.epochs().slice(1).map((r) => r.changes) });

  if (m === "GET" && path === "/api/owners") {
    const s = store.state();
    return send(res, 200, { epoch: s.epoch, owners: s.owners, issuerHeld: s.owners.map((o, i) => o === issuerKey(i).public) });
  }

  if (m === "POST" && path === "/api/transfers") {
    const { change } = await body(req);
    if (!isChange(change)) throw new HttpError(400, "malformed change");
    if (demoKeys.has(change.from)) throw new HttpError(403, "the public demo vault can prove what it holds but cannot transfer it");
    store.submit(change, "transfer");
    return send(res, 202, { queued: true, registry: registryView() });
  }

  if (m === "POST" && path === "/api/issue") {
    if (!env.demoIssuance) throw new HttpError(403, "demo issuance is off");
    const { tokenId, to } = await body(req);
    if (!Number.isInteger(tokenId) || typeof to !== "string" || !/^[0-9a-f]{64}$/.test(to)) throw new HttpError(400, "tokenId and a 32-byte hex key are required");
    const s = store.state();
    const k = issuerKey(tokenId);
    if (s.owners[tokenId] !== k.public) throw new HttpError(409, "token is no longer held by the issuer");
    const change = signTransfer(s.collection, s.epoch, { tokenId, from: k.public, to, ref: "00".repeat(32) }, k.secret);
    store.submit(change, "demo issuance (no payment)");
    return send(res, 202, { queued: true, registry: registryView() });
  }

  if (m === "POST" && path === "/api/claim") {
    const { tokenId, code, to } = await body(req);
    if (!Number.isInteger(tokenId) || typeof code !== "string" || !/^[0-9a-f]{20}$/.test(code) || typeof to !== "string" || !/^[0-9a-f]{64}$/.test(to))
      throw new HttpError(400, "a claim needs the token, its code and a fresh key");
    const c = store.claim(tokenId);
    const given = Buffer.from(createHash("sha256").update(code).digest("hex"));
    if (!c || !timingSafeEqual(given, Buffer.from(c.codeHash))) throw new HttpError(403, "that claim code is not valid for this token");
    if (c.usedAt) throw new HttpError(409, "this claim code has already been used");
    const s = store.state();
    const k = issuerKey(tokenId);
    if (s.owners[tokenId] !== k.public) throw new HttpError(409, "token is no longer held by the issuer");
    store.submit(signTransfer(s.collection, s.epoch, { tokenId, from: k.public, to, ref: "00".repeat(32) }, k.secret), "claimed with a code");
    store.useClaim(tokenId);
    return send(res, 202, { queued: true, registry: registryView() });
  }

  if (m === "GET" && path === "/api/sale") {
    if (!env.salesAddress || !env.salesUivk) return send(res, 200, { available: false });
    const s = store.state();
    const queued = new Set(store.pending().map((p) => p.change.tokenId));
    const reserved = store.reservedByClaims();
    const forSale = s.owners.map((o, i) => i).filter((i) => s.owners[i] === issuerKey(i).public && !queued.has(i) && !reserved.has(i));
    const amount = (env.priceZats / 1e8).toFixed(8).replace(/0+$/, "");
    return send(res, 200, { available: true, collection: s.collection, address: env.salesAddress, priceZats: env.priceZats, amount, forSale });
  }

  if (m === "POST" && path === "/api/buy") {
    if (!env.salesAddress || !env.salesUivk) throw new HttpError(404, "this collection is not on sale");
    const { txid } = await body(req);
    if (typeof txid !== "string" || !/^[0-9a-f]{64}$/.test(txid)) throw new HttpError(400, "paste the transaction id of your payment");
    const seen = store.purchase(txid);
    if (seen) throw new HttpError(409, seen.status === "issued" ? `that payment already bought No. ${seen.tokenId}` : "that payment is already waiting for a refund");
    const { hex, height } = await blockchair(fetch, env.chainApi).tx(txid);
    if (height === null) throw new HttpError(425, "your payment is not mined yet; this page will try again in a minute");
    let p;
    try {
      p = readPurchase(hex, env.salesUivk, store.collection(), env.priceZats, { make, check });
    } catch (e) {
      const msg = (e as Error).message;
      // A bad sales key is the seller's setup problem, not something the buyer can fix.
      if (/viewing key/.test(msg)) throw new HttpError(503, "the seller's sales key is not set up correctly; your payment is safe, try again later");
      throw new HttpError(422, msg);
    }
    const s = store.state();
    const k = issuerKey(p.tokenId);
    const taken = !(p.tokenId < s.owners.length) || s.owners[p.tokenId] !== k.public || store.pending().some((q) => q.change.tokenId === p.tokenId) || store.reservedByClaims().has(p.tokenId);
    if (taken) {
      store.addPurchase(txid, p.tokenId, p.value, "refund-due");
      throw new HttpError(409, `No. ${p.tokenId} was taken before your payment arrived. The operator has been told and will refund you.`);
    }
    store.submit(signTransfer(s.collection, s.epoch, { tokenId: p.tokenId, from: k.public, to: p.to, ref: p.ref }, k.secret), "sold for ZEC");
    store.addPurchase(txid, p.tokenId, p.value, "issued");
    return send(res, 202, { queued: true, tokenId: p.tokenId, registry: registryView() });
  }

  if (m === "GET" && path === "/api/operator/purchases") {
    requireOperator(req);
    return send(res, 200, { purchases: store.purchases() });
  }

  const req_ = path.match(/^\/api\/anchor-request\/(\d+)$/);
  if (m === "GET" && req_) return send(res, 200, anchorRequest(Number(req_[1])));

  if (m === "POST" && path === "/api/operator/seal") {
    requireOperator(req);
    const row = store.seal();
    notifyLocker();
    return send(res, 200, { sealed: row.record.epoch, request: anchorRequest(row.record.epoch) });
  }

  if (m === "POST" && path === "/api/operator/anchor") {
    requireOperator(req);
    const { epoch, txid } = await body(req);
    return send(res, 200, await recordAnchor(epoch, txid));
  }

  /*
   * Token gating. A site asks for a challenge, sends the visitor to their vault, and gets a proof
   * link back. The challenge is bound to the site that asked and works once, and the proof is
   * checked against the newest record locked on Zcash, re-read from mainnet.
   */
  if (m === "POST" && path === "/api/gate/challenge") {
    const { returnUrl } = await body(req);
    let ret: URL;
    try {
      ret = new URL(String(returnUrl));
    } catch {
      throw new HttpError(400, "returnUrl must be the page to come back to");
    }
    if (!/^https?:$/.test(ret.protocol)) throw new HttpError(400, "returnUrl must be http or https");
    const origin = req.headers.origin;
    if (origin && origin !== ret.origin) throw new HttpError(400, "returnUrl must be on the site asking for the challenge");
    const nonce = randomBytes(32).toString("hex");
    store.addGateChallenge(nonce, ret.origin);
    ret.hash = "";
    const base = env.publicUrl || `${req.headers["x-forwarded-proto"] ?? "http"}://${req.headers.host}`;
    return send(res, 200, {
      collection: store.collection(),
      nonce,
      expiresAt: new Date(Date.now() + GATE_TTL).toISOString(),
      proveUrl: `${base}/#prove=${store.collection()}.${nonce}&return=${encodeURIComponent(ret.toString())}`,
    });
  }

  if (m === "POST" && path === "/api/gate/verify") {
    const b = await body(req);
    const origin = req.headers.origin ?? b.origin;
    let p;
    try {
      p = decodeProof(String(b.proof ?? ""));
    } catch {
      throw new HttpError(400, "that is not a Seisin proof");
    }
    const c = store.gateChallenge(p.nonce);
    if (!c) throw new HttpError(403, "this proof answers a challenge Seisin did not issue for a site");
    if (c.origin !== origin) throw new HttpError(403, "this proof was made for a different site");
    if (c.usedAt) throw new HttpError(409, "this proof has already been used");
    if (Date.now() - c.createdAt > GATE_TTL) throw new HttpError(410, "this challenge has expired; ask for a new one");
    const rows = store.epochs();
    const locked = rows.filter((r) => r.anchor).pop();
    const target = locked ?? (env.gateAllowUnlocked ? rows[rows.length - 1] : undefined);
    if (!target) throw new HttpError(409, "no record is locked on Zcash yet");
    let height: number | null = null;
    if (target.anchor) {
      const a = await checkAnchor({ txid: target.anchor.txid, proof: target.anchor.proof }, env.anchorAddress, blockchair(fetch, env.chainApi), zdp);
      if (recordHash(a.record) !== target.hash) throw new HttpError(500, "the lock on Zcash does not match the stored record");
      height = a.height;
    }
    const why = verifyOwnership(p, target.record, p.nonce);
    if (why) throw new HttpError(403, why);
    if (!store.useGateChallenge(p.nonce)) throw new HttpError(409, "this proof has already been used");
    return send(res, 200, {
      ok: true,
      collection: p.collection,
      tokenId: p.tokenId,
      record: target.record.epoch,
      locked: !!target.anchor,
      lockedAtHeight: height,
      lockTxid: target.anchor?.txid ?? null,
    });
  }

  /*
   * Moving existing holders onto Seisin. The operator uploads token -> shielded
   * address; each token gets a one-time claim code, delivered privately in the
   * encrypted memo of a small payment to that address. Only a hash of the code
   * is stored, and the address is never stored at all.
   */
  if (m === "POST" && path === "/api/operator/claims") {
    requireOperator(req);
    const { rows, amountZats } = await body(req);
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 50) throw new HttpError(400, "send 1 to 50 rows of { tokenId, address }");
    const s = store.state();
    const queued = new Set(store.pending().map((p) => p.change.tokenId));
    const seen = new Set<number>();
    for (const r of rows) {
      if (!Number.isInteger(r?.tokenId) || r.tokenId < 0 || r.tokenId >= s.owners.length) throw new HttpError(400, `no such token: ${r?.tokenId}`);
      if (seen.has(r.tokenId)) throw new HttpError(400, `token ${r.tokenId} appears twice`);
      seen.add(r.tokenId);
      if (typeof r.address !== "string" || !/^u1[0-9a-z]{100,}$/.test(r.address)) throw new HttpError(400, `token ${r.tokenId}: the address must be a shielded unified address (u1…)`);
      if (s.owners[r.tokenId] !== issuerKey(r.tokenId).public || queued.has(r.tokenId)) throw new HttpError(409, `token ${r.tokenId} is no longer held by the issuer`);
    }
    const base = env.publicUrl || `${req.headers["x-forwarded-proto"] ?? "http"}://${req.headers.host}`;
    const zats = Number.isInteger(amountZats) && amountZats >= 1000 ? amountZats : 10000;
    const amount = (zats / 1e8).toFixed(8).replace(/0+$/, "");
    const claims = rows.map((r: { tokenId: number; address: string }) => {
      const code = randomBytes(10).toString("hex");
      store.setClaim(r.tokenId, createHash("sha256").update(code).digest("hex"));
      const link = `${base}/#claim=${s.collection}.${r.tokenId}.${code}`;
      const memo = `Seisin: you hold ${s.collection} No. ${r.tokenId}. Claim it into your own private vault: ${link}`;
      return { tokenId: r.tokenId, address: r.address, link, memo };
    });
    const params = claims.flatMap((c: { address: string; memo: string }, i: number) => {
      const k = i === 0 ? "" : `.${i}`;
      return [`address${k}=${c.address}`, `amount${k}=${amount}`, `memo${k}=${b64url(c.memo)}`];
    });
    return send(res, 200, { claims, amount, uri: `zcash:?${params.join("&")}` });
  }

  /*
   * Moving a registry to a new host: replay the public log from genesis, then
   * re-check every anchor against mainnet. Only allowed on an empty registry
   * whose genesis matches, so it can never rewrite history.
   */
  if (m === "POST" && path === "/api/operator/import") {
    requireOperator(req);
    const { genesis: g, batches, anchors } = await body(req);
    if (store.epochs().length !== 1 || store.pending().length) throw new HttpError(409, "import needs an empty registry");
    if (JSON.stringify(g) !== JSON.stringify(store.genesisOwners())) throw new HttpError(409, "genesis does not match this registry's issuer keys");
    if (!Array.isArray(batches) || !batches.every((b: unknown) => Array.isArray(b) && b.every(isChange))) throw new HttpError(400, "batches must be arrays of changes");
    for (const b of batches as Change[][]) {
      for (const c of b) store.submit(c, "imported");
      store.seal();
    }
    const done = [];
    for (const a of (anchors ?? []) as { epoch: number; txid: string }[]) done.push(await recordAnchor(a.epoch, a.txid));
    notifyLocker();
    return send(res, 200, { head: store.epochs().length - 1, anchored: done.map((d) => ({ epoch: d.anchored, height: d.height })) });
  }

  throw new HttpError(404, "not found");
}

// ---- static web app ----

const web = join(root, "web/dist");
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveStatic(res: ServerResponse, path: string) {
  let f = resolve(web, "." + decodeURIComponent(path));
  if (!f.startsWith(web) || !existsSync(f) || statSync(f).isDirectory()) f = join(web, "index.html");
  if (!existsSync(f)) return send(res, 404, { error: "web app is not built; run npm run build" });
  const immutable = f.includes(`${join("web", "dist", "assets")}`);
  res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
  res.end(readFileSync(f));
}

createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  try {
    if (path === "/health") return send(res, 200, { ok: true, commit: env.commit, collection: store.collection(), head: store.epochs().length - 1 });
    if (path === "/SPEC.md") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      return res.end(readFileSync(join(root, "SPEC.md")));
    }
    // Gate calls come from other sites' pages: allow them by origin, and answer the preflight.
    if (path.startsWith("/api/gate/")) {
      if (req.headers.origin) {
        res.setHeader("access-control-allow-origin", req.headers.origin);
        res.setHeader("vary", "origin");
      }
      res.setHeader("access-control-allow-methods", "POST, OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }
    }
    if (path.startsWith("/api/")) return await api(req, res, path);
    serveStatic(res, path);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    send(res, status, { error: (e as Error).message });
  }
}).listen(env.port, () => console.log(`seisin operator on :${env.port} (commit ${env.commit})`));
