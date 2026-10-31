// End-to-end test for the Word import baseline routes against a live server
// (default http://127.0.0.1:3001). Covers: store once, read back, second write
// refused, another tenant refused, baseline bound to the original's version 1.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = process.env.KX_BASE ?? "http://127.0.0.1:3001";
let pass = 0, fail = 0;
const ok = (cond: boolean, name: string) => { cond ? pass++ : fail++; console.log(`${cond ? "✓" : "✗ FAIL"} ${name}`); };

async function req(method: string, path: string, body?: unknown, token?: string, raw?: Buffer, ct?: string) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(ct ? { "content-type": ct } : body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}

const suffix = randomBytes(4).toString("hex");
const password = "testpass-1234";
const regA = await req("POST", "/api/auth/register", { email: `base-a-${suffix}@test.kreatix.local`, password, displayName: "A" });
const regB = await req("POST", "/api/auth/register", { email: `base-b-${suffix}@test.kreatix.local`, password, displayName: "B" });
const tokA = regA.body.token as string, tokB = regB.body.token as string;
ok(!!tokA && !!tokB, "two tenants registered");

const docx = readFileSync("../web/test-fixtures/docx/indemnity-form.docx");
const up = await req("POST", `/api/drive/upload?name=indemnity-${suffix}.docx&kind=writer`, undefined, tokA, docx,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
const id = up.body.item?.id as string;
ok(!!id, "original uploaded");

const baseline = { type: "doc", content: [{ type: "paragraph", attrs: { srcIdx: "0" }, content: [{ type: "text", text: "MTN" }] }] };
const none = await req("GET", `/api/files/${id}/source-baseline`, undefined, tokA);
ok(none.status === 404, "no baseline before import");

const put1 = await req("PUT", `/api/files/${id}/source-baseline`, { doc: baseline }, tokA);
ok(put1.status === 200, "baseline stored by the owner");

const got = await req("GET", `/api/files/${id}/source-baseline`, undefined, tokA);
ok(got.status === 200 && JSON.stringify(got.body.doc) === JSON.stringify(baseline), "baseline read back unchanged");

const put2 = await req("PUT", `/api/files/${id}/source-baseline`, { doc: { type: "doc", content: [] } }, tokA);
ok(put2.status === 409, "second write refused (baseline is immutable)");
const still = await req("GET", `/api/files/${id}/source-baseline`, undefined, tokA);
ok(JSON.stringify(still.body.doc) === JSON.stringify(baseline), "baseline unchanged after refused write");

const other = await req("GET", `/api/files/${id}/source-baseline`, undefined, tokB);
ok(other.status === 404, "another tenant cannot read the baseline");
const otherPut = await req("PUT", `/api/files/${id}/source-baseline`, { doc: baseline }, tokB);
ok(otherPut.status === 403, "another tenant cannot write the baseline");

const dup = await req("POST", `/api/drive/upload?name=other-${suffix}.docx&kind=writer`, undefined, tokA, docx,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
const dupId = dup.body.item?.id as string;
const dupGet = await req("GET", `/api/files/${dupId}/source-baseline`, undefined, tokA);
ok(dupGet.status === 404, "a baseline does not transfer to another file");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
