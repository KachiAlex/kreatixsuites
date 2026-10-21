// Automated backups: daily pg_dump of Postgres + tarball of the blob store,
// written under BACKUP_DIR with keep-count retention. pg_dump ships in the
// runtime image (postgresql-client-17); when it's absent (dev machines) the
// run is recorded as an error and the blob tarball still proceeds.
import { spawn } from "node:child_process";
import { randomUUID, createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { basename, join } from "node:path";
import { DATA_DIR, one, q, run } from "./db.js";

export const BACKUP_DIR = process.env.KREATIX_BACKUP_DIR ?? join(DATA_DIR, "backups");
const KEEP = Math.max(2, Number(process.env.KREATIX_BACKUP_KEEP ?? 14));
const DAILY_GAP_MS = 22 * 60 * 60 * 1000; // run again if the last ok backup is >22h old

mkdirSync(BACKUP_DIR, { recursive: true });

export interface BackupRun {
  id: string; kind: "db" | "blobs"; file: string | null;
  bytes: number; status: "running" | "ok" | "error";
  error: string | null; created_at: string;
}

function spawnCollect(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env } });
    let err = "";
    p.stderr?.on("data", (d) => { err += String(d); });
    p.stdout?.resume();
    p.on("error", (e) => resolve({ code: -1, err: (e as NodeJS.ErrnoException).code === "ENOENT" ? `${cmd} not found on PATH` : String(e) }));
    p.on("close", (code) => resolve({ code: code ?? -1, err: err.trim().slice(0, 500) }));
  });
}

/** pg_dump streamed through gzip into BACKUP_DIR — PGPASSWORD via env, never argv. */
async function dumpDatabase(file: string): Promise<{ bytes: number; error?: string }> {
  const url = new URL(process.env.KREATIX_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/kreatix");
  const args = [
    "-h", url.hostname, "-p", url.port || "5432", "-U", decodeURIComponent(url.username),
    "-d", url.pathname.slice(1) || "kreatix",
    "--no-owner", "--clean", "--if-exists", "-Z", "6", "-f", file,
  ];
  // -Z 6 gives gzip-compressed plain SQL without needing a gzip pipe
  const { code, err } = await spawnCollect("pg_dump", args, { PGPASSWORD: decodeURIComponent(url.password) });
  if (code !== 0) { try { unlinkSync(file); } catch { /* partial file may not exist */ } return { bytes: 0, error: err || `pg_dump exited ${code}` }; }
  return { bytes: statSync(file).size };
}

async function tarBlobs(file: string): Promise<{ bytes: number; error?: string }> {
  // --force-local keeps Windows drive-letter paths (C:\…) from being parsed as host:path
  const { code, err } = await spawnCollect("tar", ["--force-local", "-czf", file, "-C", DATA_DIR, "blobs"]);
  if (code !== 0) { try { unlinkSync(file); } catch { /* ignore */ } return { bytes: 0, error: err || `tar exited ${code}` }; }
  return { bytes: statSync(file).size };
}

/** Integrity check — a truncated/corrupt archive is worse than no backup
 *  because it reads as "ok" in listings until restore day. Full decompress
 *  pass (gzip -t / tar -t), which also catches mid-write crashes. */
async function verifyArchive(file: string): Promise<string | null> {
  const isTar = file.endsWith(".tar.gz");
  const { code, err } = await spawnCollect(isTar ? "tar" : "gzip",
    isTar ? ["-tzf", file] : ["-t", file]);
  return code === 0 ? null : (err || "archive failed integrity check");
}

/* ---- optional off-site copy: S3-compatible PUT (R2 / AWS S3 / MinIO) ----
 *  Path-style requests on purpose — R2 and MinIO both accept them, and they
 *  keep the signing code simple. Set KREATIX_BACKUP_S3_* env to enable. */
const S3 = {
  endpoint: process.env.KREATIX_BACKUP_S3_ENDPOINT?.replace(/\/$/, "") ?? "",
  bucket: process.env.KREATIX_BACKUP_S3_BUCKET ?? "",
  region: process.env.KREATIX_BACKUP_S3_REGION ?? "auto",
  key: process.env.KREATIX_BACKUP_S3_ACCESS_KEY ?? "",
  secret: process.env.KREATIX_BACKUP_S3_SECRET_KEY ?? "",
  prefix: (process.env.KREATIX_BACKUP_S3_PREFIX ?? "backups").replace(/^\/|\/$/g, ""),
};
export const s3OffloadEnabled = !!(S3.endpoint && S3.bucket && S3.key && S3.secret);

async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}

