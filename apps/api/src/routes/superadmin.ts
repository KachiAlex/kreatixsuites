// Platform superadmin — pricing config, all workspaces, payment confirmation.
// Every route requires auth + users.is_super (seeded from env, not per-org).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { q, one, run, now } from "../db.js";
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
      amount_ngn: number | null; override_until: string | null; ai_token_budget: number | null;
    }>(
      `SELECT o.id, o.name, o.created_at,
              (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id AND NOT u.disabled) AS seats,
              s.status, s.trial_ends_at, s.period_end, s.amount_ngn, s.override_until, s.ai_token_budget
       FROM orgs o LEFT JOIN subscriptions s ON s.org_id = o.id
       ORDER BY o.created_at DESC LIMIT 500`);
    const cfg = await getConfig();
    return {
      orgs: rows.map((r) => ({
        ...r,
        state: r.status ? effectiveState({ org_id: r.id, seats: r.seats, ...pickSub(r) }).state : "none",
        monthlyAmountNgn: monthlyAmount(cfg, r.seats),
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
    return { subscription: await ensureSubscription(orgId) };
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
}

function pickSub(r: { status: string | null; trial_ends_at: string | null; period_end: string | null; override_until: string | null; amount_ngn: number | null }) {
  return {
    status: r.status!, trial_ends_at: r.trial_ends_at, period_start: null,
    period_end: r.period_end, amount_ngn: r.amount_ngn, override_until: r.override_until,
  };
}
