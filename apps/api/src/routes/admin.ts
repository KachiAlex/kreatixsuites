// Admin policy center: org members, DLP/retention policies, audit log.
// All endpoints require owner or admin role.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { q as dbq, one, run, now } from "../db.js";
import { requireAuth, type AuthedRequest, type UserRow } from "../auth.js";
import { getPolicies, setPolicies, dlpRules, isSafePattern, type DlpRule } from "../policies.js";
import { encryptionEnabled, decryptField } from "../crypto.js";
import { metrics } from "../metrics.js";
import { activeCollabRooms, collabPeers } from "../collab.js";
import { ssoEnabled } from "./sso.js";
import { samlEnabled } from "./saml.js";
import { sendMailSafe, tpl } from "../email.js";
import { ensureSubscription, effectivePlan, planLimit, seatCount } from "../billing.js";
import { logActivity } from "../items.js";

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

  /** Join requests — people who found this workspace via its verified domain.
   *  Pending first, then the most recent decisions for context. */
  app.get("/api/admin/join-requests", async (req) => {
    const { user } = req as AuthedRequest;
    const rows = await dbq(
      `SELECT j.id, j.email, j.display_name, j.status, j.decided_at, j.created_at,
              u.display_name AS decided_by_name
       FROM join_requests j LEFT JOIN users u ON u.id = j.decided_by
       WHERE j.org_id = $1
       ORDER BY (j.status = 'pending') DESC, j.created_at DESC LIMIT 100`,
      [user.orgId]);
    return { requests: rows };
  });

  /** Approve → the requester joins. Fresh emails get a one-time invite link
   *  (they register straight into the org); an existing account is moved in
   *  directly only when its old workspace is empty — never strand files. */
  app.post("/api/admin/join-requests/:id/approve", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const jr = await one<{ id: string; org_id: string; email: string; display_name: string; status: string }>(
      "SELECT id, org_id, email, display_name, status FROM join_requests WHERE id = $1 AND org_id = $2",
      [(req.params as { id: string }).id, user.orgId]);
    if (!jr) return reply.code(404).send({ error: "not_found", message: "Join request not found" });
    if (jr.status !== "pending")
      return reply.code(409).send({ error: "conflict", message: `Request already ${jr.status}` });
    const maxMembers = planLimit(await effectivePlan(await ensureSubscription(user.orgId)), "max_members", 0);
    if (maxMembers > 0 && (await seatCount(user.orgId)) >= maxMembers) {
      return reply.code(402).send({
        error: "seat_limit",
        message: "This workspace is at its plan's member limit — upgrade to add more people",
      });
    }
    const org = await one<{ name: string }>("SELECT name FROM orgs WHERE id = $1", [user.orgId]);
    const orgName = org?.name ?? "the workspace";
    // claim the decision first — concurrent approves lose the CAS and 409
    const claimed = await run(
      "UPDATE join_requests SET status = 'approved', decided_by = $1, decided_at = $2 WHERE id = $3 AND status = 'pending'",
      [user.id, now(), jr.id]);
    if (!claimed)
      return reply.code(409).send({ error: "conflict", message: "Request already decided" });

    const existing = await one<{ id: string; org_id: string }>(
      "SELECT id, org_id FROM users WHERE lower(email) = $1", [jr.email]);
    if (existing) {
      // move them in only when their current workspace is an empty solo shell
      const hasItems = await one(
        "SELECT 1 AS x FROM items WHERE org_id = $1 AND owner_id = $2 LIMIT 1", [existing.org_id, existing.id]);
      const hasMates = await one(
        "SELECT 1 AS x FROM users WHERE org_id = $1 AND id <> $2 LIMIT 1", [existing.org_id, existing.id]);
      if (!hasItems && !hasMates) {
        await run("UPDATE users SET org_id = $1, role = 'member' WHERE id = $2", [user.orgId, existing.id]);
        void logActivity(user.orgId, user.id, null, "join-request.approved",
          `${jr.display_name} <${jr.email}> — existing account moved in`);
        sendMailSafe(app.log, { to: jr.email, ...tpl.joinApprovedMember(orgName) });
        return { ok: true, moved: true };
      }
      // account with real data — an org move would strand their files
      void logActivity(user.orgId, user.id, null, "join-request.approved",
        `${jr.display_name} <${jr.email}> — existing account, needs manual transfer`);
      sendMailSafe(app.log, {
        to: jr.email,
        ...tpl.joinRequestNeedsTransfer(orgName),
      });
      return { ok: true, moved: false, existingAccount: true };
    }
    // no account — one-time invite, 30 days
    const token = randomBytes(18).toString("base64url");
    await run(
      "INSERT INTO org_invites (id, org_id, token, created_by, max_uses, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [randomUUID(), user.orgId, token, user.id, 1,
        new Date(Date.now() + 30 * 86400000).toISOString(), now()]);
    void logActivity(user.orgId, user.id, null, "join-request.approved",
      `${jr.display_name} <${jr.email}> — invite sent`);
    sendMailSafe(app.log, { to: jr.email, ...tpl.joinApprovedInvite(orgName, token) });
    return { ok: true, invited: true };
  });

  app.post("/api/admin/join-requests/:id/decline", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const claimed = await run(
      "UPDATE join_requests SET status = 'declined', decided_by = $1, decided_at = $2 WHERE id = $3 AND org_id = $4 AND status = 'pending'",
      [user.id, now(), (req.params as { id: string }).id, user.orgId]);
    if (!claimed)
      return reply.code(404).send({ error: "not_found", message: "Join request not found or already decided" });
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

  app.put("/api/admin/policies", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const patch = policiesSchema.parse(req.body);
    if (patch.dlpPatterns?.length) {
      const bad = patch.dlpPatterns.find((p) => { try { return !isSafePattern(p); } catch { return true; } });
      if (bad) return reply.code(400).send({ error: "unsafe_pattern",
        message: `Pattern rejected — nested quantifiers or ambiguous alternation can stall scanning: /${bad.slice(0, 60)}/` });
    }
    return { policies: await setPolicies(user.orgId, patch) };
  });

  /**
   * Audit log: org-scoped activity, filterable by action prefix, user, file,
   * and date range. ?action=share&user=<id>&file=<id>&from=<iso>&to=<iso>
   * &limit=200 (max 500). Keyset pagination: pass ?before=<created_at>
   * &beforeId=<id> from the previous page's nextCursor.
   */
  app.get("/api/admin/audit", async (req) => {
    const { user } = req as AuthedRequest;
    const q = req.query as { action?: string; user?: string; file?: string; from?: string; to?: string; limit?: string; before?: string; beforeId?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500);
    const from = q.from && !isNaN(Date.parse(q.from)) ? new Date(q.from).toISOString() : null;
    const to = q.to && !isNaN(Date.parse(q.to)) ? new Date(q.to).toISOString() : null;
    const before = q.before && !isNaN(Date.parse(q.before)) ? new Date(q.before).toISOString() : null;
    const rows = await dbq<{ id: string; detail: string | null; file_name: string | null; created_at: string }>(
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
         AND ($7::timestamptz IS NULL OR (a.created_at, a.id) < ($7::timestamptz, $8::text))
       ORDER BY a.created_at DESC, a.id DESC LIMIT $9`,
      [user.orgId, q.action || null, q.user || null, q.file || null, from, to,
       before, q.beforeId || null, limit],
    );
    const last = rows[rows.length - 1];
    return {
      entries: rows.map((r) => ({
        ...r,
        detail: decryptField(r.detail),
        file_name: decryptField(r.file_name),
      })),
      nextCursor: rows.length === limit && last
        ? { before: last.created_at, beforeId: last.id }
        : null,
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

  /* ── Custodians: users whose content a hold preserves ──── */

  app.post("/api/admin/holds/:id/custodians", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { id } = req.params as { id: string };
    const hold = await one<{ id: string }>("SELECT id FROM legal_holds WHERE id = $1 AND org_id = $2", [id, user.orgId]);
    if (!hold) return reply.code(404).send({ error: "not_found" });
    const { userId } = z.object({ userId: z.string().max(64) }).parse(req.body);
    const n = await run(
      `INSERT INTO legal_hold_custodians (hold_id, user_id)
       SELECT $1, id FROM users WHERE id = $2 AND org_id = $3 ON CONFLICT DO NOTHING`,
      [id, userId, user.orgId]);
    if (!n) return reply.code(404).send({ error: "not_found", message: "User not in this org" });
    return { ok: true };
  });

  app.delete("/api/admin/holds/:id/custodians/:userId", async (req) => {
    const { user } = req as AuthedRequest;
    const { id, userId } = req.params as { id: string; userId: string };
    await run(
      `DELETE FROM legal_hold_custodians WHERE hold_id = $1 AND user_id = $2
         AND hold_id IN (SELECT id FROM legal_holds WHERE org_id = $3)`,
      [id, userId, user.orgId]);
    return { ok: true };
  });

  app.get("/api/admin/holds/:id/custodians", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { id } = req.params as { id: string };
    const hold = await one<{ id: string }>("SELECT id FROM legal_holds WHERE id = $1 AND org_id = $2", [id, user.orgId]);
    if (!hold) return reply.code(404).send({ error: "not_found" });
    const rows = await dbq<{ user_id: string; display_name: string; email: string; n_items: string }>(
      `SELECT u.id AS user_id, u.display_name, u.email,
              (SELECT COUNT(*) FROM items i WHERE i.owner_id = u.id AND i.org_id = $2) AS n_items
       FROM legal_hold_custodians lhc JOIN users u ON u.id = lhc.user_id
       WHERE lhc.hold_id = $1`, [id, user.orgId]);
    return { custodians: rows.map((r) => ({ id: r.user_id, name: r.display_name, email: r.email, itemCount: Number(r.n_items) })) };
  });

  /* ── DLP engine: rules + review queue ──────────────────── */

  app.get("/api/admin/dlp/rules", async (req) => {
    const { user } = req as AuthedRequest;
    const rows = await dlpRules(user.orgId);
    return { rules: rows };
  });

  app.post("/api/admin/dlp/rules", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const d = z.object({
      name: z.string().trim().min(1).max(200),
      pattern: z.string().min(1).max(300),
      severity: z.enum(["low", "medium", "high"]).default("medium"),
      action: z.enum(["flag", "block"]).default("flag"),
      appliesTo: z.enum(["files", "chat", "all"]).default("files"),
    }).parse(req.body);
    try { new RegExp(d.pattern); } catch {
      return reply.code(400).send({ error: "bad_request", message: "Pattern isn't a valid regex" });
    }
    if (!isSafePattern(d.pattern)) {
      return reply.code(400).send({ error: "unsafe_pattern",
        message: "Pattern rejected — nested quantifiers or ambiguous alternation can stall scanning" });
    }
    const id = randomUUID();
    await run(
      `INSERT INTO dlp_rules (id, org_id, name, pattern, severity, action, applies_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, user.orgId, d.name, d.pattern, d.severity, d.action, d.appliesTo]);
    return reply.code(201).send({ rule: { id, name: d.name } });
  });

  app.patch("/api/admin/dlp/rules/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { id } = req.params as { id: string };
    const d = z.object({
      name: z.string().trim().min(1).max(200).optional(),
      pattern: z.string().min(1).max(300).optional(),
      severity: z.enum(["low", "medium", "high"]).optional(),
      action: z.enum(["flag", "block"]).optional(),
      appliesTo: z.enum(["files", "chat", "all"]).optional(),
      enabled: z.boolean().optional(),
    }).parse(req.body);
    if (d.pattern) { try { new RegExp(d.pattern); } catch {
      return reply.code(400).send({ error: "bad_request", message: "Pattern isn't a valid regex" });
    } if (!isSafePattern(d.pattern)) {
      return reply.code(400).send({ error: "unsafe_pattern",
        message: "Pattern rejected — nested quantifiers or ambiguous alternation can stall scanning" });
    } }
    const cur = await one<DlpRule>("SELECT * FROM dlp_rules WHERE id = $1 AND org_id = $2", [id, user.orgId]);
    if (!cur) return reply.code(404).send({ error: "not_found" });
    await run(
      `UPDATE dlp_rules SET name=$2, pattern=$3, severity=$4, action=$5, applies_to=$6, enabled=$7
       WHERE id = $1`,
      [id, d.name ?? cur.name, d.pattern ?? cur.pattern, d.severity ?? cur.severity,
       d.action ?? cur.action, d.appliesTo ?? cur.applies_to, d.enabled ?? cur.enabled]);
    return { ok: true };
  });

  app.delete("/api/admin/dlp/rules/:id", async (req) => {
    const { user } = req as AuthedRequest;
    await run("DELETE FROM dlp_rules WHERE id = $1 AND org_id = $2",
      [(req.params as { id: string }).id, user.orgId]);
    return { ok: true };
  });

  /** Violation queue — events from the scan pipeline, newest first. */
  app.get("/api/admin/dlp/events", async (req) => {
    const { user } = req as AuthedRequest;
    const q_ = req.query as { status?: string };
    const status = ["open", "confirmed", "dismissed"].includes(q_.status ?? "") ? q_.status! : "open";
    const rows = await dbq(
      `SELECT e.id, e.rule_name, e.ref_type, e.ref_id, e.excerpt, e.action, e.status, e.created_at,
              u.display_name AS actor, i.name AS item_name
       FROM dlp_events e
       LEFT JOIN users u ON u.id = e.actor_id
       LEFT JOIN items i ON e.ref_type = 'item' AND i.id = e.ref_id
       WHERE e.org_id = $1 AND e.status = $2
       ORDER BY e.created_at DESC LIMIT 500`,
      [user.orgId, status]);
    return {
      events: rows.map((r: any) => ({
        id: r.id, rule: r.rule_name, refType: r.ref_type, refId: r.ref_id,
        excerpt: decryptField(r.excerpt) ?? r.excerpt, action: r.action, status: r.status,
        actor: r.actor, itemName: r.item_name ? decryptField(r.item_name) ?? r.item_name : null,
        createdAt: r.created_at,
      })),
    };
  });

  /** Disposition a violation — confirm (true positive) or dismiss. */
  app.patch("/api/admin/dlp/events/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { id } = req.params as { id: string };
    const d = z.object({ status: z.enum(["confirmed", "dismissed", "open"]) }).parse(req.body);
    const ev = await one<{ id: string; ref_type: string; ref_id: string }>(
      "SELECT id, ref_type, ref_id FROM dlp_events WHERE id = $1 AND org_id = $2", [id, user.orgId]);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    await run("UPDATE dlp_events SET status = $2 WHERE id = $1", [id, d.status]);
    // dismissing all open item events clears the item's flag
    if (d.status === "dismissed" && ev.ref_type === "item") {
      const open = await one(
        `SELECT 1 AS x FROM dlp_events WHERE ref_type = 'item' AND ref_id = $1 AND status != 'dismissed' LIMIT 1`,
        [ev.ref_id]);
      if (!open) await run("UPDATE items SET dlp_flagged = false WHERE id = $1", [ev.ref_id]);
    }
    return { ok: true, status: d.status };
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
    const bundle = await custodianBundle(user.orgId, custodian, user.email);
    reply.header("content-disposition",
      `attachment; filename="ediscovery-${custodian.email.replace(/[^a-z0-9@.-]+/gi, "_")}-${Date.now()}.json"`);
    return reply.type("application/json").send(bundle);
  });

  /** Matter-scoped export: every custodian on the hold + every explicitly
   *  held item — one document for the whole legal matter. */
  app.get("/api/admin/holds/:id/export", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { id } = req.params as { id: string };
    const hold = await one<{ id: string; name: string; description: string | null; active: boolean; created_at: string }>(
      "SELECT id, name, description, active, created_at FROM legal_holds WHERE id = $1 AND org_id = $2", [id, user.orgId]);
    if (!hold) return reply.code(404).send({ error: "not_found" });

    const custodianRows = await dbq<{ id: string; email: string; display_name: string }>(
      `SELECT u.id, u.email, u.display_name FROM legal_hold_custodians lhc
       JOIN users u ON u.id = lhc.user_id WHERE lhc.hold_id = $1`, [id]);
    const heldItems = await dbq(
      `SELECT i.id, i.name, i.kind, i.mime, i.size, i.owner_id, u.display_name AS owner, i.created_at
       FROM legal_hold_items lhi JOIN items i ON i.id = lhi.item_id
       JOIN users u ON u.id = i.owner_id WHERE lhi.hold_id = $1`, [id]);
    const dec = (v: unknown) => (typeof v === "string" ? (decryptField(v) ?? v) : v);

    const bundles = [];
    for (const c of custodianRows) bundles.push(await custodianBundle(user.orgId, c, user.email));

    const bundle = {
      exportedAt: now(), orgId: user.orgId, exportedBy: user.email,
      matter: { id: hold.id, name: hold.name, description: hold.description, active: hold.active, createdAt: hold.created_at },
      custodianCount: bundles.length,
      custodians: bundles,
      heldItems: heldItems.map((i: any) => ({
        id: i.id, name: dec(i.name), kind: i.kind, mime: i.mime, size: Number(i.size),
        owner: i.owner, createdAt: i.created_at,
      })),
      note: "Per-custodian sections follow the same schema as /api/admin/ediscovery/export/:userId. Binary content is referenced by item id, not inlined.",
    };
    reply.header("content-disposition",
      `attachment; filename="matter-${hold.name.replace(/[^a-z0-9.-]+/gi, "_")}-${Date.now()}.json"`);
    return reply.type("application/json").send(bundle);
  });
}

