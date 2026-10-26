import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { now, one, q, run } from "./db.js";
import { libraryPermission } from "./sites.js";
import { logActivity } from "./items.js";
import { sendMail } from "./email.js";
import type { Permission, User, UserRole } from "@kreatix/shared";

const secret = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "kreatix-dev-secret-change-in-production",
);

// Separate key for desktop offline entitlements — this one is embedded in the
// desktop build, so it must NOT be the auth secret (a forged entitlement only
// unlocks offline editing; the server write-gate still governs sync).
const entitlementSecret = new TextEncoder().encode(
  process.env.KREATIX_ENTITLEMENT_SECRET ?? "kreatix-entitlement-dev-secret",
);

// New hashes use N=32768 (OWASP's interactive-login floor); the legacy
// scrypt:salt:hash format verifies at the old N=16384 so existing
// credentials keep working until they're next re-hashed.
const SCRYPT_N = 32768;
const scryptOpts = (n: number) => ({ N: n, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64, scryptOpts(SCRYPT_N)).toString("hex");
  return `scrypt:${SCRYPT_N}:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  // Non-scrypt rows (e.g. "sso:<uuid>" placeholders) → clean failure, not a throw.
  if (parts[0] !== "scrypt" || (parts.length !== 3 && parts.length !== 4)) return false;
  const n = parts.length === 4 ? Number(parts[1]) : 16384;
  const [salt, hash] = parts.slice(-2);
  if (!Number.isInteger(n) || n < 1024 || n > 1048576 || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64, scryptOpts(n));
  const expected = Buffer.from(hash, "hex");
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

/** "7d"/"12h"/"30m" → seconds (jose-style relative ttl strings). */
function ttlSeconds(ttl: string): number | null {
  const m = /^(\d+)\s*([smhd])$/.exec(ttl.trim());
  if (!m) return null;
  const n = +m[1];
  return n * ({ s: 1, m: 60, h: 3600, d: 86400 } as const)[m[2] as "s" | "m" | "h" | "d"];
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

export async function signToken(
  userId: string, ttl = "7d", client: "web" | "desktop" = "web",
  meta?: { ip?: string; ua?: string },
): Promise<string> {
  // tkv = token_version at issue time; resolveSession rejects on mismatch,
  // which is what makes "sign out everywhere" actually work
  const row = await one<{ token_version: number; org_id: string; email: string; display_name: string }>(
    "SELECT token_version, org_id, email, display_name FROM users WHERE id = $1", [userId]);
  // Org session-lifetime policy clamps every issue path (password, MFA,
  // Google, SAML/OIDC, SCIM-independent). Read inline — policies.ts is in an
  // import cycle with items.ts and auth.ts must stay out of it.
  if (row?.org_id) {
    const pol = await one<{ json: string | { maxSessionDays?: number } }>(
      "SELECT json FROM org_policies WHERE org_id = $1", [row.org_id]);
    try {
      const parsed = typeof pol?.json === "string" ? JSON.parse(pol.json) : pol?.json;
      const capDays = Number(parsed?.maxSessionDays) || 0;
      const ttlS = ttlSeconds(ttl);
      if (capDays > 0 && ttlS !== null && ttlS > capDays * 86400)
        ttl = `${Math.floor(capDays)}d`;
    } catch { /* malformed policy json — platform default stands */ }
  }
  const jti = randomUUID();
  const token = await new SignJWT({ sub: userId, client, tkv: row?.token_version ?? 0 })
    .setJti(jti)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret);
  // sessions row is what powers per-device listing/revocation — awaited so a
  // token is never handed out before its row exists (resolveSession is
  // deny-by-default for unknown jti's)
  await run(
    `INSERT INTO sessions (id, user_id, client, user_agent, ip, created_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6)`,
    [jti, userId, client, meta?.ua?.slice(0, 300) ?? null, meta?.ip ?? null, now()],
  ).catch(() => { /* table predates this deploy — token still works via tkv */ });
  // Unusual sign-in detection — alert when a *returning* account
  // authenticates from an IP that has never held one of its sessions.
  // First-ever logins and repeat IPs stay quiet. Whole block is best-effort:
  // an alert failure must never block authentication.
  if (meta?.ip && row?.org_id) {
    const ip = meta.ip;
    void (async () => {
      const seen = await one<{ seen_ip: number; prior: number }>(
        `SELECT COUNT(*) FILTER (WHERE ip = $2)::int AS seen_ip,
                COUNT(*) FILTER (WHERE id <> $3)::int AS prior
           FROM sessions WHERE user_id = $1`,
        [userId, ip, jti]);
      // seen_ip counts the just-inserted row — 1 means never seen before
      if (!seen || seen.seen_ip > 1 || seen.prior === 0) return;
      const detail = JSON.stringify({ ip, ua: meta.ua ?? null, client });
      await logActivity(row.org_id, userId, null, "auth.new-ip", detail);
      await sendMail({
        to: row.email,
        subject: "New sign-in to your Kreatix account",
        html: [
          `<p>Hi ${escHtml(row.display_name || "there")},</p>`,
          `<p>Your account just signed in from a new location:</p>`,
          `<ul><li><b>IP:</b> ${escHtml(ip)}</li>`,
          `<li><b>Device:</b> ${escHtml((meta.ua ?? "unknown").slice(0, 120))}</li>`,
          `<li><b>Client:</b> ${escHtml(client)}</li>`,
          `<li><b>Time:</b> ${new Date().toUTCString()}</li></ul>`,
          `<p>If this was you, no action is needed. If you don't recognize this sign-in, reset your password immediately and sign out of all devices in Security settings.</p>`,
        ].join(""),
        text: [
          `Hi ${row.display_name || "there"},`,
          "",
          `Your account just signed in from a new location:`,
          `  IP address: ${ip}`,
          `  Device:     ${(meta.ua ?? "unknown").slice(0, 120)}`,
          `  Client:     ${client}`,
          `  Time:       ${new Date().toUTCString()}`,
          "",
          "If this was you, no action is needed. If you don't recognize this sign-in,",
          "reset your password immediately and use Security settings to sign out of all devices.",
        ].join("\n"),
      }).catch(() => {});
    })().catch(() => {});
  }
  return token;
}

