// AI entitlement + quota — every /api/ai chat request passes checkAiQuota.
// Hybrid model: per-user burst + daily caps (fairness), per-workspace monthly
// token budget (cost control, scales with seats), a small lifetime taste
// quota for trialing workspaces, and a platform-wide spend circuit-breaker.
import { one, q, run } from "./db.js";
import { ensureSubscription, effectiveState, seatCount, type Subscription } from "./billing.js";
import { mailEnabled, sendMail, orgAdminRecipients, tpl } from "./email.js";
import { decryptField } from "./crypto.js";

const envInt = (k: string, dflt: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};

export const limits = {
  trialRequests: () => envInt("KREATIX_AI_TRIAL_REQUESTS", 50),
  orgTokensBase: () => envInt("KREATIX_AI_ORG_TOKENS_BASE", 3_000_000),
  orgTokensPerSeat: () => envInt("KREATIX_AI_ORG_TOKENS_PER_SEAT", 1_000_000),
  businessBase: () => envInt("KREATIX_AI_ORG_TOKENS_BUSINESS_BASE", 12_000_000),
  businessPerSeat: () => envInt("KREATIX_AI_ORG_TOKENS_BUSINESS_PER_SEAT", 4_000_000),
  userDaily: () => envInt("KREATIX_AI_USER_DAILY", 300),
  userPerMin: () => envInt("KREATIX_AI_USER_PER_MIN", 20),
  platformBudgetUsd: () => envInt("KREATIX_AI_MONTHLY_BUDGET_USD", 200),
};

/** Workspace AI provider config — set when the org supplies its own
 *  OpenAI-compatible key (BYOK). Usage is still metered, but it costs the
 *  platform nothing so token budgets don't apply. */
export interface OrgAiProvider { key: string; baseUrl: string; model: string | null }

export async function orgAiProvider(orgId: string): Promise<OrgAiProvider | null> {
  const r = await one<{ ai_key: string | null; ai_base_url: string | null; ai_model: string | null }>(
    "SELECT ai_key, ai_base_url, ai_model FROM subscriptions WHERE org_id = $1", [orgId]);
  const key = r?.ai_key ? decryptField(r.ai_key) : null;
  return key ? { key, baseUrl: r!.ai_base_url || "https://api.openai.com/v1", model: r!.ai_model } : null;
}

export interface AiQuota {
  plan: "trial" | "paid";
  byok?: boolean;
  orgTokensUsed: number;
  orgTokensLimit: number;
  userTodayUsed: number;
  userTodayLimit: number;
  trialRequestsUsed?: number;
  trialRequestsLimit?: number;
  resetsAt: string; // next daily/monthly boundary relevant to the plan
}

export interface AiCheck {
  allowed: boolean;
  http?: number;
  error?: "ai_not_in_plan" | "rate_limited" | "quota_exceeded" | "platform_budget";
  message?: string;
  retryAfterSec?: number;
  quota: AiQuota;
}

const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
};
const nextMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
};
const nextDay = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) + "T00:00:00.000Z";

/** Monthly token budget for a paid org — seat-scaled by plan tier,
 *  explicit override wins over everything. */
export function orgTokenLimit(sub: Subscription, seats: number): number {
  if (sub.ai_token_budget != null) return sub.ai_token_budget;
  if (sub.plan === "business")
    return limits.businessBase() + limits.businessPerSeat() * Math.max(0, seats - 1);
  return limits.orgTokensBase() + limits.orgTokensPerSeat() * Math.max(0, seats - 1);
}

/** Platform-wide spend this month (USD, from micros) — 5-min cached. */
let spendCache: { usd: number; at: number } | null = null;
export async function platformSpendUsd(): Promise<number> {
  if (spendCache && Date.now() - spendCache.at < 300_000) return spendCache.usd;
  const r = await one<{ m: string }>(
    "SELECT COALESCE(SUM(cost_micros),0)::text AS m FROM ai_usage WHERE created_at >= $1",
    [monthStart()],
  );
  const usd = Number(r?.m ?? 0) / 1e6;
  spendCache = { usd, at: Date.now() };
  return usd;
}
/** Bust the spend cache after a request is metered (keeps the breaker tight). */
export function noteAiSpend(): void { spendCache = null; }

