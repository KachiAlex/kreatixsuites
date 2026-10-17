// Kreatix Mail bridge — the suite proxies kreatix-mail (mail.kreatixtech.com)
// so a suite session is enough: accounts are auto-provisioned through the mail
// service's admin API, and every proxied call carries a short-lived JWT minted
// with the shared KREATIX_MAIL_JWT_SECRET (the mail service's own secret).
// Set KREATIX_MAIL_BASE + KREATIX_MAIL_JWT_SECRET + KREATIX_MAIL_ADMIN_SECRET
// to enable; otherwise every route reports {enabled:false}.
import { createHmac, randomBytes } from "node:crypto";
import { resolveTxt, resolveMx } from "node:dns/promises";
import { one, run } from "./db.js";

const MAIL_BASE = () => (process.env.KREATIX_MAIL_BASE ?? "").replace(/\/+$/, "");
const FALLBACK_DOMAIN = () => process.env.KREATIX_MAIL_DOMAIN || "kreatixtech.com";

export const mailEnabled = () =>
  !!(MAIL_BASE() && process.env.KREATIX_MAIL_JWT_SECRET && process.env.KREATIX_MAIL_ADMIN_SECRET);

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

/** The org's verified primary domain, or the platform default. */
async function mailDomainForOrg(orgId: string): Promise<string> {
  const row = await one<{ domain: string }>(
    "SELECT domain FROM org_domains WHERE org_id = $1 AND is_primary AND status = 'verified'", [orgId]);
  return row?.domain ?? FALLBACK_DOMAIN();
}

/** DNS checks for the domain panel: verification TXT + inbound MX. */
export async function checkDomainDns(domain: string, verifyToken: string) {
  let txtOk = false, mxOk = false;
  try {
    const records = await resolveTxt(domain);
    txtOk = records.some((chunks) => chunks.join("").trim() === `kreatix-verify=${verifyToken}`);
  } catch { /* NXDOMAIN / no TXT */ }
  try {
    const mx = await resolveMx(domain);
    mxOk = mx.some((r) => /(^|\.)kreatixtech\.com$/i.test(r.exchange.replace(/\.$/, "")));
  } catch { /* no MX */ }
  return { txtOk, mxOk };
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
    if (res.status === 409) continue; // address taken — retry with suffix
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

export async function mailStatus(user: { id: string; email: string; displayName: string; orgId: string }) {
  if (!mailEnabled()) return { enabled: false as const };
  const acct = await ensureMailAccount(user);
  return { enabled: true as const, address: acct.email };
}