/** Offline entitlement for the desktop app — signed subscription state the
 *  client can verify without connectivity (14-day offline grace). */
export async function signEntitlement(claims: {
  org: string; status: string; seats: number; periodEnd?: string | null;
  plan?: string; features?: Record<string, boolean>;
}): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience("kreatix-desktop")
    .setIssuedAt()
    .setExpirationTime("14d")
    .sign(entitlementSecret);
}

/** Short-lived token between password check and TOTP challenge — NOT a
 *  session token; requireAuth rejects it via the audience check below. */
export async function signMfaToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience("kreatix-mfa")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secret);
}

export async function verifyMfaToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { audience: "kreatix-mfa" });
    return (payload.sub as string) ?? null;
  } catch { return null; }
}

export async function verifyToken(token: string): Promise<{ sub?: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (payload.aud === "kreatix-mfa") return null;
    return payload as { sub?: string };
  } catch { return null; }
}

export interface AuthedRequest extends FastifyRequest {
  user: User;
  /** Verified JWT claims (jti, tkv, client…) — set by requireAuth. */
  payload?: Record<string, unknown> | null;
}

export interface ResolvedSession {
  token: string | null;
  payload: Record<string, unknown> | null;
  user: UserRow | null;
}

/** ?t= is only honored on blob-serving GETs (img/iframe/video src can't send
 *  headers) — anywhere else a URL-carried token just leaks into Referer and
 *  history. The WS endpoints verify their own tokens outside requireAuth. */
const QUERY_TOKEN_PATHS =
  /^\/api\/(files\/[^/]+\/(content|raw|versions\/\d+\/content)|meet\/recordings\/[^/]+\/stream)$/;

/** Extract + verify the session credentials ONCE per request. The result is
 *  cached on the request so the global hooks (billing gate, IP allowlist,
 *  superadmin confinement) and route-level requireAuth share a single
 *  jwtVerify + user lookup instead of four. */
export function resolveSession(req: FastifyRequest): Promise<ResolvedSession> {
  const cached = req as FastifyRequest & { _kxSession?: Promise<ResolvedSession> };
  if (!cached._kxSession) cached._kxSession = resolveSessionInner(req);
  return cached._kxSession;
}

