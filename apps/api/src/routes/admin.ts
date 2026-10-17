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
  dlpOnSave: z.enum(["off", "flag", "block"]).optional(),
  watermarkConfidentialExports: z.boolean().optional(),
  allowedIpRanges: z.array(z.string().max(64)).max(50).optional(),
  requireDesktopClient: z.boolean().optional(),
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
  /** Mark the org's onboarding wizard complete — any step or the finish button. */
  app.post("/api/admin/onboarding", async (req) => {
    const { user } = req as AuthedRequest;
    await run("UPDATE orgs SET onboarded_at = COALESCE(onboarded_at, now()) WHERE id = $1", [user.orgId]);
    return { ok: true };
  });

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
   * Audit log: org-scoped activity, filterable by action prefix, user, file,
   * and date range. ?action=share&user=<id>&file=<id>&from=<iso>&to=<iso>
   * &limit=200 (max 500)
   */
  app.get("/api/admin/audit", async (req) => {
    const { user } = req as AuthedRequest;
    const q = req.query as { action?: string; user?: string; file?: string; from?: string; to?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500);
    const from = q.from && !isNaN(Date.parse(q.from)) ? new Date(q.from).toISOString() : null;
    const to = q.to && !isNaN(Date.parse(q.to)) ? new Date(q.to).toISOString() : null;
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
         AND ($5::timestamptz IS NULL OR a.created_at >= $5)
         AND ($6::timestamptz IS NULL OR a.created_at <= $6)
       ORDER BY a.created_at DESC LIMIT $7`,
      [user.orgId, q.action || null, q.user || null, q.file || null, from, to, limit],
    );
    return {
      entries: rows.map((r) => ({
        ...r,
        detail: decryptField(r.detail),
        file_name: decryptField(r.file_name),
      })),
    };
  });

  /** Distinct action verbs — populates the audit filter dropdown. */
  app.get("/api/admin/audit/actions", async (req) => {
    const { user } = req as AuthedRequest;
    const rows = await dbq<{ action: string }>(
      "SELECT DISTINCT action FROM activity WHERE org_id = $1 ORDER BY action",
      [user.orgId]);
    return { actions: rows.map((r) => r.action) };
  });

  /** Org-wide audit export as CSV — same filters as GET /api/admin/audit,
   *  capped at 10k rows newest-first (SharePoint audit-log report). */
  app.get("/api/admin/audit.csv", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const q = req.query as { action?: string; user?: string; file?: string; from?: string; to?: string };
    const from = q.from && !isNaN(Date.parse(q.from)) ? new Date(q.from).toISOString() : null;
    const to = q.to && !isNaN(Date.parse(q.to)) ? new Date(q.to).toISOString() : null;
    const rows = await dbq<{ action: string; detail: string | null; created_at: string; actor: string | null; actor_email: string | null; file_name: string | null }>(
      `SELECT a.action, a.detail, a.created_at,
              u.display_name AS actor, u.email AS actor_email, i.name AS file_name
       FROM activity a
       LEFT JOIN users u ON u.id = a.actor_id
       LEFT JOIN items i ON i.id = a.file_id
       WHERE a.org_id = $1
         AND ($2::text IS NULL OR a.action LIKE $2 || '%')
         AND ($3::text IS NULL OR a.actor_id = $3)
         AND ($4::text IS NULL OR a.file_id = $4)
         AND ($5::timestamptz IS NULL OR a.created_at >= $5)
         AND ($6::timestamptz IS NULL OR a.created_at <= $6)
       ORDER BY a.created_at DESC LIMIT 10000`,
      [user.orgId, q.action || null, q.user || null, q.file || null, from, to],
    );
    const cell = (v: string | null) => `"${(v ?? "").replaceAll('"', '""')}"`;
    const csv = "timestamp,actor,email,action,file,detail\n" + rows.map((r) =>
      [r.created_at, r.actor, r.actor_email, r.action,
       r.file_name ? decryptField(r.file_name) ?? r.file_name : "",
       r.detail ? decryptField(r.detail) ?? r.detail : ""].map(cell).join(","),
    ).join("\n");
    reply.header("content-disposition", `attachment; filename="kreatix-audit-${Date.now()}.csv"`);
    return reply.type("text/csv").send(csv);
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

  /* ── Legal holds ───────────────────────────────────────── */

  app.get("/api/admin/holds", async (req) => {
    const { user } = req as AuthedRequest;
    const rows = await dbq<{ id: string; name: string; description: string | null; active: boolean; created_at: string; n_items: string; created_by_name: string }>(
      `SELECT h.id, h.name, h.description, h.active, h.created_at, u.display_name AS created_by_name,
              (SELECT COUNT(*) FROM legal_hold_items i WHERE i.hold_id = h.id) AS n_items
       FROM legal_holds h JOIN users u ON u.id = h.created_by
       WHERE h.org_id = $1 ORDER BY h.created_at DESC`, [user.orgId]);
    return {
      holds: rows.map((h) => ({
        id: h.id, name: h.name, description: h.description, active: h.active,
        createdBy: h.created_by_name, createdAt: h.created_at, itemCount: Number(h.n_items),
      })),
    };
  });

  app.post("/api/admin/holds", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const d = z.object({
      name: z.string().trim().min(1).max(200), description: z.string().max(2000).optional(),
      itemIds: z.array(z.string().max(64)).max(500).optional(),
    }).parse(req.body);
    const id = randomUUID();
    await run("INSERT INTO legal_holds (id, org_id, name, description, created_by) VALUES ($1,$2,$3,$4,$5)",
      [id, user.orgId, d.name, d.description ?? null, user.id]);
    for (const itemId of d.itemIds ?? []) {
      // only org items may be held — silently skip foreign/missing ids
      await run(
        `INSERT INTO legal_hold_items (hold_id, item_id)
         SELECT $1, id FROM items WHERE id = $2 AND org_id = $3 ON CONFLICT DO NOTHING`,
        [id, itemId, user.orgId]);
    }
    return reply.code(201).send({ hold: { id, name: d.name } });
  });

  app.post("/api/admin/holds/:id/items", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { id } = req.params as { id: string };
    const hold = await one<{ id: string }>("SELECT id FROM legal_holds WHERE id = $1 AND org_id = $2", [id, user.orgId]);
    if (!hold) return reply.code(404).send({ error: "not_found" });
    const { itemId } = z.object({ itemId: z.string().max(64) }).parse(req.body);
    const n = await run(
      `INSERT INTO legal_hold_items (hold_id, item_id)
       SELECT $1, id FROM items WHERE id = $2 AND org_id = $3 ON CONFLICT DO NOTHING`,
      [id, itemId, user.orgId]);
    if (!n) return reply.code(404).send({ error: "not_found", message: "Item not found" });
    return { ok: true };
  });

  app.delete("/api/admin/holds/:id/items/:itemId", async (req) => {
    const { user } = req as AuthedRequest;
    const { id, itemId } = req.params as { id: string; itemId: string };
    await run(
      `DELETE FROM legal_hold_items WHERE hold_id = $1 AND item_id = $2
         AND hold_id IN (SELECT id FROM legal_holds WHERE org_id = $3)`,
      [id, itemId, user.orgId]);
    return { ok: true };
  });

  app.get("/api/admin/holds/:id/items", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { id } = req.params as { id: string };
    const hold = await one<{ id: string }>("SELECT id FROM legal_holds WHERE id = $1 AND org_id = $2", [id, user.orgId]);
    if (!hold) return reply.code(404).send({ error: "not_found" });
    const rows = await dbq<{ item_id: string; name: string; kind: string; owner: string }>(
      `SELECT i.id AS item_id, i.name, i.kind, u.display_name AS owner
       FROM legal_hold_items lhi JOIN items i ON i.id = lhi.item_id
       JOIN users u ON u.id = i.owner_id WHERE lhi.hold_id = $1`,
      [id]);
    return {
      items: rows.map((r) => ({ id: r.item_id, name: decryptField(r.name) ?? r.name, kind: r.kind, owner: r.owner })),
    };
  });

  /** Direct item flag — simpler than a named hold for one-off preservation. */
  app.patch("/api/admin/holds/item/:itemId", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { itemId } = req.params as { itemId: string };
    const d = z.object({ hold: z.boolean() }).parse(req.body);
    const n = await run("UPDATE items SET legal_hold = $2 WHERE id = $1 AND org_id = $3",
      [itemId, d.hold, user.orgId]);
    if (!n) return reply.code(404).send({ error: "not_found" });
    return { ok: true, hold: d.hold };
  });

  /** Site-wide hold — covers every item in every library under the site. */
  app.patch("/api/admin/holds/site/:siteId", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { siteId } = req.params as { siteId: string };
    const d = z.object({ hold: z.boolean() }).parse(req.body);
    const n = await run("UPDATE sites SET legal_hold = $2 WHERE id = $1 AND org_id = $3",
      [siteId, d.hold, user.orgId]);
    if (!n) return reply.code(404).send({ error: "not_found" });
    return { ok: true, hold: d.hold };
  });

  /** Activate/deactivate a hold — deactivation releases deletes again. */
  app.patch("/api/admin/holds/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { id } = req.params as { id: string };
    const d = z.object({ active: z.boolean() }).parse(req.body);
    const n = await run("UPDATE legal_holds SET active = $2 WHERE id = $1 AND org_id = $3", [id, d.active, user.orgId]);
    if (!n) return reply.code(404).send({ error: "not_found" });
    return { ok: true, active: d.active };
  });

  /* ── eDiscovery export ─────────────────────────────────── */

  /** One-click custodian export: everything the suite stores for a user —
   *  file inventory (name/kind/size/versions/labels), chat messages they
   *  authored, their comments, activity rows, calendar events they created
   *  or attend, form submissions, and task assignments. Returns one JSON
   *  document; binary content is referenced by blob key + sha, not inlined
   *  (files stay available through the normal download paths). */
  app.get("/api/admin/ediscovery/export/:userId", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { userId } = req.params as { userId: string };
    const custodian = await one<{ id: string; email: string; display_name: string }>(
      "SELECT id, email, display_name FROM users WHERE id = $1 AND org_id = $2", [userId, user.orgId]);
    if (!custodian) return reply.code(404).send({ error: "not_found", message: "User not in this org" });

    const files = await dbq(
      `SELECT i.id, i.name, i.kind, i.mime, i.size, i.label, i.trashed, i.legal_hold,
              i.created_at, i.updated_at,
              (SELECT COUNT(*) FROM versions v WHERE v.file_id = i.id) AS n_versions
       FROM items i WHERE i.org_id = $1 AND (i.owner_id = $2 OR EXISTS
         (SELECT 1 FROM shares s WHERE s.file_id = i.id AND s.user_id = $2))
       ORDER BY i.updated_at DESC LIMIT 5000`, [user.orgId, userId]);

    const chat = await dbq(
      `SELECT m.id, m.channel_id, m.body, m.created_at, c.name AS channel
       FROM chat_messages m JOIN chat_channels c ON c.id = m.channel_id
       WHERE m.user_id = $1 AND c.org_id = $2 ORDER BY m.created_at LIMIT 20000`, [userId, user.orgId]);

    const comments = await dbq(
      `SELECT cm.id, cm.body, cm.anchor, cm.created_at, cm.resolved, i.name AS file_name
       FROM comments cm JOIN items i ON i.id = cm.file_id
       WHERE cm.author_id = $1 AND i.org_id = $2 ORDER BY cm.created_at LIMIT 5000`, [userId, user.orgId]);

    const activity = await dbq(
      `SELECT a.action, a.detail, a.created_at, i.name AS file_name
       FROM activity a LEFT JOIN items i ON i.id = a.file_id
       WHERE a.org_id = $1 AND a.actor_id = $2 ORDER BY a.created_at DESC LIMIT 20000`, [user.orgId, userId]);

    const events = await dbq(
      `SELECT e.title, e.starts_at, e.ends_at, e.created_at FROM calendar_events e
       WHERE e.org_id = $1 AND (e.created_by = $2 OR EXISTS
         (SELECT 1 FROM calendar_attendees a WHERE a.event_id = e.id AND a.user_id = $2))
       ORDER BY e.starts_at LIMIT 5000`, [user.orgId, userId]);

    const tasks = await dbq(
      `SELECT t.title, t.status, t.due_at, t.created_at FROM tasks t
       WHERE t.org_id = $1 AND (t.assignee_id = $2 OR t.created_by = $2)
       ORDER BY t.created_at DESC LIMIT 5000`, [user.orgId, userId]);

    const dec = (v: unknown) => (typeof v === "string" ? (decryptField(v) ?? v) : v);
    const bundle = {
      exportedAt: now(), orgId: user.orgId, exportedBy: user.email,
      custodian: { id: custodian.id, email: custodian.email, displayName: custodian.display_name },
      files: files.map((f: any) => ({
        id: f.id, name: dec(f.name), kind: f.kind, mime: f.mime, size: Number(f.size),
        label: f.label, trashed: f.trashed, legalHold: f.legal_hold,
        versionCount: Number(f.n_versions), createdAt: f.created_at, updatedAt: f.updated_at,
      })),
      chatMessages: chat.map((m: any) => ({
        id: m.id, channel: m.channel, body: dec(m.body), createdAt: m.created_at,
      })),
      comments: comments.map((c: any) => ({
        id: c.id, file: dec(c.file_name), body: dec(c.body), anchor: c.anchor,
        resolved: c.resolved, createdAt: c.created_at,
      })),
      activity: activity.map((a: any) => ({
        action: a.action, detail: dec(a.detail), file: dec(a.file_name), at: a.created_at,
      })),
      calendarEvents: events.map((e: any) => ({
        title: dec(e.title), startsAt: e.starts_at, endsAt: e.ends_at, createdAt: e.created_at,
      })),
      tasks: tasks.map((t: any) => ({
        title: dec(t.title), status: t.status, dueAt: t.due_at, createdAt: t.created_at,
      })),
      note: "Binary file content is not inlined — fetch items via /api/files/:id/content with an admin session. Mail lives in the mail service; export mailboxes there separately.",
    };
    reply.header("content-disposition",
      `attachment; filename="ediscovery-${custodian.email.replace(/[^a-z0-9@.-]+/gi, "_")}-${Date.now()}.json"`);
    return reply.type("application/json").send(bundle);
  });
}
