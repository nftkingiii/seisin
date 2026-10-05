import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptBackup, decryptBackup } from "../src/core/backup.js";

test("an encrypted backup restores with its passphrase and nothing else", async () => {
  const seed = randomBytes(32).toString("hex");
  const file = await encryptBackup(seed, "correct horse battery");
  assert.ok(!file.includes(seed), "the secret is in the file in the clear");
  assert.equal(await decryptBackup(file, "correct horse battery"), seed);
  await assert.rejects(decryptBackup(file, "correct horse batterY"), /wrong passphrase/);

  const f = JSON.parse(file);
  const bytes = Buffer.from(f.data, "base64");
  bytes[0] ^= 1;
  await assert.rejects(decryptBackup(JSON.stringify({ ...f, data: bytes.toString("base64") }), "correct horse battery"), /damaged/);
  await assert.rejects(decryptBackup('{"hello":1}', "correct horse battery"), /not a Seisin backup/);
  await assert.rejects(encryptBackup(seed, "short"), /at least 10/);
});
