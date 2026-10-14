import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { one, q } from "./db.js";
import { libraryPermission } from "./sites.js";
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

export async function signToken(userId: string, ttl = "7d"): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret);
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
}

/** Fastify preHandler — requires a valid Bearer token (or the `kx_t` cookie,
 *  which lets <img>/<iframe> media URLs authenticate without headers), attaches req.user */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization;
  const cookieToken = (req.headers.cookie ?? "")
    .split(";").map((c) => c.trim()).find((c) => c.startsWith("kx_t="))?.slice(5);
  const queryToken = (req.query as Record<string, unknown> | undefined)?.t as string | undefined;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : (cookieToken ?? queryToken);
  if (!token) {
    return reply.code(401).send({ error: "unauthorized", message: "Missing token" });
  }
  try {
    const { payload } = await jwtVerify(token, secret);
    if (payload.aud === "kreatix-mfa") throw new Error("mfa-pending token is not a session");
    const user = await one<UserRow>("SELECT * FROM users WHERE id = $1", [payload.sub as string]);
    if (!user || user.disabled) throw new Error("unknown user");
    (req as AuthedRequest).user = toUser(user);
  } catch {
    return reply.code(401).send({ error: "unauthorized", message: "Invalid token" });
  }
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
