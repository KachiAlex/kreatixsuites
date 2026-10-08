// Platform superadmin — pricing config, all workspaces, payment confirmation.
// Every route requires auth + users.is_super (seeded from env, not per-org).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { q, one, run, now, tx, DATA_DIR } from "../db.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import {
  getConfig, setConfig, ensureSubscription, confirmPayment, seatCount,
  monthlyAmount, effectiveState, getPlans, resolvePlan, bustPlanCache, type Plan,
} from "../billing.js";
import { mailEnabled, sendMail, tpl } from "../email.js";
import { limits } from "../aiQuota.js";

async function requireSuper(req: FastifyRequest, reply: FastifyReply) {
  const { user } = req as AuthedRequest;
  if (!user.isSuper) return reply.code(403).send({ error: "forbidden", message: "Superadmin only" });
}

/** Append-only operator log — actor denormalized (users/orgs may be deleted later). */
async function logSa(user: { id: string; email: string }, action: string, target?: string | null, detail?: unknown) {
  try {
    await run(
      "INSERT INTO sa_audit (id, actor_id, actor_email, action, target, detail, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [randomUUID(), user.id, user.email, action, target ?? null,
       detail == null ? null : typeof detail === "string" ? detail : JSON.stringify(detail), now()]);
  } catch (e) { console.warn("[sa_audit] write failed:", e); }
}

