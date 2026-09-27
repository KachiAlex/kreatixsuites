// Suggesting-mode collab smoke test — two Y.Docs synced via applyUpdate (the
// same update transport y-websocket carries). Verifies insertion/deletion
// marks + author attrs survive sync, and that accepting on one peer converges
// on the other. Run: npx tsx test-collab-suggest.mts
import { DOMParser as LDParser } from "linkedom";
(globalThis as Record<string, unknown>).DOMParser ??= LDParser;
import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TrackChangesExtension } from "tiptap-track-changes";
import {
  prosemirrorToYXmlFragment, updateYFragment, yXmlFragmentToProsemirrorJSON,
} from "y-prosemirror";

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
const textOf = (json: Json): string =>
  ((json.content as Json[]) ?? []).map((n) => (n.text as string) ?? textOf(n)).join("");

// two peers with a bidirectional update relay (what the WS provider does)
const A = new Y.Doc();
const B = new Y.Doc();
let linked = true;
const relay = (src: Y.Doc, dst: Y.Doc) =>
  src.on("update", (u: Uint8Array) => { if (linked) Y.applyUpdate(dst, u); });
relay(A, B);
relay(B, A);
const fragA = A.getXmlFragment("default");
const fragB = B.getXmlFragment("default");
const toJson = (doc: Y.Doc) =>
  yXmlFragmentToProsemirrorJSON(doc.getXmlFragment("default")) as Json;

// ---- 1. A seeds a doc with an insertion + a deletion suggestion ----
const authorA = { id: "u-a", name: "Ada", color: "#3B82C4" };
const seed: Json = {
  type: "doc",
  content: [
    { type: "paragraph", content: [
      { type: "text", text: "The quick " },
      { type: "text", text: "brown", marks: [{ type: "deletion", attrs: { id: "chg-1", authorId: authorA.id, authorName: authorA.name, authorColor: authorA.color } }] },
      { type: "text", text: "silver", marks: [{ type: "insertion", attrs: { id: "chg-1", authorId: authorA.id, authorName: authorA.name, authorColor: authorA.color } }] },
      { type: "text", text: " fox" },
    ] },
  ],
};
const pmSeed = schema.nodeFromJSON(seed);
prosemirrorToYXmlFragment(pmSeed, fragA);

// ---- 2. marks survive sync to B ----
const jsonB = toJson(B);
check("insertion mark synced", marksIn(jsonB, "insertion").length === 1);
check("deletion mark synced", marksIn(jsonB, "deletion").length === 1);
const ins = marksIn(jsonB, "insertion")[0];
check("author attrs preserved", ins?.attrs?.authorId === "u-a" && ins?.attrs?.authorName === "Ada" && ins?.attrs?.authorColor === "#3B82C4");
check("text converged", textOf(jsonB) === "The quick brownsilver fox");

// ---- 3. concurrent edits merge without losing the suggestion ----
linked = false; // B goes "offline"
// B types at the end while offline
const jB = toJson(B);
(jB.content as Json[]).push({ type: "paragraph", content: [{ type: "text", text: " Signed, B" }] });
updateYFragment(B, fragB, schema.nodeFromJSON(jB), { mapping: new Map(), isOMark: new Map() });
// A keeps suggesting meanwhile (unchanged doc = no-op update), then reconnect
linked = true;
Y.applyUpdate(B, Y.encodeStateAsUpdate(A, Y.encodeStateVector(B)));
Y.applyUpdate(A, Y.encodeStateAsUpdate(B, Y.encodeStateVector(A)));
const jsonA2 = toJson(A);
check("concurrent text merged", textOf(jsonA2).includes("Signed, B"));
check("suggestion survived merge", marksIn(jsonA2, "insertion").length === 1 && marksIn(jsonA2, "deletion").length === 1);

// ---- 4. B accepts A's change — both peers converge ----
const accepted: Json = {
  type: "doc",
  content: [
    { type: "paragraph", content: [
      { type: "text", text: "The quick " },
      { type: "text", text: "silver" }, // insertion accepted, deletion dropped
      { type: "text", text: " fox" },
    ] },
    { type: "paragraph", content: [{ type: "text", text: " Signed, B" }] },
  ],
};
updateYFragment(B, fragB, schema.nodeFromJSON(accepted), { mapping: new Map(), isOMark: new Map() });
const jsonA3 = toJson(A);
const jsonB3 = toJson(B);
check("accept converges on A", marksIn(jsonA3, "insertion").length === 0 && marksIn(jsonA3, "deletion").length === 0);
check("peers identical", JSON.stringify(jsonA3) === JSON.stringify(jsonB3));
check("final text", textOf(jsonA3) === "The quick silver fox Signed, B");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
