// Admin policy center: org members, DLP/retention policies, audit log.
// All endpoints require owner or admin role.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { q as dbq, one, run, now } from "../db.js";
import { requireAuth, type AuthedRequest, type UserRow } from "../auth.js";
import { getPolicies, setPolicies } from "../policies.js";
import { encryptionEnabled, decryptField } from "../crypto.js";
import { metrics } from "../metrics.js";
import { activeCollabRooms, collabPeers } from "../collab.js";
import { ssoEnabled } from "./sso.js";
import { samlEnabled } from "./saml.js";
import { sendMailSafe, tpl } from "../email.js";
import { ensureSubscription, effectivePlan, planLimit, seatCount } from "../billing.js";

const policiesSchema = z.object({
  aiDisabled: z.boolean().optional(),
  blockPublicLinksForConfidential: z.boolean().optional(),
  blockRestrictedShareLinks: z.boolean().optional(),
  trashRetentionDays: z.number().int().min(0).max(3650).optional(),
  dlpPatterns: z.array(z.string().min(1).max(300)).max(10).optional(),
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
    const rows = await dbq<UserRow>(
      "SELECT id, email, display_name, initials, role, disabled, created_at FROM users WHERE org_id = $1 ORDER BY created_at",
      [user.orgId],
    );
    return {
      members: rows.map((u) => ({
        id: u.id, email: u.email, displayName: u.display_name,
        initials: u.initials, role: u.role, disabled: u.disabled, createdAt: u.created_at,
      })),
    };
  });

  /** Change a member's role (cannot change your own, owner role is immutable here) */
  app.patch("/api/admin/members/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const target = await one<UserRow>(
      "SELECT * FROM users WHERE id = $1 AND org_id = $2",
      [(req.params as { id: string }).id, user.orgId],
    );
    if (!target) return reply.code(404).send({ error: "not_found" });
    if (target.id === user.id) {
      return reply.code(400).send({ error: "bad_request", message: "Cannot change your own role" });
    }
    if (target.role === "owner") {
      return reply.code(403).send({ error: "forbidden", message: "Cannot change the owner's role" });
    }
    const { role } = roleSchema.parse(req.body);
    await run("UPDATE users SET role = $1 WHERE id = $2", [role, target.id]);
    return { ok: true, role };
  });

  /** Disable/enable a member — disabled users can't sign in and drop out of the
   *  billable seat count; their files stay intact (FK-safe deactivation). */
  app.post("/api/admin/members/:id/disabled", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const target = await one<UserRow>(
      "SELECT * FROM users WHERE id = $1 AND org_id = $2",
      [(req.params as { id: string }).id, user.orgId],
    );
    if (!target) return reply.code(404).send({ error: "not_found" });
    if (target.id === user.id) return reply.code(400).send({ error: "bad_request", message: "Cannot disable yourself" });
    if (target.role === "owner") return reply.code(403).send({ error: "forbidden", message: "Cannot disable the owner" });
    const { disabled } = z.object({ disabled: z.boolean() }).parse(req.body);
    await run("UPDATE users SET disabled = $1 WHERE id = $2", [disabled, target.id]);
    return { ok: true, disabled };
  });

  /** Invite links — anyone with the link joins this workspace as a member. */
  app.get("/api/admin/invites", async (req) => {
    const { user } = req as AuthedRequest;
    const rows = await dbq(
      `SELECT i.id, i.token, i.max_uses, i.uses, i.expires_at, i.created_at, u.display_name AS created_by_name
       FROM org_invites i JOIN users u ON u.id = i.created_by
       WHERE i.org_id = $1 AND (i.expires_at IS NULL OR i.expires_at > $2) AND i.uses < i.max_uses
       ORDER BY i.created_at DESC`, [user.orgId, now()]);
    return { invites: rows };
  });

  app.post("/api/admin/invites", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const body = z.object({
      maxUses: z.number().int().min(1).max(500).default(25),
      expiresDays: z.number().int().min(1).max(90).default(14),
      email: z.string().email().optional(),      // also mail the link to this address
    }).parse(req.body ?? {});
    // plan seat cap — clamp uses to the seats left (0 = unlimited plan)
    const maxMembers = planLimit(await effectivePlan(await ensureSubscription(user.orgId)), "max_members", 0);
    const seatsLeft = maxMembers > 0 ? Math.max(0, maxMembers - await seatCount(user.orgId)) : null;
    if (seatsLeft === 0) {
      return reply.code(402).send({
        error: "seat_limit",
        message: "This workspace is at its plan's member limit — upgrade to add more people",
      });
    }
    const maxUses = seatsLeft === null ? body.maxUses : Math.min(body.maxUses, seatsLeft);
    const id = randomUUID();
    const token = randomBytes(18).toString("base64url");
    const expires = new Date(Date.now() + body.expiresDays * 86400000).toISOString();
    await run(
      "INSERT INTO org_invites (id, org_id, token, created_by, max_uses, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, user.orgId, token, user.id, maxUses, expires, now()],
    );
    if (body.email) {
      const org = await one<{ name: string }>("SELECT name FROM orgs WHERE id = $1", [user.orgId]);
      sendMailSafe(app.log, {
        to: body.email,
        ...tpl.invite(org?.name ?? "a workspace", user.displayName, token),
      });
    }
    return { id, token, expiresAt: expires, emailed: !!body.email, maxUses, seatsLeft };
  });

  app.delete("/api/admin/invites/:id", async (req) => {
    const { user } = req as AuthedRequest;
    await run("DELETE FROM org_invites WHERE id = $1 AND org_id = $2", [(req.params as { id: string }).id, user.orgId]);
    return { ok: true };
  });

  /** SCIM provisioning tokens — plaintext shown once at creation. */
  app.get("/api/admin/scim/tokens", async (req) => {
    const { user } = req as AuthedRequest;
    return {
      tokens: await dbq("SELECT id, label, created_at FROM scim_tokens WHERE org_id = $1 ORDER BY created_at", [user.orgId]),
      endpoint: "/scim/v2",
    };
  });

  app.post("/api/admin/scim/tokens", async (req) => {
    const { user } = req as AuthedRequest;
    const { label } = (req.body ?? {}) as { label?: string };
    const token = `kxscim_${randomBytes(24).toString("base64url")}`;
    const id = randomUUID();
    await run("INSERT INTO scim_tokens (id, org_id, token_hash, label, created_at) VALUES ($1,$2,$3,$4,$5)",
      [id, user.orgId, createHash("sha256").update(token).digest("hex"), label?.slice(0, 80) ?? null, now()]);
    return { id, token };
  });

  app.delete("/api/admin/scim/tokens/:id", async (req) => {
    const { user } = req as AuthedRequest;
    await run("DELETE FROM scim_tokens WHERE id = $1 AND org_id = $2", [(req.params as { id: string }).id, user.orgId]);
    return { ok: true };
  });

  /** Org policies (DLP + retention) */
  app.get("/api/admin/policies", async (req) => {
    const { user } = req as AuthedRequest;
    return { policies: await getPolicies(user.orgId), encryptionAtRest: encryptionEnabled() };
  });

  app.put("/api/admin/policies", async (req) => {
    const { user } = req as AuthedRequest;
    const patch = policiesSchema.parse(req.body);
    return { policies: await setPolicies(user.orgId, patch) };
  });

  /**
   * Audit log: org-scoped activity, filterable by action prefix, user, file.
   * ?action=share&user=<id>&file=<id>&limit=200 (max 500)
   */
  app.get("/api/admin/audit", async (req) => {
    const { user } = req as AuthedRequest;
    const q = req.query as { action?: string; user?: string; file?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500);
    const rows = await dbq<{ detail: string | null; file_name: string | null }>(
      `SELECT a.id, a.action, a.detail, a.created_at,
              u.display_name AS actor_name, u.email AS actor_email,
              i.name AS file_name, a.file_id
       FROM activity a
       LEFT JOIN users u ON u.id = a.actor_id
       LEFT JOIN items i ON i.id = a.file_id
       WHERE a.org_id = $1
         AND ($2::text IS NULL OR a.action LIKE $2 || '%')
         AND ($3::text IS NULL OR a.actor_id = $3)
         AND ($4::text IS NULL OR a.file_id = $4)
       ORDER BY a.created_at DESC LIMIT $5`,
      [user.orgId, q.action || null, q.user || null, q.file || null, limit],
    );
    return {
      entries: rows.map((r) => ({
        ...r,
        detail: decryptField(r.detail),
        file_name: decryptField(r.file_name),
      })),
    };
  });

  /** Observability: process + data + request stats. Table counts are scoped
   *  to the caller's org — platform-wide tallies belong to superadmin only. */
  app.get("/api/admin/metrics", async (req) => {
    const { user } = req as AuthedRequest;
    const count = async (sql: string) => ((await one<{ n: number }>(sql, [user.orgId])) ?? { n: 0 }).n;
    return {
      uptimeSec: Math.floor((Date.now() - metrics.startedAt) / 1000),
      requests: { total: metrics.requests, errors5xx: metrics.errors, byStatus: metrics.byStatus },
      collab: { rooms: activeCollabRooms(), peers: collabPeers() },
      data: {
        users: await count("SELECT COUNT(*) n FROM users WHERE org_id = $1"),
        items: await count("SELECT COUNT(*) n FROM items WHERE org_id = $1"),
        versions: await count("SELECT COUNT(*) n FROM versions v JOIN items i ON i.id = v.file_id WHERE i.org_id = $1"),
        comments: await count("SELECT COUNT(*) n FROM comments c JOIN items i ON i.id = c.file_id WHERE i.org_id = $1"),
        shareLinks: await count("SELECT COUNT(*) n FROM share_links s JOIN items i ON i.id = s.file_id WHERE i.org_id = $1"),
        aiActions: await count("SELECT COUNT(*) n FROM ai_actions a JOIN items i ON i.id = a.file_id WHERE i.org_id = $1"),
        indexRows: await count("SELECT COUNT(*) n FROM search_index s JOIN items i ON i.id = s.file_id WHERE i.org_id = $1"),
      },
      security: { encryptionAtRest: encryptionEnabled(), sso: ssoEnabled, saml: samlEnabled },
      memory: process.memoryUsage().heapUsed,
    };
  });
}
