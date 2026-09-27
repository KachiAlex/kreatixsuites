// Admin policy center: org members, DLP/retention policies, audit log.
// All endpoints require owner or admin role.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../db.js";
import { requireAuth, type AuthedRequest, type UserRow } from "../auth.js";
import { getPolicies, setPolicies } from "../policies.js";
import { encryptionEnabled } from "../crypto.js";

const policiesSchema = z.object({
  blockPublicLinksForConfidential: z.boolean().optional(),
  blockRestrictedShareLinks: z.boolean().optional(),
  trashRetentionDays: z.number().int().min(0).max(3650).optional(),
});

const roleSchema = z.object({ role: z.enum(["admin", "member", "guest"]) });

async function requireOrgAdmin(req: FastifyRequest, reply: FastifyReply) {
  const { user } = req as AuthedRequest;
  if (user.role !== "owner" && user.role !== "admin") {
    return reply.code(403).send({ error: "forbidden", message: "Org owner/admin only" });
  }
}

export function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireOrgAdmin);

  /** Org members (role management lives here) */
  app.get("/api/admin/members", async (req) => {
    const { user } = req as AuthedRequest;
    const rows = db
      .prepare("SELECT id, email, display_name, initials, role, created_at FROM users WHERE org_id = ? ORDER BY created_at")
      .all(user.orgId) as UserRow[];
    return {
      members: rows.map((u) => ({
        id: u.id, email: u.email, displayName: u.display_name,
        initials: u.initials, role: u.role, createdAt: u.created_at,
      })),
    };
  });

  /** Change a member's role (cannot change your own, owner role is immutable here) */
  app.patch("/api/admin/members/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const target = db
      .prepare("SELECT * FROM users WHERE id = ? AND org_id = ?")
      .get((req.params as { id: string }).id, user.orgId) as UserRow | undefined;
    if (!target) return reply.code(404).send({ error: "not_found" });
    if (target.id === user.id) {
      return reply.code(400).send({ error: "bad_request", message: "Cannot change your own role" });
    }
    if (target.role === "owner") {
      return reply.code(403).send({ error: "forbidden", message: "Cannot change the owner's role" });
    }
    const { role } = roleSchema.parse(req.body);
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, target.id);
    return { ok: true, role };
  });

  /** Org policies (DLP + retention) */
  app.get("/api/admin/policies", async (req) => {
    const { user } = req as AuthedRequest;
    return { policies: getPolicies(user.orgId), encryptionAtRest: encryptionEnabled() };
  });

  app.put("/api/admin/policies", async (req) => {
    const { user } = req as AuthedRequest;
    const patch = policiesSchema.parse(req.body);
    return { policies: setPolicies(user.orgId, patch) };
  });

  /**
   * Audit log: org-scoped activity, filterable by action prefix, user, file.
   * ?action=share&user=<id>&file=<id>&limit=200 (max 500)
   */
  app.get("/api/admin/audit", async (req) => {
    const { user } = req as AuthedRequest;
    const q = req.query as { action?: string; user?: string; file?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500);
    const rows = db
      .prepare(
        `SELECT a.id, a.action, a.detail, a.created_at,
                u.display_name AS actor_name, u.email AS actor_email,
                i.name AS file_name, a.file_id
         FROM activity a
         LEFT JOIN users u ON u.id = a.actor_id
         LEFT JOIN items i ON i.id = a.file_id
         WHERE a.org_id = :org
           AND (:action IS NULL OR a.action LIKE :action || '%')
           AND (:user IS NULL OR a.actor_id = :user)
           AND (:file IS NULL OR a.file_id = :file)
         ORDER BY a.created_at DESC LIMIT :limit`,
      )
      .all({
        org: user.orgId,
        action: q.action || null,
        user: q.user || null,
        file: q.file || null,
        limit,
      });
    return { entries: rows };
  });
}
