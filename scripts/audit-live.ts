// Audits a live Seisin registry from the command line, the same way the browser does:
// replay the public log, check every signature and the fixed supply, then check each record's
// lock note on Zcash mainnet against the raw transaction with no key.
//   node --import tsx scripts/audit-live.ts [https://seisin.up.railway.app]
import { readFileSync } from "node:fs";
import { initSync, check, addressHasReceiver } from "../vendor/zcash-delivery-proof/zcash_delivery_proof_wasm.js";
import { replay, recordHash } from "../src/core/registry.js";
import { checkAnchor, blockchair } from "../src/core/anchor.js";

initSync({ module: readFileSync(new URL("../vendor/zcash-delivery-proof/zcash_delivery_proof_wasm_bg.wasm", import.meta.url)) });
const base = (process.argv[2] ?? "https://seisin.up.railway.app").replace(/\/$/, "");
const get = (p: string) => fetch(base + p).then((r) => r.json());
const [view, log] = await Promise.all([get("/api/registry"), get("/api/log")]);

const recs = replay(log.collection, log.genesis, log.batches);
const same = recs.length === view.epochs.length && view.epochs.every((e: { hash: string }, i: number) => recordHash(recs[i]) === e.hash);
console.log(`history: ${recs.length} records rebuilt from the public log, signatures checked, ${same ? "all match" : "MISMATCH"}`);
console.log(`supply: ${[...new Set(recs.map((r) => r.supply))].join(", ")} tokens in every record`);

for (const e of view.epochs) {
  if (!e.anchor) { console.log(`record ${e.epoch}: not locked yet`); continue; }
  const a = await checkAnchor({ txid: e.anchor.txid, proof: e.anchor.proof }, view.anchorAddress, blockchair(), { check, addressHasReceiver });
  const ok = recordHash(a.record) === e.hash;
  console.log(`record ${e.epoch}: ${ok ? "locked" : "MEMO IS A DIFFERENT RECORD"}, ${a.pool} note mined at height ${a.height}, tx ${e.anchor.txid}`);
}
