// Kreatix Mail bridge — the suite proxies kreatix-mail (mail.kreatixtech.com)
// so a suite session is enough: accounts are auto-provisioned through the mail
// service's admin API, and every proxied call carries a short-lived JWT minted
// with the shared KREATIX_MAIL_JWT_SECRET (the mail service's own secret).
// Set KREATIX_MAIL_BASE + KREATIX_MAIL_JWT_SECRET + KREATIX_MAIL_ADMIN_SECRET
// to enable; otherwise every route reports {enabled:false}.
import { createHmac, randomBytes } from "node:crypto";
import { resolveTxt, resolveMx } from "node:dns/promises";
import { one, q, run } from "./db.js";

const MAIL_BASE = () => (process.env.KREATIX_MAIL_BASE ?? "").replace(/\/+$/, "");
const FALLBACK_DOMAIN = () => process.env.KREATIX_MAIL_DOMAIN || "kreatixtech.com";

export const mailEnabled = () =>
  !!(MAIL_BASE() && process.env.KREATIX_MAIL_JWT_SECRET && process.env.KREATIX_MAIL_ADMIN_SECRET);

export const mailBase = MAIL_BASE;

/** Push a raw RFC822 message through the mail service's inbound pipeline —
 *  the same endpoint Postfix pipes into, so spam/blocked-sender/alias routing
 *  all apply to imported mail identically. */
