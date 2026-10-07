// Platform superadmin — pricing config, all workspaces, payment confirmation.
// Every route requires auth + users.is_super (seeded from env, not per-org).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { q, one, run, now, tx, DATA_DIR } from "../db.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import {
  getConfig, setConfig, ensureSubscription, confirmPayment, seatCount,
  monthlyAmount, effectiveState,
} from "../billing.js";
import { mailEnabled, sendMail, tpl } from "../email.js";
import { limits } from "../aiQuota.js";

async function requireSuper(req: FastifyRequest, reply: FastifyReply) {
  const { user } = req as AuthedRequest;
  if (!user.isSuper) return reply.code(403).send({ error: "forbidden", message: "Superadmin only" });
}

export function superadminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireSuper);

  /** Platform overview: orgs, seats, MRR, pending payments. */
  app.get("/api/superadmin/overview", async () => {
    const count = async (sql: string, params?: unknown[]) => ((await one<{ n: number }>(sql, params))?.n ?? 0);
    const mrr = await one<{ total: number | null }>(
      `SELECT SUM(amount_ngn) AS total FROM subscriptions WHERE status = 'active' AND period_end > $1`, [now()]);
    return {
      orgs: await count("SELECT COUNT(*) n FROM orgs"),
      users: await count("SELECT COUNT(*) n FROM users WHERE NOT disabled"),
      activeSubs: await count("SELECT COUNT(*) n FROM subscriptions WHERE status = 'active' AND period_end > $1", [now()]),
      trialing: await count("SELECT COUNT(*) n FROM subscriptions WHERE status = 'trialing' AND trial_ends_at > $1", [now()]),
      locked: await count(
        `SELECT COUNT(*) n FROM subscriptions s WHERE
           COALESCE(s.override_until, '1970-01-01'::timestamptz) < $1 AND (
             (s.status = 'trialing' AND COALESCE(s.trial_ends_at, '1970-01-01'::timestamptz) + interval '7 days' < $1)
             OR (s.status = 'active' AND COALESCE(s.period_end, '1970-01-01'::timestamptz) + interval '7 days' < $1)
             OR s.status = 'canceled')`, [now()]),
      pendingPayments: await count("SELECT COUNT(*) n FROM payments WHERE status = 'pending'"),
      mrrNgn: mrr?.total ?? 0,
    };
  });

  /** All workspaces with seat counts + subscription state. */
  app.get("/api/superadmin/orgs", async () => {
    const rows = await q<{
      id: string; name: string; created_at: string; seats: number;
      status: string | null; trial_ends_at: string | null; period_end: string | null;
      amount_ngn: number | null; override_until: string | null; ai_token_budget: number | null; plan: string | null;
    }>(
      `SELECT o.id, o.name, o.created_at,
              (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id AND NOT u.disabled) AS seats,
              s.status, s.trial_ends_at, s.period_end, s.amount_ngn, s.override_until, s.ai_token_budget, s.plan,
              EXISTS(SELECT 1 FROM users su WHERE su.org_id = o.id AND su.is_super) AS has_super
       FROM orgs o LEFT JOIN subscriptions s ON s.org_id = o.id
       ORDER BY o.created_at DESC LIMIT 500`);
    const cfg = await getConfig();
    return {
      orgs: rows.map((r) => ({
        ...r,
        state: r.status ? effectiveState({ org_id: r.id, seats: r.seats, ...pickSub(r) }).state : "none",
        monthlyAmountNgn: monthlyAmount(cfg, r.seats, r.plan === "business" ? "business" : "standard"),
      })),
    };
  });

  /** Pricing/plan config — what every workspace pays. */
  app.get("/api/superadmin/billing-config", async () => ({ config: await getConfig() }));

  app.put("/api/superadmin/billing-config", async (req) => {
    const patch = z.object({
      base_price_ngn: z.number().int().min(0).max(10_000_000).optional(),
      member_price_ngn: z.number().int().min(0).max(10_000_000).optional(),
      trial_months: z.number().int().min(0).max(24).optional(),
      business_multiplier: z.number().int().min(1).max(10).optional(),
      currency: z.string().min(3).max(8).optional(),
    }).parse(req.body);
    return { config: await setConfig(patch) };
  });

  /** Payment queue — confirm (bank transfer) or reject. */
  app.get("/api/superadmin/payments", async (req) => {
    const status = ((req.query as { status?: string }).status ?? "pending");
    const rows = await q(
      `SELECT p.*, o.name AS org_name FROM payments p
       JOIN orgs o ON o.id = p.org_id
       WHERE ($1::text IS NULL OR p.status = $1)
       ORDER BY p.created_at DESC LIMIT 200`, [status === "all" ? null : status]);
    return { payments: rows };
  });

  app.post("/api/superadmin/payments/:id/confirm", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const id = (req.params as { id: string }).id;
    const sub = await confirmPayment(id, user.id);
    if (!sub) return reply.code(404).send({ error: "not_found" });
    return { ok: true, subscription: sub };
  });

  app.post("/api/superadmin/payments/:id/reject", async (req) => {
    const id = (req.params as { id: string }).id;
    await run("UPDATE payments SET status = 'rejected', confirmed_by = $2 WHERE id = $1 AND status = 'pending'", [id, (req as AuthedRequest).user.id]);
    return { ok: true };
  });

  /** Send a test transactional email — verifies Brevo wiring end-to-end. */
  app.post("/api/superadmin/test-email", async (req, reply) => {
    if (!mailEnabled()) return reply.code(503).send({ error: "disabled", message: "KREATIX_BREVO_API_KEY not set" });
    const { to } = z.object({ to: z.string().email() }).parse(req.body);
    const r = await sendMail({ to, ...tpl.welcome("there", "Test Workspace") });
    return { ok: r.ok, messageId: r.messageId };
  });

  /** Per-workspace subscription control — comp time, extend trial, cancel. */
  app.patch("/api/superadmin/orgs/:id/subscription", async (req, reply) => {
    const orgId = (req.params as { id: string }).id;
    if (!(await one("SELECT id FROM orgs WHERE id = $1", [orgId]))) {
      return reply.code(404).send({ error: "not_found" });
    }
    const body = z.object({
      overrideUntil: z.string().datetime().nullable().optional(), // comp N months / grant access
      extendTrialDays: z.number().int().min(1).max(730).optional(),
      status: z.enum(["canceled"]).optional(),
      aiTokenBudget: z.number().int().min(0).nullable().optional(), // AI quota override (null = computed)
      plan: z.enum(["standard", "business"]).optional(),            // AI budget tier
    }).parse(req.body);
    await ensureSubscription(orgId);
    if (body.extendTrialDays) {
      await run(
        `UPDATE subscriptions SET trial_ends_at = COALESCE(trial_ends_at, $2) + ($3 || ' days')::interval, updated_at = $2
         WHERE org_id = $1`,
        [orgId, now(), String(body.extendTrialDays)]);
    }
    if (body.overrideUntil !== undefined) {
      await run("UPDATE subscriptions SET override_until = $2, updated_at = $3 WHERE org_id = $1",
        [orgId, body.overrideUntil, now()]);
    }
    if (body.status === "canceled") {
      await run("UPDATE subscriptions SET status = 'canceled', updated_at = $2 WHERE org_id = $1", [orgId, now()]);
    }
    if (body.aiTokenBudget !== undefined) {
      await run("UPDATE subscriptions SET ai_token_budget = $2, updated_at = $3 WHERE org_id = $1",
        [orgId, body.aiTokenBudget, now()]);
    }
    if (body.plan !== undefined) {
      await run("UPDATE subscriptions SET plan = $2, updated_at = $3 WHERE org_id = $1",
        [orgId, body.plan, now()]);
    }
    return { subscription: await ensureSubscription(orgId) };
  });

  /** User feedback stream — newest first, optional sentiment filter. */
  app.get("/api/superadmin/feedback", async (req) => {
    const sentiment = (req.query as { sentiment?: string }).sentiment || null;
    const [rows, stats] = await Promise.all([
      q(
        `SELECT f.id, f.sentiment, f.message, f.reply, f.replied_at, f.page, f.created_at,
                o.name AS org_name, u.display_name, u.email
         FROM feedback f
         JOIN orgs o ON o.id = f.org_id
         JOIN users u ON u.id = f.user_id
         WHERE ($1::text IS NULL OR f.sentiment = $1)
         ORDER BY f.created_at DESC LIMIT 300`, [sentiment]),
      q<{ sentiment: string; n: string }>(
        `SELECT sentiment, COUNT(*)::text AS n FROM feedback
         WHERE created_at >= CURRENT_DATE - INTERVAL '29 days' GROUP BY sentiment`, []),
    ]);
    return { feedback: rows, stats: Object.fromEntries(stats.map((s) => [s.sentiment, Number(s.n)])) };
  });

  /** Reply to a feedback item — lands in the user's widget thread + their inbox. */
  app.post("/api/superadmin/feedback/:id/reply", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { id } = req.params as { id: string };
    const { message } = z.object({ message: z.string().min(1).max(2000) }).parse(req.body ?? {});
    const fb = await one<{ user_id: string; message: string }>(
      "SELECT user_id, message FROM feedback WHERE id = $1", [id]);
    if (!fb) return reply.code(404).send({ error: "not_found", message: "Feedback not found" });
    await run("UPDATE feedback SET reply = $2, replied_at = $3, replied_by = $4 WHERE id = $1",
      [id, message.trim(), now(), user.id]);
    const target = await one<{ email: string; display_name: string; disabled: boolean }>(
      "SELECT email, display_name, disabled FROM users WHERE id = $1", [fb.user_id]);
    if (target && !target.disabled && mailEnabled()) {
      sendMail({ to: target.email, ...tpl.feedbackReply(target.display_name, fb.message, message.trim()) })
        .catch((e) => req.log.warn({ err: String(e), to: target.email }, "feedback reply email failed"));
    }
    return { ok: true };
  });

  /** Platform AI spend this month + heaviest workspaces (cost control). */
  app.get("/api/superadmin/ai-usage", async () => {
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
    const [totals, topOrgs] = await Promise.all([
      one<{ requests: string; tokens: string; cost_usd: string }>(
        `SELECT COUNT(*)::text AS requests,
                COALESCE(SUM(prompt_tokens + completion_tokens),0)::text AS tokens,
                (COALESCE(SUM(cost_micros),0)/1000000.0)::text AS cost_usd
         FROM ai_usage WHERE created_at >= $1`, [monthStart]),
      q<{ org_id: string; name: string; requests: string; tokens: string; cost_usd: string }>(
        `SELECT u.org_id, o.name, COUNT(*)::text AS requests,
                COALESCE(SUM(u.prompt_tokens + u.completion_tokens),0)::text AS tokens,
                (COALESCE(SUM(u.cost_micros),0)/1000000.0)::text AS cost_usd
         FROM ai_usage u JOIN orgs o ON o.id = u.org_id
         WHERE u.created_at >= $1
         GROUP BY u.org_id, o.name ORDER BY SUM(u.cost_micros) DESC LIMIT 20`, [monthStart]),
    ]);
    return {
      month: monthStart,
      requests: Number(totals?.requests ?? 0),
      tokens: Number(totals?.tokens ?? 0),
      costUsd: Number(totals?.cost_usd ?? 0),
      budgetUsd: limits.platformBudgetUsd(),
      topOrgs: topOrgs.map((r) => ({ orgId: r.org_id, name: r.name, requests: Number(r.requests), tokens: Number(r.tokens), costUsd: Number(r.cost_usd) })),
    };
  });

  /** Hard-delete one workspace — full tenant purge (DB rows + orphan blobs). */
  app.delete("/api/superadmin/orgs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await deleteOrg(id);
    if (!r.ok) {
      return reply.code(r.error === "not_found" ? 404 : 409).send({
        error: r.error,
        message: r.error === "super_org"
          ? "This workspace hosts a platform superadmin account and cannot be deleted"
          : "Workspace not found",
      });
    }
    return r;
  });

  /** Bulk hard-delete — each workspace purged in its own transaction. */
  app.post("/api/superadmin/orgs/delete", async (req, reply) => {
    const parsed = z.object({ ids: z.array(z.string().min(1)).min(1).max(100) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request", message: "Expected { ids: string[] }" });
    const results = [];
    for (const id of parsed.data.ids) results.push({ id, ...(await deleteOrg(id)) });
    return { results, deleted: results.filter((r) => r.ok).length };
  });
}

interface OrgDeleteResult {
  ok: boolean; error?: "not_found" | "super_org";
  name?: string; users?: number; files?: number; blobs?: number;
}

/** Ordered tenant purge. Several tables lack ON DELETE CASCADE, so children go
 *  first: rows keyed by this org's files, then rows keyed by its users, then
 *  org-scoped rows, then the org itself — all in one transaction. Blob files
 *  are content-addressed (deduped), so only orphans get unlinked afterwards. */
async function deleteOrg(orgId: string): Promise<OrgDeleteResult> {
  const org = await one<{ id: string; name: string }>("SELECT id, name FROM orgs WHERE id = $1", [orgId]);
  if (!org) return { ok: false, error: "not_found" };
  // never delete an org that hosts a superadmin — that would brick the portal account
  if (await one("SELECT 1 AS x FROM users WHERE org_id = $1 AND is_super", [orgId])) {
    return { ok: false, error: "super_org" };
  }

  let stats = { users: 0, files: 0 };
  const blobKeys = await tx(async (c) => {
    const del = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rowCount ?? 0;
    const fileIds = (await c.query<{ id: string }>("SELECT id FROM items WHERE org_id = $1", [orgId])).rows.map((r) => r.id);
    const userIds = (await c.query<{ id: string }>("SELECT id FROM users WHERE org_id = $1", [orgId])).rows.map((r) => r.id);
    const keys = fileIds.length
      ? (await c.query<{ blob_key: string }>("SELECT DISTINCT blob_key FROM versions WHERE file_id = ANY($1)", [fileIds])).rows.map((r) => r.blob_key)
      : [];
    if (fileIds.length) {
      for (const t of ["search_index", "mentions", "ai_actions", "comments", "share_links", "shares", "collab_states", "versions"]) {
        await del(`DELETE FROM ${t} WHERE file_id = ANY($1)`, [fileIds]);
      }
      await del("DELETE FROM items WHERE org_id = $1", [orgId]);
    }
    if (userIds.length) {
      // belt & braces — rows in other orgs that reference these users
      await del("DELETE FROM mentions WHERE from_user_id = ANY($1) OR to_user_id = ANY($1)", [userIds]);
      await del("DELETE FROM comments WHERE author_id = ANY($1)", [userIds]);
      await del("DELETE FROM activity WHERE actor_id = ANY($1)", [userIds]);
      await del("DELETE FROM ai_usage WHERE user_id = ANY($1)", [userIds]);
      await del("DELETE FROM ai_actions WHERE user_id = ANY($1)", [userIds]);
      await del("DELETE FROM feedback WHERE user_id = ANY($1)", [userIds]);
      await del("DELETE FROM org_invites WHERE created_by = ANY($1)", [userIds]);
      stats.users = await del("DELETE FROM users WHERE org_id = $1", [orgId]);
    }
    for (const t of ["activity", "org_policies", "scim_tokens", "org_invites", "payments", "subscriptions", "feedback", "ai_usage"]) {
      await del(`DELETE FROM ${t} WHERE org_id = $1`, [orgId]);
    }
    stats.files = fileIds.length;
    await del("DELETE FROM orgs WHERE id = $1", [orgId]);
    return keys;
  });

  // blobs are content-addressed — only unlink keys no remaining version needs
  let blobs = 0;
  for (const key of blobKeys) {
    if (await one("SELECT 1 AS x FROM versions WHERE blob_key = $1 LIMIT 1", [key])) continue;
    try {
      unlinkSync(join(DATA_DIR, "blobs", key.slice(0, 2), key));
      blobs++;
    } catch { /* already gone — non-fatal */ }
  }
  return { ok: true, name: org.name, users: stats.users, files: stats.files, blobs };
}

function pickSub(r: { status: string | null; trial_ends_at: string | null; period_end: string | null; override_until: string | null; amount_ngn: number | null }) {
  return {
    status: r.status!, trial_ends_at: r.trial_ends_at, period_start: null,
    period_end: r.period_end, amount_ngn: r.amount_ngn, override_until: r.override_until,
  };
}
