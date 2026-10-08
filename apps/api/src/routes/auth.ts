import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { one, run, now } from "../db.js";
import { hashPassword, verifyPassword, signToken, signMfaToken, verifyMfaToken, requireAuth, initials, toUser, type UserRow, type AuthedRequest } from "../auth.js";
import { sendMailSafe, tpl } from "../email.js";
import { ensureSubscription, effectivePlan, effectiveState, planLimit, seatCount } from "../billing.js";
import { encryptField, decryptField } from "../crypto.js";
import { genSecret, otpauthUri, verifyTotp, genBackupCodes, consumeBackupCode } from "../mfa.js";

// Brute-force ceilings — the in-memory limiter is per-IP; pair with real
// TLS-terminating rate control at the edge for distributed attacks.
const RL_LOGIN = { max: 10, timeWindow: "1 minute" };
const RL_AUTH = { max: 20, timeWindow: "1 minute" };

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).max(80),
  orgName: z.string().max(80).optional(),
  invite: z.string().max(64).optional(),
});

export function authRoutes(app: FastifyInstance) {
  /** Invite-link preview — name of the workspace you're joining. */
  app.get("/api/auth/invite/:token", { config: { rateLimit: RL_AUTH } }, async (req, reply) => {
    const inv = await one<{ org_id: string; name: string }>(
      `SELECT i.org_id, o.name FROM org_invites i JOIN orgs o ON o.id = i.org_id
       WHERE i.token = $1 AND (i.expires_at IS NULL OR i.expires_at > $2) AND i.uses < i.max_uses`,
      [(req.params as { token: string }).token, now()]);
    if (!inv) return reply.code(404).send({ error: "not_found", message: "Invite expired or invalid" });
    return { orgName: inv.name };
  });

  app.post("/api/auth/register", { config: { rateLimit: RL_AUTH } }, async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const existing = await one("SELECT id FROM users WHERE email = $1", [body.email]);
    if (existing) return reply.code(409).send({ error: "conflict", message: "Email already registered" });

    // invite → join an existing workspace as a member; no invite → new workspace + owner
    let orgId: string;
    let role = "owner";
    let orgName = body.orgName ?? `${body.displayName}'s workspace`;
    if (body.invite) {
      const inv = await one<{ id: string; org_id: string; name: string }>(
        `SELECT i.id, i.org_id, o.name FROM org_invites i JOIN orgs o ON o.id = i.org_id
         WHERE i.token = $1 AND (i.expires_at IS NULL OR i.expires_at > $2) AND i.uses < i.max_uses`,
        [body.invite, now()]);
      if (!inv) return reply.code(400).send({ error: "bad_invite", message: "Invite link is expired or invalid" });
      // plan seat cap — free/pro workspaces have a member ceiling (0 = unlimited)
      const sub = await ensureSubscription(inv.org_id);
      const maxMembers = planLimit(await effectivePlan(sub), "max_members", 0);
      if (maxMembers > 0 && (await seatCount(inv.org_id)) >= maxMembers) {
        return reply.code(402).send({ error: "seat_limit", message: "This workspace is full — its plan's member limit has been reached" });
      }
      await run("UPDATE org_invites SET uses = uses + 1 WHERE id = $1", [inv.id]);
      orgId = inv.org_id;
      orgName = inv.name;
      role = "member";
    } else {
      orgId = randomUUID();
      await run("INSERT INTO orgs (id, name, created_at) VALUES ($1,$2,$3)", [orgId, orgName, now()]);
    }
    const userId = randomUUID();
    await run(
      "INSERT INTO users (id, org_id, email, password_hash, display_name, initials, role, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [userId, orgId, body.email, hashPassword(body.password), body.displayName, initials(body.displayName), role, now()],
    );

    const t = body.invite ? tpl.joinedWorkspace(body.displayName, orgName) : tpl.welcome(body.displayName, orgName);
    sendMailSafe(app.log, { to: body.email, toName: body.displayName, ...t });

    const user = toUser((await one<UserRow>("SELECT * FROM users WHERE id = $1", [userId]))!);
    return { token: await signToken(userId), user };
  });

  app.post("/api/auth/login", { config: { rateLimit: RL_LOGIN } }, async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string(), client: z.string().optional() }).parse(req.body);
    const row = await one<UserRow>("SELECT * FROM users WHERE email = $1", [body.email]);
    if (!row || row.disabled || !verifyPassword(body.password, row.password_hash)) {
      return reply.code(401).send({ error: "unauthorized", message: "Invalid email or password" });
    }
    // second factor — password verified, now challenge the TOTP
    if (row.totp_secret) {
      return { mfaRequired: true, mfaToken: await signMfaToken(row.id) };
    }
    // desktop sessions get 30d — the 14-day offline grace must not strand
    // a logged-in desktop user mid-offline-period
    return { token: await signToken(row.id, body.client === "desktop" ? "30d" : "7d"), user: toUser(row) };
  });

  /** Second step of login when the account has TOTP enabled. Accepts a
   *  6-digit authenticator code or a one-time backup code. */
  app.post("/api/auth/mfa/login", { config: { rateLimit: RL_LOGIN } }, async (req, reply) => {
    const body = z.object({ mfaToken: z.string(), code: z.string(), client: z.string().optional() }).parse(req.body);
    const userId = await verifyMfaToken(body.mfaToken);
    if (!userId) return reply.code(401).send({ error: "unauthorized", message: "Sign-in session expired — start over" });
    const row = await one<UserRow>("SELECT * FROM users WHERE id = $1", [userId]);
    if (!row || row.disabled || !row.totp_secret) {
      return reply.code(401).send({ error: "unauthorized", message: "Invalid session" });
    }
    const secret = decryptField(row.totp_secret) ?? "";
    let ok = verifyTotp(secret, body.code);
    if (!ok) {
      const remaining = consumeBackupCode(body.code, row.totp_backups);
      if (remaining) {
        await run("UPDATE users SET totp_backups = $1 WHERE id = $2", [JSON.stringify(remaining), row.id]);
        ok = true;
      }
    }
    if (!ok) return reply.code(401).send({ error: "unauthorized", message: "Invalid authentication code" });
    return { token: await signToken(row.id, body.client === "desktop" ? "30d" : "7d"), user: toUser(row) };
  });

  /** Begin enrollment — the secret is returned but not stored until the
   *  user proves they can generate codes (mfa/enable). */
  app.post("/api/auth/mfa/setup", { preHandler: requireAuth, config: { rateLimit: RL_AUTH } }, async (req) => {
    const secret = genSecret();
    return { secret, uri: otpauthUri((req as AuthedRequest).user.email, secret) };
  });

  app.post("/api/auth/mfa/enable", { preHandler: requireAuth, config: { rateLimit: RL_AUTH } }, async (req, reply) => {
    const body = z.object({ secret: z.string().min(16).max(64), code: z.string() }).parse(req.body);
    if (!verifyTotp(body.secret, body.code)) {
      return reply.code(400).send({ error: "bad_code", message: "Code didn't match — check your authenticator clock and try again" });
    }
    const { codes, hashes } = genBackupCodes();
    await run("UPDATE users SET totp_secret = $1, totp_backups = $2 WHERE id = $3",
      [encryptField(body.secret), JSON.stringify(hashes), (req as AuthedRequest).user.id]);
    return { backupCodes: codes };
  });

  /** Fresh set of backup codes — requires a live TOTP code. */
  app.post("/api/auth/mfa/codes", { preHandler: requireAuth, config: { rateLimit: RL_AUTH } }, async (req, reply) => {
    const body = z.object({ code: z.string() }).parse(req.body);
    const row = await one<UserRow>("SELECT * FROM users WHERE id = $1", [(req as AuthedRequest).user.id]);
    if (!row?.totp_secret) return reply.code(400).send({ error: "not_enabled", message: "Two-factor is not enabled" });
    if (!verifyTotp(decryptField(row.totp_secret) ?? "", body.code)) {
      return reply.code(401).send({ error: "unauthorized", message: "Invalid authentication code" });
    }
    const { codes, hashes } = genBackupCodes();
    await run("UPDATE users SET totp_backups = $1 WHERE id = $2", [JSON.stringify(hashes), row.id]);
    return { backupCodes: codes };
  });

  app.post("/api/auth/mfa/disable", { preHandler: requireAuth, config: { rateLimit: RL_AUTH } }, async (req, reply) => {
    const body = z.object({ password: z.string(), code: z.string() }).parse(req.body);
    const row = await one<UserRow>("SELECT * FROM users WHERE id = $1", [(req as AuthedRequest).user.id]);
    if (!row || !verifyPassword(body.password, row.password_hash)) {
      return reply.code(401).send({ error: "unauthorized", message: "Wrong password" });
    }
    if (!row.totp_secret) return { ok: true };
    const secret = decryptField(row.totp_secret) ?? "";
    const ok = verifyTotp(secret, body.code) || consumeBackupCode(body.code, row.totp_backups) !== null;
    if (!ok) return reply.code(401).send({ error: "unauthorized", message: "Invalid authentication code" });
    await run("UPDATE users SET totp_secret = NULL, totp_backups = NULL WHERE id = $1", [row.id]);
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: requireAuth }, async (req) => {
    const { user } = req as AuthedRequest;
    const sub = await ensureSubscription(user.orgId);
    const plan = await effectivePlan(sub);
    return {
      user,
      plan: { slug: plan.slug, name: plan.name, features: plan.features ?? {}, limits: plan.limits ?? {}, state: effectiveState(sub).state },
    };
  });
}