export async function postInbound(targetEmail: string, mime: Buffer): Promise<void> {
  const secret = process.env.KREATIX_MAIL_INBOUND_SECRET ?? "";
  if (!MAIL_BASE() || !secret) throw new Error("inbound email endpoint not configured");
  const res = await fetch(`${MAIL_BASE()}/api/inbound-email`, {
    method: "POST",
    headers: {
      "content-type": "message/rfc822",
      "x-inbound-secret": secret,
      "x-envelope-to": targetEmail,
    },
    body: new Uint8Array(mime),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`inbound-email ${res.status}`);
}

// mail JWT: HS256 {sub:number, email, role:'user', type:'access', iat, exp}
// — minted per request (15min), stateless; the suite session is the gate.
const b64u = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function mintMailToken(mailUserId: number, mailEmail: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64u(JSON.stringify({
    sub: mailUserId, email: mailEmail, role: "user", type: "access",
    iat: now, exp: now + 15 * 60,
  }));
  const sig = createHmac("sha256", process.env.KREATIX_MAIL_JWT_SECRET!)
    .update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64u(sig)}`;
}

/** Derive a unique localpart for the user's @kreatixtech.com mailbox. */
const localpart = (email: string, id: string): string => {
  const local = email.split("@")[0]?.toLowerCase().replace(/[^a-z0-9._-]/g, "") || "";
  return local || `u-${id.slice(0, 8)}`;
};

interface MailAccount { id: number; email: string }

/** Claim an existing mailbox when it IS the suite user's own address —
 *  e.g. an account created on the mail service before the bridge existed.
 *  Never claims an address that belongs to a different identity; those
 *  still collide and get a +suffix mailbox. */
async function claimOwnMailbox(
  address: string, user: { id: string; email: string },
): Promise<MailAccount | null> {
  if (address !== user.email.toLowerCase()) return null;
  const res = await fetch(`${MAIL_BASE()}/api/admin/users`, {
    headers: { "x-admin-secret": process.env.KREATIX_MAIL_ADMIN_SECRET! },
  });
  if (!res.ok) return null;
  const { users } = await res.json() as { users?: { id: number; email: string; is_active?: number }[] };
  const match = (users ?? []).find((u) => u.email === address && u.is_active !== 0);
  if (!match) return null;
  await run("UPDATE users SET mail_user_id = $2, mail_email = $3 WHERE id = $1",
    [user.id, match.id, match.email]);
  return { id: match.id, email: match.email };
}

/** Thrown when a business workspace has no verified primary domain yet — its
 *  mailbox must be on the company's own domain, never the platform's. */
export class MailDomainRequiredError extends Error {
  constructor() { super("A verified company domain is required before Mail can be used"); }
}

/** The org's verified primary domain. Personal workspaces use the platform
 *  domain; business workspaces must verify a domain first. */
async function mailDomainForOrg(orgId: string): Promise<string> {
  const row = await one<{ domain: string | null; kind: string }>(
    `SELECT d.domain, o.kind FROM orgs o
       LEFT JOIN org_domains d ON d.org_id = o.id AND d.is_primary AND d.status = 'verified'
      WHERE o.id = $1`, [orgId]);
  if (row?.domain) return row.domain;
  if (row?.kind === "personal") return FALLBACK_DOMAIN();
  throw new MailDomainRequiredError();
}

/** DNS checks for the domain panel + cutover wizard: verification TXT,
 *  inbound MX (and where it currently points), SPF, and DMARC. DKIM/Brevo
 *  records authenticate via brevoAuthenticateDomain, not raw DNS. */
export async function checkDomainDns(domain: string, verifyToken: string) {
  let txtOk = false, mxOk = false, spfOk = false, dmarcOk = false;
  let mxTargets: string[] = [];
  try {
    const records = await resolveTxt(domain);
    const flat = records.map((chunks) => chunks.join("").trim());
    txtOk = flat.some((t) => t === `kreatix-verify=${verifyToken}`);
    spfOk = flat.some((t) => t.startsWith("v=spf1"));
  } catch { /* NXDOMAIN / no TXT */ }
  try {
    const mx = await resolveMx(domain);
    mxTargets = mx.sort((a, b) => a.priority - b.priority).map((r) => r.exchange.replace(/\.$/, ""));
    mxOk = mxTargets.some((h) => /(^|\.)kreatixtech\.com$/i.test(h));
  } catch { /* no MX */ }
  try {
    const records = await resolveTxt(`_dmarc.${domain}`);
    dmarcOk = records.some((chunks) => chunks.join("").trim().startsWith("v=DMARC1"));
  } catch { /* no DMARC */ }
  return { txtOk, mxOk, mxTargets, spfOk, dmarcOk };
}

export interface MailboxMove { userId: string; mailUserId: number; from: string; to: string }

/** Plan moving existing platform-domain mailboxes onto the org's verified domain.
 *  Read-only — nothing changes until applyMailboxMigration runs. */
export async function planMailboxMigration(orgId: string): Promise<{ domain: string; moves: MailboxMove[] }> {
  const dom = await one<{ domain: string }>(
    "SELECT domain FROM org_domains WHERE org_id = $1 AND is_primary AND status = 'verified'", [orgId]);
  if (!dom) throw new MailDomainRequiredError();
  const rows = await q<{ id: string; mail_user_id: number; mail_email: string }>(
    `SELECT id, mail_user_id, mail_email FROM users
      WHERE org_id = $1 AND NOT disabled AND mail_user_id IS NOT NULL AND mail_email IS NOT NULL`, [orgId]);
  const moves: MailboxMove[] = [];
  for (const r of rows) {
    if (r.mail_email.toLowerCase().endsWith(`@${dom.domain.toLowerCase()}`)) continue;
    const local = r.mail_email.split("@")[0].replace(/\+[0-9a-f]{4}$/, "");
    moves.push({ userId: r.id, mailUserId: r.mail_user_id, from: r.mail_email, to: `${local}@${dom.domain}` });
  }
  return { domain: dom.domain, moves };
}

/** Switch each planned mailbox to its new address on the mail service (the old
 *  address keeps receiving mail there) and record it on the suite user. */
export async function applyMailboxMigration(orgId: string, moves: MailboxMove[]) {
  const results: { userId: string; from: string; to?: string; error?: string }[] = [];
  for (const m of moves) {
    let done: string | null = null;
    let lastError = "";
    for (const candidate of [m.to, ...[0, 1, 2].map((i) => `${m.to.split("@")[0]}+${randomBytes(2).toString("hex")}@${m.to.split("@")[1]}`)]) {
      const res = await fetch(`${MAIL_BASE()}/api/admin/users/${m.mailUserId}/primary-address`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-secret": process.env.KREATIX_MAIL_ADMIN_SECRET! },
        body: JSON.stringify({ new_email: candidate }),
      });
      if (res.ok) { done = candidate; break; }
      lastError = `mail service ${res.status}`;
      if (res.status !== 409) break;
    }
    if (done) {
      await run("UPDATE users SET mail_email = $2 WHERE id = $1", [m.userId, done]);
      results.push({ userId: m.userId, from: m.from, to: done });
    } else results.push({ userId: m.userId, from: m.from, error: lastError });
  }
  return results;
}

/** Lazily create the user's mailbox through the mail admin API and remember
 *  the mapping on the users row. */
async function ensureMailAccount(user: { id: string; email: string; displayName: string; orgId: string }): Promise<MailAccount> {
  const row = await one<{ mail_user_id: number | null; mail_email: string | null }>(
    "SELECT mail_user_id, mail_email FROM users WHERE id = $1", [user.id]);
  if (row?.mail_user_id && row.mail_email)
    return { id: row.mail_user_id, email: row.mail_email };

  const domain = await mailDomainForOrg(user.orgId);
  const base = localpart(user.email, user.id);
  const password = randomBytes(24).toString("hex"); // SSO bridge — never used for login
  for (let i = 0; i < 8; i++) {
    const address = i === 0 ? `${base}@${domain}` : `${base}+${randomBytes(2).toString("hex")}@${domain}`;
    const res = await fetch(`${MAIL_BASE()}/api/admin/users`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": process.env.KREATIX_MAIL_ADMIN_SECRET! },
      body: JSON.stringify({ email: address, password, display_name: user.displayName, role: "user" }),
    });
    if (res.status === 409) {
      // address taken — if it's the user's own address, adopt the existing
      // mailbox (keeps prior mail); otherwise retry with a suffix
      const claimed = await claimOwnMailbox(address, user).catch(() => null);
      if (claimed) return claimed;
      continue;
    }
    if (!res.ok) throw new Error(`mail admin create failed: ${res.status}`);
    const created = await res.json() as { id?: number; email?: string };
    if (!created.id) throw new Error("mail admin create returned no id");
    await run("UPDATE users SET mail_user_id = $2, mail_email = $3 WHERE id = $1",
      [user.id, created.id, created.email ?? address]);
    return { id: created.id, email: created.email ?? address };
  }
  throw new Error("could not allocate a mailbox address");
}

/** Authenticated fetch against the mail service on the user's behalf. */
export async function mailFetch(
  user: { id: string; email: string; displayName: string; orgId: string },
  path: string, init: { method?: string; body?: Buffer; contentType?: string } = {},
): Promise<Response> {
  const acct = await ensureMailAccount(user);
  const res = await fetch(`${MAIL_BASE()}/api${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${mintMailToken(acct.id, acct.email)}`,
      ...(init.body ? { "content-type": init.contentType ?? "application/json" } : {}),
    },
    body: init.body,
  });
  // a stale mapping (mailbox deleted mail-side) heals itself on next call
  if (res.status === 401) await run("UPDATE users SET mail_user_id = NULL, mail_email = NULL WHERE id = $1", [user.id]);
  return res;
}

/** Fetch as another org member — used for delegate/shared mailbox access.
 *  The caller must have already verified a mail_shares grant. */
export async function mailFetchAs(
  owner: { id: string; email: string; displayName: string; orgId: string },
  path: string, init: { method?: string; body?: Buffer; contentType?: string } = {},
): Promise<Response> {
  return mailFetch(owner, path, init);
}

// ── Brevo sender-domain automation ─────────────────────────────────────
// Outbound mail is sent by the kreatix-mail service's Brevo account, so
// customer domains must be authenticated THERE. The suite uses a copy of
// that account's key (KREATIX_MAIL_BREVO_KEY) to register the domain and
// read back the DNS records to display.
export interface BrevoRecord { host_name: string; type: string; value: string; status: boolean }
export interface BrevoDomain {
  id?: number | string; authenticated: boolean;
  records: { brevoCode?: BrevoRecord; dkim1?: BrevoRecord; dkim2?: BrevoRecord; dmarc?: BrevoRecord };
}

const BREVO_KEY = () => process.env.KREATIX_MAIL_BREVO_KEY || "";
export const brevoEnabled = () => !!BREVO_KEY();

const mapRecords = (j: any): BrevoDomain["records"] => ({
  brevoCode: j?.dns_records?.brevo_code ?? undefined,
  dkim1: j?.dns_records?.dkim1Record ?? j?.dns_records?.dkim_record ?? undefined,
  dkim2: j?.dns_records?.dkim2Record ?? undefined,
  dmarc: j?.dns_records?.dmarc_record ?? undefined,
});

async function brevoApi(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`https://api.brevo.com/v3${path}`, {
    ...init,
    headers: { "api-key": BREVO_KEY(), "content-type": "application/json", accept: "application/json", ...(init?.headers ?? {}) },
  });
}

