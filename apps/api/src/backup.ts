// Automated backups: daily pg_dump of Postgres + tarball of the blob store,
// written under BACKUP_DIR with keep-count retention. pg_dump ships in the
// runtime image (postgresql-client-17); when it's absent (dev machines) the
// run is recorded as an error and the blob tarball still proceeds.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
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

async function record(kind: BackupRun["kind"], file: string | null, bytes: number, status: BackupRun["status"], error?: string) {
  await run(
    `INSERT INTO backup_runs (id, kind, file, bytes, status, error) VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), kind, file, bytes, status, error ?? null],
  );
}

export async function runBackup(): Promise<{ db: BackupRun["status"]; blobs: BackupRun["status"] }> {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

  const dbFile = `db-${stamp}.sql.gz`;
  const dbRes = await dumpDatabase(join(BACKUP_DIR, dbFile));
  await record("db", dbRes.error ? null : dbFile, dbRes.bytes, dbRes.error ? "error" : "ok", dbRes.error);

  const blobFile = `blobs-${stamp}.tar.gz`;
  const blobRes = await tarBlobs(join(BACKUP_DIR, blobFile));
  await record("blobs", blobRes.error ? null : blobFile, blobRes.bytes, blobRes.error ? "error" : "ok", blobRes.error);

  await pruneBackups();
  return { db: dbRes.error ? "error" : "ok", blobs: blobRes.error ? "error" : "ok" };
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
