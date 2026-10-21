// Blob encryption at rest — AES-256-GCM. Enabled when KREATIX_DATA_KEY is set
// (64-hex key, or any passphrase → scrypt-derived). New blobs are written with
// a "KX1\0" magic header; plaintext blobs (pre-encryption) still read fine, so
// enabling the key is backward compatible.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const MAGIC = Buffer.from("KX1\0");

// Key ring: KREATIX_DATA_KEY may be a comma-separated list ("new,old1,old2").
// The FIRST entry encrypts; every entry is tried on decrypt, so rotating is
// "prepend the new key, restart, let ciphertext re-wrap lazily on next write,
// drop the old key once a rekey sweep has run". GCM's auth tag doubles as the
// wrong-key check — a mismatched key fails authentication, not silent garbage.
const keys: Buffer[] = [];
{
  const raw = process.env.KREATIX_DATA_KEY;
  if (raw) {
    for (const part of raw.split(",")) {
      const k = part.trim();
      if (!k) continue;
      keys.push(/^[0-9a-fA-F]{64}$/.test(k)
        ? Buffer.from(k, "hex")
        : scryptSync(k, "kreatix-blob-key-v1", 32));
    }
  }
}
const key = keys[0] ?? null;

export const encryptionEnabled = () => key !== null;
/** How many keys are on the ring — >1 means a rotation is in flight. */
export const keyRingSize = () => keys.length;

export function encryptBlob(data: Buffer): Buffer {
  if (!key) return data;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), enc]);
}

export function decryptBlob(data: Buffer): Buffer {
  if (!data.subarray(0, 4).equals(MAGIC)) return data; // legacy plaintext
  if (!keys.length) throw new Error("Encrypted blob but KREATIX_DATA_KEY is not set");
  const nonce = data.subarray(4, 16);
  const tag = data.subarray(16, 32);
  for (const k of keys) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", k, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]);
    } catch { /* wrong key on the ring — try the next */ }
  }
  throw new Error("Encrypted blob could not be decrypted with any configured key");
}

// ---- field-level encryption for sensitive DB free-text columns ----
// (comments, AI prompts/ops, activity details). Queryable/structural columns
// stay plaintext — search and listing would break otherwise. Ciphertext is
// marked "enc:v1:<base64 nonce|ciphertext|tag>"; plaintext reads back as-is,
// so enabling the key is backward compatible.
const FIELD_PREFIX = "enc:v1:";

export function encryptField(plain: string | null): string | null {
  if (!key || plain === null) return plain;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const enc = Buffer.concat([nonce, cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return FIELD_PREFIX + enc.toString("base64");
}

export function decryptField(value: string | null): string | null {
  if (value === null || !value.startsWith(FIELD_PREFIX)) return value;
  if (!keys.length) return "[encrypted — key not configured]";
  const raw = Buffer.from(value.slice(FIELD_PREFIX.length), "base64");
  for (const k of keys) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", k, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
    } catch { /* wrong key on the ring — try the next */ }
  }
  return "[encrypted — unknown key version]";
}
