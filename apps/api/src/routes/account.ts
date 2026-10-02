// Self-service account routes: GDPR data export and account erasure.
import type { FastifyInstance } from "fastify";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { q, one, run, tx, now, DATA_DIR } from "../db.js";
import { requireAuth, verifyPassword, type AuthedRequest, type UserRow } from "../auth.js";
import { verifyTotp, consumeBackupCode } from "../mfa.js";
import { decryptField } from "../crypto.js";
import { getBlob } from "../blobs.js";
import { itemName } from "../items.js";
import { zipFiles } from "../zip.js";

const blobFile = (key: string) => join(DATA_DIR, "blobs", key.slice(0, 2), key);

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
      const blob = getBlob(h.blob_key);
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
   * (when MFA is enabled) a valid TOTP/backup code. Deletes owned items
   * (cascading versions/comments/shares/collab state), unlinks orphaned
   * blobs, removes authored content, and drops the user row — existing JWTs
   * die with it since requireAuth re-reads the user each request.
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

    const blobKeys = (await q<{ blob_key: string }>(
      "SELECT v.blob_key FROM versions v JOIN items i ON i.id = v.file_id WHERE i.owner_id = $1",
      [row.id])).map((r) => r.blob_key);

    const orgId = row.org_id;
    await tx(async (c) => {
      await c.query("DELETE FROM activity WHERE actor_id = $1", [row.id]);
      await c.query("DELETE FROM mentions WHERE from_user_id = $1", [row.id]);
      await c.query("DELETE FROM comments WHERE author_id = $1", [row.id]);
      await c.query("DELETE FROM ai_actions WHERE user_id = $1", [row.id]);
      await c.query("DELETE FROM shares WHERE user_id = $1", [row.id]);
      await c.query("DELETE FROM org_invites WHERE created_by = $1", [row.id]);
      await c.query("DELETE FROM versions WHERE created_by = $1 AND file_id NOT IN (SELECT id FROM items WHERE owner_id = $1)", [row.id]);
      await c.query("DELETE FROM items WHERE owner_id = $1", [row.id]);
      await c.query("DELETE FROM users WHERE id = $1", [row.id]);
      // empty org → remove it (policies/subscriptions cascade or go too)
      await c.query("DELETE FROM orgs WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM users WHERE org_id = $1)", [orgId]);
    });

    // drop blob files no other version still references (content-addressed
    // dedup means another item may share a key)
    for (const k of blobKeys) {
      const still = await one("SELECT 1 FROM versions WHERE blob_key = $1 LIMIT 1", [k]);
      if (!still) try { unlinkSync(blobFile(k)); } catch { /* already gone */ }
    }
    return { ok: true };
  });
}
