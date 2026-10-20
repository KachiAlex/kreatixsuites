const API = "https://suites.kreatixtech.com";
const stamp = Date.now().toString(36);
const J = async (r) => { const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, j: t }; } };
const out = (k, v) => console.log(k.padEnd(22), v);
const reg = await J(await fetch(`${API}/api/auth/register`, { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: `sig3-${stamp}@t.kreatixtest.io`, password: "Test1234!x", displayName: "Boss3", kind: "business" }) }));
const H = { "content-type": "application/json", authorization: `Bearer ${reg.j.token}` };
const cf = await J(await fetch(`${API}/api/forms`, { method: "POST", headers: H,
  body: JSON.stringify({ title: "SigT", fields: [{ id: "q", label: "X", type: "text" }],
    settings: { requireSignature: true, signatories: [reg.j.user?.id ?? ""] } }) }));
const sub = await J(await fetch(`${API}/api/forms/public/${cf.j.form.token}`, { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: { q: "y" } }) }));
out("submit", sub.s);
const l = await J(await fetch(`${API}/api/forms/${cf.j.form.id}/responses`, { headers: H }));
const rid = l.j.responses?.[0]?.id; out("pending row", `${l.s} rid=${!!rid}`);
const bad = await J(await fetch(`${API}/api/forms/${cf.j.form.id}/responses/${rid}/sign`, {
  method: "POST", headers: H, body: JSON.stringify({ method: "drawn", dataUrl: "data:image/png;base64,bm90YXBuZw==" }) }));
out("non-PNG data", `${bad.s} ${bad.j.message}`);
const huge = await J(await fetch(`${API}/api/forms/${cf.j.form.id}/responses/${rid}/sign`, {
  method: "POST", headers: H, body: JSON.stringify({ method: "drawn", dataUrl: "data:image/png;base64," + "iVBORw0KG".repeat(60000) }) }));
out("oversized", huge.s);
// public payload shows requiresSignature
const pub = await J(await fetch(`${API}/api/forms/public/${cf.j.form.token}`));
out("public flag", pub.j.form.requiresSignature);
console.log("CLEANUP", `sig3-${stamp}@t.kreatixtest.io`);
