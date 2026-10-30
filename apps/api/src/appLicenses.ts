// Per-app seat licensing — M365-style "license → seat → app".
// subscriptions.app_seats holds per-app seat caps for the org
// ({"mail": 5} = 5 Mail seats purchased). An app with NO cap keeps the
// existing org-wide behavior (plan + disabled_apps only). A capped app
// additionally requires a grant row in user_app_licenses.
import { one, q, run } from "./db.js";
import type { SuiteApp } from "@kreatix/shared";

export interface LicenseSubject {
  id: string;
  orgId: string;
  disabledApps?: string[];
  isSuper?: boolean;
}

const TTL = 30_000;
const seatsCache = new Map<string, { seats: Record<string, number>; at: number }>();
const grantCache = new Map<string, { ok: boolean; at: number }>();

export function invalidateLicenseCache(userId?: string, orgId?: string) {
  if (orgId) seatsCache.delete(orgId);
  if (userId) for (const k of grantCache.keys()) if (k.startsWith(`${userId}:`)) grantCache.delete(k);
  if (!userId && !orgId) { seatsCache.clear(); grantCache.clear(); }
}

/** The org's purchased seat caps — {} = everything uncapped. */
export async function appSeatsFor(orgId: string): Promise<Record<string, number>> {
  const hit = seatsCache.get(orgId);
  if (hit && Date.now() - hit.at < TTL) return hit.seats;
  // the plan supplies default caps (limits.mail_seats); an explicit per-org value
  // in subscriptions.app_seats overrides it
  const row = await one<{ app_seats: Record<string, number> | null; plan_limits: Record<string, number> | null }>(
    "SELECT s.app_seats, p.limits AS plan_limits FROM subscriptions s LEFT JOIN plans p ON p.slug = s.plan WHERE s.org_id = $1", [orgId]);
  const planMail = row?.plan_limits?.mail_seats;
  const seats: Record<string, number> = { ...(planMail != null ? { mail: planMail } : {}), ...(row?.app_seats ?? {}) };
  seatsCache.set(orgId, { seats, at: Date.now() });
  return seats;
}

export async function hasSeatGrant(userId: string, slug: string): Promise<boolean> {
  const key = `${userId}:${slug}`;
  const hit = grantCache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.ok;
  const row = await one<{ user_id: string }>(
    "SELECT user_id FROM user_app_licenses WHERE user_id = $1 AND app_slug = $2", [userId, slug]);
  const ok = !!row;
  grantCache.set(key, { ok, at: Date.now() });
  return ok;
}

/** Unified app gate — disabled list wins, then seat caps. */
export async function appAccessAllowed(user: LicenseSubject, slug: SuiteApp): Promise<boolean> {
  if (user.isSuper) return true;
  if (user.disabledApps?.includes(slug)) return false;
  const seats = await appSeatsFor(user.orgId);
  if (seats[slug] == null) return true;
  return hasSeatGrant(user.id, slug);
}

/** Seats granted vs cap, per app — for the admin panel. */
export async function seatUsage(orgId: string): Promise<Record<string, { cap: number; used: number }>> {
  const seats = await appSeatsFor(orgId);
  if (!Object.keys(seats).length) return {};
  const rows = await q<{ app_slug: string; n: number }>(
    `SELECT l.app_slug, COUNT(*)::int AS n FROM user_app_licenses l
     JOIN users u ON u.id = l.user_id WHERE u.org_id = $1 GROUP BY l.app_slug`, [orgId]);
  const used = new Map(rows.map((r) => [r.app_slug, r.n]));
  return Object.fromEntries(Object.entries(seats)
    .map(([slug, cap]) => [slug, { cap, used: used.get(slug) ?? 0 }]));
}

export async function grantSeat(userId: string, slug: string, actorId: string) {
  await run(
    `INSERT INTO user_app_licenses (user_id, app_slug, granted_by, created_at)
     VALUES ($1,$2,$3,now()) ON CONFLICT (user_id, app_slug) DO NOTHING`, [userId, slug, actorId]);
  invalidateLicenseCache(userId);
}

export async function releaseSeat(userId: string, slug: string) {
  await run("DELETE FROM user_app_licenses WHERE user_id = $1 AND app_slug = $2", [userId, slug]);
  invalidateLicenseCache(userId);
}

/** Grant a seat for a capped app — throws {status:409} when the pool is full. */
export async function grantSeatWithinCap(orgId: string, userId: string, slug: string, actorId: string) {
  const seats = await appSeatsFor(orgId);
  const cap = seats[slug];
  if (cap == null) return; // uncapped — nothing to grant
  const n = await one<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM user_app_licenses l
     JOIN users u ON u.id = l.user_id WHERE u.org_id = $1 AND l.app_slug = $2`, [orgId, slug]);
  const already = await one<{ user_id: string }>(
    "SELECT user_id FROM user_app_licenses WHERE user_id = $1 AND app_slug = $2", [userId, slug]);
  if (already) return;
  if ((n?.n ?? 0) >= cap) {
    throw { status: 409, message: `No ${slug} seats left — ${n?.n ?? 0}/${cap} assigned` };
  }
  await grantSeat(userId, slug, actorId);
}