/** Everything the suite stores for one custodian — shared by the single-user
 *  export and the matter-scoped hold export. */
async function custodianBundle(orgId: string, custodian: { id: string; email: string; display_name: string }, exportedBy: string) {
    const userId = custodian.id;
    const files = await dbq(
      `SELECT i.id, i.name, i.kind, i.mime, i.size, i.label, i.trashed, i.legal_hold,
              i.created_at, i.updated_at,
              (SELECT COUNT(*) FROM versions v WHERE v.file_id = i.id) AS n_versions
       FROM items i WHERE i.org_id = $1 AND (i.owner_id = $2 OR EXISTS
         (SELECT 1 FROM shares s WHERE s.file_id = i.id AND s.user_id = $2))
       ORDER BY i.updated_at DESC LIMIT 5000`, [orgId, userId]);

    const chat = await dbq(
      `SELECT m.id, m.channel_id, m.body, m.created_at, c.name AS channel
       FROM chat_messages m JOIN chat_channels c ON c.id = m.channel_id
       WHERE m.user_id = $1 AND c.org_id = $2 ORDER BY m.created_at LIMIT 20000`, [userId, orgId]);

    const comments = await dbq(
      `SELECT cm.id, cm.body, cm.anchor, cm.created_at, cm.resolved, i.name AS file_name
       FROM comments cm JOIN items i ON i.id = cm.file_id
       WHERE cm.author_id = $1 AND i.org_id = $2 ORDER BY cm.created_at LIMIT 5000`, [userId, orgId]);

    const activity = await dbq(
      `SELECT a.action, a.detail, a.created_at, i.name AS file_name
       FROM activity a LEFT JOIN items i ON i.id = a.file_id
       WHERE a.org_id = $1 AND a.actor_id = $2 ORDER BY a.created_at DESC LIMIT 20000`, [orgId, userId]);

    const events = await dbq(
      `SELECT e.title, e.starts_at, e.ends_at, e.created_at FROM calendar_events e
       WHERE e.org_id = $1 AND (e.created_by = $2 OR EXISTS
         (SELECT 1 FROM calendar_attendees a WHERE a.event_id = e.id AND a.user_id = $2))
       ORDER BY e.starts_at LIMIT 5000`, [orgId, userId]);

    const tasks = await dbq(
      `SELECT t.title, t.status, t.due_at, t.created_at FROM tasks t
       WHERE t.org_id = $1 AND (t.assignee_id = $2 OR t.created_by = $2)
       ORDER BY t.created_at DESC LIMIT 5000`, [orgId, userId]);

    const dec = (v: unknown) => (typeof v === "string" ? (decryptField(v) ?? v) : v);
    return {
      exportedAt: now(), orgId, exportedBy,
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
}

// ---------- public API keys + outbound webhooks ----------

const keyCreateSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(["read", "write", "hooks"])).min(1).max(3),
});
const hookSchema = z.object({
  url: z.string().url().max(500),
  events: z.array(z.string().max(60)).max(40).default([]),
});

