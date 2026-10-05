import { decodeMemo } from "./memo.js";
import type { RegistryRecord } from "./registry.js";

/*
 * An anchor is a shielded Zcash mainnet transaction that pays the registry's
 * anchor address a note whose memo is the record. The operator publishes a
 * delivery proof for that note; anyone can check it against the transaction's
 * bytes with no viewing key.
 */

export interface Anchor {
  txid: string;
  proof: string; // zdp:1:…
}

export interface ZdpApi {
  check(txHex: string, proof: string, network: string): string;
  addressHasReceiver(address: string, proof: string): boolean;
}

export interface ChainSource {
  /** Raw transaction bytes and the height it was mined at (null if unmined). */
  tx(txid: string): Promise<{ hex: string; height: number | null }>;
}

export interface CheckedAnchor {
  record: RegistryRecord;
  txid: string;
  height: number;
  pool: string;
  address: string;
  value: number;
}

export async function checkAnchor(a: Anchor, anchorAddress: string, chain: ChainSource, zdp: ZdpApi): Promise<CheckedAnchor> {
  if (!/^[0-9a-f]{64}$/.test(a.txid)) throw new Error("txid must be 32 bytes of hex");
  const { hex, height } = await chain.tx(a.txid);
  let d: { txid: string; pool: string; address: string; value: number; memoText: string | null };
  try {
    d = JSON.parse(zdp.check(hex, a.proof, "mainnet"));
  } catch (e) {
    throw new Error(`delivery proof does not match the transaction: ${(e as Error).message ?? e}`);
  }
  if (d.txid !== a.txid) throw new Error("proof names a different transaction");
  if (!zdp.addressHasReceiver(anchorAddress, a.proof)) throw new Error("note was not paid to the registry's anchor address");
  if (height === null) throw new Error("anchor transaction is not mined yet");
  if (!d.memoText) throw new Error("anchor note has no text memo");
  return { record: decodeMemo(d.memoText), txid: a.txid, height, pool: d.pool, address: anchorAddress, value: d.value };
}

/** Blockchair's public API: raw bytes plus the block it was mined in. */
export function blockchair(fetchFn: typeof fetch = fetch, base = "https://api.blockchair.com/zcash"): ChainSource {
  return {
    async tx(txid) {
      const [raw, dash] = await Promise.all([
        fetchFn(`${base}/raw/transaction/${txid}`).then((r) => r.json()),
        fetchFn(`${base}/dashboards/transaction/${txid}`).then((r) => r.json()),
      ]);
      const hex = raw?.data?.[txid]?.raw_transaction;
      if (typeof hex !== "string") throw new Error("transaction not found on Zcash mainnet");
      const h = dash?.data?.[txid]?.transaction?.block_id;
      return { hex, height: typeof h === "number" && h > 0 ? h : null };
    },
  };
}
