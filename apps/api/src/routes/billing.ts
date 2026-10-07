// Workspace billing — subscription status, checkout (Paystack when configured,
// manual bank-transfer otherwise), payment history. Any member can read the
// summary (banner); checkout requires owner/admin.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { q, one, run, now } from "../db.js";
import { requireAuth, signEntitlement, type AuthedRequest } from "../auth.js";
import { summary, createPayment, confirmPayment, paystackInit, paystackVerify, getConfig } from "../billing.js";
import { aiQuotaFor } from "../aiQuota.js";

async function requireOrgAdmin(req: FastifyRequest, reply: FastifyReply) {
  const { user } = req as AuthedRequest;
  if (user.role !== "owner" && user.role !== "admin") {
    return reply.code(403).send({ error: "forbidden", message: "Workspace owner/admin only" });
  }
}

export function billingRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /** Compact summary for the banner — any member can read. */
  app.get("/api/billing/summary", async (req) => {
    const { user } = req as AuthedRequest;
    return summary(user.orgId);
  });

  /**
   * Signed offline entitlement for the desktop app — a JWT snapshot of the
   * workspace's subscription state the client can verify without connectivity
   * (14-day offline grace). The server-side write gate stays authoritative;
   * this only gates the client's local edit surface.
   */
  app.get("/api/billing/entitlement", async (req) => {
    const { user } = req as AuthedRequest;
    const s = await summary(user.orgId);
    const token = await signEntitlement({
      org: user.orgId, status: s.state, seats: s.seats, periodEnd: s.periodEnd ?? null,
    });
    return { token, subscription: s };
  });

  /**
   * AI usage for this workspace this month — requests, tokens, estimated
   * cost, per-member breakdown. Any member can read their org's meter.
   */
  app.get("/api/billing/ai-usage", async (req) => {
    const { user } = req as AuthedRequest;
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
    const [totals, byUser, byDay, byMode, quota] = await Promise.all([
      one<{ requests: string; tokens: string; cost_usd: string }>(
        `SELECT COUNT(*)::text AS requests,
                COALESCE(SUM(prompt_tokens + completion_tokens),0)::text AS tokens,
                (COALESCE(SUM(cost_micros),0)/1000000.0)::text AS cost_usd
         FROM ai_usage WHERE org_id = $1 AND created_at >= $2`, [user.orgId, monthStart]),
      q<{ user_id: string; display_name: string; requests: string; tokens: string }>(
        `SELECT u.user_id, usr.display_name, COUNT(*)::text AS requests,
                COALESCE(SUM(u.prompt_tokens + u.completion_tokens),0)::text AS tokens
         FROM ai_usage u JOIN users usr ON usr.id = u.user_id
         WHERE u.org_id = $1 AND u.created_at >= $2
         GROUP BY u.user_id, usr.display_name ORDER BY SUM(u.prompt_tokens + u.completion_tokens) DESC LIMIT 5`,
        [user.orgId, monthStart]),
      q<{ day: string; requests: string; tokens: string }>(
        `SELECT created_at::date::text AS day, COUNT(*)::text AS requests,
                COALESCE(SUM(prompt_tokens + completion_tokens),0)::text AS tokens
         FROM ai_usage WHERE org_id = $1 AND created_at >= CURRENT_DATE - INTERVAL '29 days'
         GROUP BY 1 ORDER BY 1`, [user.orgId]),
      q<{ mode: string; requests: string; tokens: string }>(
        `SELECT mode, COUNT(*)::text AS requests,
                COALESCE(SUM(prompt_tokens + completion_tokens),0)::text AS tokens
         FROM ai_usage WHERE org_id = $1 AND created_at >= $2
         GROUP BY mode ORDER BY SUM(prompt_tokens + completion_tokens) DESC`,
        [user.orgId, monthStart]),
      aiQuotaFor(user.orgId, user.id),
    ]);
    return {
      month: monthStart,
      requests: Number(totals?.requests ?? 0),
      tokens: Number(totals?.tokens ?? 0),
      costUsd: Number(totals?.cost_usd ?? 0),
      quota,
      byUser: byUser.map((r) => ({ userId: r.user_id, name: r.display_name, requests: Number(r.requests), tokens: Number(r.tokens) })),
      byDay: byDay.map((r) => ({ day: r.day, requests: Number(r.requests), tokens: Number(r.tokens) })),
      byMode: byMode.map((r) => ({ mode: r.mode, requests: Number(r.requests), tokens: Number(r.tokens) })),
    };
  });

  /** Full billing view (status, seats, price, payment history) — owner/admin. */
  app.get("/api/billing", { preHandler: requireOrgAdmin }, async (req) => {
    const { user } = req as AuthedRequest;
    const [s, payments] = await Promise.all([
      summary(user.orgId),
      q(`SELECT id, amount_ngn, seats, months, method, reference, status,
                period_start, period_end, plan, created_at
         FROM payments WHERE org_id = $1 ORDER BY created_at DESC LIMIT 24`, [user.orgId]),
    ]);
    return { subscription: s, payments };
  });

  /**
   * Start checkout — creates a pending payment for the next month.
   * With KREATIX_PAYSTACK_SECRET: returns a Paystack authorization URL.
   * Without it: returns manual/bank-transfer mode and the payment stays
   * pending until the superadmin confirms.
   */
  app.post("/api/billing/checkout", { preHandler: requireOrgAdmin }, async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { months, plan } = z.object({
      months: z.number().int().min(1).max(12).default(1),
      plan: z.enum(["standard", "business"]).default("standard"),
    }).parse(req.body ?? {});
    const p = await createPayment(user.orgId, process.env.KREATIX_PAYSTACK_SECRET ? "paystack" : "manual", undefined, months, plan);
    const cfg = await getConfig();

    if (process.env.KREATIX_PAYSTACK_SECRET) {
      const reference = `kx-${p.id}`;
      await run("UPDATE payments SET reference = $2 WHERE id = $1", [p.id, reference]);
      const base = process.env.KREATIX_PUBLIC_URL ?? `https://${req.headers.host}`;
      const { authorization_url } = await paystackInit(user.email, p.amountNgn, reference, `${base}/admin?paid=1`);
      return { mode: "paystack", authorizationUrl: authorization_url, paymentId: p.id, amountNgn: p.amountNgn };
    }
    return {
      mode: "manual",
      paymentId: p.id,
      amountNgn: p.amountNgn,
      seats: p.seats,
      currency: cfg.currency,
      message: "Bank transfer — quote your workspace name. Payment is confirmed by the platform admin within 24h.",
    };
  });

  /** Paystack callback → verify reference with Paystack → activate. */
  app.post("/api/billing/paystack/verify", { preHandler: requireOrgAdmin }, async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { reference } = z.object({ reference: z.string().min(4).max(80) }).parse(req.body);
    const payment = await one<{ id: string; status: string; amount_ngn: number }>(
      "SELECT id, status, amount_ngn FROM payments WHERE reference = $1 AND org_id = $2", [reference, user.orgId]);
    if (!payment) return reply.code(404).send({ error: "not_found", message: "Unknown payment reference" });
    if (payment.status === "confirmed") return { ok: true, already: true };

    const v = await paystackVerify(reference);
    if (!v.ok) return reply.code(402).send({ error: "payment_failed", message: "Payment not confirmed by Paystack" });
    // never grant a term for a charge smaller than the pending payment
    if (v.amountNgn < payment.amount_ngn) {
      return reply.code(402).send({ error: "amount_mismatch", message: "Verified amount is below the payment total" });
    }
    await confirmPayment(payment.id, user.id);
    return { ok: true };
  });
}
