import type { FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { db, now } from "../db.js";
import { getItem, toDriveItem, logActivity } from "../items.js";
import {
  requireAuth, permissionFor, hasPermission, hashPassword, verifyPassword,
  type AuthedRequest, type UserRow,
} from "../auth.js";
import { getBlob } from "../blobs.js";
import { getPolicies } from "../policies.js";
import { sendRawBlob } from "./content.js";

const shareSchema = z.object({
  email: z.string().email(),
  permission: z.enum(["editor", "reviewer", "commenter", "viewer"]),
});

const linkSchema = z.object({
  permission: z.enum(["viewer", "commenter", "editor"]).default("viewer"),
  expiresAt: z.string().datetime().nullable().optional(),
  password: z.string().min(4).nullable().optional(),
  blockDownload: z.boolean().default(false),
});

export function sharingRoutes(app: FastifyInstance) {
  // ---- authenticated share management ----
  app.register(async (authed) => {
    authed.addHook("preHandler", requireAuth);

    authed.get("/api/files/:id/shares", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const item = getItem((req.params as { id: string }).id);
      if (!item || !hasPermission(permissionFor(user.id, item), "viewer")) {
        return reply.code(404).send({ error: "not_found" });
      }
      const rows = db
        .prepare(
          `SELECT s.id, s.user_id, s.permission, u.display_name, u.email, u.initials
           FROM shares s JOIN users u ON u.id = s.user_id WHERE s.file_id = ?`,
        )
        .all(item.id) as { id: string; user_id: string; permission: string; display_name: string; email: string; initials: string }[];
      return {
        shares: rows.map((r) => ({
          id: r.id, fileId: item.id, userId: r.user_id, permission: r.permission,
          user: { displayName: r.display_name, email: r.email, initials: r.initials },
        })),
      };
    });

    authed.post("/api/files/:id/shares", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const item = getItem((req.params as { id: string }).id);
      if (!item || !hasPermission(permissionFor(user.id, item), "editor")) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const body = shareSchema.parse(req.body);
      const target = db.prepare("SELECT * FROM users WHERE email = ?").get(body.email) as UserRow | undefined;
      if (!target) return reply.code(404).send({ error: "not_found", message: "No user with that email" });
      if (target.id === user.id) return reply.code(400).send({ error: "bad_request", message: "Already the owner" });

      db.prepare(
        `INSERT INTO shares (id, file_id, user_id, permission, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT(file_id, user_id) DO UPDATE SET permission = excluded.permission`,
      ).run(randomUUID(), item.id, target.id, body.permission, now());
      logActivity(user.orgId, user.id, item.id, "share", `${body.email} → ${body.permission}`);
      return { ok: true };
    });

    authed.delete("/api/files/:id/shares/:userId", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const { id, userId } = req.params as { id: string; userId: string };
      const item = getItem(id);
      if (!item || !hasPermission(permissionFor(user.id, item), "editor")) {
        return reply.code(403).send({ error: "forbidden" });
      }
      db.prepare("DELETE FROM shares WHERE file_id = ? AND user_id = ?").run(item.id, userId);
      return { ok: true };
    });

    // ---- share links (KBS-SHARED-008 / KBS-DRIVE-006) ----
    authed.get("/api/files/:id/links", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const item = getItem((req.params as { id: string }).id);
      if (!item || !hasPermission(permissionFor(user.id, item), "viewer")) {
        return reply.code(404).send({ error: "not_found" });
      }
      const rows = db.prepare("SELECT * FROM share_links WHERE file_id = ?").all(item.id) as LinkRow[];
      return { links: rows.map(linkOut) };
    });

    authed.post("/api/files/:id/links", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const item = getItem((req.params as { id: string }).id);
      if (!item || !hasPermission(permissionFor(user.id, item), "editor")) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const body = linkSchema.parse(req.body);
      // DLP: org policy may forbid public links on labeled files
      const policies = getPolicies(user.orgId);
      const label = item.label ?? "internal";
      if (
        (policies.blockRestrictedShareLinks && label === "restricted") ||
        (policies.blockPublicLinksForConfidential && (label === "confidential" || label === "restricted"))
      ) {
        return reply.code(403).send({
          error: "policy_blocked",
          message: `Org policy blocks public share links for '${label}' files`,
        });
      }
      const token = randomBytes(24).toString("base64url");
      const id = randomUUID();
      db.prepare(
        `INSERT INTO share_links (id, file_id, token, permission, expires_at, password_hash, block_download, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(id, item.id, token, body.permission, body.expiresAt ?? null,
        body.password ? hashPassword(body.password) : null, body.blockDownload ? 1 : 0, now());
      logActivity(user.orgId, user.id, item.id, "share-link", body.permission);
      const row = db.prepare("SELECT * FROM share_links WHERE id = ?").get(id) as LinkRow;
      return { link: linkOut(row), url: `/shared/${token}` };
    });

    authed.delete("/api/files/:id/links/:linkId", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const { id, linkId } = req.params as { id: string; linkId: string };
      const item = getItem(id);
      if (!item || !hasPermission(permissionFor(user.id, item), "editor")) {
        return reply.code(403).send({ error: "forbidden" });
      }
      db.prepare("DELETE FROM share_links WHERE id = ? AND file_id = ?").run(linkId, item.id);
      return { ok: true };
    });
  });

  // ---- public share-link resolution (no auth) ----
  app.get("/api/links/:token", async (req, reply) => {
    const row = resolveLink((req.params as { token: string }).token, req);
    if ("error" in row) return reply.code(row.error === "password" ? 401 : 404).send({ error: row.error });
    const item = getItem(row.link.file_id)!;
    return { item: toDriveItem(item), permission: row.link.permission };
  });

  app.get("/api/links/:token/content", async (req, reply) => {
    const row = resolveLink((req.params as { token: string }).token, req);
    if ("error" in row) return reply.code(row.error === "password" ? 401 : 404).send({ error: row.error });
    const item = getItem(row.link.file_id)!;
    const v = db
      .prepare("SELECT * FROM versions WHERE file_id = ? ORDER BY number DESC LIMIT 1")
      .get(item.id) as { blob_key: string; number: number } | undefined;
    const blob = v && getBlob(v.blob_key);
    if (!v || !blob) return reply.code(404).send({ error: "not_found" });
    if (item.mime.startsWith("application/x-kreatix-")) {
      return { version: v.number, content: JSON.parse(blob.toString("utf8")), blockDownload: !!row.link.block_download };
    }
    if (row.link.block_download) return reply.code(403).send({ error: "forbidden", message: "Download disabled" });
    return sendRawBlob(reply, item.mime, blob, item.name);
  });
}

interface LinkRow {
  id: string;
  file_id: string;
  token: string;
  permission: "viewer" | "commenter" | "editor";
  expires_at: string | null;
  password_hash: string | null;
  block_download: number;
  created_at: string;
}

function linkOut(r: LinkRow) {
  return {
    id: r.id, fileId: r.file_id, token: r.token, permission: r.permission,
    expiresAt: r.expires_at, hasPassword: !!r.password_hash,
    blockDownload: !!r.block_download, createdAt: r.created_at,
  };
}

function resolveLink(token: string, req: { headers: Record<string, unknown> }) {
  const link = db.prepare("SELECT * FROM share_links WHERE token = ?").get(token) as LinkRow | undefined;
  if (!link) return { error: "not_found" as const };
  if (link.expires_at && new Date(link.expires_at) < new Date()) return { error: "expired" as const };
  if (link.password_hash) {
    const pw = (req.headers["x-link-password"] as string) ?? "";
    if (!pw || !verifyPassword(pw, link.password_hash)) return { error: "password" as const };
  }
  return { link };
}
