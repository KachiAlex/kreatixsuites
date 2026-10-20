const API = "https://suites.kreatixtech.com";
const stamp = Date.now().toString(36);
const J = async (r) => { const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, j: t }; } };
const out = (k, v) => console.log(k.padEnd(26), v);

// owner + workspace
const reg = await J(await fetch(`${API}/api/auth/register`, { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: `sig-${stamp}@t.kreatixtest.io`, password: "Test1234!x", displayName: "Boss", kind: "business" }) }));
const H = { "content-type": "application/json", authorization: `Bearer ${reg.j.token}` };
const org = reg.j.user?.orgId ?? (await J(await fetch(`${API}/api/auth/me`, { headers: H }))).j.user?.orgId;

// second member via invite
const inv = await J(await fetch(`${API}/api/admin/invites`, { method: "POST", headers: H,
  body: JSON.stringify({ role: "member" }) }));
const reg2 = await J(await fetch(`${API}/api/auth/register`, { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: `sig2-${stamp}@t.kreatixtest.io`, password: "Test1234!x", displayName: "Not Boss", invite: inv.j.invite?.token ?? inv.j.token, kind: "business" }) }));
const H2 = { "content-type": "application/json", authorization: `Bearer ${reg2.j.token}` };
out("member joined", reg2.s);

// members list (picker source) — non-admin can fetch it
const mem = await J(await fetch(`${API}/api/forms/members`, { headers: H2 }));
out("member roster", `${mem.s} n=${mem.j.members?.length}`);

// form requires signature; only the owner signs
const cf = await J(await fetch(`${API}/api/forms`, { method: "POST", headers: H,
  body: JSON.stringify({ title: "Expense Sign-off", fields: [
    { id: "q1", label: "Amount", type: "number", required: true },
    { id: "q2", label: "Reason", type: "text", required: true },
  ], settings: { requireSignature: true, signatories: [reg.j.user?.id ?? ""] } }) }));
const form = cf.j.form; out("create", `${cf.s} requireSignature=${form.settings.requireSignature}`);

// public submit → pending
const sub = await J(await fetch(`${API}/api/forms/public/${form.token}`, { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ answers: { q1: 42000, q2: "Hardware" }, respondent: "expense@staff" }) }));
out("submit → pending", sub.s);
const list = await J(await fetch(`${API}/api/forms/${form.id}/responses`, { headers: H }));
const rid = list.j.responses[0].id;
out("status pending", list.j.responses[0].status);

// non-signatory tries to read signables + sign → both forbidden
const sq = await J(await fetch(`${API}/api/forms/${form.id}/signables`, { headers: H2 }));
out("outsider signables", sq.s);
const badSign = await J(await fetch(`${API}/api/forms/${form.id}/responses/${rid}/sign`, {
  method: "POST", headers: H2, body: JSON.stringify({ method: "typed", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }) }));
out("outsider sign", badSign.s);

// owner signs (1x1 transparent PNG)
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const sign = await J(await fetch(`${API}/api/forms/${form.id}/responses/${rid}/sign`, {
  method: "POST", headers: H, body: JSON.stringify({ method: "typed", dataUrl: PNG }) }));
out("sign", sign.s);

// double-sign → 409
const dbl = await J(await fetch(`${API}/api/forms/${form.id}/responses/${rid}/sign`, {
  method: "POST", headers: H, body: JSON.stringify({ method: "typed", dataUrl: PNG }) }));
out("double-sign", `${dbl.s} ${dbl.j.error}`);

// artifact + list state
const png = await fetch(`${API}/api/forms/${form.id}/responses/${rid}/signature.png`, { headers: H });
out("signature.png", `${png.status} ${png.headers.get("content-type")}`);
const list2 = await J(await fetch(`${API}/api/forms/${form.id}/responses`, { headers: H }));
out("after sign", `status=${list2.j.responses[0].status} signedBy=${list2.j.responses[0].signedBy}`);

// bad PNG rejected
const cf2 = await J(await fetch(`${API}/api/forms`, { method: "POST", headers: H,
  body: JSON.stringify({ title: "Sig2", fields: [{ id: "q", label: "X", type: "text" }], settings: { requireSignature: true, signatories: [] } }) }));
out("empty signatories ok", cf2.s); // allowed to save; warns in UI
await fetch(`${API}/api/forms/${cf2.j.form.token}`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ answers: { q: "y" } }) });
const l3 = await J(await fetch(`${API}/api/forms/${cf2.j.form.id}/responses`, { headers: H }));
const badPng = await J(await fetch(`${API}/api/forms/${cf2.j.form.id}/responses/${l3.j.responses[0].id}/sign`, {
  method: "POST", headers: H, body: JSON.stringify({ method: "drawn", dataUrl: "data:image/png;base64,bm90YXBuZw==" }) }));
out("bad PNG", `${badPng.s} ${badPng.j.message}`);

console.log("CLEANUP", `sig-${stamp}@t.kreatixtest.io`, `sig2-${stamp}@t.kreatixtest.io`, org);
