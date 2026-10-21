// Enterprise controls e2e — run on VPS against http://127.0.0.1:3017
import { createHmac, randomBytes, createHash } from "node:crypto";
import { execSync } from "node:child_process";

const BASE = "http://127.0.0.1:3017";
const psql = (sql) => execSync(`docker exec kreatix-db-1 psql -U kreatix -d kreatix -tAqc "${sql.replaceAll('"', '\\"')}"`).toString().trim();
const results = [];
const check = (name, cond, extra = "") => { results.push([name, !!cond, extra]); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`); };

const api = async (path, { method = "GET", token, body, headers = {}, raw } = {}) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
               ...(body && !raw ? { "content-type": "application/json" } : {}), ...headers },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const ct = r.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await r.json() : await r.text();
  return { status: r.status, data, headers: r.headers };
};

// TOTP (RFC 6238, mirrors mfa.ts)
const b32 = (s) => {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = 0, val = 0; const out = [];
  for (const c of s.replace(/=+$/, "")) { val = (val << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
};
const totp = (secret, t = Math.floor(Date.now() / 30000)) => {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(t));
  const h = createHmac("sha1", b32(secret)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return (n % 1e6).toString().padStart(6, "0");
};

const stamp = Date.now().toString(36);
const emailA = `e2e-ent-a-${stamp}@example.com`;
const emailB = `e2e-ent-b-${stamp}@example.org`;

// 1. register two orgs — A (test tenant) + B (external share target)
const regA = await api("/api/auth/register", { method: "POST", body: { email: emailA, password: "Str0ng!Pass", displayName: "Ent Test A", orgName: "EntTestA" } });
check("register org A", regA.status === 200 && regA.data.token, `status ${regA.status}`);
const tokA = regA.data.token; const userA = regA.data.user;
const regB = await api("/api/auth/register", { method: "POST", body: { email: emailB, password: "Str0ng!Pass", displayName: "Ent Test B", orgName: "EntTestB" } });
check("register org B", regB.status === 200 && regB.data.token);
const tokB = regB.data.token;

// 2. set org A policies directly
psql(`INSERT INTO org_policies (org_id, json) VALUES ('${userA.orgId}', '{"mfaRequired":true,"blockConfidentialDownloads":true,"passwordComplexity":true}') ON CONFLICT (org_id) DO UPDATE SET json = excluded.json`);

// 3. MFA gate
let me = await api("/api/auth/me", { token: tokA });
check("/me reports mfaSetupRequired", me.data.mfaSetupRequired === true, JSON.stringify(me.data.mfaSetupRequired));
const gated = await api("/api/drive", { token: tokA });
check("non-auth path blocked pre-enroll", gated.status === 403 && gated.data.error === "mfa_enrollment_required", `status ${gated.status}`);

// 4. enroll — full TOTP round trip
const setup = await api("/api/auth/mfa/setup", { method: "POST", token: tokA, body: {} });
check("mfa/setup under gate", setup.status === 200 && !!setup.data.secret);
const en = await api("/api/auth/mfa/enable", { method: "POST", token: tokA, body: { secret: setup.data.secret, code: totp(setup.data.secret) } });
check("mfa/enable with valid TOTP", en.status === 200 && Array.isArray(en.data.backupCodes), `status ${en.status}`);
me = await api("/api/auth/me", { token: tokA });
check("/me clears flag post-enroll", me.data.mfaSetupRequired === false);
const drv = await api("/api/drive", { token: tokA });
check("drive accessible post-enroll", drv.status === 200, `status ${drv.status}`);

// 5. login now requires the TOTP second factor — mark verified first
// (open signups must verify before their *next* login)
psql(`UPDATE users SET email_verified = true WHERE email IN ('${emailA}','${emailB}')`);
const loginNoMfa = await api("/api/auth/login", { method: "POST", body: { email: emailA, password: "Str0ng!Pass" } });
check("login returns mfa challenge", loginNoMfa.data.mfaRequired === true && !!loginNoMfa.data.mfaToken,
  `${loginNoMfa.status} ${JSON.stringify(loginNoMfa.data).slice(0, 120)}`);
const loginMfa = await api("/api/auth/mfa/login", { method: "POST", body: { mfaToken: loginNoMfa.data.mfaToken, code: totp(setup.data.secret) } });
check("mfa login completes", loginMfa.status === 200 && !!loginMfa.data.token, `status ${loginMfa.status}`);
const tokA2 = loginMfa.data.token;

// 6. upload binary + label confidential + share viewer to org B user
const up = await api("/api/drive/upload?name=conf.png", { method: "POST", token: tokA2, raw: true,
  headers: { "content-type": "application/octet-stream" },
  body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...randomBytes(64)]) });
check("binary upload", up.status === 200 && up.data.item?.id, JSON.stringify(up.data).slice(0, 120));
const fileId = up.data.item?.id;
const patch = await api(`/api/drive/${fileId}`, { method: "PATCH", token: tokA2, body: { label: "confidential" } });
check("label confidential", patch.status === 200, `status ${patch.status}`);
const shr = await api(`/api/files/${fileId}/shares`, { method: "POST", token: tokA2, body: { email: emailB, permission: "viewer" } });
check("share to external viewer", shr.status === 200, `status ${shr.status}`);

// 7. download gate — external viewer blocked, owner unaffected
const dlB = await api(`/api/files/${fileId}/content`, { token: tokB });
check("viewer /content blocked", dlB.status === 403 && dlB.data.error === "download_blocked", `status ${dlB.status}`);
const rawB = await api(`/api/files/${fileId}/raw`, { token: tokB });
check("viewer /raw blocked", rawB.status === 403, `status ${rawB.status}`);
const dlA = await api(`/api/files/${fileId}/content`, { token: tokA2 });
check("owner /content unaffected", dlA.status === 200, `status ${dlA.status}`);

// 8. public link — anon guest also blocked by org policy on labeled file
const mkLink = await api(`/api/files/${fileId}/links`, { method: "POST", token: tokA2, body: { permission: "viewer" } });
check("create public link", mkLink.status === 200 && !!mkLink.data.token, JSON.stringify(mkLink.data).slice(0, 100));
const linkTok = mkLink.data.token;
const anon = await api(`/api/links/${linkTok}/content`);
check("anon link download blocked", anon.status === 403, `status ${anon.status}`);

// 9. access review — link + external share listed
const ar = await api("/api/admin/access-review", { token: tokA2 });
const kinds = (ar.data.grants ?? []).map(g => g.kind).sort();
check("access-review lists grants", ar.status === 200 && kinds.includes("public_link") && kinds.includes("external_share"),
  JSON.stringify(ar.data.counts));
const arCsv = await api("/api/admin/access-review?format=csv", { token: tokA2 });
check("access-review CSV", arCsv.status === 200 && typeof arCsv.data === "string" && arCsv.data.includes("public_link"), `status ${arCsv.status}`);

// 10. new-IP alert — second login from a different X-Forwarded-For
await api("/api/auth/login", { method: "POST", headers: { "x-forwarded-for": "203.0.113.77" },
  body: { email: emailB, password: "Str0ng!Pass" } });
await api("/api/auth/login", { method: "POST", headers: { "x-forwarded-for": "198.51.100.99" },
  body: { email: emailB, password: "Str0ng!Pass" } });
await new Promise(r => setTimeout(r, 1500)); // alert fires in a detached task
const newIp = psql(`SELECT COUNT(*) FROM activity WHERE action = 'auth.new-ip' AND actor_id = (SELECT id FROM users WHERE email='${emailB}')`);
check("new-IP audit row", Number(newIp) >= 1, `rows ${newIp}`);

// 11. password complexity — mint a reset token for user A
const resetTok = randomBytes(32).toString("base64url");
const tokHash = createHash("sha256").update(resetTok).digest("hex");
psql(`INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at, created_at) VALUES ('${randomBytes(16).toString("hex")}', '${userA.id}', 'password_reset', '${tokHash}', now() + interval '30 min', now())`);
const weak = await api("/api/auth/reset", { method: "POST", body: { token: resetTok, password: "alllowercase1" } });
check("weak password rejected", weak.status === 400 && /uppercase|lowercase|number/i.test(weak.data.message ?? ""), `status ${weak.status}`);
const resetTok2 = randomBytes(32).toString("base64url");
psql(`INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at, created_at) VALUES ('${randomBytes(16).toString("hex")}', '${userA.id}', 'password_reset', '${createHash("sha256").update(resetTok2).digest("hex")}', now() + interval '30 min', now())`);
const strong = await api("/api/auth/reset", { method: "POST", body: { token: resetTok2, password: "MixedCase99" } });
check("compliant password accepted", strong.status === 200, `status ${strong.status}`);

// 12. metrics endpoint
const metUn = await api("/api/metrics");
check("/api/metrics unauth → 401", metUn.status === 401, `status ${metUn.status}`);

console.log(`\n${results.filter(r => r[1]).length}/${results.length} checks passed`);
// stash ids for cleanup
console.log(`CLEANUP ${userA.id} ${emailA} ${regB.data.user.id} ${emailB} ${userA.orgId} ${regB.data.user.orgId}`);