export function superadminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireSuper);

  /** Platform overview: orgs, seats, MRR, pending payments. */
  app.get("/api/superadmin/overview", async () => {
    const count = async (sql: string, params?: unknown[]) => ((await one<{ n: number }>(sql, params))?.n ?? 0);
    const mrr = await one<{ total: number | null }>(
      `SELECT SUM(amount_ngn) AS total FROM subscriptions WHERE status = 'active' AND period_end > $1`, [now()]);
    const orgs = await count("SELECT COUNT(*) n FROM orgs");
    const activeSubs = await count("SELECT COUNT(*) n FROM subscriptions WHERE status = 'active' AND period_end > $1", [now()]);
    const trialing = await count("SELECT COUNT(*) n FROM subscriptions WHERE status = 'trialing' AND trial_ends_at > $1", [now()]);
    const locked = await count("SELECT COUNT(*) n FROM subscriptions WHERE status = 'suspended'", []);
    const granted = await count("SELECT COUNT(*) n FROM subscriptions WHERE override_until > $1", [now()]);
    return {
      orgs,
      users: await count("SELECT COUNT(*) n FROM users WHERE NOT disabled"),
      activeSubs, trialing, locked, granted,
      freeTier: Math.max(0, orgs - activeSubs - trialing - locked - granted),
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
    const plans = await getPlans();
    return {
      orgs: rows.map((r) => ({
        ...r,
        state: r.status ? effectiveState({ org_id: r.id, seats: r.seats, ...pickSub(r) }).state : "none",
        monthlyAmountNgn: monthlyAmount(resolvePlan(plans, r.plan), r.seats),
      })),
    };
  });

  /** Plan catalog — pricing tiers + entitlement matrix, editable below. */
  app.get("/api/superadmin/plans", async () => ({ plans: await getPlans() }));

  app.put("/api/superadmin/plans/:slug", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const slug = (req.params as { slug: string }).slug;
    const body = z.object({
      name: z.string().min(1).max(60).optional(),
      price_ngn: z.number().int().min(0).max(100_000_000).optional(),
      member_price_ngn: z.number().int().min(0).max(100_000_000).optional(),
      features: z.record(z.string(), z.boolean()).optional(),
      limits: z.record(z.string(), z.number().int().min(0).max(1_000_000_000)).optional(),
      active: z.boolean().optional(),
      sort: z.number().int().min(0).max(999).optional(),
    }).parse(req.body);
    const before = await one<Plan>("SELECT * FROM plans WHERE slug = $1", [slug]);
    if (!before) return reply.code(404).send({ error: "not_found" });
    const after: Plan = {
      ...before,
      name: body.name ?? before.name,
      price_ngn: body.price_ngn ?? before.price_ngn,
      member_price_ngn: body.member_price_ngn ?? before.member_price_ngn,
      features: body.features ? { ...before.features, ...body.features } : before.features,
      limits: body.limits ? { ...before.limits, ...body.limits } : before.limits,
      active: body.active ?? before.active,
      sort: body.sort ?? before.sort,
    };
    if (after.slug === "free" && (after.price_ngn > 0 || after.member_price_ngn > 0)) {
      return reply.code(400).send({ error: "bad_request", message: "The free plan must stay priced at ₦0" });
    }
    if (!after.active && after.slug === "free") {
      return reply.code(400).send({ error: "bad_request", message: "The free plan cannot be deactivated" });
    }
    await run(
      `UPDATE plans SET name=$2, price_ngn=$3, member_price_ngn=$4, features=$5, limits=$6, active=$7, sort=$8 WHERE slug=$1`,
      [slug, after.name, after.price_ngn, after.member_price_ngn,
       JSON.stringify(after.features), JSON.stringify(after.limits), after.active, after.sort]);
    bustPlanCache();
    await logSa(user, "plan.update", `${after.name} (${slug})`,
      { priceNgn: { from: before.price_ngn, to: after.price_ngn },
        memberPriceNgn: { from: before.member_price_ngn, to: after.member_price_ngn },
        featuresChanged: Object.keys(body.features ?? {}).filter((k) => before.features?.[k] !== after.features[k]),
        limitsChanged: Object.keys(body.limits ?? {}).filter((k) => before.limits?.[k] !== after.limits[k]),
        active: { from: before.active, to: after.active } });
    return { plan: after };
  });

  app.post("/api/superadmin/plans", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const body = z.object({
      slug: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
      name: z.string().min(1).max(60),
      price_ngn: z.number().int().min(0).max(100_000_000),
      member_price_ngn: z.number().int().min(0).max(100_000_000).default(0),
      features: z.record(z.string(), z.boolean()).default({}),
      limits: z.record(z.string(), z.number().int().min(0).max(1_000_000_000)).default({}),
    }).parse(req.body);
    if (await one("SELECT slug FROM plans WHERE slug = $1", [body.slug])) {
      return reply.code(409).send({ error: "conflict", message: "Plan slug already exists" });
    }
    await run(
      `INSERT INTO plans (slug, name, price_ngn, member_price_ngn, features, limits, sort) VALUES ($1,$2,$3,$4,$5,$6,99)`,
      [body.slug, body.name, body.price_ngn, body.member_price_ngn,
       JSON.stringify(body.features), JSON.stringify(body.limits)]);
    bustPlanCache();
    await logSa(user, "plan.create", `${body.name} (${body.slug})`, { priceNgn: body.price_ngn, memberPriceNgn: body.member_price_ngn });
    return { plan: await one("SELECT * FROM plans WHERE slug = $1", [body.slug]) };
  });

  /** Pricing/plan config — what every workspace pays. */
  app.get("/api/superadmin/billing-config", async () => ({ config: await getConfig() }));

  app.put("/api/superadmin/billing-config", async (req) => {
    const { user } = req as AuthedRequest;
    const patch = z.object({
      base_price_ngn: z.number().int().min(0).max(10_000_000).optional(),
      member_price_ngn: z.number().int().min(0).max(10_000_000).optional(),
      trial_months: z.number().int().min(0).max(24).optional(),
      business_multiplier: z.number().int().min(1).max(10).optional(),
      currency: z.string().min(3).max(8).optional(),
    }).parse(req.body);
    const before = await getConfig();
    const config = await setConfig(patch);
    const changes = Object.fromEntries(
      Object.entries(patch).map(([k, v]) => [k, { from: (before as unknown as Record<string, unknown>)[k], to: v }]));
    await logSa(user, "config.pricing", "platform billing", changes);
    return { config };
  });

  /** Payment queue — confirm (bank transfer) or reject. */
  app.get("/api/superadmin/payments", async (req) => {
    const { status = "pending", from, to } = req.query as { status?: string; from?: string; to?: string };
    const rows = await q(
      `SELECT p.*, o.name AS org_name FROM payments p
       JOIN orgs o ON o.id = p.org_id
       WHERE ($1::text IS NULL OR p.status = $1)
         AND ($2::timestamptz IS NULL OR p.created_at >= $2::timestamptz)
         AND ($3::timestamptz IS NULL OR p.created_at < $3::timestamptz)
       ORDER BY p.created_at DESC LIMIT 500`,
      [status === "all" ? null : status, from || null, to || null]);
    return { payments: rows };
  });

  app.post("/api/superadmin/payments/:id/confirm", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const id = (req.params as { id: string }).id;
    const pay = await one<{ amount_ngn: number; reference: string | null; org_name: string; status: string }>(
      `SELECT p.amount_ngn, p.reference, o.name AS org_name, p.status
       FROM payments p JOIN orgs o ON o.id = p.org_id WHERE p.id = $1`, [id]);
    const sub = await confirmPayment(id, user.id);
    if (!sub) return reply.code(404).send({ error: "not_found" });
    await logSa(user, "payment.confirm", pay?.org_name ?? id,
      { amountNgn: pay?.amount_ngn, reference: pay?.reference, priorStatus: pay?.status });
    return { ok: true, subscription: sub };
  });

  app.post("/api/superadmin/payments/:id/reject", async (req) => {
    const { user } = req as AuthedRequest;
    const id = (req.params as { id: string }).id;
    const pay = await one<{ amount_ngn: number; reference: string | null; org_name: string }>(
      `SELECT p.amount_ngn, p.reference, o.name AS org_name
       FROM payments p JOIN orgs o ON o.id = p.org_id WHERE p.id = $1`, [id]);
    await run("UPDATE payments SET status = 'rejected', confirmed_by = $2 WHERE id = $1 AND status = 'pending'", [id, user.id]);
    await logSa(user, "payment.reject", pay?.org_name ?? id, { amountNgn: pay?.amount_ngn, reference: pay?.reference });
    return { ok: true };
  });

  /** Send a test transactional email — verifies Brevo wiring end-to-end. */
  app.post("/api/superadmin/test-email", async (req, reply) => {
    if (!mailEnabled()) return reply.code(503).send({ error: "disabled", message: "KREATIX_BREVO_API_KEY not set" });
    const { user } = req as AuthedRequest;
    const { to } = z.object({ to: z.string().email() }).parse(req.body);
    const r = await sendMail({ to, ...tpl.welcome("there", "Test Workspace") });
    await logSa(user, "email.test", to, { ok: r.ok, messageId: r.messageId });
    return { ok: r.ok, messageId: r.messageId };
  });

  /** Per-workspace subscription control — comp time, extend trial, cancel. */
  app.patch("/api/superadmin/orgs/:id/subscription", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const orgId = (req.params as { id: string }).id;
    const orgRow = await one<{ name: string }>("SELECT name FROM orgs WHERE id = $1", [orgId]);
    if (!orgRow) {
      return reply.code(404).send({ error: "not_found" });
    }
    const body = z.object({
      overrideUntil: z.string().datetime().nullable().optional(), // comp N months / grant access
      extendTrialDays: z.number().int().min(1).max(730).optional(),
      status: z.enum(["canceled"]).optional(),
      aiTokenBudget: z.number().int().min(0).nullable().optional(), // AI quota override (null = computed)
      plan: z.string().min(1).max(40).optional(),                   // plan slug from the catalog
    }).parse(req.body);
    await ensureSubscription(orgId);
    const applied: Record<string, unknown> = {};
    if (body.extendTrialDays) {
      await run(
        `UPDATE subscriptions SET trial_ends_at = COALESCE(trial_ends_at, $2) + ($3 || ' days')::interval, updated_at = $2
         WHERE org_id = $1`,
        [orgId, now(), String(body.extendTrialDays)]);
      applied.extendTrialDays = body.extendTrialDays;
    }
    if (body.overrideUntil !== undefined) {
      await run("UPDATE subscriptions SET override_until = $2, updated_at = $3 WHERE org_id = $1",
        [orgId, body.overrideUntil, now()]);
      applied.overrideUntil = body.overrideUntil;
    }
    if (body.status === "canceled") {
      await run("UPDATE subscriptions SET status = 'canceled', updated_at = $2 WHERE org_id = $1", [orgId, now()]);
      applied.status = "canceled";
    }
    if (body.aiTokenBudget !== undefined) {
      await run("UPDATE subscriptions SET ai_token_budget = $2, updated_at = $3 WHERE org_id = $1",
        [orgId, body.aiTokenBudget, now()]);
      applied.aiTokenBudget = body.aiTokenBudget;
    }
    if (body.plan !== undefined) {
      const pl = (await getPlans(true)).find((p) => p.slug === body.plan);
      if (!pl) return reply.code(400).send({ error: "bad_plan", message: "Unknown or inactive plan" });
      await run("UPDATE subscriptions SET plan = $2, updated_at = $3 WHERE org_id = $1",
        [orgId, pl.slug, now()]);
      applied.plan = pl.slug;
    }
    if (Object.keys(applied).length) await logSa(user, "org.subscription", orgRow.name, applied);
    return { subscription: await ensureSubscription(orgId) };
  });

  /** Workspace drill-down — metadata only (never file contents). */
  app.get("/api/superadmin/orgs/:id/detail", async (req, reply) => {
    const orgId = (req.params as { id: string }).id;
    const org = await one<{ id: string; name: string; created_at: string; seats: string }>(
      `SELECT o.id, o.name, o.created_at,
              (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id AND NOT u.disabled)::text AS seats
       FROM orgs o WHERE o.id = $1`, [orgId]);
    if (!org) return reply.code(404).send({ error: "not_found" });
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
    const [members, sub, usage, ai, payments, fbCount] = await Promise.all([
      q(`SELECT id, display_name, email, initials, role, is_super, disabled, created_at,
                (SELECT MAX(a.created_at) FROM activity a WHERE a.actor_id = u.id) AS last_active
         FROM users u WHERE u.org_id = $1 ORDER BY u.created_at ASC`, [orgId]),
      ensureSubscription(orgId),
      one<{ files: string; bytes: string; versions: string; comments: string }>(
        `SELECT COUNT(*)::text AS files,
                COALESCE(SUM(size),0)::text AS bytes,
                (SELECT COUNT(*) FROM versions v JOIN items i ON i.id = v.file_id WHERE i.org_id = $1)::text AS versions,
                (SELECT COUNT(*) FROM comments c JOIN items i ON i.id = c.file_id WHERE i.org_id = $1)::text AS comments
         FROM items WHERE org_id = $1`, [orgId]),
      one<{ requests: string; tokens: string; cost_usd: string }>(
        `SELECT COUNT(*)::text AS requests,
                COALESCE(SUM(prompt_tokens + completion_tokens),0)::text AS tokens,
                (COALESCE(SUM(cost_micros),0)/1000000.0)::text AS cost_usd
         FROM ai_usage WHERE org_id = $1 AND created_at >= $2`, [orgId, monthStart]),
      q(`SELECT id, amount_ngn, method, reference, plan, status, created_at
         FROM payments WHERE org_id = $1 ORDER BY created_at DESC LIMIT 50`, [orgId]),
      one<{ n: string }>("SELECT COUNT(*)::text AS n FROM feedback WHERE org_id = $1", [orgId]),
    ]);
    const plans = await getPlans();
    return {
      org: {
        id: org.id, name: org.name, createdAt: org.created_at, seats: Number(org.seats),
        subscription: sub,
        state: sub.status ? effectiveState({ org_id: org.id, seats: Number(org.seats), ...pickSub(sub) }).state : "none",
        monthlyAmountNgn: monthlyAmount(resolvePlan(plans, sub.plan), Number(org.seats)),
      },
      members,
      usage: { files: Number(usage?.files ?? 0), bytes: Number(usage?.bytes ?? 0), versions: Number(usage?.versions ?? 0), comments: Number(usage?.comments ?? 0) },
      ai: { requests: Number(ai?.requests ?? 0), tokens: Number(ai?.tokens ?? 0), costUsd: Number(ai?.cost_usd ?? 0) },
      payments,
      feedbackCount: Number(fbCount?.n ?? 0),
    };
  });

  /** Enable/disable a member account in a workspace — support action, audited. */
  app.post("/api/superadmin/orgs/:orgId/members/:userId", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { orgId, userId } = req.params as { orgId: string; userId: string };
    const { disabled } = z.object({ disabled: z.boolean() }).parse(req.body);
    const member = await one<{ email: string; display_name: string; is_super: boolean; disabled: boolean }>(
      "SELECT email, display_name, is_super, disabled FROM users WHERE id = $1 AND org_id = $2", [userId, orgId]);
    if (!member) return reply.code(404).send({ error: "not_found" });
    if (member.is_super) return reply.code(409).send({ error: "protected", message: "Superadmin accounts cannot be disabled from here" });
    if (userId === user.id) return reply.code(409).send({ error: "self", message: "Cannot disable your own account" });
    await run("UPDATE users SET disabled = $2 WHERE id = $1", [userId, disabled]);
    await logSa(user, disabled ? "member.disable" : "member.enable", member.email, { orgId });
    return { ok: true, disabled };
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
    await logSa(user, "feedback.reply", target?.email ?? fb.user_id, { feedbackId: id });
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
    const { user } = req as AuthedRequest;
    const { id } = req.params as { id: string };
    const r = await deleteOrg(id).catch((e) => {
      req.log.error(e, `org delete failed: ${id}`);
      return { ok: false as const, error: "failed" as const };
    });
    if (!r.ok) {
      const code = r.error === "not_found" ? 404 : r.error === "super_org" ? 409 : 500;
      return reply.code(code).send({
        error: r.error,
        message: r.error === "super_org"
          ? "This workspace hosts a platform superadmin account and cannot be deleted"
          : r.error === "not_found" ? "Workspace not found" : "Delete failed — check server logs",
      });
    }
    await logSa(user, "org.delete", r.name ?? id, { users: r.users, files: r.files, blobs: r.blobs });
    return r;
  });

  /** Bulk hard-delete — each workspace purged in its own transaction. */
  app.post("/api/superadmin/orgs/delete", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const parsed = z.object({ ids: z.array(z.string().min(1)).min(1).max(100) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request", message: "Expected { ids: string[] }" });
    const results = [];
    for (const id of parsed.data.ids) {
      try {
        results.push({ id, ...(await deleteOrg(id)) });
      } catch (e) {
        req.log.error(e, `org delete failed: ${id}`);
        results.push({ id, ok: false, error: "failed" });
      }
    }
    const deleted = results.filter((r) => r.ok);
    if (deleted.length) {
      await logSa(user, "org.delete.bulk", `${deleted.length} workspaces`,
        { deleted: deleted.map((r) => ({ id: r.id, name: (r as { name?: string }).name })), attempted: parsed.data.ids.length });
    }
    return { results, deleted: deleted.length };
  });

  /** Append-only audit trail — newest first, optional action/target filters. */
  app.get("/api/superadmin/audit", async (req) => {
    const { action, q: search } = req.query as { action?: string; q?: string };
    const rows = await q(
      `SELECT id, actor_email, action, target, detail, created_at
       FROM sa_audit
       WHERE ($1::text IS NULL OR action = $1)
         AND ($2::text IS NULL OR target ILIKE '%' || $2 || '%' OR actor_email ILIKE '%' || $2 || '%')
       ORDER BY created_at DESC LIMIT 300`,
      [action || null, search || null]);
    return { audit: rows };
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
      // cross-org safety: content these users authored on OTHER workspaces'
      // files (shared-file edits) is reassigned to each file's owner so the
      // other tenant keeps its history; ephemeral traces are deleted.
      await del("UPDATE versions v SET created_by = (SELECT owner_id FROM items i WHERE i.id = v.file_id) WHERE v.created_by = ANY($1)", [userIds]);
      await del("UPDATE comments c SET author_id = (SELECT owner_id FROM items i WHERE i.id = c.file_id) WHERE c.author_id = ANY($1)", [userIds]);
      await del("UPDATE items SET owner_id = (SELECT u2.id FROM users u2 WHERE u2.org_id = items.org_id ORDER BY NOT u2.disabled DESC, u2.created_at LIMIT 1) WHERE owner_id = ANY($1) AND org_id <> $2", [userIds, orgId]);
      await del("DELETE FROM mentions WHERE from_user_id = ANY($1) OR to_user_id = ANY($1)", [userIds]);
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
