// Self-service account routes: GDPR data export and account erasure.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q, one, run, now } from "../db.js";
import { requireAuth, verifyPassword, type AuthedRequest, type UserRow } from "../auth.js";
import { verifyTotp, consumeBackupCode } from "../mfa.js";
import { decryptField } from "../crypto.js";
import { getBlob } from "../blobs.js";
import { zipFiles } from "../zip.js";
import { eraseUser } from "../lifecycle.js";

export function accountRoutes(app: FastifyInstance) {
  /**
   * GET /api/me/export — ZIP of everything the account holds: profile,
   * drive metadata, comments, shares, activity log, plus each owned file's
   * latest content under files/.
   */
  app.get("/api/me/export", { preHandler: requireAuth }, async (req, reply) => {
    const user = (req as AuthedRequest).user;
    const [items, comments, shares, activity] = await Promise.all([
      q("SELECT id, name, kind, mime, size, starred, trashed, label, created_at, updated_at FROM items WHERE owner_id = $1 ORDER BY updated_at DESC", [user.id]),
      q("SELECT c.file_id, c.body, c.anchor, c.resolved, c.created_at FROM comments c WHERE c.author_id = $1", [user.id]),
      q("SELECT s.file_id, s.permission, s.created_at FROM shares s WHERE s.user_id = $1", [user.id]),
      q("SELECT action, detail, created_at FROM activity WHERE actor_id = $1 ORDER BY created_at DESC LIMIT 5000", [user.id]),
    ]);

    const entries: { name: string; data: Buffer }[] = [{ name: "profile.json", data: Buffer.from(JSON.stringify({
      exportedAt: now(), user: { id: user.id, email: user.email, displayName: user.displayName,
        role: user.role, mfaEnabled: user.mfaEnabled },
    }, null, 2)) }];

    entries.push({ name: "metadata.json", data: Buffer.from(JSON.stringify({
      items: (items as Record<string, unknown>[]).map((r) => ({ ...r, name: decryptField(r.name as string) ?? r.name })),
      comments: (comments as Record<string, unknown>[]).map((r) => ({ ...r, body: decryptField(r.body as string) ?? r.body })),
      shares, activity: (activity as Record<string, unknown>[]).map((r) => ({ ...r, detail: decryptField(r.detail as string) ?? r.detail })),
    }, null, 2)) });

    // latest version blob of each owned item → files/<name>
    const heads = await q<{ file_id: string; blob_key: string; name: string; mime: string }>(
      `SELECT DISTINCT ON (v.file_id) v.file_id, v.blob_key, i.name, i.mime
       FROM versions v JOIN items i ON i.id = v.file_id
       WHERE i.owner_id = $1 ORDER BY v.file_id, v.number DESC`, [user.id]);
    const used = new Set<string>();
    for (const h of heads) {
      const blob = await getBlob(h.blob_key);
      if (!blob) continue;
      let name = (decryptField(h.name) ?? h.name).replace(/[\\/:*?"<>|]/g, "_");
      while (used.has(name)) name = `_${name}`;
      used.add(name);
      entries.push({ name: `files/${name}`, data: blob });
    }

    const zip = zipFiles(entries);
    return reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="kreatix-export-${user.id.slice(0, 8)}.zip"`)
      .send(zip);
  });

  /**
   * POST /api/me/delete — permanent account erasure. Requires password and
   * (when MFA is enabled) a valid TOTP/backup code. Personal data is removed
   * and the row is anonymized so shared content keeps a coherent "Deleted
   * user" attribution; org-shared resources transfer to a successor instead
   * of being cascade-wiped. If this is the org's last member the whole org
   * (and its data) is deleted instead.
   */
  app.post("/api/me/delete", { preHandler: requireAuth }, async (req, reply) => {
    const body = z.object({ password: z.string(), code: z.string().optional() }).parse(req.body);
    const row = await one<UserRow>("SELECT * FROM users WHERE id = $1", [(req as AuthedRequest).user.id]);
    if (!row || !verifyPassword(body.password, row.password_hash))
      return reply.code(401).send({ error: "unauthorized", message: "Wrong password" });
    if (row.totp_secret) {
      const secret = decryptField(row.totp_secret) ?? "";
      const ok = body.code && (verifyTotp(secret, body.code) ||
        consumeBackupCode(body.code, row.totp_backups) !== null);
      if (!ok) return reply.code(401).send({ error: "unauthorized", message: "Valid authentication code required" });
      await run("UPDATE users SET totp_backups = $1 WHERE id = $2",
        [consumeBackupCode(body.code!, row.totp_backups) ?? row.totp_backups, row.id]);
    }

    const result = await eraseUser(row.id);
    return { ok: true, mode: result.mode };
  });

  /** POST /api/me/onboarding — persist the getting-started dismissal so the
   *  checklist stays gone across devices and browsers. */
  app.post("/api/me/onboarding", { preHandler: requireAuth }, async (req) => {
    const { dismissed } = z.object({ dismissed: z.boolean() }).parse(req.body);
    await run("UPDATE users SET onboarding_dismissed = $1 WHERE id = $2", [dismissed, (req as AuthedRequest).user.id]);
    return { ok: true };
  });
}
