import type { FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { q, one, run, now } from "../db.js";
import { getItem, toDriveItem, logActivity, itemName } from "../items.js";
import {
  requireAuth, permissionFor, hasPermission, hashPassword, verifyPassword,
  type AuthedRequest, type UserRow,
} from "../auth.js";
import { getBlob } from "../blobs.js";
import { getPolicies, dlpHit } from "../policies.js";
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
      const item = await getItem((req.params as { id: string }).id);
      if (!item || !hasPermission(await permissionFor(user.id, item), "viewer")) {
        return reply.code(404).send({ error: "not_found" });
      }
      const rows = await q<{ id: string; user_id: string; permission: string; display_name: string; email: string; initials: string }>(
        `SELECT s.id, s.user_id, s.permission, u.display_name, u.email, u.initials
         FROM shares s JOIN users u ON u.id = s.user_id WHERE s.file_id = $1`,
        [item.id],
      );
      return {
        shares: rows.map((r) => ({
          id: r.id, fileId: item.id, userId: r.user_id, permission: r.permission,
          user: { displayName: r.display_name, email: r.email, initials: r.initials },
        })),
      };
    });

    authed.post("/api/files/:id/shares", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const item = await getItem((req.params as { id: string }).id);
      if (!item || !hasPermission(await permissionFor(user.id, item), "editor")) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const body = shareSchema.parse(req.body);
      const target = await one<UserRow>("SELECT * FROM users WHERE email = $1", [body.email]);
      if (!target) return reply.code(404).send({ error: "not_found", message: "No user with that email" });
      if (target.id === user.id) return reply.code(400).send({ error: "bad_request", message: "Already the owner" });

      await run(
        `INSERT INTO shares (id, file_id, user_id, permission, created_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT(file_id, user_id) DO UPDATE SET permission = excluded.permission`,
        [randomUUID(), item.id, target.id, body.permission, now()],
      );
      void logActivity(user.orgId, user.id, item.id, "share", `${body.email} → ${body.permission}`);
      return { ok: true };
    });

    authed.delete("/api/files/:id/shares/:userId", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const { id, userId } = req.params as { id: string; userId: string };
      const item = await getItem(id);
      if (!item || !hasPermission(await permissionFor(user.id, item), "editor")) {
        return reply.code(403).send({ error: "forbidden" });
      }
      await run("DELETE FROM shares WHERE file_id = $1 AND user_id = $2", [item.id, userId]);
      return { ok: true };
    });

    // ---- share links (KBS-SHARED-008 / KBS-DRIVE-006) ----
    authed.get("/api/files/:id/links", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const item = await getItem((req.params as { id: string }).id);
      if (!item || !hasPermission(await permissionFor(user.id, item), "viewer")) {
        return reply.code(404).send({ error: "not_found" });
      }
      const rows = await q<LinkRow>("SELECT * FROM share_links WHERE file_id = $1", [item.id]);
      return { links: rows.map(linkOut) };
    });

    authed.post("/api/files/:id/links", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const item = await getItem((req.params as { id: string }).id);
      if (!item || !hasPermission(await permissionFor(user.id, item), "editor")) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const body = linkSchema.parse(req.body);
      // DLP: org policy may forbid public links on labeled files
      const policies = await getPolicies(user.orgId);
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
      // DLP: content patterns block share links regardless of label
      if (await dlpHit(item.id, itemName(item), user.orgId)) {
        void logActivity(user.orgId, user.id, item.id, "dlp-blocked-link", itemName(item));
        return reply.code(403).send({
          error: "policy_blocked",
          message: "Org DLP policy blocks share links for content matching a restricted pattern",
        });
      }
      const token = randomBytes(24).toString("base64url");
      const id = randomUUID();
      await run(
        `INSERT INTO share_links (id, file_id, token, permission, expires_at, password_hash, block_download, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, item.id, token, body.permission, body.expiresAt ?? null,
         body.password ? hashPassword(body.password) : null, body.blockDownload, now()],
      );
      void logActivity(user.orgId, user.id, item.id, "share-link", body.permission);
      const row = (await one<LinkRow>("SELECT * FROM share_links WHERE id = $1", [id]))!;
      return { link: linkOut(row), url: `/shared/${token}` };
    });

    authed.delete("/api/files/:id/links/:linkId", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const { id, linkId } = req.params as { id: string; linkId: string };
      const item = await getItem(id);
      if (!item || !hasPermission(await permissionFor(user.id, item), "editor")) {
        return reply.code(403).send({ error: "forbidden" });
      }
      await run("DELETE FROM share_links WHERE id = $1 AND file_id = $2", [linkId, item.id]);
      return { ok: true };
    });
  });

  // ---- public share-link resolution (no auth) ----
  app.get("/api/links/:token", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const row = await resolveLink((req.params as { token: string }).token, req);
    if ("error" in row) return reply.code(row.error === "password" ? 401 : 404).send({ error: row.error });
    const item = (await getItem(row.link.file_id))!;
    return { item: await toDriveItem(item), permission: row.link.permission };
  });

  app.get("/api/links/:token/content", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const row = await resolveLink((req.params as { token: string }).token, req);
    if ("error" in row) return reply.code(row.error === "password" ? 401 : 404).send({ error: row.error });
    const item = (await getItem(row.link.file_id))!;
    const v = await one<{ blob_key: string; number: number }>(
      "SELECT * FROM versions WHERE file_id = $1 ORDER BY number DESC LIMIT 1",
      [item.id],
    );
    const blob = v && getBlob(v.blob_key);
    if (!v || !blob) return reply.code(404).send({ error: "not_found" });
    if (item.mime.startsWith("application/x-kreatix-")) {
      return { version: v.number, content: JSON.parse(blob.toString("utf8")), blockDownload: !!row.link.block_download };
    }
    if (row.link.block_download) return reply.code(403).send({ error: "forbidden", message: "Download disabled" });
    return sendRawBlob(reply, item.mime, blob, itemName(item));
  });
}

interface LinkRow {
  id: string;
  file_id: string;
  token: string;
  permission: "viewer" | "commenter" | "editor";
  expires_at: string | null;
  password_hash: string | null;
  block_download: boolean;
  created_at: string;
}

function linkOut(r: LinkRow) {
  return {
    id: r.id, fileId: r.file_id, token: r.token, permission: r.permission,
    expiresAt: r.expires_at, hasPassword: !!r.password_hash,
    blockDownload: !!r.block_download, createdAt: r.created_at,
  };
}

async function resolveLink(token: string, req: { headers: Record<string, unknown> }) {
  const link = await one<LinkRow>("SELECT * FROM share_links WHERE token = $1", [token]);
  if (!link) return { error: "not_found" as const };
  if (link.expires_at && new Date(link.expires_at) < new Date()) return { error: "expired" as const };
  if (link.password_hash) {
    const pw = (req.headers["x-link-password"] as string) ?? "";
    if (!pw || !verifyPassword(pw, link.password_hash)) return { error: "password" as const };
  }
  return { link };
}
