// Per-organization enterprise SSO — each workspace federates to its OWN IdP
// (its Okta/Entra/Google tenant), which is what makes the `ssoRequired`
// org policy usable for real customers. The env-configured global
// providers (KREATIX_SAML_*/KREATIX_OIDC_*) remain for single-tenant deploys.
//
// Flows mirror the global handlers:
//   SAML: GET /api/auth/orgsso/:org/login → IdP → POST …/acs → cookie → /login?sso=1
//   OIDC: GET /api/auth/orgsso/:org/login → provider → GET …/callback → cookie → /login?sso=1
// Discovery: GET /api/auth/orgsso/lookup?email=… — user's org config or
// managed-domain match → initiation URLs for the login page's SSO button.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { SAML } from "@node-saml/node-saml";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { q, one, run, now } from "../db.js";
import { encryptField, decryptField } from "../crypto.js";
import { initials, signToken, requireAuth, type AuthedRequest, type UserRow } from "../auth.js";
import { issueMobileCode, mobileAuthRedirect } from "../mobileAuth.js";
import { ensureSubscription, effectivePlan, planLimit, seatCount } from "../billing.js";

const RL = { max: 20, timeWindow: "1 minute" };

// ---- config -----------------------------------------------------------------

interface SamlConf { entryPoint: string; cert: string; spIssuer?: string }
interface OidcConf { issuer: string; clientId: string; clientSecret: string; scope?: string; requireVerifiedEmail?: boolean }

interface OrgSsoRow {
  id: string; org_id: string; protocol: "saml" | "oidc";
  config: string; domains: string[]; enabled: boolean;
}

const confSchema = {
  saml: z.object({
    entryPoint: z.string().url(),
    cert: z.string().min(100, "Paste the IdP's signing certificate (PEM)"),
    spIssuer: z.string().max(500).optional(),
  }),
  oidc: z.object({
    issuer: z.string().url(),
    clientId: z.string().min(3),
    clientSecret: z.string().min(8),
    scope: z.string().max(200).optional(),
    requireVerifiedEmail: z.boolean().optional(),
  }),
};

async function loadConfig(orgId: string, protocol: "saml" | "oidc") {
  const row = await one<OrgSsoRow>(
    "SELECT * FROM org_sso WHERE org_id = $1 AND protocol = $2 AND enabled", [orgId, protocol]);
  if (!row) return null;
  const conf = JSON.parse(decryptField(row.config) ?? "{}");
  return { row, conf: conf as SamlConf & OidcConf };
}

function publicBase(req: FastifyRequest): string {
  if (process.env.KREATIX_PUBLIC_URL) return process.env.KREATIX_PUBLIC_URL.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string) ?? req.protocol;
  return `${proto}://${req.headers.host}`;
}

// ---- state nonces (OIDC) — single-use, 10 min ------------------------------
const states = new Map<string, { orgId: string; exp: number; mobile: boolean }>();
const newState = (orgId: string, mobile: boolean) => {
  const s = randomBytes(16).toString("hex");
  states.set(s, { orgId, exp: Date.now() + 600_000, mobile });
  for (const [k, v] of states) if (v.exp < Date.now()) states.delete(k);
  return s;
};
const consumeState = (s: string) => {
  const e = states.get(s);
  states.delete(s);
  return e && e.exp > Date.now() ? e : null;
};