async function resolveSessionInner(req: FastifyRequest): Promise<ResolvedSession> {
  const header = req.headers.authorization;
  const cookieToken = (req.headers.cookie ?? "")
    .split(";").map((c) => c.trim()).find((c) => c.startsWith("kx_t="))?.slice(5);
  const queryToken = req.method === "GET" && QUERY_TOKEN_PATHS.test((req.url ?? "").split("?")[0])
    ? (req.query as Record<string, unknown> | undefined)?.t as string | undefined
    : undefined;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : (cookieToken ?? queryToken);
  if (!token) return { token: null, payload: null, user: null };
  try {
    const { payload } = await jwtVerify(token, secret);
    if (payload.aud === "kreatix-mfa") return { token, payload: null, user: null };
    const user = await one<UserRow>("SELECT * FROM users WHERE id = $1", [payload.sub as string]);
    if (!user || user.disabled) return { token, payload, user: null };
    // token_version bump revokes — tokens minted before this column existed
    // carry no tkv and verify as version 0 until the first bump
    if ((typeof payload.tkv === "number" ? payload.tkv : 0) !== user.token_version) {
      return { token, payload: payload as Record<string, unknown>, user: null };
    }
    // per-session revocation: tokens minted before the sessions table existed
    // carry no jti and pass through (governed by tkv above); new tokens must
    // map to a live session row. last_seen is touched at most once/minute.
    if (typeof payload.jti === "string") {
      const sess = await one<{ revoked_at: string | null; last_seen_at: string }>(
        "SELECT revoked_at, last_seen_at FROM sessions WHERE id = $1", [payload.jti]);
      if (!sess || sess.revoked_at) {
        return { token, payload: payload as Record<string, unknown>, user: null };
      }
      if (Date.now() - Date.parse(sess.last_seen_at) > 60_000) {
        void run("UPDATE sessions SET last_seen_at = $1 WHERE id = $2", [now(), payload.jti]).catch(() => {});
      }
    }
    return { token, payload: payload as Record<string, unknown>, user };
  } catch {
    return { token, payload: null, user: null };
  }
}

/** Fastify preHandler — requires a valid Bearer token (or the `kx_t` cookie,
 *  which lets <img>/<iframe> media URLs authenticate without headers), attaches req.user */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const { token, payload, user } = await resolveSession(req);
  if (!token) {
    return reply.code(401).send({ error: "unauthorized", message: "Missing token" });
  }
  if (!user) {
    return reply.code(401).send({ error: "unauthorized", message: "Invalid token" });
  }
  (req as AuthedRequest).user = toUser(user);
  (req as AuthedRequest).payload = payload;
}

export interface UserRow {
  id: string;
  org_id: string;
  email: string;
  password_hash: string;
  display_name: string;
  initials: string;
  role: UserRole;
  is_super: boolean;
  disabled: boolean;
  totp_secret: string | null;
  totp_backups: string | null;
  email_verified?: boolean;
  email_verify_required?: boolean;
  onboarding_dismissed?: boolean;
  token_version: number;
  disabled_apps?: string[];
  mail_user_id?: number | null;
  mail_email?: string | null;
  created_at: string;
}

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    orgId: row.org_id,
    email: row.email,
    displayName: row.display_name,
    initials: row.initials,
    role: row.role,
    isSuper: row.is_super,
    mfaEnabled: !!row.totp_secret,
    emailVerified: !!row.email_verified,
    onboardingDismissed: !!row.onboarding_dismissed,
    disabledApps: row.disabled_apps ?? [],
    createdAt: row.created_at,
  };
}

const PERM_RANK: Record<Permission, number> = {
  viewer: 1,
  commenter: 2,
  reviewer: 3,
  editor: 4,
  owner: 5,
};

/** Effective permission of a user on an item, or null if no access.
 *  Sources (most-permissive wins): direct share, site-library membership,
 *  a share on an ancestor folder (SharePoint-style inheritance), and
 *  `media_for` host access (viewer-capped). */
