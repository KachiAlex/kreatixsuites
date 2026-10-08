// Subscription billing — one subscription per workspace (org).
// Price = base (admin seat) + member_price × (seats − 1), per month.
// States: trialing → active → past_due → locked (writes blocked, reads open).
// A superadmin `override_until` comp/extension wins over every other state.
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { one, run, now, q, DATA_DIR } from "./db.js";
import { hashPassword } from "./auth.js";
import { mailEnabled, sendMail, orgAdminRecipients, tpl } from "./email.js";

export interface BillingConfig {
  id: string;
  base_price_ngn: number;
  member_price_ngn: number;
  trial_months: number;
  business_multiplier: number; // business plan costs ×N standard (per month)
  currency: string;
}

export interface Subscription {
  org_id: string;
  status: string;               // trialing | active | suspended | canceled
  trial_ends_at: string | null;
  period_start: string | null;
  period_end: string | null;
  amount_ngn: number | null;
  seats: number;
  override_until: string | null;
  ai_token_budget?: number | null;      // superadmin AI quota override
  ai_budget_warned_at?: string | null;  // 80%-of-budget notice bookkeeping
  plan?: string;                        // plan slug — resolved via plans table
}

/** Plan catalog row — superadmin-editable pricing + entitlement matrix. */
export interface Plan {
  slug: string;
  name: string;
  price_ngn: number;            // base/month, includes the owner seat
  member_price_ngn: number;     // each additional enabled member
  features: Record<string, boolean>;
  limits: Record<string, number>;
  active: boolean;
  sort: number;
}

// legacy slugs → catalog slugs (existing DBs may hold 'standard')
const PLAN_ALIAS: Record<string, string> = { standard: "pro" };

const FREE_PLAN: Plan = {
  slug: "free", name: "Free", price_ngn: 0, member_price_ngn: 0,
  features: { ai: true, export: true }, limits: { ai_daily: 20 }, active: true, sort: 0,
};

let planCache: { rows: Plan[]; at: number } | null = null;
export async function getPlans(activeOnly = false): Promise<Plan[]> {
  if (!planCache || Date.now() - planCache.at > 10_000) {
    planCache = { rows: await q<Plan>("SELECT * FROM plans ORDER BY sort, price_ngn"), at: Date.now() };
  }
  return activeOnly ? planCache.rows.filter((p) => p.active) : planCache.rows;
}
export function bustPlanCache(): void { planCache = null; }

/** Sync resolver over a fetched plan list — aliases + free fallback. */
export function resolvePlan(plans: Plan[], slug?: string | null): Plan {
  const want = PLAN_ALIAS[slug ?? ""] ?? slug ?? "free";
  return plans.find((p) => p.slug === want)
      ?? plans.find((p) => p.slug === "free") ?? FREE_PLAN;
}

/** Resolve a subscription plan slug to a catalog row — aliases + free fallback. */
export async function planOf(slug?: string | null): Promise<Plan> {
  const plan = resolvePlan(await getPlans(), slug);
  return plan.active ? plan : resolvePlan(await getPlans(), "free");
}

export function planEntitled(plan: Plan, feature: string): boolean {
  return plan.features?.[feature] === true;
}
export function planLimit(plan: Plan, key: string, dflt: number): number {
  const v = plan.limits?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}
/** Server-side entitlement check — resolves the org's *effective* plan
 *  (downgraded/expired workspaces get the free plan's flags, not the paid one). */
export async function entitled(orgId: string, feature: string): Promise<boolean> {
  const sub = await ensureSubscription(orgId);
  const plan = await effectivePlan(sub);
  return planEntitled(plan, feature);
}

export type SubState = "free" | "trialing" | "active" | "grace" | "locked" | "granted";

const GRACE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

export async function getConfig(): Promise<BillingConfig> {
  return (await one<BillingConfig>("SELECT * FROM billing_config WHERE id = 'default'"))!;
}

