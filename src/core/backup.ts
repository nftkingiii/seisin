// Encrypted vault backups: the vault secret sealed with a passphrase, using only the platform's
// WebCrypto (browsers and Node). PBKDF2-SHA256 stretches the passphrase; AES-GCM seals and
// authenticates the secret, so a wrong passphrase and a damaged file are both refused.

const FORMAT = "seisin-vault-backup";
const ITERATIONS = 600_000;

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const utf8 = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(s));

async function keyFrom(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const base = await crypto.subtle.importKey("raw", utf8(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export const MIN_PASSPHRASE = 10;

export async function encryptBackup(seedHex: string, passphrase: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new Error("not a vault secret");
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`use a passphrase of at least ${MIN_PASSPHRASE} characters`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(passphrase, salt, ITERATIONS);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(FORMAT) }, key, utf8(seedHex)));
  return JSON.stringify(
    {
      format: FORMAT,
      v: 1,
      kdf: { name: "PBKDF2-SHA256", iterations: ITERATIONS, salt: b64(salt) },
      cipher: { name: "AES-GCM", iv: b64(iv) },
      data: b64(data),
      created: new Date().toISOString().slice(0, 10),
    },
    null,
    2,
  );
}

export async function decryptBackup(file: string, passphrase: string): Promise<string> {
  let f;
  try {
    f = JSON.parse(file);
  } catch {
    throw new Error("that is not a Seisin backup file");
  }
  if (f?.format !== FORMAT || f.v !== 1 || f.kdf?.name !== "PBKDF2-SHA256" || f.cipher?.name !== "AES-GCM") throw new Error("that is not a Seisin backup file");
  const iterations = Number(f.kdf.iterations);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 10_000_000) throw new Error("that backup file is damaged");
  try {
    const key = await keyFrom(passphrase, unb64(f.kdf.salt), iterations);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(f.cipher.iv), additionalData: utf8(FORMAT) }, key, unb64(f.data));
    const seed = new TextDecoder().decode(plain);
    if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error();
    return seed;
  } catch {
    throw new Error("wrong passphrase, or the file is damaged");
  }
}