async function s3Put(filePath: string, name: string): Promise<string | null> {
  const payloadHash = await sha256File(filePath);
  const objectKey = `${S3.prefix}/${name}`;
  const url = `${S3.endpoint}/${S3.bucket}/${objectKey}`;
  const host = new URL(S3.endpoint).host;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const date = amzDate.slice(0, 8);
  const headers = [
    ["content-length", String(statSync(filePath).size)],
    ["host", host],
    ["x-amz-content-sha256", payloadHash],
    ["x-amz-date", amzDate],
  ] as [string, string][];
  headers.sort(([a], [b]) => a.localeCompare(b));
  const canonicalHeaders = headers.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = headers.map(([k]) => k).join(";");
  const canonical = ["PUT", `/${S3.bucket}/${objectKey}`, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${S3.region}/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonical).digest("hex")}`;
  const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
  const signing = hmac(hmac(hmac(hmac(Buffer.from(`AWS4${S3.secret}`), date), S3.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signing).update(toSign).digest("hex");
  const auth = `AWS4-HMAC-SHA256 Credential=${S3.key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: { authorization: auth, "content-length": headers[0][1], "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate },
      // undici streaming uploads need the explicit body + duplex pair
      body: createReadStream(filePath) as unknown as ReadableStream,
      duplex: "half",
      signal: AbortSignal.timeout(10 * 60_000),
    } as RequestInit & { duplex: string });
    return res.ok ? null : `S3 PUT ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
  } catch (e) {
    return (e as Error).message.slice(0, 200);
  }
}

async function offload(file: string, name: string): Promise<void> {
  const err = await s3Put(file, name);
  if (err) {
    console.warn(`[backup] off-site copy failed for ${name}: ${err}`);
    return;
  }
  await run("UPDATE backup_runs SET offloaded_at = now() WHERE file = $1", [name]);
}

async function record(kind: BackupRun["kind"], file: string | null, bytes: number, status: BackupRun["status"], error?: string) {
  await run(
    `INSERT INTO backup_runs (id, kind, file, bytes, status, error) VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), kind, file, bytes, status, error ?? null],
  );
}

export async function runBackup(): Promise<{ db: BackupRun["status"]; blobs: BackupRun["status"] }> {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

  const dbFile = `db-${stamp}.sql.gz`;
  const dbPath = join(BACKUP_DIR, dbFile);
  const dbRes = await dumpDatabase(dbPath);
  const dbVerify = dbRes.error ? null : await verifyArchive(dbPath);
  const dbErr = dbRes.error ?? dbVerify;
  await record("db", dbErr ? null : dbFile, dbRes.bytes, dbErr ? "error" : "ok",
    dbErr ? (dbVerify ? `integrity: ${dbVerify}` : dbRes.error) : undefined);
  if (!dbErr && s3OffloadEnabled) await offload(dbPath, dbFile).catch((e) => console.warn("[backup] offload error", e));

  const blobFile = `blobs-${stamp}.tar.gz`;
  const blobPath = join(BACKUP_DIR, blobFile);
  const blobRes = await tarBlobs(blobPath);
  const blobVerify = blobRes.error ? null : await verifyArchive(blobPath);
  const blobErr = blobRes.error ?? blobVerify;
  await record("blobs", blobErr ? null : blobFile, blobRes.bytes, blobErr ? "error" : "ok",
    blobErr ? (blobVerify ? `integrity: ${blobVerify}` : blobRes.error) : undefined);
  if (!blobErr && s3OffloadEnabled) await offload(blobPath, blobFile).catch((e) => console.warn("[backup] offload error", e));

  await pruneBackups();
  return { db: dbErr ? "error" : "ok", blobs: blobErr ? "error" : "ok" };
}

export async function pruneBackups(keep = KEEP): Promise<number> {
  const runs = await q<BackupRun>(`SELECT * FROM backup_runs WHERE file IS NOT NULL ORDER BY created_at DESC`);
  const byKind = new Map<string, BackupRun[]>();
  for (const r of runs) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);
  let pruned = 0;
  for (const list of byKind.values()) {
    for (const r of list.slice(keep)) {
      try { unlinkSync(join(BACKUP_DIR, basename(r.file!))); } catch { /* already gone */ }
      await run(`DELETE FROM backup_runs WHERE id = $1`, [r.id]);
      pruned++;
    }
  }
  return pruned;
}

/** Called hourly — runs the backup set if the last ok run is stale. */
export async function maybeRunDailyBackup(): Promise<BackupRun["status"] | null> {
  const last = await one<{ created_at: string }>(
    `SELECT created_at FROM backup_runs WHERE kind = 'db' AND status = 'ok' ORDER BY created_at DESC LIMIT 1`);
  if (last && Date.now() - Date.parse(last.created_at) < DAILY_GAP_MS) return null;
  const res = await runBackup();
  return res.db === "ok" && res.blobs === "ok" ? "ok" : "error";
}

export async function listBackups(): Promise<BackupRun[]> {
  return q<BackupRun>(`SELECT * FROM backup_runs ORDER BY created_at DESC LIMIT 60`);
}

/** Resolve a stored filename for download — strict basename, must exist. */
export function backupPath(name: string): string | null {
  if (!/^[a-z0-9_.-]+\.(sql\.gz|tar\.gz)$/i.test(name)) return null;
  const p = join(BACKUP_DIR, basename(name));
  return existsSync(p) ? p : null;
}

export function backupDirInfo(): { dir: string; files: number; bytes: number } {
  try {
    const files = readdirSync(BACKUP_DIR);
    return { dir: BACKUP_DIR, files: files.length, bytes: files.reduce((n, f) => n + statSync(join(BACKUP_DIR, f)).size, 0) };
  } catch {
    return { dir: BACKUP_DIR, files: 0, bytes: 0 };
  }
}