export async function setConfig(patch: Partial<Pick<BillingConfig, "base_price_ngn" | "member_price_ngn" | "trial_months" | "business_multiplier" | "currency">>): Promise<BillingConfig> {
  await run(
    `UPDATE billing_config SET
       base_price_ngn      = COALESCE($2, base_price_ngn),
       member_price_ngn    = COALESCE($3, member_price_ngn),
       trial_months        = COALESCE($4, trial_months),
       business_multiplier = COALESCE($5, business_multiplier),
       currency            = COALESCE($6, currency),
       updated_at = $7
     WHERE id = 'default'`,
    ["default", patch.base_price_ngn ?? null, patch.member_price_ngn ?? null, patch.trial_months ?? null, patch.business_multiplier ?? null, patch.currency ?? null, now()],
  );
  return getConfig();
}

/** Enabled (non-disabled) seats in the workspace — the billable member count. */
export async function seatCount(orgId: string): Promise<number> {
  const r = await one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users WHERE org_id = $1 AND NOT disabled", [orgId]);
  return r?.n ?? 1;
}

export type PlanTier = string; // plan slug — resolved via the plans catalog

/** Monthly amount for a plan at a seat count. */
export function monthlyAmount(plan: Plan, seats: number): number {
  return plan.price_ngn + plan.member_price_ngn * Math.max(0, seats - 1);
}

const addMonths = (iso: string, months: number) => {
  const d = new Date(iso);
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
};

/** Fetch-or-create the org's subscription — new workspaces land on the free plan. */
export async function ensureSubscription(orgId: string): Promise<Subscription> {
  let sub = await one<Subscription>("SELECT * FROM subscriptions WHERE org_id = $1", [orgId]);
  if (sub) return sub;
  await run(
    `INSERT INTO subscriptions (org_id, status, seats, plan, updated_at)
     VALUES ($1, 'active', 1, 'free', $2) ON CONFLICT (org_id) DO NOTHING`,
    [orgId, now()],
  );
  sub = (await one<Subscription>("SELECT * FROM subscriptions WHERE org_id = $1", [orgId]))!;
  return sub;
}

/**
 * Effective state — pure read; the write gate calls this on every mutation.
 * Freemium semantics: an expired/canceled paid workspace downgrades to "free"
 * (basic editing stays usable) rather than locking. "locked" is reserved for
 * explicit suspension (status='suspended') — an admin kill switch.
 */
export function effectiveState(sub: Subscription, at = Date.now()): { state: SubState; until: string | null } {
  if (sub.override_until && new Date(sub.override_until).getTime() > at) {
    return { state: "granted", until: sub.override_until };
  }
  if (sub.status === "suspended") return { state: "locked", until: null };
  if (sub.status === "canceled") return { state: "free", until: null };
  const end =
    sub.status === "trialing" ? sub.trial_ends_at
    : sub.status === "active" ? sub.period_end
    : null;
  if (end && new Date(end).getTime() > at) {
    return { state: sub.status === "trialing" ? "trialing" : "active", until: end };
  }
  if (end && new Date(end).getTime() + GRACE_DAYS * DAY > at) {
    return { state: "grace", until: new Date(new Date(end).getTime() + GRACE_DAYS * DAY).toISOString() };
  }
  // paid period lapsed (or free plan from the start) → free tier
  return { state: "free", until: end };
}

/** The plan whose features/limits actually apply right now — paid plans only
 *  while the subscription is live; everything else resolves to free. */
export async function effectivePlan(sub: Subscription): Promise<Plan> {
  const { state } = effectiveState(sub);
  if (state === "free" || state === "locked") return planOf("free");
  return planOf(sub.plan);
}

export interface PlanPub {
  slug: string; name: string; priceNgn: number; memberPriceNgn: number;
  amountNgn: number;                       // computed for this org's seat count
  features: Record<string, boolean>; limits: Record<string, number>;
}
export interface BillingSummary {
  state: SubState;
  status: string;
  until: string | null;
  daysLeft: number | null;
  seats: number;
  amountNgn: number;                       // current plan at current seats
  plan: PlanTier;                          // effective plan slug (free when downgraded)
  planName: string;
  features: Record<string, boolean>;       // effective entitlements — the UI gate map
  limits: Record<string, number>;
  plans: PlanPub[];                        // upgrade catalog
  currency: string;
  trialEndsAt: string | null;
  periodEnd: string | null;
  config: { trialMonths: number };
  paystackEnabled: boolean;
}

