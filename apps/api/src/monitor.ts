// Hourly health checks + admin alerting. Checks run in-process; failures are
// emailed to org owners (via Brevo when configured) and POSTed to an optional
// ops webhook (KREATIX_ALERT_WEBHOOK). Results are surfaced at /api/admin/health.
import { statfsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, one, q } from "./db.js";
import { metrics } from "./metrics.js";
import { orgAdminRecipients, sendMailSafe, tpl } from "./email.js";
import { backupDirInfo } from "./backup.js";

export interface HealthCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "crit";
  detail?: string;
}

const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const lastAlert = new Map<string, number>(); // check.id → last alert ts (dedupe)

async function checkDb(): Promise<HealthCheck> {
  try {
    const t = Date.now();
    await one(`SELECT 1 AS ok`);
    return { id: "db", label: "Postgres", status: "ok", detail: `${Date.now() - t}ms` };
  } catch (e) {
    return { id: "db", label: "Postgres", status: "crit", detail: String(e instanceof Error ? e.message : e) };
  }
}

function checkDisk(): HealthCheck {
  try {
    const s = statfsSync(DATA_DIR);
    const free = s.bavail * s.bsize;
    const pct = Math.round((s.bavail / s.blocks) * 100);
    const gb = (free / 1e9).toFixed(1);
    if (pct < 5 || free < 2e9) return { id: "disk", label: "Disk space", status: "crit", detail: `${gb} GB free (${pct}%)` };
    if (pct < 15 || free < 10e9) return { id: "disk", label: "Disk space", status: "warn", detail: `${gb} GB free (${pct}%)` };
    return { id: "disk", label: "Disk space", status: "ok", detail: `${gb} GB free` };
  } catch {
    return { id: "disk", label: "Disk space", status: "warn", detail: "statfs unavailable" };
  }
}

function checkBlobsWritable(): HealthCheck {
  try {
    const probe = join(DATA_DIR, "blobs", `.probe-${Date.now()}`);
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    return { id: "blobs", label: "Blob store writable", status: "ok" };
  } catch (e) {
    return { id: "blobs", label: "Blob store writable", status: "crit", detail: String(e instanceof Error ? e.message : e) };
  }
}

async function checkWebhookBacklog(): Promise<HealthCheck> {
  const row = await one<{ n: number }>(
    `SELECT COUNT(*)::int n FROM webhook_deliveries WHERE status = 'pending' AND created_at < now() - interval '1 hour'`);
  const n = row?.n ?? 0;
  return {
    id: "webhooks", label: "Webhook backlog",
    status: n > 50 ? "warn" : "ok",
    detail: n ? `${n} deliveries pending >1h` : undefined,
  };
}

async function checkSweeps(): Promise<HealthCheck> {
  const stale = await q<{ name: string; ok: boolean; last_run: string }>(
    `SELECT name, ok, last_run FROM sweep_state
     WHERE ok = false OR last_run < now() - interval '48 hours'`);
  if (stale.length)
    return { id: "sweeps", label: "Scheduled sweeps", status: "warn",
      detail: stale.map((s) => `${s.name}${s.ok ? " (stale)" : " (failing)"}`).join(", ") };
  return { id: "sweeps", label: "Scheduled sweeps", status: "ok" };
}

function checkBackups(): HealthCheck {
  const d = backupDirInfo();
  return {
    id: "backups", label: "Backup storage",
    status: d.files === 0 ? "warn" : "ok",
    detail: d.files === 0 ? "no backups yet" : `${d.files} files, ${(d.bytes / 1e9).toFixed(2)} GB`,
  };
}

export async function runHealthChecks(): Promise<HealthCheck[]> {
  const checks = await Promise.allSettled([
    checkDb(),
    checkWebhookBacklog(),
    checkSweeps(),
  ]);
  const asyncs = checks.map((c, i) =>
    c.status === "fulfilled" ? c.value
      : { id: `check${i}`, label: "Health check", status: "crit" as const, detail: String(c.reason) });
  return [...asyncs, checkDisk(), checkBlobsWritable(), checkBackups()];
}

/** Hourly sweep — alerts admins when checks degrade (6h dedupe per check). */
export async function monitorSweep(log: { warn: (o: unknown, m: string) => void; info: (o: unknown, m: string) => void }) {
  const checks = await runHealthChecks();
  const bad = checks.filter((c) => c.status !== "ok" && (Date.now() - (lastAlert.get(c.id) ?? 0) > ALERT_COOLDOWN_MS));
  if (!bad.length) return { alerts: 0, checks };

  const lines = bad.map((c) => `[${c.status.toUpperCase()}] ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
  log.warn({ checks: lines }, "health checks degraded");
  for (const c of bad) lastAlert.set(c.id, Date.now());

  // ops webhook (fire-and-forget)
  const hook = process.env.KREATIX_ALERT_WEBHOOK;
  if (hook) {
    fetch(hook, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "kreatix.health", checks: bad, at: new Date().toISOString() }),
    }).catch((e) => log.warn(e, "alert webhook failed"));
  }

  // email org owners/admins when Brevo is configured
  try {
    const orgs = await q<{ org_id: string }>(`SELECT DISTINCT org_id FROM users`);
    const m = tpl.systemAlert(lines);
    for (const { org_id } of orgs) {
      const recips = await orgAdminRecipients(org_id);
      for (const r of recips) sendMailSafe(log, { to: r.email, toName: r.name, subject: m.subject, html: m.html });
    }
  } catch (e) {
    log.warn(e, "health alert email failed");
  }
  return { alerts: bad.length, checks };
}

export async function healthReport() {
  const checks = await runHealthChecks();
  const sweeps = await q<{ name: string; last_run: string; ok: boolean; detail: string | null }>(
    `SELECT * FROM sweep_state ORDER BY name`);
  return {
    status: checks.some((c) => c.status === "crit") ? "crit" : checks.some((c) => c.status === "warn") ? "warn" : "ok",
    checks,
    sweeps: sweeps.map((s) => ({ name: s.name, lastRun: s.last_run, ok: s.ok, detail: s.detail })),
    uptimeSec: Math.floor((Date.now() - metrics.startedAt) / 1000),
    errors5xx: metrics.errors,
  };
}
