// Blob encryption at rest — AES-256-GCM. Enabled when KREATIX_DATA_KEY is set
// (64-hex key, or any passphrase → scrypt-derived). New blobs are written with
// a "KX1\0" magic header; plaintext blobs (pre-encryption) still read fine, so
// enabling the key is backward compatible.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const MAGIC = Buffer.from("KX1\0");

let key: Buffer | null = null;
{
  const raw = process.env.KREATIX_DATA_KEY;
  if (raw) {
    key = /^[0-9a-fA-F]{64}$/.test(raw.trim())
      ? Buffer.from(raw.trim(), "hex")
      : scryptSync(raw, "kreatix-blob-key-v1", 32);
  }
}

export const encryptionEnabled = () => key !== null;

export function encryptBlob(data: Buffer): Buffer {
  if (!key) return data;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), enc]);
}

export function decryptBlob(data: Buffer): Buffer {
  if (!data.subarray(0, 4).equals(MAGIC)) return data; // legacy plaintext
  if (!key) throw new Error("Encrypted blob but KREATIX_DATA_KEY is not set");
  const nonce = data.subarray(4, 16);
  const tag = data.subarray(16, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]);
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
  if (!key) return "[encrypted — key not configured]";
  const raw = Buffer.from(value.slice(FIELD_PREFIX.length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
}
