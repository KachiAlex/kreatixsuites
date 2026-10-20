const API = "https://suites.kreatixtech.com";
const stamp = Date.now().toString(36);
const email = `f3-${stamp}@t.kreatixtest.io`;
const out = (k, v) => console.log(k.padEnd(24), v);
const J = async (r) => { const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, j: t }; } };

// register test workspace
const reg = await J(await fetch(`${API}/api/auth/register`, { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "Test1234!x", displayName: "F3 Tester", orgName: `f3-${stamp}`, kind: "business" }) }));
const tok = reg.j.token; if (!tok) { console.log("register failed", reg.j); process.exit(1); }
const H = { "content-type": "application/json", authorization: `Bearer ${tok}` };
out("register", reg.s);

// form: nps + ranking + payment + editAfterSubmit
const cf = await J(await fetch(`${API}/api/forms`, { method: "POST", headers: H,
  body: JSON.stringify({ title: "F3 Test", fields: [
    { id: "q1", label: "Recommend?", type: "nps", required: true },
    { id: "q2", label: "Rank", type: "ranking", options: ["Alpha", "Beta", "Gamma"] },
    { id: "q3", label: "Fee", type: "payment", payAmount: 500, payLabel: "Entry" },
  ], settings: { editAfterSubmit: true } }) }));
const form = cf.j.form; const ftok = form.token;
out("create form", cf.s);

// admin paystack: invalid key → 400
const badKey = await J(await fetch(`${API}/api/admin/org-paystack`, { method: "POST", headers: H, body: JSON.stringify({ secret: "not-a-key" }) }));
out("bad key rejected", badKey.s);
// set a syntactically-valid test key (Paystack API will reject it downstream → proves wiring)
await J(await fetch(`${API}/api/admin/org-paystack`, { method: "POST", headers: H, body: JSON.stringify({ secret: "sk_test_0123456789abcdef" }) }));
const hasKey = await J(await fetch(`${API}/api/admin/org-paystack`, { headers: H }));
out("paystack set", JSON.stringify(hasKey.j));

// public GET → view count + editAfterSubmit flag
const g1 = await J(await fetch(`${API}/api/forms/public/${ftok}`));
out("public GET", `${g1.s} editAfterSubmit=${g1.j.form.editAfterSubmit} fields=${g1.j.form.fields.length}`);

// submit → payment required → unpaid + payUrl (Paystack will reject the fake test key → 502)
const sub = await J(await fetch(`${API}/api/forms/public/${ftok}`, { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ answers: { q1: 9, q2: ["Beta", "Alpha", "Gamma"] } }) }));
out("submit (pay form)", `${sub.s} ${JSON.stringify(sub.j).slice(0, 120)}`);

// same form minus payment → clean submit + editToken
const cf2 = await J(await fetch(`${API}/api/forms`, { method: "POST", headers: H,
  body: JSON.stringify({ title: "F3 Edit", fields: [
    { id: "q1", label: "NPS", type: "nps" }, { id: "q2", label: "Rank", type: "ranking", options: ["A", "B", "C"] },
  ], settings: { editAfterSubmit: true } }) }));
const tok2 = cf2.j.form.token;
await fetch(`${API}/api/forms/public/${tok2}`); // +1 view
const sub2 = await J(await fetch(`${API}/api/forms/public/${tok2}`, { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ answers: { q1: 10, q2: ["C", "A", "B"] }, respondent: "tester" }) }));
out("submit + editToken", `${sub2.s} token=${sub2.j.editToken?.slice(0, 8)}…`);
const et = sub2.j.editToken;

// invalid ranking → 400
const badRank = await J(await fetch(`${API}/api/forms/public/${tok2}`, { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ answers: { q1: 5, q2: ["A", "B"] } }) }));
out("partial ranking", `${badRank.s} ${badRank.j.message}`);
// nps out of range → 400
const badNps = await J(await fetch(`${API}/api/forms/public/${tok2}`, { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ answers: { q1: 11 } }) }));
out("nps>10", `${badNps.s} ${badNps.j.message}`);

// GET ?edit= → prior answers
const eg = await J(await fetch(`${API}/api/forms/public/${tok2}?edit=${et}`));
out("edit prefill", `${eg.s} q1=${eg.j.prior?.answers?.q1}`);
// PUT edit
const pu = await J(await fetch(`${API}/api/forms/public/${tok2}`, { method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ editToken: et, answers: { q1: 3, q2: ["B", "C", "A"] } }) }));
out("PUT edit", pu.s);

// summary → views + completion + nps
const sum = await J(await fetch(`${API}/api/forms/${cf2.j.form.id}/summary`, { headers: H }));
out("summary", `${sum.s} views=${sum.j.views} completion=${sum.j.completionRate} nps=${sum.j.summary?.[0]?.nps} rankAvg=${sum.j.summary?.[1]?.rankAvg}`);

// responses list → paid fields present
const rl = await J(await fetch(`${API}/api/forms/${cf2.j.form.id}/responses`, { headers: H }));
out("responses", `${rl.s} n=${rl.j.responses?.length} editedQ1=${rl.j.responses?.[0]?.answers?.q1}`);

// cleanup: delete both forms + org data
await fetch(`${API}/api/forms/${form.id}`, { method: "DELETE", headers: H });
await fetch(`${API}/api/forms/${cf2.j.form.id}`, { method: "DELETE", headers: H });
console.log("CLEANUP marker", email);