export function integrationAdminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireOrgAdmin);
  const orgId = (req: FastifyRequest) => (req as AuthedRequest).user.orgId;
  const uid = (req: FastifyRequest) => (req as AuthedRequest).user.id;

  app.get("/api/admin/api-keys", async (req) => {
    const keys = await dbq(
      `SELECT id, name, prefix, scopes, created_at, last_used_at,
              (SELECT display_name FROM users WHERE id = api_keys.created_by) AS creator
       FROM api_keys WHERE org_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
      [orgId(req)]);
    return { keys };
  });

  app.post("/api/admin/api-keys", async (req, reply) => {
    const body = keyCreateSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid", issues: body.error.issues });
    const { createApiKey } = await import("../integrations.js");
    const r = await createApiKey(orgId(req), body.data.name, body.data.scopes, uid(req));
    return reply.code(201).send(r);
  });

  app.delete("/api/admin/api-keys/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const n = await run("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND org_id = $2", [id, orgId(req)]);
    if (!n) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });

  app.get("/api/admin/webhooks", async (req) => {
    const hooks = await dbq(
      `SELECT w.id, w.url, w.events, w.active, w.created_at,
              (SELECT count(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'failed')::int AS failures,
              (SELECT max(d.delivered_at) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'delivered') AS last_delivered
       FROM webhooks w WHERE w.org_id = $1 ORDER BY w.created_at DESC`, [orgId(req)]);
    return { hooks };
  });

  app.post("/api/admin/webhooks", async (req, reply) => {
    const body = hookSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid", issues: body.error.issues });
    // SSRF guard — only http(s) webhook targets, no link-local/metadata hosts
    let u: URL;
    try { u = new URL(body.data.url); } catch { return reply.code(400).send({ error: "bad_url" }); }
    if (!["http:", "https:"].includes(u.protocol)) return reply.code(400).send({ error: "bad_url" });
    if (/^(localhost|127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1)/i.test(u.hostname)) {
      return reply.code(400).send({ error: "bad_url", message: "Private/link-local webhook targets aren't allowed" });
    }
    const id = randomUUID();
    const secret = randomBytes(24).toString("hex");
    await run(
      `INSERT INTO webhooks (id, org_id, url, secret, events, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, orgId(req), body.data.url, secret, JSON.stringify(body.data.events), uid(req)]);
    return reply.code(201).send({ hook: { id, url: body.data.url, events: body.data.events, secret } });
  });

  app.delete("/api/admin/webhooks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const n = await run("DELETE FROM webhooks WHERE id = $1 AND org_id = $2", [id, orgId(req)]);
    if (!n) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });

  app.post("/api/admin/webhooks/:id/toggle", async (req, reply) => {
    const { id } = req.params as { id: string };
    const n = await run(
      "UPDATE webhooks SET active = NOT active WHERE id = $1 AND org_id = $2", [id, orgId(req)]);
    if (!n) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });

  app.get("/api/admin/webhooks/:id/deliveries", async (req, reply) => {
    const { id } = req.params as { id: string };
    const hook = await one("SELECT id FROM webhooks WHERE id = $1 AND org_id = $2", [id, orgId(req)]);
    if (!hook) return reply.code(404).send({ error: "not_found" });
    const deliveries = await dbq(
      `SELECT id, event, status, attempts, response_code, last_error, created_at, delivered_at
       FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]);
    return { deliveries };
  });

  // manual test ping — sends a signed synthetic event through the real path
  app.post("/api/admin/webhooks/:id/test", async (req, reply) => {
    const { id } = req.params as { id: string };
    const hook = await one<{ id: string; org_id: string; url: string; secret: string; events: string[]; active: boolean }>(
      "SELECT * FROM webhooks WHERE id = $1 AND org_id = $2", [id, orgId(req)]);
    if (!hook) return reply.code(404).send({ error: "not_found" });
    // bypass the event-subscription filter — a test always targets this hook
    const { deliverOne } = await import("../integrations.js");
    const body = { id: `evt_${randomUUID()}`, event: "test.ping", orgId: hook.org_id, at: new Date().toISOString(), data: {} };
    const did = randomUUID();
    await run(
      `INSERT INTO webhook_deliveries (id, webhook_id, org_id, event, payload, next_retry_at)
       VALUES ($1,$2,$3,'test.ping',$4,now())`, [did, hook.id, hook.org_id, JSON.stringify(body)]);
    await deliverOne(did, { url: hook.url, secret: hook.secret }, body);
    const d = await one<{ status: string; response_code: number | null }>(
      "SELECT status, response_code FROM webhook_deliveries WHERE id = $1", [did]);
    return { ok: d?.status === "delivered", status: d?.response_code, error: d?.status !== "delivered" ? "delivery failed" : undefined };
  });
}

// ---------- white-labeling ----------

export function brandingRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  const orgId = (req: FastifyRequest) => (req as AuthedRequest).user.orgId;

  app.get("/api/org/brand", async (req) => {
    const o = await one<{ name: string; brand_name: string | null; brand_logo: string | null }>(
      "SELECT name, brand_name, brand_logo FROM orgs WHERE id = $1", [orgId(req)]);
    return {
      brand: {
        name: o?.brand_name ?? o?.name ?? "",
        logoUrl: o?.brand_logo ? `/api/org/brand/${orgId(req)}/logo` : null,
      },
    };
  });

  app.put("/api/admin/branding", { preHandler: requireOrgAdmin }, async (req, reply) => {
    const body = z.object({ name: z.string().min(1).max(80) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid" });
    await run("UPDATE orgs SET brand_name = $1 WHERE id = $2", [body.data.name, orgId(req)]);
    return { ok: true };
  });

  // raw image bytes — capped at 512KB, stored in the blob store
  app.post("/api/admin/branding/logo", { preHandler: requireOrgAdmin }, async (req, reply) => {
    const buf = req.body as Buffer;
    const mime = req.headers["content-type"] ?? "";
    if (!/^image\/(png|jpeg|svg\+xml|webp|x-icon|vnd\.microsoft\.icon)$/.test(mime)) {
      return reply.code(400).send({ error: "bad_type", message: "PNG, JPEG, SVG or WebP logo" });
    }
    if (!Buffer.isBuffer(buf) || buf.length === 0 || buf.length > 512 * 1024) {
      return reply.code(400).send({ error: "bad_size", message: "Logo must be under 512KB" });
    }
    const { storageQuota } = await import("../billing.js");
    const quota = await storageQuota(orgId(req), buf.length);
    if (!quota.ok) {
      return reply.code(413).send({ error: "storage_quota",
        message: "Workspace storage full — upgrade or free space" });
    }
    const { putBlob } = await import("../blobs.js");
    const { key } = await putBlob(buf);
    await run("UPDATE orgs SET brand_logo = $1, brand_logo_mime = $2 WHERE id = $3", [key, mime, orgId(req)]);
    return { logoUrl: `/api/org/brand/${orgId(req)}/logo` };
  });

  app.delete("/api/admin/branding/logo", { preHandler: requireOrgAdmin }, async (req) => {
    await run("UPDATE orgs SET brand_logo = NULL, brand_logo_mime = NULL WHERE id = $1", [orgId(req)]);
    return { ok: true };
  });
}
