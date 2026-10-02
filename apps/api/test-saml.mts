// SAML ACS E2E — crafts a signed SAMLResponse with the test IdP key and
// posts it to the live ACS endpoint. Requires API running with
// KREATIX_SAML_* env (see docs). KX_BASE defaults to localhost:3001.
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { deflateRawSync } from "node:zlib";
// xml-crypto is a transitive dep of @node-saml/node-saml — used here only
// to *forge* the test IdP's signature (the app does its own validation).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - no types needed for test
import { SignedXml } from "xml-crypto";

const BASE = process.env.KX_BASE ?? "http://localhost:3001";
const IDP_KEY = readFileSync(new URL("./test-fixtures/saml-idp-key.pem", import.meta.url), "utf8");
const IDP_CERT_B64 = readFileSync(new URL("./test-fixtures/saml-idp-cert.pem", import.meta.url), "utf8")
  .replace(/-----[^-]+-----|\s/g, "");

let passed = 0, failed = 0;
const check = (ok: boolean, label: string, extra?: unknown) => {
  if (ok) { passed++; console.log(`ok ${label}`); }
  else { failed++; console.log(`FAIL ${label}`, extra ?? ""); }
};

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const in10 = () => new Date(Date.now() + 600_000).toISOString().replace(/\.\d+Z$/, "Z");

function signedResponse(email: string, { sign = true, badSig = false }: { sign?: boolean; badSig?: boolean } = {}): string {
  const id = `_${Date.now()}x`;
  const assertionId = `_${Date.now()}a`;
  const assertion = `
  <saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" IssueInstant="${now()}" Version="2.0">
    <saml:Issuer>https://idp.example.com</saml:Issuer>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData NotOnOrAfter="${in10()}" Recipient="${BASE}/api/auth/saml/callback"/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="${now()}" NotOnOrAfter="${in10()}">
      <saml:AudienceRestriction><saml:Audience>kreatix-test</saml:Audience></saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AuthnStatement AuthnInstant="${now()}">
      <saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>
    </saml:AuthnStatement>
    <saml:AttributeStatement>
      <saml:Attribute Name="displayName"><saml:AttributeValue>Saml Test User</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>
    </saml:AttributeStatement>
  </saml:Assertion>`;

  const mkSig = (xpath: string) => {
    const sig = new SignedXml({
      privateKey: IDP_KEY,
      signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
      getKeyInfoContent: () => `<X509Data><X509Certificate>${IDP_CERT_B64}</X509Certificate></X509Data>`,
      idAttribute: "ID",
    });
    sig.addReference({
      xpath,
      transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
      digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    });
    return sig;
  };

  let signedAssertion = assertion;
  if (sign) {
    const sig = mkSig("//*[local-name()='Assertion']");
    sig.computeSignature(assertion, { location: { reference: "//*[local-name()='Assertion']/*[local-name()='Issuer']", action: "after" } } as never);
    signedAssertion = sig.getSignedXml();
  }

  const response = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
    ID="${id}" Version="2.0" IssueInstant="${now()}" Destination="${BASE}/api/auth/saml/callback" InResponseTo="">
  <saml:Issuer>https://idp.example.com</saml:Issuer>
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  ${signedAssertion}
</samlp:Response>`;

  if (!sign) return response;
  const sig2 = mkSig("//*[local-name()='Response']");
  sig2.computeSignature(response, { location: { reference: "//*[local-name()='Response']/*[local-name()='Issuer']", action: "after" } } as never);
  let out = sig2.getSignedXml();
  if (badSig) {
    const m = /(<[a-zA-Z:]*SignatureValue[^>]*>)(.)([^<]+)/.exec(out);
    if (!m) throw new Error("no SignatureValue found to corrupt");
    const idx = out.indexOf(m[0]);
    out = out.slice(0, idx) + m[1] + (m[2] === "0" ? "1" : "0") + m[3] + out.slice(idx + m[0].length);
  }
  return out;
}

const postAcs = async (samlResponse: string) => {
  const res = await fetch(`${BASE}/api/auth/saml/callback`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ SAMLResponse: Buffer.from(samlResponse).toString("base64") }),
    redirect: "manual",
  });
  return { status: res.status, location: res.headers.get("location") ?? "", cookie: res.headers.get("set-cookie") ?? "" };
};

// status + metadata
const st = await fetch(`${BASE}/api/auth/saml/status`).then((r) => r.json());
check(st.enabled === true, "saml status enabled");
const md = await fetch(`${BASE}/api/auth/saml/metadata`).then((r) => r.text());
check(md.includes("EntityDescriptor") && md.includes("/api/auth/saml/callback"), "SP metadata XML");

// happy path: signed assertion → 302 to /login?sso=1 + HttpOnly cookie
const email = `saml+${Date.now()}@example.com`;
const r1 = await postAcs(signedResponse(email));
check(r1.status === 302 && r1.location.includes("/login?sso=1"), "signed response → login redirect", { s: r1.status, l: r1.location });
check(r1.cookie.includes("kx_sso=") && r1.cookie.includes("HttpOnly"), "sso cookie set");

// exchange cookie → session token → /api/me works
const kx = (r1.cookie.match(/kx_sso=([^;]+)/) ?? [])[1];
if (kx) {
  const exch = await fetch(`${BASE}/api/auth/sso/exchange`, {
    method: "POST", headers: { "content-type": "application/json", cookie: `kx_sso=${kx}` }, body: "{}",
  }).then(async (r) => ({ s: r.status, b: await r.json() as { token?: string } }));
  check(exch.s === 200 && !!exch.b.token, "cookie → session token");
  if (exch.b.token) {
    const me = await fetch(`${BASE}/api/auth/me`, { headers: { authorization: `Bearer ${exch.b.token}` } }).then((r) => r.json() as Promise<{ user?: { email?: string; displayName?: string } }>);
    check(me.user?.email === email, "saml user provisioned + logged in", me);
    check(me.user?.displayName === "Saml Test User", "displayName mapped", me.user?.displayName);
  }
}

// tampered signature must be rejected
const r2 = await postAcs(signedResponse(`bad+${Date.now()}@example.com`, { badSig: true }));
check(r2.status === 302 && /sso_error/.test(r2.location), "bad signature → sso_error redirect", r2.location);

// unsigned response must be rejected (wantAuthnResponseSigned default)
const r3 = await postAcs(signedResponse(`nosig+${Date.now()}@example.com`, { sign: false }));
check(r3.status === 302 && /sso_error/.test(r3.location), "unsigned response → sso_error", r3.location);

// missing SAMLResponse → 400
const r4 = await fetch(`${BASE}/api/auth/saml/callback`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "foo=bar",
});
check(r4.status === 400, "missing SAMLResponse → 400");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
void deflateRawSync; void createSign;