/** Fetch the current state of a domain in the Brevo account (null if absent). */
export async function brevoGetDomain(domain: string): Promise<BrevoDomain | null> {
  if (!brevoEnabled()) return null;
  const res = await brevoApi(`/senders/domains/${encodeURIComponent(domain)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`brevo get domain ${res.status}`);
  const j = await res.json() as any;
  return { id: j.id, authenticated: !!j.authenticated, records: mapRecords(j) };
}

/** Register the domain with Brevo (idempotent) and return its DNS records. */
export async function brevoRegisterDomain(domain: string): Promise<BrevoDomain | null> {
  if (!brevoEnabled()) return null;
  const res = await brevoApi("/senders/domains", { method: "POST", body: JSON.stringify({ name: domain }) });
  if (res.ok) {
    const j = await res.json() as any;
    return { id: j.id, authenticated: !!j.authenticated, records: mapRecords(j) };
  }
  // already registered → just read the records back
  const j = await res.json().catch(() => ({})) as any;
  if (res.status === 400 && /already exists/i.test(j?.message ?? "")) return brevoGetDomain(domain);
  throw new Error(`brevo register domain ${res.status}: ${j?.message ?? ""}`);
}

/** Ask Brevo to re-validate the domain's DNS; returns authenticated state. */
export async function brevoAuthenticateDomain(domain: string): Promise<boolean | null> {
  if (!brevoEnabled()) return null;
  const res = await brevoApi(`/senders/domains/${encodeURIComponent(domain)}/authenticate`, { method: "PUT" });
  if (!res.ok) return null;
  return !!(await res.json() as any)?.authenticated;
}

/** SSO handoff into the full mail app — mints the mail service's own access
 *  JWT for an already-authenticated suite session and returns the exchange
 *  URL (mail app swaps it for a real access+refresh session). */
export async function mailSsoUrl(
  user: { id: string; email: string; displayName: string; orgId: string },
): Promise<string | null> {
  if (!mailEnabled()) return null;
  const acct = await ensureMailAccount(user);
  const org = await one<{ name: string; brand_name: string | null; brand_logo: string | null }>(
    "SELECT name, brand_name, brand_logo FROM orgs WHERE id = $1", [user.orgId]);
  const params = new URLSearchParams({ token: mintMailToken(acct.id, acct.email) });
  if (org) {
    params.set("brand", org.brand_name || org.name);
    if (org.brand_logo) params.set("logo", `${(process.env.KREATIX_PUBLIC_URL || "https://suites.kreatixtech.com").replace(/\/+$/, "")}/api/org/brand/${user.orgId}/logo`);
  }
  return `${MAIL_BASE()}/sso?${params.toString()}`;
}

export async function mailStatus(user: { id: string; email: string; displayName: string; orgId: string }) {
  if (!mailEnabled()) return { enabled: false as const };
  try {
    const acct = await ensureMailAccount(user);
    return { enabled: true as const, address: acct.email };
  } catch (e) {
    if (e instanceof MailDomainRequiredError) return { enabled: false as const, reason: "domain_required" as const };
    throw e;
  }
}

/** Admin-forced provisioning — same lazy path a member's first Mail visit
 *  takes, callable on behalf of any org member from the admin panel. */
export async function provisionMailbox(user: { id: string; email: string; displayName: string; orgId: string }) {
  return ensureMailAccount(user);
}

export interface MailAdminUser {
  id: number; email: string; display_name: string; is_active: number;
  storage_used: number; storage_quota: number; last_login_at: string | null;
}

/** Mail-service admin view — every mailbox on the service. Callers join it
 *  to suite users by address. Null when mail is off or unreachable. */
export async function mailAdminUsers(): Promise<MailAdminUser[] | null> {
  if (!mailEnabled()) return null;
  const res = await fetch(`${MAIL_BASE()}/api/admin/users`, {
    headers: { "x-admin-secret": process.env.KREATIX_MAIL_ADMIN_SECRET! },
  }).catch(() => null);
  if (!res?.ok) return null;
  const j = await res.json() as { users?: MailAdminUser[] };
  return j.users ?? [];
}

/** Create a standalone mailbox (shared/role address like sales@org.com) —
 *  no suite user is attached; members reach it via the mail service's
 *  linked-account/delegation model. Throws on conflict (address taken). */
export async function createMailbox(address: string, displayName: string): Promise<MailAccount> {
  const res = await fetch(`${MAIL_BASE()}/api/admin/users`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-secret": process.env.KREATIX_MAIL_ADMIN_SECRET! },
    body: JSON.stringify({ email: address, password: randomBytes(24).toString("hex"), display_name: displayName, role: "user" }),
  });
  if (res.status === 409) throw new Error("address_taken");
  if (!res.ok) throw new Error(`mail admin create failed: ${res.status}`);
  const created = await res.json() as { id?: number; email?: string };
  if (!created.id) throw new Error("mail admin create returned no id");
  return { id: created.id, email: created.email ?? address };
}

/** Patch mailbox state on the mail service (suspend/restore, quota, name). */
export async function updateMailbox(
  mailUserId: number,
  patch: { is_active?: boolean; storage_quota?: number; display_name?: string },
): Promise<boolean> {
  const res = await fetch(`${MAIL_BASE()}/api/admin/users/${mailUserId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-admin-secret": process.env.KREATIX_MAIL_ADMIN_SECRET! },
    body: JSON.stringify(patch),
  }).catch(() => null);
  return !!res?.ok;
}
