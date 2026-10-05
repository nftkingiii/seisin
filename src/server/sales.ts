/*
 * Paid first sales. A buyer pays the collection's sales address with their one-time receive key in
 * the encrypted memo: `SEISIN-BUY <collection> <tokenId> <key>`. Only the operator holds the sales
 * viewing key, so only the operator can read which key a payment was for; the public log shows the
 * issuance with a ref that commits to the payment's delivery proof.
 */
import { createHash } from "node:crypto";

export interface SalesZdp {
  make(txHex: string, viewingKey: string): string;
  check(txHex: string, proof: string, network: string): string;
}

export interface Purchase {
  tokenId: number;
  to: string;
  value: number;
  proof: string;
  ref: string; // sha256 of the delivery proof: lets the operator show which payment paid for it
}

export const buyMemo = (collection: string, tokenId: number, key: string) => `SEISIN-BUY ${collection} ${tokenId} ${key}`;

/** Finds the purchase a transaction makes, or says why it is not one. */
export function readPurchase(txHex: string, salesUivk: string, collection: string, price: number, zdp: SalesZdp): Purchase {
  const notes = JSON.parse(zdp.make(txHex, salesUivk)) as { proof: string; side?: string }[];
  if (notes.length === 0) throw new Error("that transaction pays nothing to this collection's sales address");
  const reasons: string[] = [];
  for (const n of notes) {
    if (n.side && n.side !== "received") continue;
    const d = JSON.parse(zdp.check(txHex, n.proof, "mainnet")) as { value: number; memoText: string | null };
    const m = (d.memoText ?? "").trim().match(/^SEISIN-BUY ([a-z0-9-]+) (\d+) ([0-9a-f]{64})$/);
    if (!m) {
      reasons.push("its memo is not a Seisin purchase");
      continue;
    }
    if (m[1] !== collection) {
      reasons.push(`it buys from ${m[1]}, not ${collection}`);
      continue;
    }
    if (d.value < price) {
      reasons.push(`it pays ${d.value} zatoshi; the price is ${price}`);
      continue;
    }
    return { tokenId: Number(m[2]), to: m[3], value: d.value, proof: n.proof, ref: createHash("sha256").update(n.proof).digest("hex") };
  }
  throw new Error(`no purchase found in that transaction: ${[...new Set(reasons)].join("; ")}`);
}
