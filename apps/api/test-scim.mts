// SCIM 2.0 E2E — exercises provisioning token admin + Users CRUD/filter/PATCH
// against a live API (KX_BASE, default http://localhost:3001).
const BASE = process.env.KX_BASE ?? "http://localhost:3001";
let passed = 0, failed = 0;
const check = (ok: boolean, label: string, extra?: unknown) => {
  if (ok) { passed++; console.log(`ok ${label}`); }
  else { failed++; console.log(`FAIL ${label}`, extra ?? ""); }
};

const j = async (path: string, opts: RequestInit = {}, token?: string, scim = false) => {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      ...(opts.body ? { "content-type": scim ? "application/scim+json" : "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("json") ? await res.json() : await res.text();
  return { status: res.status, body: body as Record<string, unknown> };
};

const su = `scimtest+${Date.now()}@example.com`;
// 1. org owner registers → gets session JWT
const reg = await j("/api/auth/register", { method: "POST", body: JSON.stringify({ email: su, password: "OwnerPass!1", displayName: "SCIM Admin", orgName: "SCIM Org" }) });
check(reg.status === 200 || reg.status === 201, "register org owner", reg.body);
const jwt = (reg.body.token ?? reg.body.accessToken) as string;
check(!!jwt, "owner jwt");

// 2. create a provisioning token via admin API
const tok = await j("/api/admin/scim/tokens", { method: "POST", body: JSON.stringify({ label: "okta-test" }) }, jwt);
check(tok.status === 200 && typeof tok.body.token === "string" && String(tok.body.token).startsWith("kxscim_"), "admin creates scim token", tok.body);
const scim = tok.body.token as string;

// 3. token list shows it (without the secret)
const list = await j("/api/admin/scim/tokens", {}, jwt);
check(Array.isArray(list.body.tokens) && (list.body.tokens as { token?: string }[]).every((t) => !("token" in t)), "token list hides secret");

// 4. discovery docs
const spc = await j("/scim/v2/ServiceProviderConfig", {}, scim, true);
check(spc.status === 200 && (spc.body.patch as { supported: boolean })?.supported === true, "ServiceProviderConfig");
const rt = await j("/scim/v2/ResourceTypes", {}, scim, true);
check(rt.status === 200 && (rt.body.Resources as { id: string }[])?.[0]?.id === "User", "ResourceTypes");

// 5. bad token rejected
const bad = await j("/scim/v2/Users", {}, "kxscim_wrong", true);
check(bad.status === 401, "bad token → 401");

// 6. provision a user
const target = `prov+${Date.now()}@example.com`;
const created = await j("/scim/v2/Users", {
  method: "POST",
  body: JSON.stringify({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: target, password: "ProvPass!1", externalId: "idp-99", name: { givenName: "Pro", familyName: "Visioned" }, active: true }),
}, scim, true);
check(created.status === 201, "POST /Users → 201", created.body);
const uid = created.body.id as string;
check(!!uid && created.body.userName === target && created.body.active === true, "user resource shape");
check(created.body.displayName === "Pro Visioned", "displayName from name parts", created.body.displayName);
// 7. the provisioned user can actually log in
const login = await j("/api/auth/login", { method: "POST", body: JSON.stringify({ email: target, password: "ProvPass!1" }) });
check(login.status === 200 && !!(login.body.token ?? login.body.accessToken), "provisioned user can login", login.status);

// 8. duplicate userName → 409
const dup = await j("/scim/v2/Users", { method: "POST", body: JSON.stringify({ userName: target }) }, scim, true);
check(dup.status === 409 && dup.body.scimType === "uniqueness", "duplicate → 409", dup.body);

// 9. filter lookup
const filt = await j(`/scim/v2/Users?filter=${encodeURIComponent(`userName eq "${target}"`)}`, {}, scim, true);
check(filt.status === 200 && filt.body.totalResults === 1, "userName eq filter", filt.body.totalResults);
const fext = await j(`/scim/v2/Users?filter=${encodeURIComponent(`externalId eq "idp-99"`)}`, {}, scim, true);
check(fext.status === 200 && fext.body.totalResults === 1, "externalId eq filter");
const badF = await j(`/scim/v2/Users?filter=${encodeURIComponent('userName co "x"')}`, {}, scim, true);
check(badF.status === 400, "unsupported filter → 400");

// 10. PATCH deactivate (Entra-style value object + path style)
const p1 = await j(`/scim/v2/Users/${uid}`, { method: "PATCH", body: JSON.stringify({ schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "Replace", path: "active", value: false }] }) }, scim, true);
check(p1.status === 200 && p1.body.active === false, "PATCH active=false");
const loginOff = await j("/api/auth/login", { method: "POST", body: JSON.stringify({ email: target, password: "ProvPass!1" }) });
check(loginOff.status === 401 || loginOff.status === 403, "deactivated user cannot login", loginOff.status);
const p2 = await j(`/scim/v2/Users/${uid}`, { method: "PATCH", body: JSON.stringify({ Operations: [{ op: "replace", value: { active: true, displayName: "Renamed User" } }] }) }, scim, true);
check(p2.status === 200 && p2.body.active === true && p2.body.displayName === "Renamed User", "PATCH value-object form");

// 11. PUT full replace incl. userName change
const renamed = `moved+${Date.now()}@example.com`;
const put = await j(`/scim/v2/Users/${uid}`, { method: "PUT", body: JSON.stringify({ userName: renamed, displayName: "Moved User", active: true }) }, scim, true);
check(put.status === 200 && put.body.userName === renamed, "PUT replaces userName");
const loginNew = await j("/api/auth/login", { method: "POST", body: JSON.stringify({ email: renamed, password: "ProvPass!1" }) });
check(loginNew.status === 200, "login under new userName");

// 12. org isolation — a second org's token must not see this user
const reg2 = await j("/api/auth/register", { method: "POST", body: JSON.stringify({ email: `other+${Date.now()}@example.com`, password: "OwnerPass!1", displayName: "Other", orgName: "Other Org" }) });
const jwt2 = (reg2.body.token ?? reg2.body.accessToken) as string;
const tok2 = await j("/api/admin/scim/tokens", { method: "POST", body: JSON.stringify({}) }, jwt2);
const cross = await j(`/scim/v2/Users/${uid}`, {}, tok2.body.token as string, true);
check(cross.status === 404, "cross-org user → 404");

// 13. pagination shape
const page = await j("/scim/v2/Users?startIndex=1&count=1", {}, scim, true);
check(page.status === 200 && page.body.itemsPerPage === 1 && (page.body.totalResults as number) >= 2, "pagination");

// 14. DELETE
const del = await j(`/scim/v2/Users/${uid}`, { method: "DELETE" }, scim, true);
check(del.status === 204, "DELETE → 204");
const gone = await j(`/scim/v2/Users/${uid}`, {}, scim, true);
check(gone.status === 404 || (gone.body.active === false), "deleted user gone/disabled");

// 15. revoke token → 401
const del2 = await j(`/api/admin/scim/tokens/${(list.body.tokens as { id: string }[])[0].id}`, { method: "DELETE" }, jwt);
check(del2.status === 200, "revoke token");
const revoked = await j("/scim/v2/Users", {}, scim, true);
check(revoked.status === 401, "revoked token → 401");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