export async function summary(orgId: string): Promise<BillingSummary> {
  const [sub, cfg, seats, plans] = await Promise.all(
    [ensureSubscription(orgId), getConfig(), seatCount(orgId), getPlans(true)]);
  const { state, until } = effectiveState(sub);
  const plan = await effectivePlan(sub);
  const daysLeft = until ? Math.ceil((new Date(until).getTime() - Date.now()) / DAY) : null;
  return {
    state, status: sub.status, until, daysLeft, seats,
    plan: plan.slug, planName: plan.name,
    features: plan.features ?? {}, limits: plan.limits ?? {},
    plans: plans.map((p) => ({
      slug: p.slug, name: p.name, priceNgn: p.price_ngn, memberPriceNgn: p.member_price_ngn,
      amountNgn: monthlyAmount(p, seats), features: p.features ?? {}, limits: p.limits ?? {},
    })),
    amountNgn: monthlyAmount(plan, seats),
    currency: cfg.currency,
    trialEndsAt: sub.trial_ends_at,
    periodEnd: sub.period_end,
    config: { trialMonths: cfg.trial_months },
    paystackEnabled: !!process.env.KREATIX_PAYSTACK_SECRET,
  };
}

/**
 * Record a payment + activate the period. If the workspace is still inside a
 * paid/trial period the new period chains onto it (never shortens access).
 * Returns the updated subscription.
 */
export async function confirmPayment(paymentId: string, confirmedBy: string | null): Promise<Subscription | undefined> {
  const p = await one<{
    id: string; org_id: string; months: number; amount_ngn: number; seats: number; status: string; plan: string;
  }>("SELECT * FROM payments WHERE id = $1", [paymentId]);
  if (!p || p.status === "confirmed") return p ? ensureSubscription(p.org_id) : undefined;

  const sub = await ensureSubscription(p.org_id);
  const { until } = effectiveState(sub);
  const start = until && new Date(until).getTime() > Date.now() ? until : now();
  const end = addMonths(start, p.months);

  await run("UPDATE payments SET status = 'confirmed', confirmed_by = $2, period_start = $3, period_end = $4 WHERE id = $1",
    [p.id, confirmedBy, start, end]);
  const plan = await planOf(p.plan);
  await run(
    `UPDATE subscriptions SET status = 'active', period_start = $2, period_end = $3,
       amount_ngn = $4, seats = $5, plan = $7, locked_notified_at = NULL, updated_at = $6 WHERE org_id = $1`,
    [p.org_id, start, end, p.amount_ngn, p.seats, now(), plan.slug],
  );

  // receipt to the workspace admins — fire-and-forget
  if (mailEnabled()) {
    const org = await one<{ name: string }>("SELECT name FROM orgs WHERE id = $1", [p.org_id]);
    const t = tpl.paymentReceipt(org?.name ?? "your workspace", p.amount_ngn, p.seats, p.months, end);
    for (const r of await orgAdminRecipients(p.org_id)) {
      sendMail({ to: r.email, toName: r.name, ...t }).catch(() => {});
    }
  }
  return ensureSubscription(p.org_id);
}

/**
 * Daily notice sweep — emails workspace admins when (a) the trial has ≤7 days
 * left (once), or (b) the workspace just locked (once per lock). Flags live on
 * the subscription row; `confirmPayment` clears locked_notified_at so a later
 * lock notifies again.
 */
