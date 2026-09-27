// Live collab e2e — two real y-websocket clients through the API's WS route
// (auth + permission checks + sync protocol), exercising suggesting-mode
// marks end to end. Run inside the app container or against any reachable API:
//   KX_BASE=http://127.0.0.1:3017 npx tsx test-collab-e2e.mts
import { DOMParser as LDParser } from "linkedom";
(globalThis as Record<string, unknown>).DOMParser ??= LDParser;
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TrackChangesExtension } from "tiptap-track-changes";
import { prosemirrorToYXmlFragment, updateYFragment, yXmlFragmentToProsemirrorJSON } from "y-prosemirror";

const BASE = process.env.KX_BASE ?? "http://127.0.0.1:3017";
const WS = BASE.replace(/^http/, "ws");

let passed = 0, failed = 0;
const check = (name: string, cond: boolean) => {
  if (cond) passed++;
  else { failed++; console.log("FAIL:", name); }
};

const schema = getSchema([StarterKit, TrackChangesExtension]);
type Json = Record<string, unknown>;
const marksIn = (json: Json, type: string): Json[] => {
  const out: Json[] = [];
  const walk = (n: Json) => {
    (n.marks as Json[] | undefined)?.forEach((m) => { if (m.type === type) out.push(m); });
    (n.content as Json[] | undefined)?.forEach(walk);
  };
  walk(json);
  return out;
};
const toJson = (doc: Y.Doc) => yXmlFragmentToProsemirrorJSON(doc.getXmlFragment("default")) as Json;

const api = async (path: string, opts: RequestInit = {}, token?: string) => {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<Json>;
};

const waitFor = async (cond: () => boolean, ms = 8000, step = 150): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return cond();
};

// ---- setup: throwaway user + writer doc ----
const stamp = Date.now();
const reg = await api("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({
    email: `collab-test-${stamp}@kreatix.test`,
    password: "test-collab-99!", displayName: "Collab Test", orgName: "CollabTest",
  }),
});
const token = reg.token as string;
const { item } = await api("/api/drive", {
  method: "POST",
  body: JSON.stringify({ name: `collab-e2e-${stamp}`, kind: "writer" }),
}, token);
const fileId = (item as Json).id as string;

const docA = new Y.Doc();
const docB = new Y.Doc();
// disableBc: same-process providers would otherwise sync over BroadcastChannel,
// bypassing the server-side permission gate we're testing
const provA = new WebsocketProvider(`${WS}/api/collab`, fileId, docA, { params: { token }, disableBc: true });
const provB = new WebsocketProvider(`${WS}/api/collab`, fileId, docB, { params: { token }, disableBc: true });
provA.awareness.setLocalStateField("user", { name: "Ada", initials: "A", color: "#3B82C4" });
provB.awareness.setLocalStateField("user", { name: "Ben", initials: "B", color: "#F2782E" });

try {
  check("both peers connected", await waitFor(() => provA.synced && provB.synced));

  // ---- A seeds a doc carrying insertion + deletion suggestion marks ----
  prosemirrorToYXmlFragment(schema.nodeFromJSON({
    type: "doc",
    content: [{ type: "paragraph", content: [
      { type: "text", text: "net " },
      { type: "text", text: "old", marks: [{ type: "deletion", attrs: { id: "c1", authorId: "u-a", authorName: "Ada", authorColor: "#3B82C4" } }] },
      { type: "text", text: "new", marks: [{ type: "insertion", attrs: { id: "c1", authorId: "u-a", authorName: "Ada", authorColor: "#3B82C4" } }] },
    ] }],
  }), docA.getXmlFragment("default"));

  const synced = await waitFor(() => marksIn(toJson(docB), "insertion").length === 1);
  check("marks propagate over WS", synced);
  check("author attrs survive WS",
    marksIn(toJson(docB), "insertion")[0]?.attrs?.authorName === "Ada");
  check("deletion mark propagates", marksIn(toJson(docB), "deletion").length === 1);

  // ---- awareness: B sees A's presence ----
  check("awareness propagates",
    await waitFor(() => [...provB.awareness.getStates().values()]
      .some((s) => (s as Json).user && ((s as Json).user as Json).name === "Ada")));

  // ---- B accepts the change; A converges ----
  updateYFragment(docB, docB.getXmlFragment("default"), schema.nodeFromJSON({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "net new" }] }],
  }), { mapping: new Map(), isOMark: new Map() });
  check("accept converges on A",
    await waitFor(() =>
      marksIn(toJson(docA), "insertion").length === 0
      && marksIn(toJson(docA), "deletion").length === 0
      && JSON.stringify(toJson(docA)) === JSON.stringify(toJson(docB))));

  // ---- permission tiers: reviewer/commenter write over WS, viewer dropped ----
  const mkUser = async (label: string) => {
    const r = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: `collab-test-${label}-${stamp}@kreatix.test`,
        password: "test-collab-99!", displayName: label, orgName: "CollabTest",
      }),
    });
    return r.token as string;
  };
  const tokReviewer = await mkUser("rev");
  const tokCommenter = await mkUser("cmt");
  const tokViewer = await mkUser("view");
  const share = (email: string, permission: string) => api(`/api/files/${fileId}/shares`, {
    method: "POST", body: JSON.stringify({ email, permission }),
  }, token);
  await share(`collab-test-rev-${stamp}@kreatix.test`, "reviewer");
  await share(`collab-test-cmt-${stamp}@kreatix.test`, "commenter");
  await share(`collab-test-view-${stamp}@kreatix.test`, "viewer");

  const putStatus = async (t: string) => {
    const res = await fetch(`${BASE}/api/files/${fileId}/content`, {
      method: "PUT",
      headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
      body: JSON.stringify({ content: { kind: "writer", doc: { type: "doc", content: [{ type: "paragraph" }] } } }),
    });
    return res.status;
  };
  check("reviewer PUT allowed", (await putStatus(tokReviewer)) === 200);
  check("commenter PUT rejected", (await putStatus(tokCommenter)) === 403);
  check("viewer PUT rejected", (await putStatus(tokViewer)) === 403);

  const hasMarker = (m: string) => JSON.stringify(toJson(docA)).includes(`__${m}__`);
  const tryWrite = async (t: string, marker: string, ms = 4000) => {
    const d = new Y.Doc();
    const p = new WebsocketProvider(`${WS}/api/collab`, fileId, d, { params: { token: t }, disableBc: true });
    try {
      if (!(await waitFor(() => p.synced))) return "no-sync";
      updateYFragment(d, d.getXmlFragment("default"), schema.nodeFromJSON({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: `__${marker}__` }] }],
      }), { mapping: new Map(), isOMark: new Map() });
      return (await waitFor(() => hasMarker(marker), ms)) ? "propagated" : "dropped";
    } finally { p.destroy(); d.destroy(); }
  };
  check("reviewer WS write propagates", (await tryWrite(tokReviewer, "REV")) === "propagated");
  check("commenter WS write propagates", (await tryWrite(tokCommenter, "CMT")) === "propagated");
  check("viewer WS write dropped", (await tryWrite(tokViewer, "VIEW", 2500)) === "dropped");
} finally {
  provA.destroy(); provB.destroy();
  // clean up the fixture doc (trash → permanent delete)
  await api(`/api/drive/${fileId}`, { method: "PATCH", body: JSON.stringify({ trashed: true }) }, token).catch(() => {});
  await api(`/api/drive/${fileId}`, { method: "DELETE" }, token).catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
