const API = "https://suites.kreatixtech.com";
const stamp = Date.now().toString(36);
const email = `f3s-${stamp}@t.kreatixtest.io`;
const J = async (r) => { const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, j: t }; } };
const out = (k, v) => console.log(k.padEnd(22), v);

const reg = await J(await fetch(`${API}/api/auth/register`, { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "Test1234!x", displayName: "Sync T", kind: "business" }) }));
const tok = reg.j.token; if (!tok) { console.log("reg fail", reg.j); process.exit(1); }
const H = { "content-type": "application/json", authorization: `Bearer ${tok}` };

// create form + a sheets item, link syncSheet
const cf = await J(await fetch(`${API}/api/forms`, { method: "POST", headers: H,
  body: JSON.stringify({ title: "Sync Test", fields: [
    { id: "q1", label: "Name", type: "text", required: true },
    { id: "q2", label: "Score", type: "nps" },
  ] }) }));
const form = cf.j.form;
const di = await J(await fetch(`${API}/api/drive`, { method: "POST", headers: H,
  body: JSON.stringify({ name: "Sync Sheet", kind: "sheets" }) }));
const itemId = di.j.item.id;
await J(await fetch(`${API}/api/files/${itemId}/content`, { method: "PUT", headers: H,
  body: JSON.stringify({ content: { kind: "sheets", workbook: { sheets: [{ name: "Responses", cells: {} }] } } }) }));
const link = await J(await fetch(`${API}/api/forms/${form.id}`, { method: "PATCH", headers: H,
  body: JSON.stringify({ settings: { syncSheet: itemId } }) }));
out("link syncSheet", `${link.s} ${link.j.form?.settings?.syncSheet === itemId}`);

// two rapid submits — FOR UPDATE lock must serialize the appends
const [s1, s2] = await Promise.all([
  fetch(`${API}/api/forms/public/${form.token}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: { q1: "Alpha", q2: 9 } }) }),
  fetch(`${API}/api/forms/public/${form.token}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: { q1: "Beta", q2: 4 } }) }),
]);
out("submits", `${s1.status},${s2.status}`);
await new Promise((r) => setTimeout(r, 2500)); // sync is fire-and-forget — give it a beat

// fetch the sheet back — expect headers + 2 data rows
const ver = await J(await fetch(`${API}/api/files/${itemId}/versions`, { headers: H }));
out("versions", ver.j.versions?.length ?? "?");
console.log("CLEANUP", email, "| form", form.id, "| item", itemId);