export async function billingNotices(log?: { warn: (o: unknown, m: string) => void }): Promise<{ warned: number; locked: number }> {
  const out = { warned: 0, locked: 0 };
  if (!mailEnabled()) return out;
  const cfg = await getConfig();
  const subs = await q<Subscription & { trial_warned_at: string | null; locked_notified_at: string | null; name: string }>(
    `SELECT s.*, o.name FROM subscriptions s JOIN orgs o ON o.id = s.org_id`);
  for (const sub of subs) {
    const { state, until } = effectiveState(sub);
    const plan = await planOf(sub.plan);
    const amount = monthlyAmount(plan, sub.seats || 1);
    const t =
      state === "trialing" && until && !sub.trial_warned_at &&
        new Date(until).getTime() - Date.now() < 7 * DAY
        ? tpl.trialEnding(sub.name, Math.ceil((new Date(until).getTime() - Date.now()) / DAY), amount)
      : state === "locked" && !sub.locked_notified_at && plan.price_ngn > 0
        ? tpl.workspaceLocked(sub.name, amount)
      : null;
    if (!t) continue;
    try {
      for (const r of await orgAdminRecipients(sub.org_id)) {
        await sendMail({ to: r.email, toName: r.name, ...t });
      }
      await run(
        `UPDATE subscriptions SET ${state === "locked" ? "locked_notified_at" : "trial_warned_at"} = $2 WHERE org_id = $1`,
        [sub.org_id, now()]);
      if (state === "locked") out.locked++; else out.warned++;
    } catch (e) {
      log?.warn({ err: String(e), org: sub.org_id }, "billing notice email failed");
    }
  }
  return out;
}

/** Create a pending payment row for the org's next `months` periods on the
 *  given plan tier — amount_ngn is the TOTAL for the whole term so
 *  confirmation math and payment-provider verification stay consistent. */
export async function createPayment(orgId: string, method: string, reference?: string, months = 1, planSlug = "pro"): Promise<{ id: string; amountNgn: number; seats: number; months: number } | { error: string }> {
  const plan = await planOf(planSlug);
  if (plan.price_ngn <= 0 && plan.member_price_ngn <= 0) return { error: "free_plan" };
  const seats = await seatCount(orgId);
  const amount = monthlyAmount(plan, seats) * months;
  const id = randomUUID();
  await run(
    `INSERT INTO payments (id, org_id, amount_ngn, seats, months, method, reference, status, plan, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)`,
    [id, orgId, amount, seats, months, method, reference ?? null, plan.slug, now()],
  );
  return { id, amountNgn: amount, seats, months };
}

// ---- Paystack (enabled when KREATIX_PAYSTACK_SECRET is set) ----

const PS = "https://api.paystack.co";

export async function paystackInit(email: string, amountNgn: number, reference: string, callbackUrl: string): Promise<{ authorization_url: string }> {
  const res = await fetch(`${PS}/transaction/initialize`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.KREATIX_PAYSTACK_SECRET}` },
    body: JSON.stringify({ email, amount: amountNgn * 100, reference, callback_url: callbackUrl }),
  });
  const json = await res.json() as { status: boolean; message?: string; data?: { authorization_url: string } };
  if (!json.status || !json.data) throw new Error(json.message ?? "Paystack init failed");
  return json.data;
}

export async function paystackVerify(reference: string): Promise<{ ok: boolean; amountNgn: number }> {
  const res = await fetch(`${PS}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { authorization: `Bearer ${process.env.KREATIX_PAYSTACK_SECRET}` },
  });
  const json = await res.json() as { status: boolean; data?: { status: string; amount: number } };
  const ok = json.status && json.data?.status === "success";
  return { ok, amountNgn: (json.data?.amount ?? 0) / 100 };
}

/**
 * Confirm pending Paystack payments without a webhook — the hosted Paystack
 * dashboard only allows one webhook URL per business, and another product on
 * this account owns it. The sweep re-verifies pending references server-side
 * (authoritative) and confirms anything settled >3min ago, giving up at 48h.
 */
export async function sweepPendingPaystack(log?: { warn: (o: unknown, m: string) => void }): Promise<{ confirmed: number }> {
  if (!process.env.KREATIX_PAYSTACK_SECRET) return { confirmed: 0 };
  const rows = await q<{ id: string; reference: string; amount_ngn: number; months: number }>(
    `SELECT id, reference, amount_ngn, months FROM payments
     WHERE status = 'pending' AND method = 'paystack' AND reference IS NOT NULL
       AND created_at < $1 AND created_at > $2`,
    [new Date(Date.now() - 3 * 60_000).toISOString(), new Date(Date.now() - 48 * 3600_000).toISOString()]);
  let confirmed = 0;
  for (const p of rows) {
    try {
      const v = await paystackVerify(p.reference!);
      if (v.ok && v.amountNgn >= p.amount_ngn) {
        await confirmPayment(p.id, null);
        confirmed++;
      }
    } catch (e) {
      log?.warn({ err: String(e), ref: p.reference }, "paystack verify failed");
    }
  }
  return { confirmed };
}