/** Usage snapshot for the UI meter + quota decisions. */
export async function aiQuotaFor(orgId: string, userId: string): Promise<AiQuota> {
  const sub = await ensureSubscription(orgId);
  const seats = await seatCount(orgId);
  const { state } = effectiveState(sub);
  const isTrial = state === "trialing";
  const byok = !!(await orgAiProvider(orgId));

  const [orgTokens, userToday, trialReqs] = await Promise.all([
    isTrial ? Promise.resolve({ n: "0" }) : one<{ n: string }>(
      "SELECT COALESCE(SUM(prompt_tokens + completion_tokens),0)::text AS n FROM ai_usage WHERE org_id = $1 AND created_at >= $2",
      [orgId, monthStart()],
    ),
    one<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM ai_usage WHERE user_id = $1 AND created_at >= CURRENT_DATE",
      [userId],
    ),
    isTrial ? one<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM ai_usage WHERE org_id = $1", [orgId]) : Promise.resolve(null),
  ]);

  return {
    plan: isTrial ? "trial" : "paid",
    byok,
    orgTokensUsed: Number(orgTokens?.n ?? 0),
    orgTokensLimit: orgTokenLimit(sub, seats),
    userTodayUsed: Number(userToday?.n ?? 0),
    userTodayLimit: limits.userDaily(),
    trialRequestsUsed: trialReqs ? Number(trialReqs.n) : undefined,
    trialRequestsLimit: isTrial ? limits.trialRequests() : undefined,
    resetsAt: isTrial ? nextDay() : nextMonth(),
  };
}

/**
 * Gate for chat endpoints. Burst limiting stays in-memory per process
 * (anti-abuse, cheap); everything cost-bearing is DB-backed in ai_usage.
 * Order: locked → trial taste → org monthly budget → user daily → platform.
 */
const burst = new Map<string, number[]>();

export async function checkAiQuota(orgId: string, userId: string): Promise<AiCheck> {
  const sub = await ensureSubscription(orgId);
  const { state } = effectiveState(sub);
  const quota = await aiQuotaFor(orgId, userId);

  if (state === "locked") {
    return { allowed: false, http: 402, error: "ai_not_in_plan", quota,
      message: "AI is a paid-plan feature — the workspace subscription has expired" };
  }
  const byok = quota.byok ?? false;

  if (state === "trialing" && !byok && (quota.trialRequestsUsed ?? 0) >= limits.trialRequests()) {
    return { allowed: false, http: 402, error: "ai_not_in_plan", quota,
      message: "Trial AI quota used up — subscribe to keep using Kreatix AI" };
  }
  // BYOK orgs carry their own provider bill — token & platform budgets don't
  // apply; burst/daily caps stay (they protect our infra, not our wallet)
  if (!byok && !quota.trialRequestsLimit && quota.orgTokensUsed >= quota.orgTokensLimit) {
    return { allowed: false, http: 429, error: "quota_exceeded", quota,
      message: "Workspace monthly AI budget reached — resets on the 1st", retryAfterSec: secUntil(quota.resetsAt) };
  }
  if (quota.userTodayUsed >= limits.userDaily()) {
    return { allowed: false, http: 429, error: "rate_limited", quota,
      message: "Daily AI limit reached — resets at midnight", retryAfterSec: secUntil(nextDay()) };
  }
  const nowTs = Date.now();
  const w = (burst.get(userId) ?? []).filter((t) => t > nowTs - 60_000);
  if (w.length >= limits.userPerMin()) {
    burst.set(userId, w);
    return { allowed: false, http: 429, error: "rate_limited", quota,
      message: "Too many AI requests — slow down", retryAfterSec: 60 };
  }
  w.push(nowTs); burst.set(userId, w);

  if (!byok && await platformSpendUsd() >= limits.platformBudgetUsd()) {
    return { allowed: false, http: 503, error: "platform_budget", quota,
      message: "AI is temporarily unavailable — platform budget reached" };
  }
  return { allowed: true, quota };
}

