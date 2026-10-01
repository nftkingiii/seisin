import init, { check, addressHasReceiver } from "../../vendor/zcash-delivery-proof/zcash_delivery_proof_wasm.js";
import wasmUrl from "../../vendor/zcash-delivery-proof/zcash_delivery_proof_wasm_bg.wasm?url";
import {
  genesis,
  applyEpoch,
  replay,
  recordHash,
  ownerKey,
  type Change,
  type RegistryRecord,
  type RegistryState,
} from "../../src/core/registry.js";
import { checkAnchor, blockchair } from "../../src/core/anchor.js";
import { bytesToHex, hexToBytes } from "../../src/core/bytes.js";

// ---- operator API ----

export interface EpochView {
  epoch: number;
  hash: string;
  record: RegistryRecord;
  memo: string;
  changes: number;
  anchor: { txid: string; proof: string; height: number } | null;
  sealedAt: string;
}

export interface RegistryView {
  collection: string;
  supply: number;
  anchorAddress: string | null;
  anchorUivk: string | null;
  demoIssuance: boolean;
  demoVault: string | null;
  head: number;
  latestAnchored: number | null;
  epochs: EpochView[];
  pending: { tokenId: number; note: string; at: string }[];
}

export interface Log {
  collection: string;
  genesis: string[];
  batches: Change[][];
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error ?? `request failed (${r.status})`);
  return b as T;
}

export const api = {
  registry: () => call<RegistryView>("/api/registry"),
  log: () => call<Log>("/api/log"),
  post: <T,>(path: string, body: unknown, token?: string) =>
    call<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }),
};

/** Registry state at a given epoch, rebuilt from the public log rather than taken from the operator. */
export function stateAt(log: Log, epoch: number): RegistryState {
  let s = genesis(log.collection, log.genesis);
  for (const b of log.batches.slice(0, epoch)) s = applyEpoch(s, b);
  return s;
}

// ---- keyless anchor check in the browser ----

let ready: Promise<unknown> | null = null;
const zdp = () => (ready ??= init({ module_or_path: wasmUrl })).then(() => ({ check, addressHasReceiver }));

export async function checkAnchorInBrowser(view: RegistryView, e: EpochView) {
  if (!e.anchor || !view.anchorAddress) throw new Error("this epoch has no anchor");
  const a = await checkAnchor({ txid: e.anchor.txid, proof: e.anchor.proof }, view.anchorAddress, blockchair(), await zdp());
  if (recordHash(a.record) !== e.hash) throw new Error("the anchored memo is a different record");
  return a;
}

// ---- full audit ----

export type Step = { label: string; ok: boolean; detail: string };

export async function audit(view: RegistryView, log: Log): Promise<Step[]> {
  const steps: Step[] = [];
  let recs: RegistryRecord[] = [];
  try {
    recs = replay(log.collection, log.genesis, log.batches);
    const bad = view.epochs.filter((e, i) => !recs[i] || recordHash(recs[i]) !== e.hash);
    steps.push({
      label: "History replays",
      ok: bad.length === 0 && recs.length === view.epochs.length,
      detail: bad.length ? `epoch ${bad.map((b) => b.epoch).join(", ")} does not match the log` : `${recs.length} record${recs.length === 1 ? "" : "s"} rebuilt from the public log, every signature checked`,
    });
  } catch (e) {
    steps.push({ label: "History replays", ok: false, detail: (e as Error).message });
    return steps;
  }
  const supplies = new Set(recs.map((r) => r.supply));
  steps.push({ label: "Supply is fixed", ok: supplies.size === 1, detail: `${[...supplies].join(", ")} tokens in every record` });

  const anchored = view.epochs.filter((e) => e.anchor).pop();
  if (!anchored) {
    steps.push({ label: "Anchored on Zcash", ok: false, detail: "no record is anchored yet; everything above is the operator's word until one is" });
    return steps;
  }
  try {
    const a = await checkAnchorInBrowser(view, anchored);
    steps.push({
      label: "Anchored on Zcash",
      ok: true,
      detail: `epoch ${anchored.epoch} is in ${a.pool === "ironwood" || a.pool === "orchard" ? "an" : "a"} ${a.pool[0].toUpperCase() + a.pool.slice(1)} note mined at height ${a.height}, checked here with no key${anchored.epoch > 0 ? "; it commits to every earlier record" : ""}`,
    });
  } catch (e) {
    steps.push({ label: "Anchored on Zcash", ok: false, detail: (e as Error).message });
  }
  if (anchored.epoch < view.head)
    steps.push({ label: "Newer records", ok: true, detail: `epochs ${anchored.epoch + 1}–${view.head} are sealed but not anchored yet` });
  return steps;
}

// ---- holder vault (browser only) ----

const SEED = "seisin.seed";
const USED = "seisin.used"; // { "<col>:<tokenId>": highest n handed out }
const BACKED = "seisin.backed";
const DEMO = "seisin.demo";

function read(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function write(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}

export const vault = {
  seed(): Uint8Array | null {
    const h = read(SEED);
    return h && /^[0-9a-f]{64}$/.test(h) ? hexToBytes(h) : null;
  },
  create(): Uint8Array {
    const s = crypto.getRandomValues(new Uint8Array(32));
    write(SEED, bytesToHex(s));
    try {
      localStorage.removeItem(DEMO);
      localStorage.removeItem(BACKED);
    } catch {}
    return s;
  },
  /** Whether this browser is using the deliberately public demo vault. */
  isDemo(): boolean {
    return read(DEMO) === "1";
  },
  useDemo(hex: string) {
    this.restore(hex);
    write(DEMO, "1");
  },
  restore(hex: string) {
    const h = hex.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("a backup is 64 hex characters");
    write(SEED, h);
    write(BACKED, "1"); // restoring from a backup proves the holder has one
    try {
      localStorage.removeItem(DEMO);
    } catch {}
  },
  backup(): string | null {
    return read(SEED);
  },
  forget() {
    try {
      localStorage.removeItem(SEED);
      localStorage.removeItem(USED);
      localStorage.removeItem(BACKED);
      localStorage.removeItem(DEMO);
    } catch {}
  },
  /** Whether the holder has proved they wrote the backup down, by typing part of it back. */
  backedUp(): boolean {
    return read(BACKED) === "1";
  },
  confirmBackup(tail: string): boolean {
    const b = read(SEED);
    const ok = !!b && tail.trim().toLowerCase() === b.slice(-6);
    if (ok) write(BACKED, "1");
    return ok;
  },
  used(col: string, id: number): number {
    const m = JSON.parse(read(USED) ?? "{}");
    return m[`${col}:${id}`] ?? -1;
  },
  /** A never-used one-time key for receiving a token. */
  fresh(col: string, id: number) {
    const m = JSON.parse(read(USED) ?? "{}");
    const n = (m[`${col}:${id}`] ?? -1) + 1;
    m[`${col}:${id}`] = n;
    write(USED, JSON.stringify(m));
    return ownerKey(this.seed()!, col, id, n);
  },
  /** The key this vault holds for a token in a given state, if any. */
  keyFor(s: RegistryState, id: number) {
    const seed = this.seed();
    if (!seed) return null;
    for (let n = 0; n <= Math.max(this.used(s.collection, id), 0) + 8; n++) {
      const k = ownerKey(seed, s.collection, id, n);
      if (k.public === s.owners[id]) return k;
    }
    return null;
  },
};

export const RECV = "seisin-recv";
export const CHAL = "seisin-chal";

export function randomHex32(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

export const short = (h: string, n = 8) => (h.length > n * 2 ? `${h.slice(0, n)}…${h.slice(-4)}` : h);
