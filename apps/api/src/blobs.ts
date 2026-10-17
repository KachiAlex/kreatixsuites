import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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
export async function putBlob(data: Buffer): Promise<{ key: string; size: number }> {
  const key = createHash("sha256").update(data).digest("hex");
  const path = blobPath(key);
  try {
    await access(path);
  } catch {
    await mkdir(dirname(path), { recursive: true });
    // wx — a same-key race writes identical bytes anyway; no clobber
    await writeFile(path, encryptBlob(data), { flag: "wx" }).catch(() => {});
  }
  return { key, size: data.length };
}

export async function getBlob(key: string): Promise<Buffer | null> {
  try {
    return decryptBlob(await readFile(blobPath(key)));
  } catch {
    return null;
  }
}

function blobPath(key: string): string {
  return join(DATA_DIR, "blobs", key.slice(0, 2), key);
}
