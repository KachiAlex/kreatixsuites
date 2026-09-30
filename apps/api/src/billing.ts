// Subscription billing — one subscription per workspace (org).
// Price = base (admin seat) + member_price × (seats − 1), per month.
// States: trialing → active → past_due → locked (writes blocked, reads open).
// A superadmin `override_until` comp/extension wins over every other state.
import { randomUUID } from "node:crypto";
import { one, run, now, q } from "./db.js";
import { hashPassword } from "./auth.js";
import { mailEnabled, sendMail, orgAdminRecipients, tpl } from "./email.js";

export interface BillingConfig {
  id: string;
  base_price_ngn: number;
  member_price_ngn: number;
  trial_months: number;
  currency: string;
}

export interface Subscription {
  org_id: string;
  status: string;               // trialing | active | past_due | canceled
  trial_ends_at: string | null;
  period_start: string | null;
  period_end: string | null;
  amount_ngn: number | null;
  seats: number;
  override_until: string | null;
}

export type SubState = "trialing" | "active" | "grace" | "locked" | "granted";

const GRACE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

export async function getConfig(): Promise<BillingConfig> {
  return (await one<BillingConfig>("SELECT * FROM billing_config WHERE id = 'default'"))!;
}

export async function setConfig(patch: Partial<Pick<BillingConfig, "base_price_ngn" | "member_price_ngn" | "trial_months" | "currency">>): Promise<BillingConfig> {
  await run(
    `UPDATE billing_config SET
       base_price_ngn   = COALESCE($2, base_price_ngn),
       member_price_ngn = COALESCE($3, member_price_ngn),
       trial_months     = COALESCE($4, trial_months),
       currency         = COALESCE($5, currency),
       updated_at = $6
     WHERE id = 'default'`,
    ["default", patch.base_price_ngn ?? null, patch.member_price_ngn ?? null, patch.trial_months ?? null, patch.currency ?? null, now()],
  );
  return getConfig();
}

/** Enabled (non-disabled) seats in the workspace — the billable member count. */
export async function seatCount(orgId: string): Promise<number> {
  const r = await one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users WHERE org_id = $1 AND NOT disabled", [orgId]);
  return r?.n ?? 1;
}

export function monthlyAmount(cfg: BillingConfig, seats: number): number {
  return cfg.base_price_ngn + cfg.member_price_ngn * Math.max(0, seats - 1);
}

const addMonths = (iso: string, months: number) => {
  const d = new Date(iso);
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
};

/** Fetch-or-create the org's subscription (new orgs start on a free trial). */
export async function ensureSubscription(orgId: string): Promise<Subscription> {
  let sub = await one<Subscription>("SELECT * FROM subscriptions WHERE org_id = $1", [orgId]);
  if (sub) return sub;
  const cfg = await getConfig();
  await run(
    `INSERT INTO subscriptions (org_id, status, trial_ends_at, seats, amount_ngn, updated_at)
     VALUES ($1, 'trialing', $2, 1, NULL, $3) ON CONFLICT (org_id) DO NOTHING`,
    [orgId, addMonths(now(), cfg.trial_months), now()],
  );
  sub = (await one<Subscription>("SELECT * FROM subscriptions WHERE org_id = $1", [orgId]))!;
  return sub;
}

/** Effective state — pure read; the write gate calls this on every mutation. */
export function effectiveState(sub: Subscription, at = Date.now()): { state: SubState; until: string | null } {
  if (sub.override_until && new Date(sub.override_until).getTime() > at) {
    return { state: "granted", until: sub.override_until };
  }
  const end =
    sub.status === "trialing" ? sub.trial_ends_at
    : sub.status === "active" ? sub.period_end
    : null;
  if (sub.status === "canceled") return { state: "locked", until: null };
  if (end && new Date(end).getTime() > at) {
    return { state: sub.status === "trialing" ? "trialing" : "active", until: end };
  }
  if (end && new Date(end).getTime() + GRACE_DAYS * DAY > at) {
    return { state: "grace", until: new Date(new Date(end).getTime() + GRACE_DAYS * DAY).toISOString() };
  }
  return { state: "locked", until: end };
}

export interface BillingSummary {
  state: SubState;
  status: string;
  until: string | null;
  daysLeft: number | null;
  seats: number;
  amountNgn: number;
  currency: string;
  trialEndsAt: string | null;
  periodEnd: string | null;
  config: { basePriceNgn: number; memberPriceNgn: number; trialMonths: number };
  paystackEnabled: boolean;
}

export async function summary(orgId: string): Promise<BillingSummary> {
  const [sub, cfg, seats] = await Promise.all([ensureSubscription(orgId), getConfig(), seatCount(orgId)]);
  const { state, until } = effectiveState(sub);
  const daysLeft = until ? Math.ceil((new Date(until).getTime() - Date.now()) / DAY) : null;
  return {
    state, status: sub.status, until, daysLeft, seats,
    amountNgn: monthlyAmount(cfg, seats),
    currency: cfg.currency,
    trialEndsAt: sub.trial_ends_at,
    periodEnd: sub.period_end,
    config: { basePriceNgn: cfg.base_price_ngn, memberPriceNgn: cfg.member_price_ngn, trialMonths: cfg.trial_months },
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
    id: string; org_id: string; months: number; amount_ngn: number; seats: number; status: string;
  }>("SELECT * FROM payments WHERE id = $1", [paymentId]);
  if (!p || p.status === "confirmed") return p ? ensureSubscription(p.org_id) : undefined;

  const sub = await ensureSubscription(p.org_id);
  const { until } = effectiveState(sub);
  const start = until && new Date(until).getTime() > Date.now() ? until : now();
  const end = addMonths(start, p.months);

  await run("UPDATE payments SET status = 'confirmed', confirmed_by = $2, period_start = $3, period_end = $4 WHERE id = $1",
    [p.id, confirmedBy, start, end]);
  await run(
    `UPDATE subscriptions SET status = 'active', period_start = $2, period_end = $3,
       amount_ngn = $4, seats = $5, locked_notified_at = NULL, updated_at = $6 WHERE org_id = $1`,
    [p.org_id, start, end, p.amount_ngn, p.seats, now()],
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
    const amount = monthlyAmount(cfg, sub.seats || 1);
    const t =
      state === "trialing" && until && !sub.trial_warned_at &&
        new Date(until).getTime() - Date.now() < 7 * DAY
        ? tpl.trialEnding(sub.name, Math.ceil((new Date(until).getTime() - Date.now()) / DAY), amount)
      : state === "locked" && !sub.locked_notified_at
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

/** Create a pending payment row for the org's next period. */
export async function createPayment(orgId: string, method: string, reference?: string): Promise<{ id: string; amountNgn: number; seats: number }> {
  const [cfg, seats] = await Promise.all([getConfig(), seatCount(orgId)]);
  const amount = monthlyAmount(cfg, seats);
  const id = randomUUID();
  await run(
    `INSERT INTO payments (id, org_id, amount_ngn, seats, months, method, reference, status, created_at)
     VALUES ($1,$2,$3,$4,1,$5,$6,'pending',$7)`,
    [id, orgId, amount, seats, method, reference ?? null, now()],
  );
  return { id, amountNgn: amount, seats };
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
    `INSERT INTO subscriptions (org_id, status, override_until, seats, updated_at)
     VALUES ($1, 'active', '2100-01-01'::timestamptz, 1, $2)
     ON CONFLICT (org_id) DO UPDATE SET override_until = EXCLUDED.override_until, updated_at = EXCLUDED.updated_at`,
    [saOrg, now()],
  );
}
