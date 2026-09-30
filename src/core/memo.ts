import { COLLECTION_RE, type RegistryRecord } from "./registry.js";

/*
 * The anchor memo: one line that fits well inside Zcash's 512-byte memo.
 *   SEISIN/1 <collection> <epoch> <supply> <prev> <root> <changes>
 */

export function encodeMemo(r: RegistryRecord): string {
  return `SEISIN/1 ${r.collection} ${r.epoch} ${r.supply} ${r.prev} ${r.root} ${r.changes}`;
}

export function decodeMemo(text: string): RegistryRecord {
  const m = text.trim().match(/^SEISIN\/1 (\S+) (\d{1,10}) (\d{1,10}) ([0-9a-f]{64}) ([0-9a-f]{64}) ([0-9a-f]{64})$/);
  if (!m || !COLLECTION_RE.test(m[1])) throw new Error("not a Seisin anchor memo");
  return { v: 1, collection: m[1], epoch: Number(m[2]), supply: Number(m[3]), prev: m[4], root: m[5], changes: m[6] };
}
