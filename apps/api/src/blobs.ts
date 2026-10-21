import { createHash, createHmac } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./db.js";
import { decryptBlob, encryptBlob } from "./crypto.js";

/**
 * Content-addressed object store (SRS §19: canonical file objects, immutable
 * versions referenced by content hash). Keys are the SHA-256 of the
 * *plaintext* — stored bytes are AES-256-GCM encrypted when KREATIX_DATA_KEY
 * is set (crypto.ts), so the object store only ever sees ciphertext.
 *
 * Backends:
 *  - local disk under DATA_DIR/blobs (default; also the hot read cache)
 *  - optional S3-compatible mirror (S3 / Cloudflare R2 / MinIO) via
 *    KREATIX_BLOB_S3_* env — puts write through to both, gets read local
 *    first then fall back to S3 and rehydrate the cache. That makes cutover
 *    non-disruptive: pre-migration objects keep serving from disk, new ones
 *    are durable off-node, and a lost local disk rehydrates on demand.
 */

/* ---- optional S3 mirror — path-style requests like backup.ts's offload ---- */
const S3 = {
  endpoint: process.env.KREATIX_BLOB_S3_ENDPOINT?.replace(/\/$/, "") ?? "",
  bucket: process.env.KREATIX_BLOB_S3_BUCKET ?? "",
  region: process.env.KREATIX_BLOB_S3_REGION ?? "auto",
  key: process.env.KREATIX_BLOB_S3_ACCESS_KEY ?? "",
  secret: process.env.KREATIX_BLOB_S3_SECRET_KEY ?? "",
  prefix: (process.env.KREATIX_BLOB_S3_PREFIX ?? "blobs").replace(/^\/|\/$/g, ""),
};
export const blobS3Enabled = !!(S3.endpoint && S3.bucket && S3.key && S3.secret);

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** SigV4-signed request against the configured bucket. Returns the Response
 *  (caller reads body/ok) or null on network failure. */
async function s3Req(method: "PUT" | "GET" | "HEAD", objectKey: string, payload?: Buffer): Promise<Response | null> {
  const payloadHash = payload ? createHash("sha256").update(payload).digest("hex") : EMPTY_SHA256;
  const url = `${S3.endpoint}/${S3.bucket}/${objectKey}`;
  const host = new URL(S3.endpoint).host;
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const date = amzDate.slice(0, 8);
  const headers: [string, string][] = [
    ["host", host],
    ["x-amz-content-sha256", payloadHash],
    ["x-amz-date", amzDate],
  ];
  if (payload) headers.push(["content-length", String(payload.length)]);
  headers.sort(([a], [b]) => a.localeCompare(b));
  const canonicalHeaders = headers.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = headers.map(([k]) => k).join(";");
  const canonical = [method, `/${S3.bucket}/${objectKey}`, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${S3.region}/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonical).digest("hex")}`;
  const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
  const signing = hmac(hmac(hmac(hmac(Buffer.from(`AWS4${S3.secret}`), date), S3.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signing).update(toSign).digest("hex");
  const auth = `AWS4-HMAC-SHA256 Credential=${S3.key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  try {
    return await fetch(url, {
      method,
      headers: { authorization: auth, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate,
        ...(payload ? { "content-length": String(payload.length) } : {}) },
      body: payload ?? null,
      signal: AbortSignal.timeout(method === "GET" ? 60_000 : 120_000),
    });
  } catch {
    return null;
  }
}

const s3Key = (key: string) => `${S3.prefix}/${key.slice(0, 2)}/${key}`;
let s3Warned = false;
const s3Warn = (what: string) => {
  if (s3Warned) return;
  s3Warned = true;
  console.warn(`[blobs] S3 mirror degraded (${what}) — local disk continues to serve`);
};

export async function putBlob(data: Buffer): Promise<{ key: string; size: number }> {
  const key = createHash("sha256").update(data).digest("hex");
  const path = blobPath(key);
  const enc = encryptBlob(data);
  let had = true;
  try {
    await access(path);
  } catch {
    had = false;
    await mkdir(dirname(path), { recursive: true });
    // wx — a same-key race writes identical bytes anyway; no clobber
    await writeFile(path, enc, { flag: "wx" }).catch(() => {});
  }
  if (blobS3Enabled && !had) {
    // awaited so a "stored" acknowledgement means the object is off-node;
    // failure degrades to local-only (syncBlobsToS3 reconciles later)
    const res = await s3Req("PUT", s3Key(key), enc);
    if (!res) s3Warn("network");
    else if (!res.ok) s3Warn(`PUT ${res.status}`);
  }
  return { key, size: data.length };
}

export async function getBlob(key: string): Promise<Buffer | null> {
  try {
    return decryptBlob(await readFile(blobPath(key)));
  } catch { /* miss — try the mirror */ }
  if (!blobS3Enabled) return null;
  const res = await s3Req("GET", s3Key(key));
  if (!res || !res.ok) return null;
  const enc = Buffer.from(await res.arrayBuffer());
  // rehydrate the local cache so the next read is a disk hit
  try {
    await mkdir(dirname(blobPath(key)), { recursive: true });
    await writeFile(blobPath(key), enc, { flag: "wx" });
  } catch { /* cache write is best-effort */ }
  return decryptBlob(enc);
}

function blobPath(key: string): string {
  return join(DATA_DIR, "blobs", key.slice(0, 2), key);
}

/**
 * Backfill: walk the local store and PUT every object the bucket is missing
 * (HEAD → PUT-on-404). Idempotent, resumable, meant to run before cutting a
 * second node over to the S3 mirror. Called under a sweep advisory lock.
 */
export async function syncBlobsToS3(log: (msg: string) => void = console.log): Promise<{ checked: number; uploaded: number; errors: number } | null> {
  if (!blobS3Enabled) return null;
  const root = join(DATA_DIR, "blobs");
  let checked = 0, uploaded = 0, errors = 0;
  let dirs: string[];
  try { dirs = await readdir(root); } catch { return { checked: 0, uploaded: 0, errors: 0 }; }
  for (const d of dirs) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue;
    let files: string[];
    try { files = await readdir(join(root, d)); } catch { continue; }
    for (const f of files) {
      if (!/^[0-9a-f]{64}$/.test(f)) continue;
      checked++;
      const head = await s3Req("HEAD", s3Key(f));
      if (head?.ok) continue;
      if (head === null) { errors++; continue; } // network — count, don't upload blind
      try {
        const enc = await readFile(join(root, d, f));
        const put = await s3Req("PUT", s3Key(f), enc);
        if (put?.ok) uploaded++; else errors++;
      } catch { errors++; }
      if (checked % 500 === 0) log(`[blobs] s3 sync: ${checked} checked, ${uploaded} uploaded, ${errors} errors`);
    }
  }
  log(`[blobs] s3 sync done: ${checked} checked, ${uploaded} uploaded, ${errors} errors`);
  return { checked, uploaded, errors };
}