/**
 * Plan-level version retention — the free tier keeps bounded history
 * (`limits.version_days`, 0 = unlimited). Applies to orgs whose effective
 * tier is free: stored plan 'free', canceled, or a paid period expired past
 * grace. A file's newest version is never pruned — it's the live content.
 * Orphaned blobs are unlinked. Runs in the daily sweep.
 */
export async function sweepVersionRetention(): Promise<number> {
  const free = await planOf("free");
  const days = planLimit(free, "version_days", 0);
  if (days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * DAY).toISOString();
  const rows = await q<{ id: string; blob_key: string }>(
    `SELECT v.id, v.blob_key FROM versions v
     JOIN items i ON i.id = v.file_id
     JOIN subscriptions s ON s.org_id = i.org_id
     WHERE v.created_at < $1
       AND v.id <> (SELECT id FROM versions v2 WHERE v2.file_id = v.file_id
                    ORDER BY v2.created_at DESC, v2.id DESC LIMIT 1)
       AND COALESCE(s.override_until, '1970-01-01'::timestamptz) < $2
       AND (s.plan = 'free'
            OR s.status = 'canceled'
            OR COALESCE(
                 CASE WHEN s.status = 'trialing' THEN s.trial_ends_at
                      WHEN s.status = 'active' THEN s.period_end END,
                 '1970-01-01'::timestamptz) + interval '7 days' < $2)`,
    [cutoff, now()]);
  let pruned = 0;
  for (const v of rows) {
    await run("DELETE FROM versions WHERE id = $1", [v.id]);
    const stillUsed = await one("SELECT 1 FROM versions WHERE blob_key = $1 LIMIT 1", [v.blob_key]);
    if (!stillUsed) {
      try { unlinkSync(join(DATA_DIR, "blobs", v.blob_key.slice(0, 2), v.blob_key)); } catch { /* gone */ }
    }
    pruned++;
  }
  return pruned;
}

/** Seeded superadmin — credentials come from env, never from source. */
export async function ensureSuperAdmin(): Promise<void> {
  const email = process.env.KREATIX_SUPERADMIN_EMAIL || "admin@kreatixtech.com";
  const password = process.env.KREATIX_SUPERADMIN_PASSWORD;
  const orgId = "superadmin-org";
  if (!password) return; // not configured — nothing to seed
  const existing = await one<{ id: string; org_id: string }>("SELECT id, org_id FROM users WHERE email = $1", [email]);
  const saOrg = existing?.org_id ?? orgId;
  if (existing) {
    // env password is the source of truth — re-sync every boot so the seeded
    // account can be rotated (or repaired) via .env
    await run("UPDATE users SET is_super = true, password_hash = $2 WHERE id = $1", [existing.id, hashPassword(password)]);
  } else {
    await run("INSERT INTO orgs (id, name, created_at) VALUES ($1,'Kreatix HQ',$2) ON CONFLICT (id) DO NOTHING", [orgId, now()]);
    await run(
      `INSERT INTO users (id, org_id, email, password_hash, display_name, initials, role, is_super, created_at)
       VALUES ($1,$2,$3,$4,'Super Admin','SA','owner',true,$5)`,
      [randomUUID(), orgId, email, hashPassword(password), now()],
    );
  }
  // the platform workspace never locks itself out — permanent comp override
  await run(
    `INSERT INTO subscriptions (org_id, status, override_until, seats, plan, updated_at)
     VALUES ($1, 'active', '2100-01-01'::timestamptz, 1, 'business', $2)
     ON CONFLICT (org_id) DO UPDATE SET override_until = EXCLUDED.override_until, updated_at = EXCLUDED.updated_at`,
    [saOrg, now()],
  );
}
