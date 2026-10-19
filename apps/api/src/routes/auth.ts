import type { FastifyInstance } from "fastify";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { one, run, now } from "../db.js";
import { hashPassword, verifyPassword, signToken, signMfaToken, verifyMfaToken, requireAuth, initials, toUser, type UserRow, type AuthedRequest } from "../auth.js";
import { sendMailSafe, tpl } from "../email.js";
import { ensureSubscription, effectivePlan, effectiveState, planLimit, seatCount } from "../billing.js";
import { encryptField, decryptField } from "../crypto.js";
import { genSecret, otpauthUri, verifyTotp, genBackupCodes, consumeBackupCode } from "../mfa.js";
import { createRemoteJWKSet, jwtVerify } from "jose";

// Brute-force ceilings — the in-memory limiter is per-IP; pair with real
// TLS-terminating rate control at the edge for distributed attacks.
const RL_LOGIN = { max: 10, timeWindow: "1 minute" };
const RL_AUTH = { max: 20, timeWindow: "1 minute" };

// ---- single-use auth tokens (password reset / email verification) ----
// Only the sha256 of the emailed secret is stored; tokens are single-use.

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function issueAuthToken(userId: string, purpose: string, ttlMinutes: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await run(
    "INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [randomUUID(), userId, purpose, sha256(token), new Date(Date.now() + ttlMinutes * 60_000).toISOString(), now()]);
  return token;
}

async function consumeAuthToken(purpose: string, token: string): Promise<{ id: string; user_id: string } | null> {
  const row = await one<{ id: string; user_id: string }>(
    "SELECT id, user_id FROM auth_tokens WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3",
    [sha256(token), purpose, now()]);
  if (!row) return null;
  await run("UPDATE auth_tokens SET used_at = $1 WHERE id = $2", [now(), row.id]);
  return row;
}

const orgKindSchema = z.enum(["personal", "family", "business"]);
type OrgKind = z.infer<typeof orgKindSchema>;

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).max(80),
  orgName: z.string().max(80).optional(),
  kind: orgKindSchema.optional(),
  invite: z.string().max(64).optional(),
});

/** Default tenant name for a new signup — consumer kinds avoid "workspace"
 *  language (a Gmail user creating a family account shouldn't land in
 *  something branded as a business workspace). */
function defaultOrgName(kind: OrgKind, displayName: string): string {
  if (kind === "family") return `${displayName}'s family`;
  if (kind === "personal") return displayName;
  return `${displayName}'s workspace`;
}

/** Invite token → org join. Shared by password + Google registration paths. */
async function resolveInviteJoin(token: string):
  Promise<{ ok: true; orgId: string; orgName: string } | { ok: false; code: number; error: string; message: string }> {
  const inv = await one<{ id: string; org_id: string; name: string }>(
    `SELECT i.id, i.org_id, o.name FROM org_invites i JOIN orgs o ON o.id = i.org_id
     WHERE i.token = $1 AND (i.expires_at IS NULL OR i.expires_at > $2) AND i.uses < i.max_uses`,
    [token, now()]);
  if (!inv) return { ok: false, code: 400, error: "bad_invite", message: "Invite link is expired or invalid" };
  // plan seat cap — free/pro/family plans have a member ceiling (0 = unlimited)
  const sub = await ensureSubscription(inv.org_id);
  const maxMembers = planLimit(await effectivePlan(sub), "max_members", 0);
  if (maxMembers > 0 && (await seatCount(inv.org_id)) >= maxMembers) {
    return { ok: false, code: 402, error: "seat_limit", message: "This space is full — its plan's member limit has been reached" };
  }
  await run("UPDATE org_invites SET uses = uses + 1 WHERE id = $1", [inv.id]);
  return { ok: true, orgId: inv.org_id, orgName: inv.name };
}

/** The shared Family Drive folder — every member gets an editor share, so
 *  anything dropped inside is visible to the whole family (share rows are
 *  per-user; new members get theirs at join time). */
async function createFamilyFolder(orgId: string, ownerId: string): Promise<void> {
  const id = randomUUID();
  await run(
    `INSERT INTO items (id, org_id, parent_id, owner_id, name, kind, mime, created_at, updated_at)
     VALUES ($1,$2,NULL,$3,$4,'folder','application/x-kreatix-folder',$5,$5)`,
    [id, orgId, ownerId, encryptField("Family"), now()]);
  await run("UPDATE orgs SET family_folder_id = $1 WHERE id = $2", [id, orgId]);
}

