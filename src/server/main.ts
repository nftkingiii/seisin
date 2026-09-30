import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initSync, check, make, addressHasReceiver } from "../../vendor/zcash-delivery-proof/zcash_delivery_proof_wasm.js";
import { Store } from "./store.js";
import { ownerKey, signTransfer, recordHash, type Change } from "../core/registry.js";
import { encodeMemo } from "../core/memo.js";
import { checkAnchor, blockchair } from "../core/anchor.js";
import { hexToBytes } from "../core/bytes.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
initSync({ module: readFileSync(join(root, "vendor/zcash-delivery-proof/zcash_delivery_proof_wasm_bg.wasm")) });
const zdp = { check, addressHasReceiver };

const env = {
  port: Number(process.env.PORT ?? 8787),
  data: process.env.DATA_PATH ?? join(root, "data/seisin.db"),
  collection: process.env.COLLECTION ?? "deeds",
  supply: Number(process.env.SUPPLY ?? 32),
  operatorToken: process.env.OPERATOR_TOKEN ?? "",
  anchorAddress: process.env.ANCHOR_ADDRESS ?? "",
  anchorUivk: process.env.ANCHOR_UIVK ?? "",
  anchorZats: Number(process.env.ANCHOR_ZATS ?? 10000),
  demoIssuance: process.env.DEMO_ISSUANCE !== "off",
  commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.COMMIT ?? "local",
};

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

const store = new Store(env.data);
if (!store.initialized()) {
  store.init(env.collection, Array.from({ length: env.supply }, (_, i) => issuerKey(i).public));
  console.log(`created registry "${env.collection}" with supply ${env.supply}`);
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

// ---- routes ----

async function api(req: IncomingMessage, res: ServerResponse, path: string) {
  const m = req.method ?? "GET";

  if (m === "GET" && path === "/api/registry") return send(res, 200, registryView());

  if (m === "GET" && path === "/api/log")
    return send(res, 200, { collection: store.collection(), genesis: store.genesisOwners(), batches: store.epochs().slice(1).map((r) => r.changes) });

  if (m === "GET" && path === "/api/owners") {
    const s = store.state();
    return send(res, 200, { epoch: s.epoch, owners: s.owners, issuerHeld: s.owners.map((o, i) => o === issuerKey(i).public) });
  }

  if (m === "POST" && path === "/api/transfers") {
    const { change } = await body(req);
    if (!isChange(change)) throw new HttpError(400, "malformed change");
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

  const req_ = path.match(/^\/api\/anchor-request\/(\d+)$/);
  if (m === "GET" && req_) return send(res, 200, anchorRequest(Number(req_[1])));

  if (m === "POST" && path === "/api/operator/seal") {
    requireOperator(req);
    const row = store.seal();
    return send(res, 200, { sealed: row.record.epoch, request: anchorRequest(row.record.epoch) });
  }

  if (m === "POST" && path === "/api/operator/anchor") {
    requireOperator(req);
    if (!env.anchorAddress || !env.anchorUivk) throw new HttpError(409, "ANCHOR_ADDRESS and ANCHOR_UIVK are not configured");
    const { epoch, txid } = await body(req);
    const row = store.epochs()[epoch];
    if (!row) throw new HttpError(404, "no such epoch");
    if (typeof txid !== "string" || !/^[0-9a-f]{64}$/.test(txid)) throw new HttpError(400, "txid must be 32 bytes of hex");
    const chain = blockchair();
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
        store.setAnchor(epoch, { txid, proof: f.proof, height: a.height });
        return send(res, 200, { anchored: epoch, txid, height: a.height, proof: f.proof });
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    throw new HttpError(422, found.length ? `no matching anchor note: ${errors.join("; ")}` : "the anchor key sees no note in that transaction");
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
    if (path.startsWith("/api/")) return await api(req, res, path);
    serveStatic(res, path);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    send(res, status, { error: (e as Error).message });
  }
}).listen(env.port, () => console.log(`seisin operator on :${env.port} (commit ${env.commit})`));
