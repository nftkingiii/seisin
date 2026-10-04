#!/usr/bin/env node
// Stands in for zcash-devtool in tests: same commands and output shapes, no network or keys.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dir = args[args.indexOf("-w") + 1];
const cmd = args[3];
const log = (line) => appendFileSync(join(dir, "calls.log"), line + "\n");
log(cmd);

if (cmd === "init") {
  writeFileSync(join(dir, "keys.toml"), "fake = true\n");
  console.log("Wallet initialized");
} else if (cmd === "list-addresses") {
  console.log("Receiver(orchard): u1fakelockeraddress" + "x".repeat(100));
} else if (cmd === "sync") {
  console.log("synced");
} else if (cmd === "balance") {
  const z = Number(process.env.FAKE_BALANCE ?? 1000000);
  console.log(JSON.stringify({ total: z, sapling_spendable: 0, orchard_spendable: 0, ironwood_spendable: z, transparent_spendable: 0, chain_tip_height: 3510000 }));
} else if (cmd === "pay") {
  const uri = args[args.indexOf("--payment-uri") + 1];
  if (!args.includes("--disable-confirmation")) process.exit(3);
  log("uri " + uri);
  console.log("Creating transaction...\nSending transaction...\n" + "ab".repeat(32));
} else {
  if (!existsSync(dir)) process.exit(2);
  console.error("unknown command " + cmd);
  process.exit(1);
}
