import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./db.js";
import { decryptBlob, encryptBlob } from "./crypto.js";

/**
 * Content-addressed filesystem object store (SRS §19: canonical file objects
 * in object storage, immutable versions referenced by content hash).
 * Keys are the SHA-256 of the *plaintext* — stored bytes are AES-256-GCM
 * encrypted when KREATIX_DATA_KEY is set (see crypto.ts).
 * Swap for S3/MinIO in production by keeping this interface.
 */
export function putBlob(data: Buffer): { key: string; size: number } {
  const key = createHash("sha256").update(data).digest("hex");
  const path = blobPath(key);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, encryptBlob(data));
  }
  return { key, size: data.length };
}

export function getBlob(key: string): Buffer | null {
  const path = blobPath(key);
  return existsSync(path) ? decryptBlob(readFileSync(path)) : null;
}

function blobPath(key: string): string {
  return join(DATA_DIR, "blobs", key.slice(0, 2), key);
}