const secUntil = (iso: string) => Math.max(1, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));

/** Per-mode model selection — edit/plan can ride a stronger model via env. */
export function modelFor(mode: string): string {
  const key = `KREATIX_AI_MODEL_${mode.toUpperCase()}`;
  return process.env[key] || process.env.KREATIX_AI_MODEL || "gpt-4o-mini";
}

/** Microdollar cost for a request on a given model. Prices = USD per 1M tokens. */
export function costMicros(promptTokens: number, completionTokens: number): number {
  const pin = Number(process.env.KREATIX_AI_PRICE_IN_PER_MTOK ?? 0.15);
  const pout = Number(process.env.KREATIX_AI_PRICE_OUT_PER_MTOK ?? 0.60);
  return Math.round(promptTokens * pin + completionTokens * pout);
}

/**
 * Daily sweep — warn workspace admins at 80% of their org AI budget, and the
 * superadmin at 80% of the platform budget. `ai_budget_warned_at` is per-month
 * bookkeeping (reset implicitly by comparing against month start).
 */
export async function aiBudgetNotices(log?: { warn: (o: unknown, m: string) => void; info: (o: unknown, m: string) => void }): Promise<{ orgs: number; platform: boolean }> {
  const out = { orgs: 0, platform: false };
  const ms = monthStart();

  // org-level warnings (paid orgs only — trial cap is small, locked is off)
  if (mailEnabled()) {
    const subs = await q<Subscription & { name: string }>(
      `SELECT s.*, o.name FROM subscriptions s JOIN orgs o ON o.id = s.org_id
       WHERE s.ai_budget_warned_at IS NULL OR s.ai_budget_warned_at < $1`, [ms]);
    for (const sub of subs) {
      try {
        const { state } = effectiveState(sub);
        if (state !== "active" && state !== "granted") continue;
        const limit = orgTokenLimit(sub, await seatCount(sub.org_id));
        const used = await one<{ n: string }>(
          "SELECT COALESCE(SUM(prompt_tokens + completion_tokens),0)::text AS n FROM ai_usage WHERE org_id = $1 AND created_at >= $2",
          [sub.org_id, ms]);
        const pct = Math.round((Number(used?.n ?? 0) / limit) * 100);
        if (pct < 80) continue;
        for (const r of await orgAdminRecipients(sub.org_id)) {
          await sendMail({ to: r.email, toName: r.name, ...tpl.aiBudgetWarning(sub.name, pct) });
        }
        await run("UPDATE subscriptions SET ai_budget_warned_at = $2 WHERE org_id = $1", [sub.org_id, new Date().toISOString()]);
        out.orgs++;
      } catch (e) {
        log?.warn({ err: String(e), org: sub.org_id }, "ai budget notice failed");
      }
    }
  }

  // platform circuit-breaker early warning — once per month, logged + emailed
  const spent = await platformSpendUsd();
  if (spent >= limits.platformBudgetUsd() * 0.8) {
    const flagged = await one<{ flagged: boolean }>(
      "SELECT (ai_budget_warned_at >= $1) AS flagged FROM subscriptions WHERE org_id = 'superadmin-org'", [ms]);
    if (!flagged?.flagged) {
      await run("UPDATE subscriptions SET ai_budget_warned_at = $1 WHERE org_id = 'superadmin-org'", [new Date().toISOString()]);
      log?.warn({ spent, budget: limits.platformBudgetUsd() }, "platform AI budget at 80%");
      out.platform = true;
      const saEmail = process.env.KREATIX_SUPERADMIN_EMAIL;
      if (mailEnabled() && saEmail) {
        await sendMail({ to: saEmail, ...tpl.aiBudgetWarning("Platform (all workspaces)", Math.round((spent / limits.platformBudgetUsd()) * 100)) }).catch(() => {});
      }
    }
  }
  return out;
}