// ---- OIDC discovery (cached per issuer) -------------------------------------
interface Discovery { authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
const discoCache = new Map<string, Promise<Discovery>>();
function discover(issuer: string): Promise<Discovery> {
  const key = issuer.replace(/\/$/, "");
  let p = discoCache.get(key);
  if (!p) {
    p = fetch(`${key}/.well-known/openid-configuration`).then(async (r) => {
      if (!r.ok) throw new Error(`OIDC discovery failed: ${r.status}`);
      return (await r.json()) as Discovery;
    });
    p.catch(() => discoCache.delete(key)); // don't cache failures
    discoCache.set(key, p);
  }
  return p;
}

// ---- shared JIT complete: IdP identity → session ----------------------------
async function completeLogin(
  orgId: string, email: string, name: string,
  req: FastifyRequest, reply: { redirect: (u: string, c?: number) => unknown; header: (k: string, v: string) => unknown },
  mobile: boolean,
): Promise<unknown> {
  const fail = (msg: string) => reply.redirect(
    mobile ? mobileAuthRedirect({ sso_error: msg }) : `/login?sso_error=${encodeURIComponent(msg)}`, 302);

  let row = await one<UserRow>("SELECT * FROM users WHERE email = $1", [email]);
  if (row && row.org_id !== orgId) return fail("sso_wrong_tenant");
  if (!row) {
    // JIT member provision — seat-limited like invite joins
    const sub = await ensureSubscription(orgId);
    const maxMembers = planLimit(await effectivePlan(sub), "max_members", 0);
    if (maxMembers > 0 && (await seatCount(orgId)) >= maxMembers) return fail("seat_limit");
    const userId = randomUUID();
    await run(
      `INSERT INTO users (id, org_id, email, password_hash, display_name, initials, role, email_verified, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'member',true,$7)`,
      [userId, orgId, email, `sso:${randomUUID()}`, name, initials(name), now()],
    );
    row = (await one<UserRow>("SELECT * FROM users WHERE id = $1", [userId]))!;
  }
  if (row.disabled) return fail("account_disabled");

  const token = await signToken(row.id, "7d", "web", { ip: req.ip, ua: req.headers["user-agent"] });
  if (mobile) return reply.redirect(mobileAuthRedirect({ code: issueMobileCode(token) }), 302);
  const secure = publicBase(req).startsWith("https:") ? "; Secure" : "";
  reply.header("set-cookie",
    `kx_sso=${token}; HttpOnly; Path=/api/auth/sso/exchange; Max-Age=60; SameSite=Lax${secure}`);
  return reply.redirect("/login?sso=1", 302);
}

// ---- routes -----------------------------------------------------------------

export function orgSsoRoutes(app: FastifyInstance) {

  /** Discovery for the login page — given an email, which SSO providers can
   *  authenticate it? Checks the account's org configs, then managed-domain
   *  matches (JIT users have no account yet). Microsoft-style managed-domain
   *  behavior; deliberately returns the same shape for unknown emails. */
  app.get("/api/auth/orgsso/lookup", { config: { rateLimit: RL } }, async (req) => {
    const email = String((req.query as { email?: string }).email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { providers: [] };
    const domain = email.split("@")[1];

    const orgIds = new Set<string>();
    const user = await one<{ org_id: string }>("SELECT org_id FROM users WHERE email = $1", [email]);
    if (user) orgIds.add(user.org_id);
    const domMatches = await q<{ org_id: string }>(
      "SELECT org_id FROM org_sso WHERE enabled AND $1 = ANY(domains)", [domain]);
    for (const d of domMatches) orgIds.add(d.org_id);

    const providers: { protocol: string; orgId: string; label: string; url: string }[] = [];
    for (const orgId of orgIds) {
      const rows = await q<{ protocol: string; name: string }>(
        "SELECT s.protocol, o.name FROM org_sso s JOIN orgs o ON o.id = s.org_id WHERE s.org_id = $1 AND s.enabled",
        [orgId]);
      for (const r of rows) {
        providers.push({
          protocol: r.protocol, orgId,
          label: `${r.name} (${r.protocol === "saml" ? "SAML" : "SSO"})`,
          url: `/api/auth/orgsso/${orgId}/login?p=${r.protocol}`,
        });
      }
    }
    return { providers };
  });

  /** SP metadata for an org's SAML config — paste into their IdP. */
  app.get("/api/auth/orgsso/:orgId/metadata", async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const found = await loadConfig(orgId, "saml");
    if (!found) return reply.code(404).send({ error: "not_found" });
    const { conf } = found;
    const saml = new SAML({
      issuer: conf.spIssuer ?? `${publicBase(req)}/api/auth/orgsso/${orgId}`,
      callbackUrl: `${publicBase(req)}/api/auth/orgsso/${orgId}/acs`,
      entryPoint: conf.entryPoint,
      idpCert: conf.cert,
      audience: conf.spIssuer ?? `${publicBase(req)}/api/auth/orgsso/${orgId}`,
      wantAuthnResponseSigned: true, wantAssertionsSigned: true,
      acceptedClockSkewMs: 60_000, maxAssertionAgeMs: 10 * 60_000,
    });
    return reply.type("application/samlmetadata+xml").send(saml.generateServiceProviderMetadata(null, null));
  });

  /** Initiate — redirects to the org's IdP (SAML AuthnRequest or OIDC code). */
  app.get("/api/auth/orgsso/:orgId/login", { config: { rateLimit: RL } }, async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const { p, client } = req.query as { p?: string; client?: string };
    const mobile = client === "mobile";
    const protocol = p === "oidc" ? "oidc" : "saml";
    const found = await loadConfig(orgId, protocol);
    if (!found) return reply.code(404).send({ error: "not_found", message: "SSO not configured for this workspace" });
    const { conf } = found;

    try {
      if (protocol === "saml") {
        const saml = new SAML({
          issuer: conf.spIssuer ?? `${publicBase(req)}/api/auth/orgsso/${orgId}`,
          callbackUrl: `${publicBase(req)}/api/auth/orgsso/${orgId}/acs`,
          entryPoint: conf.entryPoint,
          idpCert: conf.cert,
          audience: conf.spIssuer ?? `${publicBase(req)}/api/auth/orgsso/${orgId}`,
          wantAuthnResponseSigned: true, wantAssertionsSigned: true,
          acceptedClockSkewMs: 60_000, maxAssertionAgeMs: 10 * 60_000,
        });
        const url = await saml.getAuthorizeUrlAsync(mobile ? "kx-mobile" : "", req.headers.host ?? "", {});
        return reply.redirect(url, 302);
      }
      const disco = await discover(conf.issuer);
      const url = new URL(disco.authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: conf.clientId,
        redirect_uri: `${publicBase(req)}/api/auth/orgsso/${orgId}/callback`,
        response_type: "code",
        scope: conf.scope ?? "openid email profile",
        state: newState(orgId, mobile),
      }).toString();
      return reply.redirect(url.toString(), 302);
    } catch (e) {
      return reply.code(502).send({ error: "sso_error", message: String(e) });
    }
  });

  /** OIDC callback — code → token → verified id_token → session. */
  app.get("/api/auth/orgsso/:orgId/callback", async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    const st = state ? consumeState(state) : null;
    const mobile = st?.mobile ?? false;
    const fail = (msg: string) => reply.redirect(
      mobile ? mobileAuthRedirect({ sso_error: msg }) : `/login?sso_error=${encodeURIComponent(msg)}`, 302);
    if (error) return fail(error);
    if (!code || !st || st.orgId !== orgId) return fail("invalid_state");

    const found = await loadConfig(orgId, "oidc");
    if (!found) return fail("sso_not_configured");
    const { conf } = found;
    try {
      const disco = await discover(conf.issuer);
      const tokenRes = await fetch(disco.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code", code,
          redirect_uri: `${publicBase(req)}/api/auth/orgsso/${orgId}/callback`,
          client_id: conf.clientId, client_secret: conf.clientSecret,
        }),
      });
      if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
      const tokens = (await tokenRes.json()) as { id_token?: string };
      if (!tokens.id_token) throw new Error("no id_token");

      const { payload } = await jwtVerify(
        tokens.id_token,
        createRemoteJWKSet(new URL(disco.jwks_uri)),
        { issuer: conf.issuer.replace(/\/$/, ""), audience: conf.clientId },
      );
      const email = String(payload.email ?? "").trim();
      const verified = conf.requireVerifiedEmail === false ? true : payload.email_verified === true;
      if (!email || !verified) return fail("no_verified_email");
      const name = String(payload.name ?? payload.preferred_username ?? email.split("@")[0]);
      return await completeLogin(orgId, email, name, req, reply, mobile);
    } catch (e) {
      req.log.warn({ err: String(e) }, "org oidc callback failed");
      return fail("sso_failed");
    }
  });

  /** SAML ACS — IdP posts the signed SAMLResponse here. */
  app.post("/api/auth/orgsso/:orgId/acs", async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const body = (req.body ?? {}) as Record<string, string>;
    const mobile = body.RelayState === "kx-mobile";
    const fail = (msg: string) => reply.redirect(
      mobile ? mobileAuthRedirect({ sso_error: msg }) : `/login?sso_error=${msg}`, 302);
    if (!body.SAMLResponse) return reply.code(400).send({ error: "missing SAMLResponse" });

    const found = await loadConfig(orgId, "saml");
    if (!found) return fail("sso_not_configured");
    const { conf } = found;
    try {
      const saml = new SAML({
        issuer: conf.spIssuer ?? `${publicBase(req)}/api/auth/orgsso/${orgId}`,
        callbackUrl: `${publicBase(req)}/api/auth/orgsso/${orgId}/acs`,
        entryPoint: conf.entryPoint,
        idpCert: conf.cert,
        audience: conf.spIssuer ?? `${publicBase(req)}/api/auth/orgsso/${orgId}`,
        wantAuthnResponseSigned: true, wantAssertionsSigned: true,
        acceptedClockSkewMs: 60_000, maxAssertionAgeMs: 10 * 60_000,
      });
      const { profile } = await saml.validatePostResponseAsync(body);
      if (!profile) throw new Error("no profile");
      const email = String(
        profile.email ?? profile.mail
        ?? profile["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"]
        ?? profile.nameID ?? "",
      );
      if (!email || !email.includes("@")) return fail("saml_no_email");
      const name = String(
        profile.displayName ?? profile["http://schemas.microsoft.com/identity/claims/displayname"]
        ?? ([profile.givenName ?? profile["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname"],
             profile.surname ?? profile["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname"]]
          .filter(Boolean).join(" ") || email.split("@")[0]),
      );
      return await completeLogin(orgId, email, name, req, reply, mobile);
    } catch (e) {
      req.log.warn({ err: String(e) }, "org saml acs failed");
      return fail("saml_failed");
    }
  });

  // ---- admin management (org owner/admin) ------------------------------------

  /** GET /api/admin/sso — the org's configured IdPs, secrets masked. */
  app.get("/api/admin/sso", { preHandler: requireAuth }, async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (user.role !== "owner" && user.role !== "admin") return reply.code(403).send({ error: "forbidden" });
    const rows = await q<OrgSsoRow>("SELECT * FROM org_sso WHERE org_id = $1", [user.orgId]);
    return {
      providers: rows.map((r) => {
        let c: Record<string, unknown> = {};
        try { c = JSON.parse(decryptField(r.config) ?? "{}"); } catch { /* unreadable */ }
        return {
          id: r.id, protocol: r.protocol, enabled: r.enabled, domains: r.domains,
          config: r.protocol === "saml"
            ? { entryPoint: c.entryPoint, spIssuer: c.spIssuer, certSet: !!c.cert }
            : { issuer: c.issuer, clientId: c.clientId, clientSecretSet: !!c.clientSecret, scope: c.scope },
          metadataUrl: r.protocol === "saml" ? `/api/auth/orgsso/${r.org_id}/metadata` : null,
          callbackUrl: r.protocol === "oidc"
            ? `/api/auth/orgsso/${r.org_id}/callback` : `/api/auth/orgsso/${r.org_id}/acs`,
        };
      }),
    };
  });

  /** PUT /api/admin/sso/:protocol — upsert an IdP config. Secrets are
   *  encrypted at rest and never returned. */
  app.put("/api/admin/sso/:protocol", { preHandler: requireAuth }, async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (user.role !== "owner" && user.role !== "admin") return reply.code(403).send({ error: "forbidden" });
    const { protocol } = req.params as { protocol: string };
    if (protocol !== "saml" && protocol !== "oidc") return reply.code(400).send({ error: "bad_request" });
    const body = z.object({
      config: z.record(z.string(), z.unknown()),
      domains: z.array(z.string().min(3).max(200)).max(50).default([]),
      enabled: z.boolean().default(true),
    }).parse(req.body);
    const conf = confSchema[protocol].parse(body.config);
    const domains = body.domains.map((d) => d.trim().toLowerCase().replace(/^\*?\./, "")).filter(Boolean);
    await run(
      `INSERT INTO org_sso (id, org_id, protocol, config, domains, enabled, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
       ON CONFLICT(org_id, protocol) DO UPDATE
       SET config = excluded.config, domains = excluded.domains,
           enabled = excluded.enabled, updated_at = excluded.updated_at`,
      [randomUUID(), user.orgId, protocol, encryptField(JSON.stringify(conf))!, domains, body.enabled, now()],
    );
    void (await import("../items.js")).logActivity(user.orgId, user.id, null, "sso-config", `${protocol} ${body.enabled ? "enabled" : "disabled"}`);
    return { ok: true };
  });

  app.delete("/api/admin/sso/:protocol", { preHandler: requireAuth }, async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (user.role !== "owner" && user.role !== "admin") return reply.code(403).send({ error: "forbidden" });
    const { protocol } = req.params as { protocol: string };
    await run("DELETE FROM org_sso WHERE org_id = $1 AND protocol = $2", [user.orgId, protocol]);
    return { ok: true };
  });
}
