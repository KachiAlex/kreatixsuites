// End-to-end MFA test against a live server (default http://127.0.0.1:3017).
// Registers a throwaway user, enrolls TOTP, verifies the two-step login,
// backup-code consumption, and disable. Cleans nothing (users are cheap).
import { createHmac, createHash, randomBytes } from "node:crypto";

const BASE = process.env.KX_BASE ?? "http://127.0.0.1:3017";
let pass = 0, fail = 0;
const ok = (cond: boolean, name: string) => { cond ? pass++ : fail++; console.log(`${cond ? "✓" : "✗ FAIL"} ${name}`); };

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32decode(s: string): Buffer {
  let bits = 0, val = 0; const out: number[] = [];
  for (const c of s.toUpperCase().replace(/=+$/, "")) {
    const i = B32.indexOf(c); if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret: string, t = Math.floor(Date.now() / 30000)): string {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(t));
  const h = createHmac("sha1", b32decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  return (((h[off] & 0x7f) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % 1_000_000).toString().padStart(6, "0");
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function post(path: string, body: unknown, token?: string) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> };
}
async function get(path: string, token?: string) {
  const r = await fetch(`${BASE}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> };
}

const email = `mfa-${randomBytes(4).toString("hex")}@test.kreatix.local`;
const password = "testpass-1234";

// register
const reg = await post("/api/auth/register", { email, password, displayName: "MFA Test" });
ok(reg.status === 200 && typeof reg.body.token === "string", "register");
const token = reg.body.token as string;

// login without MFA first
const l0 = await post("/api/auth/login", { email, password });
ok(l0.status === 200 && typeof l0.body.token === "string" && !l0.body.mfaRequired, "login (no MFA) → direct token");

// mfa setup
const setup = await post("/api/auth/mfa/setup", {}, token);
ok(setup.status === 200 && /^[A-Z2-7]{32}$/.test(setup.body.secret as string) && String(setup.body.uri).startsWith("otpauth://"), "mfa/setup returns secret + uri");
const secret = setup.body.secret as string;

// enable with wrong code rejected
const badEnable = await post("/api/auth/mfa/enable", { secret, code: "000000" }, token);
ok(badEnable.status === 400, "mfa/enable rejects wrong code");

// enable with correct code
const en = await post("/api/auth/mfa/enable", { secret, code: totp(secret) }, token);
ok(en.status === 200 && Array.isArray(en.body.backupCodes) && (en.body.backupCodes as string[]).length === 8, "mfa/enable returns 8 backup codes");
const backups = en.body.backupCodes as string[];

// /me reports mfaEnabled
const me = await get("/api/auth/me", token);
ok((me.body.user as { mfaEnabled?: boolean })?.mfaEnabled === true, "/me reports mfaEnabled");

// login now requires MFA
const l1 = await post("/api/auth/login", { email, password });
ok(l1.status === 200 && l1.body.mfaRequired === true && typeof l1.body.mfaToken === "string", "login → mfaRequired + mfaToken");
ok(!l1.body.token, "login does NOT leak a session token pre-MFA");

// mfa token is rejected as a session token
const meBad = await get("/api/auth/me", l1.body.mfaToken as string);
ok(meBad.status === 401, "mfaToken rejected by requireAuth (not a session)");

// wrong TOTP rejected
const m1 = await post("/api/auth/mfa/login", { mfaToken: l1.body.mfaToken, code: "999999" });
ok(m1.status === 401, "mfa/login rejects wrong TOTP");

// correct TOTP
const l2 = await post("/api/auth/login", { email, password });
const m2 = await post("/api/auth/mfa/login", { mfaToken: l2.body.mfaToken, code: totp(secret) });
ok(m2.status === 200 && typeof m2.body.token === "string", "mfa/login with valid TOTP → session token");
const me2 = await get("/api/auth/me", m2.body.token as string);
ok(me2.status === 200, "session token works after MFA");

// backup code login
const l3 = await post("/api/auth/login", { email, password });
const m3 = await post("/api/auth/mfa/login", { mfaToken: l3.body.mfaToken, code: backups[0] });
ok(m3.status === 200 && typeof m3.body.token === "string", "backup code login works");
// reuse the same backup code — must fail
const l4 = await post("/api/auth/login", { email, password });
const m4 = await post("/api/auth/mfa/login", { mfaToken: l4.body.mfaToken, code: backups[0] });
ok(m4.status === 401, "backup code is single-use");

// regenerate codes requires TOTP
const rg = await post("/api/auth/mfa/codes", { code: totp(secret) }, token);
ok(rg.status === 200 && (rg.body.backupCodes as string[]).length === 8, "backup codes regenerate with TOTP");

// disable with wrong password rejected
const dBad = await post("/api/auth/mfa/disable", { password: "wrong", code: totp(secret) }, token);
ok(dBad.status === 401, "mfa/disable rejects wrong password");

// disable with password + backup code (proves backup path in disable)
const dOk = await post("/api/auth/mfa/disable", { password, code: (rg.body.backupCodes as string[])[0] }, token);
ok(dOk.status === 200, "mfa/disable with password + backup code");

// login is single-step again
const l5 = await post("/api/auth/login", { email, password });
ok(l5.status === 200 && typeof l5.body.token === "string" && !l5.body.mfaRequired, "login single-step again after disable");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
