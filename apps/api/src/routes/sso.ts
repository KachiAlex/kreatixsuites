// OIDC single sign-on hooks. Configure via env:
//   KREATIX_OIDC_ISSUER        e.g. https://accounts.google.com
//   KREATIX_OIDC_CLIENT_ID
//   KREATIX_OIDC_CLIENT_SECRET
//   KREATIX_OIDC_REDIRECT      optional; defaults to <request origin>/api/auth/sso/callback
//   KREATIX_OIDC_SCOPE         optional; defaults to "openid email profile"
//
// Flow: GET /api/auth/sso → provider authorize → GET /api/auth/sso/callback
// exchanges the code, verifies the id_token against the provider JWKS, then
// finds-or-creates the local user and redirects to /login?sso_token=<jwt>.
import type { FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { one, run, now } from "../db.js";
import { initials, signToken, type UserRow } from "../auth.js";

const ISSUER = process.env.KREATIX_OIDC_ISSUER?.replace(/\/$/, "");
const CLIENT_ID = process.env.KREATIX_OIDC_CLIENT_ID;
const CLIENT_SECRET = process.env.KREATIX_OIDC_CLIENT_SECRET;
const SCOPE = process.env.KREATIX_OIDC_SCOPE ?? "openid email profile";

export const ssoEnabled = !!(ISSUER && CLIENT_ID && CLIENT_SECRET);

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

let discoveryPromise: Promise<Discovery> | null = null;
function discover(): Promise<Discovery> {
  discoveryPromise ??= fetch(`${ISSUER}/.well-known/openid-configuration`).then(async (r) => {
    if (!r.ok) throw new Error(`OIDC discovery failed: ${r.status}`);
    return (await r.json()) as Discovery;
  });
  return discoveryPromise;
}

// single-use state nonces, 10-minute TTL
const states = new Map<string, number>();
const newState = () => {
  const s = randomBytes(16).toString("hex");
  states.set(s, Date.now() + 600_000);
  for (const [k, exp] of states) if (exp < Date.now()) states.delete(k);
  return s;
};
const consumeState = (s: string) => {
  const exp = states.get(s);
  states.delete(s);
  return exp !== undefined && exp > Date.now();
};

function callbackUrl(req: { headers: Record<string, unknown> }): string {
  if (process.env.KREATIX_OIDC_REDIRECT) return process.env.KREATIX_OIDC_REDIRECT;
  // configured public URL beats the (client-controlled) Host header
  if (process.env.KREATIX_PUBLIC_URL)
    return `${process.env.KREATIX_PUBLIC_URL.replace(/\/$/, "")}/api/auth/sso/callback`;
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "http";
  return `${proto}://${req.headers.host}/api/auth/sso/callback`;
}

export function ssoRoutes(app: FastifyInstance) {
  app.get("/api/auth/sso/status", async () => ({ enabled: ssoEnabled }));

  app.get("/api/auth/sso", async (req, reply) => {
    if (!ssoEnabled) return reply.code(404).send({ error: "sso_disabled" });
    try {
      const disco = await discover();
      const url = new URL(disco.authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: CLIENT_ID!,
        redirect_uri: callbackUrl(req),
        response_type: "code",
        scope: SCOPE,
        state: newState(),
      }).toString();
      return reply.redirect(url.toString(), 302);
    } catch (e) {
      return reply.code(502).send({ error: "sso_error", message: String(e) });
    }
  });

  app.get("/api/auth/sso/callback", async (req, reply) => {
    if (!ssoEnabled) return reply.code(404).send({ error: "sso_disabled" });
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    if (error) return reply.redirect(`/login?sso_error=${encodeURIComponent(error)}`, 302);
    if (!code || !state || !consumeState(state)) {
      return reply.redirect("/login?sso_error=invalid_state", 302);
    }
    try {
      const disco = await discover();
      const tokenRes = await fetch(disco.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: callbackUrl(req),
          client_id: CLIENT_ID!,
          client_secret: CLIENT_SECRET!,
        }),
      });
      if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
      const tokens = (await tokenRes.json()) as { id_token?: string };
      if (!tokens.id_token) throw new Error("no id_token in response");

      const { payload } = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(disco.jwks_uri)), {
        issuer: ISSUER,
        audience: CLIENT_ID,
      });
      const email = String(payload.email ?? "");
      // Strict by default: an absent email_verified claim is NOT verified.
      // IdPs that genuinely omit the claim can set
      // KREATIX_OIDC_REQUIRE_VERIFIED_EMAIL=0 after confirming the IdP's
      // account-security posture (an unverified claim lets anyone mint an
      // account under someone else's address at a permissive IdP).
      const verified = payload.email_verified === true;
      if (!email || (process.env.KREATIX_OIDC_REQUIRE_VERIFIED_EMAIL !== "0" && !verified)) {
        return reply.redirect("/login?sso_error=no_verified_email", 302);
      }
      const name = String(payload.name ?? payload.preferred_username ?? email.split("@")[0]);

      let row = await one<UserRow>("SELECT * FROM users WHERE email = $1", [email]);
      if (!row) {
        // first SSO login → new user in their own workspace org (same as register)
        const orgId = randomUUID();
        const userId = randomUUID();
        await run("INSERT INTO orgs (id, name, created_at) VALUES ($1,$2,$3)", [
          orgId, `${name}'s workspace`, now(),
        ]);
        await run(
          "INSERT INTO users (id, org_id, email, password_hash, display_name, initials, role, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [userId, orgId, email, `sso:${randomUUID()}`, name, initials(name), "owner", now()],
        );
        row = (await one<UserRow>("SELECT * FROM users WHERE id = $1", [userId]))!;
      }
      const token = await signToken(row.id);
      // Hand the token to the SPA via a short-lived, single-purpose HttpOnly
      // cookie instead of a URL param — keeps it out of history/referrer logs.
      const secure = callbackUrl(req).startsWith("https:") ? "; Secure" : "";
      reply.header(
        "set-cookie",
        `kx_sso=${token}; HttpOnly; Path=/api/auth/sso/exchange; Max-Age=60; SameSite=Lax${secure}`,
      );
      return reply.redirect("/login?sso=1", 302);
    } catch (e) {
      // real error goes to the log — the URL gets a generic code (it lands in
      // history, referrer headers, and server logs otherwise)
      req.log.warn({ err: String(e) }, "sso callback failed");
      return reply.redirect("/login?sso_error=sso_failed", 302);
    }
  });

  /** Exchange the short-lived SSO cookie for the session token, then clear it. */
  app.post("/api/auth/sso/exchange", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const cookie = (req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("kx_sso="));
    const token = cookie?.slice("kx_sso=".length);
    if (!token) return reply.code(401).send({ error: "no_sso_cookie" });
    reply.header("set-cookie", "kx_sso=; HttpOnly; Path=/api/auth/sso/exchange; Max-Age=0");
    return { token };
  });
}