/** Grant a user an editor share on the org's Family folder (no-op unless
 *  the org is kind='family' and the folder exists). */
async function grantFamilyFolderShare(orgId: string, userId: string): Promise<void> {
  const org = await one<{ kind: string; family_folder_id: string | null }>(
    "SELECT kind, family_folder_id FROM orgs WHERE id = $1", [orgId]);
  if (org?.kind !== "family" || !org.family_folder_id) return;
  await run(
    `INSERT INTO shares (id, file_id, user_id, permission, created_at) VALUES ($1,$2,$3,'editor',$4)
     ON CONFLICT (file_id, user_id) DO NOTHING`,
    [randomUUID(), org.family_folder_id, userId, now()]);
}

const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID ?? "").trim();
// Desktop OAuth client — the installed-app flow exchanges auth codes through
// this backend so the client secret never ships inside the installer.
const GOOGLE_DESKTOP_CLIENT_ID = (process.env.GOOGLE_DESKTOP_CLIENT_ID ?? "").trim();
const GOOGLE_DESKTOP_CLIENT_SECRET = (process.env.GOOGLE_DESKTOP_CLIENT_SECRET ?? "").trim();
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

interface GoogleClaims { email?: string; email_verified?: boolean; name?: string }

/** Shared sign-in tail for both Google flows (web/Android id_token, desktop
 *  auth-code): verified claims → existing session, MFA challenge, or a
 *  find-or-create pass through the normal invite/no-invite registration. */
async function googleSignInComplete(
  claims: GoogleClaims,
  ctx: { invite?: string; kind?: OrgKind; orgName?: string },
  log: { warn: (o: unknown, m: string) => void },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
): Promise<unknown> {
  const email = claims.email?.trim();
  if (!email || claims.email_verified !== true) {
    return reply.code(401).send({ error: "bad_token", message: "Google account has no verified email" });
  }
  const displayName = (claims.name?.trim() || email.split("@")[0]).slice(0, 80);

  const existing = await one<UserRow>("SELECT * FROM users WHERE email = $1", [email]);
  if (existing) {
    if (existing.disabled) return reply.code(401).send({ error: "unauthorized", message: "Account is disabled" });
    if (existing.totp_secret) {
      return { mfaRequired: true, mfaToken: await signMfaToken(existing.id) };
    }
    return { token: await signToken(existing.id), user: toUser(existing) };
  }

  // new account — same invite/no-invite split as password registration;
  // passwordless accounts carry a non-hash marker (same convention as SSO)
  const kind: OrgKind = ctx.kind ?? "personal";
  let orgId: string;
  let role = "owner";
  let orgName = ctx.orgName ?? defaultOrgName(kind, displayName);
  if (ctx.invite) {
    const j = await resolveInviteJoin(ctx.invite);
    if (!j.ok) return reply.code(j.code).send({ error: j.error, message: j.message });
    orgId = j.orgId;
    orgName = j.orgName;
    role = "member";
  } else {
    orgId = randomUUID();
    await run("INSERT INTO orgs (id, name, kind, created_at) VALUES ($1,$2,$3,$4)",
      [orgId, orgName, kind, now()]);
  }
  const userId = randomUUID();
  await run(
    `INSERT INTO users (id, org_id, email, password_hash, display_name, initials, role, email_verified, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8)`,
    [userId, orgId, email, `sso:${randomUUID()}`, displayName, initials(displayName), role, now()]);
  if (!ctx.invite && kind === "family") await createFamilyFolder(orgId, userId);
  if (ctx.invite) await grantFamilyFolderShare(orgId, userId);

  const user = toUser((await one<UserRow>("SELECT * FROM users WHERE id = $1", [userId]))!);
  const t = ctx.invite ? tpl.joinedWorkspace(displayName, orgName) : tpl.welcome(displayName, orgName, kind);
  sendMailSafe(log, { to: email, toName: displayName, ...t });
  return { token: await signToken(userId), user };
}