export async function permissionFor(
  userId: string,
  item: { owner_id: string; id: string; parent_id?: string | null; media_for?: string | null; library_id?: string | null },
  depth = 0,
): Promise<Permission | null> {
  // media_for inheritance is a DAG but can be arbitrarily deep — cap the walk
  // so a hostile upload chain can't stack-overflow the request.
  if (depth > 8) return null;
  if (item.owner_id === userId) return "owner";
  let best: Permission | null = null;
  const share = await one<{ permission: Permission }>(
    "SELECT permission FROM shares WHERE file_id = $1 AND user_id = $2",
    [item.id, userId],
  );
  if (share) best = share.permission;
  // site membership grants access to every item in its libraries —
  // most-permissive wins against a narrower direct share
  if (item.library_id) {
    const libPerm = await libraryPermission(userId, item.library_id);
    if (libPerm && (!best || PERM_RANK[libPerm] > PERM_RANK[best])) best = libPerm;
  }
  // a share on an ancestor folder covers everything beneath it
  if (item.parent_id) {
    const ancShare = await ancestorShare(item.parent_id, userId);
    if (ancShare && (!best || PERM_RANK[ancShare] > PERM_RANK[best])) best = ancShare;
  }
  if (best) return best;
  if (item.media_for) {
    const host = await one<{ owner_id: string; id: string }>(
      "SELECT id, owner_id FROM items WHERE id = $1", [item.media_for]);
    if (host) {
      const hostPerm = await permissionFor(userId, host, depth + 1);
      // media access is capped at viewer regardless of host permission
      if (hostPerm) return "viewer";
    }
  }
  return null;
}

/** Best share a user holds on any ancestor of `parentId` — walks the parent
 *  chain (capped at 8 hops) in one recursive query. A folder share covers the
 *  whole subtree beneath it (SharePoint permission inheritance). */
async function ancestorShare(parentId: string, userId: string): Promise<Permission | null> {
  const rows = await q<{ permission: Permission }>(
    `WITH RECURSIVE anc AS (
       SELECT $1::text AS pid, 0 AS depth
       UNION ALL
       SELECT i.parent_id, anc.depth + 1 FROM anc JOIN items i ON i.id = anc.pid
       WHERE anc.pid IS NOT NULL AND anc.depth < 8
     )
     SELECT s.permission FROM anc JOIN shares s ON s.file_id = anc.pid
     WHERE s.user_id = $2 AND anc.pid IS NOT NULL`,
    [parentId, userId],
  );
  let best: Permission | null = null;
  for (const r of rows) if (!best || PERM_RANK[r.permission] > PERM_RANK[best]) best = r.permission;
  return best;
}

/** Bulk permissionFor — one query for direct shares plus one per DISTINCT
 *  library/parent (typically constant per listing), instead of 3–4 queries
 *  per item. Media-chain inheritance still walks per item (rare, DAG-capped). */
export async function permissionsFor(
  userId: string,
  items: { owner_id: string; id: string; parent_id?: string | null; media_for?: string | null; library_id?: string | null }[],
): Promise<(Permission | null)[]> {
  if (!items.length) return [];
  const ids = items.map((i) => i.id);
  const shareRows = await q<{ file_id: string; permission: Permission }>(
    "SELECT file_id, permission FROM shares WHERE file_id = ANY($1) AND user_id = $2",
    [ids, userId]);
  const shareMap = new Map(shareRows.map((r) => [r.file_id, r.permission]));
  const libIds = [...new Set(items.map((i) => i.library_id).filter((x): x is string => !!x))];
  const libMap = new Map(await Promise.all(
    libIds.map(async (l) => [l, await libraryPermission(userId, l)] as const)));
  const parentIds = [...new Set(items.map((i) => i.parent_id).filter((x): x is string => !!x))];
  const ancMap = new Map(await Promise.all(
    parentIds.map(async (p) => [p, await ancestorShare(p, userId)] as const)));
  return Promise.all(items.map(async (item) => {
    if (item.owner_id === userId) return "owner" as Permission;
    let best = shareMap.get(item.id) ?? null;
    const lp = item.library_id ? libMap.get(item.library_id) ?? null : null;
    if (lp && (!best || PERM_RANK[lp] > PERM_RANK[best])) best = lp;
    const ap = item.parent_id ? ancMap.get(item.parent_id) ?? null : null;
    if (ap && (!best || PERM_RANK[ap] > PERM_RANK[best])) best = ap;
    if (best) return best;
    if (item.media_for) {
      const host = await one<{ owner_id: string; id: string }>(
        "SELECT id, owner_id FROM items WHERE id = $1", [item.media_for]);
      if (host && (await permissionFor(userId, host, 1))) return "viewer" as Permission;
    }
    return null;
  }));
}

export function hasPermission(actual: Permission | null, required: Permission): boolean {
  return actual !== null && PERM_RANK[actual] >= PERM_RANK[required];
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
