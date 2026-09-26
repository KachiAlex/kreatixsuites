import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, now } from "../db.js";
import { hashPassword, verifyPassword, signToken, requireAuth, initials, toUser, type UserRow, type AuthedRequest } from "../auth.js";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).max(80),
  orgName: z.string().max(80).optional(),
});

export function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/register", async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(body.email);
    if (existing) return reply.code(409).send({ error: "conflict", message: "Email already registered" });

    const orgId = randomUUID();
    const userId = randomUUID();
    db.prepare("INSERT INTO orgs (id, name, created_at) VALUES (?,?,?)").run(
      orgId,
      body.orgName ?? `${body.displayName}'s workspace`,
      now(),
    );
    db.prepare(
      "INSERT INTO users (id, org_id, email, password_hash, display_name, initials, role, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(userId, orgId, body.email, hashPassword(body.password), body.displayName, initials(body.displayName), "owner", now());

    const user = toUser(db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow);
    return { token: await signToken(userId), user };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
    const row = db.prepare("SELECT * FROM users WHERE email = ?").get(body.email) as UserRow | undefined;
    if (!row || !verifyPassword(body.password, row.password_hash)) {
      return reply.code(401).send({ error: "unauthorized", message: "Invalid email or password" });
    }
    return { token: await signToken(row.id), user: toUser(row) };
  });

  app.get("/api/auth/me", { preHandler: requireAuth }, async (req) => {
    return { user: (req as AuthedRequest).user };
  });
}
