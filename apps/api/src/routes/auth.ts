import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { one, run, now } from "../db.js";
import { hashPassword, verifyPassword, signToken, requireAuth, initials, toUser, type UserRow, type AuthedRequest } from "../auth.js";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).max(80),
  orgName: z.string().max(80).optional(),
  invite: z.string().max(64).optional(),
});

export function authRoutes(app: FastifyInstance) {
  /** Invite-link preview — name of the workspace you're joining. */
  app.get("/api/auth/invite/:token", async (req, reply) => {
    const inv = await one<{ org_id: string; name: string }>(
      `SELECT i.org_id, o.name FROM org_invites i JOIN orgs o ON o.id = i.org_id
       WHERE i.token = $1 AND (i.expires_at IS NULL OR i.expires_at > $2) AND i.uses < i.max_uses`,
      [(req.params as { token: string }).token, now()]);
    if (!inv) return reply.code(404).send({ error: "not_found", message: "Invite expired or invalid" });
    return { orgName: inv.name };
  });

  app.post("/api/auth/register", async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const existing = await one("SELECT id FROM users WHERE email = $1", [body.email]);
    if (existing) return reply.code(409).send({ error: "conflict", message: "Email already registered" });

    // invite → join an existing workspace as a member; no invite → new workspace + owner
    let orgId: string;
    let role = "owner";
    if (body.invite) {
      const inv = await one<{ id: string; org_id: string }>(
        `SELECT id, org_id FROM org_invites
         WHERE token = $1 AND (expires_at IS NULL OR expires_at > $2) AND uses < max_uses`,
        [body.invite, now()]);
      if (!inv) return reply.code(400).send({ error: "bad_invite", message: "Invite link is expired or invalid" });
      await run("UPDATE org_invites SET uses = uses + 1 WHERE id = $1", [inv.id]);
      orgId = inv.org_id;
      role = "member";
    } else {
      orgId = randomUUID();
      await run("INSERT INTO orgs (id, name, created_at) VALUES ($1,$2,$3)", [
        orgId,
        body.orgName ?? `${body.displayName}'s workspace`,
        now(),
      ]);
    }
    const userId = randomUUID();
    await run(
      "INSERT INTO users (id, org_id, email, password_hash, display_name, initials, role, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [userId, orgId, body.email, hashPassword(body.password), body.displayName, initials(body.displayName), role, now()],
    );

    const user = toUser((await one<UserRow>("SELECT * FROM users WHERE id = $1", [userId]))!);
    return { token: await signToken(userId), user };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
    const row = await one<UserRow>("SELECT * FROM users WHERE email = $1", [body.email]);
    if (!row || !verifyPassword(body.password, row.password_hash)) {
      return reply.code(401).send({ error: "unauthorized", message: "Invalid email or password" });
    }
    return { token: await signToken(row.id), user: toUser(row) };
  });

  app.get("/api/auth/me", { preHandler: requireAuth }, async (req) => {
    return { user: (req as AuthedRequest).user };
  });
}
