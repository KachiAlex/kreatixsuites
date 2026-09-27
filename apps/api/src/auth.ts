import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { one } from "./db.js";
import type { Permission, User, UserRole } from "@kreatix/shared";

const secret = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "kreatix-dev-secret-change-in-production",
);

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [, salt, hash] = stored.split(":");
  const candidate = scryptSync(password, salt, 64);
  return timingSafeEqual(Buffer.from(hash, "hex"), candidate);
}

export async function signToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);
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
  const token = header?.startsWith("Bearer ") ? header.slice(7) : cookieToken;
  if (!token) {
    return reply.code(401).send({ error: "unauthorized", message: "Missing token" });
  }
  try {
    const { payload } = await jwtVerify(token, secret);
    const user = await one<UserRow>("SELECT * FROM users WHERE id = $1", [payload.sub as string]);
    if (!user) throw new Error("unknown user");
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
 *  Items with `media_for` inherit viewer access from the document that embeds
 *  them (images inside shared docs must load for viewers of that doc). */
export async function permissionFor(
  userId: string,
  item: { owner_id: string; id: string; media_for?: string | null },
): Promise<Permission | null> {
  if (item.owner_id === userId) return "owner";
  const share = await one<{ permission: Permission }>(
    "SELECT permission FROM shares WHERE file_id = $1 AND user_id = $2",
    [item.id, userId],
  );
  if (share) return share.permission;
  if (item.media_for) {
    const host = await one<{ owner_id: string; id: string }>(
      "SELECT id, owner_id FROM items WHERE id = $1", [item.media_for]);
    if (host) {
      const hostPerm = await permissionFor(userId, host);
      // media access is capped at viewer regardless of host permission
      if (hostPerm) return "viewer";
    }
  }
  return null;
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
