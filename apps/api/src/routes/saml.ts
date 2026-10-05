// SAML 2.0 single sign-on (SP side). Configure via env:
//   KREATIX_SAML_ENTRY_POINT  IdP SSO redirect URL (HTTP-Redirect binding)
//   KREATIX_SAML_ISSUER       our SP entityID, e.g. https://suite.example.com
//   KREATIX_SAML_CERT         IdP signing certificate (PEM; "\n" escapes ok)
//   KREATIX_SAML_CALLBACK     optional; defaults to <request origin>/api/auth/saml/callback
//   KREATIX_SAML_AUDIENCE     optional; defaults to KREATIX_SAML_ISSUER
//   KREATIX_SAML_WANT_SIGNED  optional; "true" (default) requires signed assertions
//
// Flow: GET /api/auth/saml → IdP → POST /api/auth/saml/callback (SAMLResponse)
// → signature + conditions validated → find-or-create user → HttpOnly cookie →
// /login?sso=1 → POST /api/auth/saml/exchange → session token.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { SAML } from "@node-saml/node-saml";
import { one, run, now } from "../db.js";
import { initials, signToken, type UserRow } from "../auth.js";
import { issueMobileCode, mobileAuthRedirect } from "../mobileAuth.js";

const ENTRY_POINT = process.env.KREATIX_SAML_ENTRY_POINT;
const ISSUER = process.env.KREATIX_SAML_ISSUER;
const CERT = process.env.KREATIX_SAML_CERT?.replace(/\\n/g, "\n");

export const samlEnabled = !!(ENTRY_POINT && ISSUER && CERT);

function callbackUrl(req: FastifyRequest): string {
  if (process.env.KREATIX_SAML_CALLBACK) return process.env.KREATIX_SAML_CALLBACK;
  // configured public URL beats the (client-controlled) Host header — the
  // callback is baked into SAML requests and metadata
  if (process.env.KREATIX_PUBLIC_URL)
    return `${process.env.KREATIX_PUBLIC_URL.replace(/\/$/, "")}/api/auth/saml/callback`;
  return `${req.protocol}://${req.host}/api/auth/saml/callback`;
}

function samlFor(req: FastifyRequest): SAML {
  return new SAML({
    issuer: ISSUER!,
    callbackUrl: callbackUrl(req),
    entryPoint: ENTRY_POINT!,
    idpCert: CERT!,
    audience: process.env.KREATIX_SAML_AUDIENCE ?? ISSUER!,
    wantAuthnResponseSigned: process.env.KREATIX_SAML_WANT_SIGNED !== "false",
    wantAssertionsSigned: process.env.KREATIX_SAML_WANT_SIGNED !== "false",
    acceptedClockSkewMs: 60_000,
    maxAssertionAgeMs: 10 * 60_000,
  });
}

export function samlRoutes(app: FastifyInstance) {
  // IdP ACS posts are urlencoded
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    try { done(null, Object.fromEntries(new URLSearchParams(body as string))); }
    catch (e) { done(e as Error); }
  });

  app.get("/api/auth/saml/status", async () => ({ enabled: samlEnabled }));

  /** SP metadata — paste into the IdP's "service provider" configuration. */
  app.get("/api/auth/saml/metadata", async (req, reply) => {
    if (!samlEnabled) return reply.code(404).send({ error: "saml_disabled" });
    const xml = samlFor(req).generateServiceProviderMetadata(null, null);
    return reply.type("application/samlmetadata+xml").send(xml);
  });

  /** SP-initiated login → redirect to IdP. ?client=mobile marks RelayState so
   *  the ACS POST returns a kx:// deep link (the response rides the system
   *  browser; a cookie wouldn't make it back into the app). */
  app.get("/api/auth/saml", async (req, reply) => {
    if (!samlEnabled) return reply.code(404).send({ error: "saml_disabled" });
    try {
      const mobile = (req.query as { client?: string }).client === "mobile";
      const url = await samlFor(req).getAuthorizeUrlAsync(mobile ? "kx-mobile" : "", req.headers.host ?? "", {});
      return reply.redirect(url, 302);
    } catch (e) {
      return reply.code(502).send({ error: "saml_error", message: String(e) });
    }
  });

  /** ACS — IdP posts the signed SAMLResponse here. */
  app.post("/api/auth/saml/callback", async (req, reply) => {
    if (!samlEnabled) return reply.code(404).send({ error: "saml_disabled" });
    const body = (req.body ?? {}) as Record<string, string>;
    if (!body.SAMLResponse) return reply.code(400).send({ error: "missing SAMLResponse" });
    const mobile = body.RelayState === "kx-mobile";
    const fail = (msg: string) => reply.redirect(
      mobile ? mobileAuthRedirect({ sso_error: msg }) : `/login?sso_error=${msg}`, 302);
    try {
      const { profile } = await samlFor(req).validatePostResponseAsync(body);
      if (!profile) throw new Error("no profile in SAML response");
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

      let row = await one<UserRow>("SELECT * FROM users WHERE email = $1", [email]);
      if (!row) {
        const orgId = randomUUID();
        const userId = randomUUID();
        await run("INSERT INTO orgs (id, name, created_at) VALUES ($1,$2,$3)", [orgId, `${name}'s workspace`, now()]);
        await run(
          "INSERT INTO users (id, org_id, email, password_hash, display_name, initials, role, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [userId, orgId, email, `sso:${randomUUID()}`, name, initials(name), "owner", now()],
        );
        row = (await one<UserRow>("SELECT * FROM users WHERE id = $1", [userId]))!;
      }
      if (row.disabled) return fail("account_disabled");
      const token = await signToken(row.id);
      if (mobile) return reply.redirect(mobileAuthRedirect({ code: issueMobileCode(token) }), 302);
      const secure = callbackUrl(req).startsWith("https:") ? "; Secure" : "";
      reply.header("set-cookie",
        `kx_sso=${token}; HttpOnly; Path=/api/auth/sso/exchange; Max-Age=60; SameSite=Lax${secure}`);
      return reply.redirect("/login?sso=1", 302);
    } catch (e) {
      req.log.warn({ err: String(e) }, "saml callback failed");
      return fail("saml_failed");
    }
  });
}
