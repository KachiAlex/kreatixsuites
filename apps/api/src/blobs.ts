import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./db.js";

/**
 * Content-addressed filesystem object store (SRS §19: canonical file objects
 * in object storage, immutable versions referenced by content hash).
 * Swap for S3/MinIO in production by keeping this interface.
 */
export function putBlob(data: Buffer): { key: string; size: number } {
  const key = createHash("sha256").update(data).digest("hex");
  const path = blobPath(key);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }
  return { key, size: data.length };
}

export function getBlob(key: string): Buffer | null {
  const path = blobPath(key);
  return existsSync(path) ? readFileSync(path) : null;
}

function blobPath(key: string): string {
  return join(DATA_DIR, "blobs", key.slice(0, 2), key);
}