export function authRoutes(app: FastifyInstance) {
  /** Google sign-in availability — the login page shows the button only when
   *  a client id is configured (also hands the client id to the GIS script). */
  app.get("/api/auth/google/status", { config: { rateLimit: RL_AUTH } }, async () => ({
    enabled: !!GOOGLE_CLIENT_ID,
    clientId: GOOGLE_CLIENT_ID || null,
    desktopEnabled: !!(GOOGLE_DESKTOP_CLIENT_ID && GOOGLE_DESKTOP_CLIENT_SECRET),
  }));

  /**
   * POST /api/auth/google — "Sign in with Google". The browser sends the GIS
   * ID token; we verify it against Google's tokeninfo endpoint and require
   * aud === our client id. Existing accounts sign straight in (MFA-enabled
   * accounts get the normal second-factor challenge instead of a bypass);
   * new accounts go through the same invite/no-invite split as password
   * registration, with the Google-verified email marked verified.
   */
  app.post("/api/auth/google", { config: { rateLimit: RL_AUTH } }, async (req, reply) => {
    if (!GOOGLE_CLIENT_ID) return reply.code(501).send({ error: "not_configured" });
    const body = z.object({
      idToken: z.string().min(20),
      invite: z.string().max(64).optional(),
      kind: orgKindSchema.optional(),
      orgName: z.string().max(80).optional(),
    }).parse(req.body);

    let claims: GoogleClaims;
    try {
      const { payload } = await jwtVerify(body.idToken, GOOGLE_JWKS, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: GOOGLE_CLIENT_ID,
      });
      claims = payload as GoogleClaims;
    } catch {
      return reply.code(401).send({ error: "bad_token", message: "Google sign-in failed" });
    }
    return googleSignInComplete(claims, body, app.log, reply);
  });

  /**
   * POST /api/auth/google/code — desktop OAuth. The Electron app drives a
   * system-browser + loopback-listener flow and posts the code + PKCE
   * verifier here; we exchange it at Google's token endpoint with the
   * DESKTOP client id/secret (kept server-side, never in the binary), then
   * verify the returned id_token against the desktop audience.
   */
  app.post("/api/auth/google/code", { config: { rateLimit: RL_AUTH } }, async (req, reply) => {
    if (!GOOGLE_DESKTOP_CLIENT_ID || !GOOGLE_DESKTOP_CLIENT_SECRET) {
      return reply.code(501).send({ error: "not_configured" });
    }
    const body = z.object({
      code: z.string().min(10),
      codeVerifier: z.string().min(20).max(200),
      redirectUri: z.string().url().max(300),
      invite: z.string().max(64).optional(),
      kind: orgKindSchema.optional(),
      orgName: z.string().max(80).optional(),
    }).parse(req.body);

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: body.code,
        redirect_uri: body.redirectUri,
        client_id: GOOGLE_DESKTOP_CLIENT_ID,
        client_secret: GOOGLE_DESKTOP_CLIENT_SECRET,
        code_verifier: body.codeVerifier,
      }),
    });
    if (!tokenRes.ok) {
      return reply.code(401).send({ error: "bad_code", message: "Google sign-in failed — try again" });
    }
    const tokens = await tokenRes.json() as { id_token?: string };
    if (!tokens.id_token) return reply.code(401).send({ error: "bad_code", message: "Google sign-in failed" });

    let claims: GoogleClaims;
    try {
      const { payload } = await jwtVerify(tokens.id_token, GOOGLE_JWKS, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: GOOGLE_DESKTOP_CLIENT_ID,
      });
      claims = payload as GoogleClaims;
    } catch {
      return reply.code(401).send({ error: "bad_token", message: "Google sign-in failed" });
    }
    return googleSignInComplete(claims, body, app.log, reply);
  });

  /** Invite-link preview — name + branding of the workspace you're joining. */
  app.get("/api/auth/invite/:token", { config: { rateLimit: RL_AUTH } }, async (req, reply) => {
    const inv = await one<{ org_id: string; name: string; brand_name: string | null; brand_logo: string | null }>(
      `SELECT i.org_id, o.name, o.brand_name, o.brand_logo FROM org_invites i JOIN orgs o ON o.id = i.org_id
       WHERE i.token = $1 AND (i.expires_at IS NULL OR i.expires_at > $2) AND i.uses < i.max_uses`,
      [(req.params as { token: string }).token, now()]);
    if (!inv) return reply.code(404).send({ error: "not_found", message: "Invite expired or invalid" });
    return {
      orgName: inv.name,
      brand: {
        name: inv.brand_name ?? inv.name,
        logoUrl: inv.brand_logo ? `/api/org/brand/${inv.org_id}/logo` : null,
      },
    };
  });

  /** Public org logo — non-sensitive brand asset (workspace icon), same model
   *  as Slack/Discord public workspace icons. */
  app.get("/api/org/brand/:orgId/logo", { config: { rateLimit: RL_AUTH } }, async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const org = await one<{ brand_logo: string | null; brand_logo_mime: string | null }>(
      "SELECT brand_logo, brand_logo_mime FROM orgs WHERE id = $1", [orgId]);
    if (!org?.brand_logo) return reply.code(404).send({ error: "not_found" });
    const { getBlob } = await import("../blobs.js");
    const buf = await getBlob(org.brand_logo);
    if (!buf) return reply.code(404).send({ error: "not_found" });
    return reply
      .header("content-type", org.brand_logo_mime ?? "image/png")
      // an SVG opened directly must not execute script in our origin
      .header("content-security-policy", "default-src 'none'")
      .header("cache-control", "public, max-age=3600")
      .send(buf);
  });

  /** Pre-register "does this workspace already exist?" check — powers the
   *  join-vs-create hint on the signup form. POST (not GET) so names and
   *  domains stay out of access logs. Two signals:
   *    nameTaken  — exact (case-insensitive) org-name match; names are
   *                 display-only so a match never blocks, just informs
   *    domainOrg  — the email's domain is DNS-verified on an existing org
   *                 (the strong "you probably meant to JOIN it" signal)
   *  Deliberately boolean/name-only — no org ids, no counts, rate-limited
   *  like the rest of the auth surface to limit name enumeration. */
  app.post("/api/auth/workspace-lookup", { config: { rateLimit: RL_AUTH } }, async (req) => {
    const b = (req.body ?? {}) as { name?: string; domain?: string };
    const name = (b.name ?? "").trim().slice(0, 80);
    const domain = (b.domain ?? "").trim().toLowerCase();
    const [hit, dOrg] = await Promise.all([
      name ? one("SELECT 1 AS x FROM orgs WHERE lower(name) = lower($1) LIMIT 1", [name]) : null,
      domain.includes(".")
        ? one<{ name: string }>(
            `SELECT o.name FROM org_domains d JOIN orgs o ON o.id = d.org_id
             WHERE d.domain = $1 AND d.status = 'verified' LIMIT 1`, [domain])
        : null,
    ]);
    return { nameTaken: !!hit, domainOrg: dOrg?.name ?? null };
  });

  app.post("/api/auth/register", { config: { rateLimit: RL_AUTH } }, async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const existing = await one("SELECT id FROM users WHERE email = $1", [body.email]);
    if (existing) return reply.code(409).send({ error: "conflict", message: "Email already registered" });

    // invite → join an existing tenant as a member; no invite → new tenant + owner
    const kind: OrgKind = body.kind ?? "personal";
    let orgId: string;
    let role = "owner";
    let orgName = body.orgName ?? defaultOrgName(kind, body.displayName);
    if (body.invite) {
      const j = await resolveInviteJoin(body.invite);
      if (!j.ok) return reply.code(j.code).send({ error: j.error, message: j.message });
      orgId = j.orgId;
      orgName = j.orgName;
      role = "member";
    } else {
      orgId = randomUUID();
      await run("INSERT INTO orgs (id, name, kind, created_at) VALUES ($1,$2,$3,$4)", [orgId, orgName, kind, now()]);
    }
    const userId = randomUUID();
    await run(
      "INSERT INTO users (id, org_id, email, password_hash, display_name, initials, role, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [userId, orgId, body.email, hashPassword(body.password), body.displayName, initials(body.displayName), role, now()],
    );
    if (!body.invite && kind === "family") await createFamilyFolder(orgId, userId);
    if (body.invite) await grantFamilyFolderShare(orgId, userId);

    const t = body.invite ? tpl.joinedWorkspace(body.displayName, orgName) : tpl.welcome(body.displayName, orgName, kind);
    sendMailSafe(app.log, { to: body.email, toName: body.displayName, ...t });
    // email verification — unverified logins still work for now; the flag
    // surfaces in /api/auth/me so the UI can nag
    const vtok = await issueAuthToken(userId, "email_verify", 24 * 60);
    sendMailSafe(app.log, { to: body.email, toName: body.displayName, ...tpl.verifyEmail(body.displayName, vtok) });

    const user = toUser((await one<UserRow>("SELECT * FROM users WHERE id = $1", [userId]))!);
    return { token: await signToken(userId), user };
  });

  /**
   * POST /api/auth/forgot — start a password reset. Always 200: the
   * response must not reveal whether the email exists (enumeration).
   */
  app.post("/api/auth/forgot", { config: { rateLimit: RL_LOGIN } }, async (req) => {
    const body = z.object({ email: z.string().email() }).parse(req.body);
    const row = await one<UserRow>("SELECT * FROM users WHERE email = $1 AND NOT disabled", [body.email]);
    if (row) {
      const token = await issueAuthToken(row.id, "password_reset", 60);
      sendMailSafe(app.log, { to: row.email, toName: row.display_name, ...tpl.passwordReset(row.display_name, token) });
    }
    return { ok: true };
  });

  /** POST /api/auth/reset — consume the emailed token, set a new password. */
  app.post("/api/auth/reset", { config: { rateLimit: RL_LOGIN } }, async (req, reply) => {
    const body = z.object({ token: z.string().min(20), password: z.string().min(8) }).parse(req.body);
    const tok = await consumeAuthToken("password_reset", body.token);
    if (!tok) return reply.code(400).send({ error: "bad_token", message: "Reset link is expired or already used" });
    await run("UPDATE users SET password_hash = $1 WHERE id = $2", [hashPassword(body.password), tok.user_id]);
    // burn any other outstanding reset/verify tokens for the account
    await run("UPDATE auth_tokens SET used_at = $1 WHERE user_id = $2 AND used_at IS NULL", [now(), tok.user_id]);
    return { ok: true };
  });

  /** GET /api/auth/verify-email?token= — marks the account verified. */
  app.get("/api/auth/verify-email", { config: { rateLimit: RL_AUTH } }, async (req, reply) => {
    const token = String((req.query as { token?: string }).token ?? "");
    const tok = token.length >= 20 ? await consumeAuthToken("email_verify", token) : null;
    if (!tok) return reply.code(400).send({ error: "bad_token", message: "Verification link is expired or already used" });
    await run("UPDATE users SET email_verified = true WHERE id = $1", [tok.user_id]);
    return { ok: true };
  });

  /** POST /api/auth/resend-verification — new verify link for the session user. */
  app.post("/api/auth/resend-verification", { preHandler: requireAuth, config: { rateLimit: RL_AUTH } }, async (req) => {
    const user = (req as AuthedRequest).user;
    if (user.emailVerified) return { ok: true };
    const row = await one<UserRow>("SELECT * FROM users WHERE id = $1", [user.id]);
    if (row && !row.email_verified) {
      const token = await issueAuthToken(row.id, "email_verify", 24 * 60);
      sendMailSafe(app.log, { to: row.email, toName: row.display_name, ...tpl.verifyEmail(row.display_name, token) });
    }
    return { ok: true };
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
    const desktop = body.client === "desktop";
    return { token: await signToken(row.id, desktop ? "30d" : "7d", desktop ? "desktop" : "web"), user: toUser(row) };
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
    const mfaDesktop = body.client === "desktop";
    return { token: await signToken(row.id, mfaDesktop ? "30d" : "7d", mfaDesktop ? "desktop" : "web"), user: toUser(row) };
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
    const org = await one<{ name: string; onboarded_at: string | null; brand_name: string | null; brand_logo: string | null; kind: string }>(
      "SELECT name, onboarded_at, brand_name, brand_logo, kind FROM orgs WHERE id = $1", [user.orgId]);
    return {
      user,
      org: {
        name: org?.name ?? "", onboardedAt: org?.onboarded_at ?? null, kind: org?.kind ?? "business",
        brandName: org?.brand_name ?? null,
        logoUrl: org?.brand_logo ? `/api/org/brand/${user.orgId}/logo` : null,
      },
      plan: { slug: plan.slug, name: plan.name, features: plan.features ?? {}, limits: plan.limits ?? {}, state: effectiveState(sub).state },
    };
  });
}
