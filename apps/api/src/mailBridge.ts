// Kreatix Mail bridge — the suite proxies kreatix-mail (mail.kreatixtech.com)
// so a suite session is enough: accounts are auto-provisioned through the mail
// service's admin API, and every proxied call carries a short-lived JWT minted
// with the shared KREATIX_MAIL_JWT_SECRET (the mail service's own secret).
// Set KREATIX_MAIL_BASE + KREATIX_MAIL_JWT_SECRET + KREATIX_MAIL_ADMIN_SECRET
// to enable; otherwise every route reports {enabled:false}.
import { createHmac, randomBytes } from "node:crypto";
import { one, run } from "./db.js";

const MAIL_BASE = () => (process.env.KREATIX_MAIL_BASE ?? "").replace(/\/+$/, "");
const MAIL_DOMAIN = () => process.env.KREATIX_MAIL_DOMAIN || "kreatixtech.com";

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

/** Lazily create the user's mailbox through the mail admin API and remember
 *  the mapping on the users row. */
async function ensureMailAccount(user: { id: string; email: string; displayName: string }): Promise<MailAccount> {
  const row = await one<{ mail_user_id: number | null; mail_email: string | null }>(
    "SELECT mail_user_id, mail_email FROM users WHERE id = $1", [user.id]);
  if (row?.mail_user_id && row.mail_email)
    return { id: row.mail_user_id, email: row.mail_email };

  const base = localpart(user.email, user.id);
  const password = randomBytes(24).toString("hex"); // SSO bridge — never used for login
  for (let i = 0; i < 8; i++) {
    const address = i === 0 ? `${base}@${MAIL_DOMAIN()}` : `${base}+${randomBytes(2).toString("hex")}@${MAIL_DOMAIN()}`;
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
  user: { id: string; email: string; displayName: string },
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

export async function mailStatus(user: { id: string; email: string; displayName: string }) {
  if (!mailEnabled()) return { enabled: false as const };
  const acct = await ensureMailAccount(user);
  return { enabled: true as const, address: acct.email };
}
