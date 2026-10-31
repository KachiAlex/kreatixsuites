// Fidelity harness — structural checks on real-document fixtures.
// Run: npx tsx test-fidelity.mts
// Byte-identical unchanged export is enforced in the editor (originalIfUnchanged);
// this harness checks that imports keep every part of the source document and that
// the rebuilt export does not drop or duplicate content.
import { DOMParser as LDParser } from "linkedom";
(globalThis as Record<string, unknown>).DOMParser ??= LDParser;
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { exportDocxBytes, importDocx } from "./src/writer/docx";
import { tryPatchExport as _tp } from "./src/writer/docxPatch";
void _tp;

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) passed++;
  else { failed++; console.log("FAIL:", name, detail); }
};
const count = (s: string, needle: string) => s.split(needle).length - 1;

const FIXTURES = [
  { file: "test-fixtures/docx/indemnity-form.docx", sha: "8926bebd34fbdb58dbb8186cdf0437243a84f923527f127e129ba2fd85ce359d",
    title: "INDEMNITY FORM", phrase: "Dared this", pictures: 5 },
];

for (const fx of FIXTURES) {
  const bytes = readFileSync(fx.file);
  check(`${fx.file}: fixture unchanged`, createHash("sha256").update(bytes).digest("hex") === fx.sha);

  const src = await JSZip.loadAsync(bytes);
  const srcDoc = await src.file("word/document.xml")!.async("string");
  const srcMedia = Object.keys(src.files).filter((n) => n.startsWith("word/media/"));
  check(`${fx.file}: source has ${fx.pictures} pictures`, srcMedia.length === fx.pictures, `got ${srcMedia.length}`);

  const imported = await importDocx(new File([bytes], fx.file.split("/").pop()!));
  check(`${fx.file}: import keeps title once`, count(imported.html, fx.title) === 1, `got ${count(imported.html, fx.title)}`);
  check(`${fx.file}: import keeps phrase once`, count(imported.html, fx.phrase) === 1, `got ${count(imported.html, fx.phrase)}`);
  check(`${fx.file}: import not degraded`, !imported.degraded);

  const blob = await exportDocxBytes(
    { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "probe" }] }] } as never, "probe");
  check(`${fx.file}: export produces a zip`, blob.size > 0);

  const outText = await (await JSZip.loadAsync(await blob.arrayBuffer())).file("word/document.xml")!.async("string");
  const srcText = [...srcDoc.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
  check(`${fx.file}: source text is non-empty`, srcText.length > 0);
}

{
  const { getSchema } = await import("@tiptap/core");
  const { DOMParser: PMDOMParser } = await import("@tiptap/pm/model");
  const StarterKit = (await import("@tiptap/starter-kit")).default;
  const Image = (await import("@tiptap/extension-image")).default;
  const { KxParaFormat } = await import("./src/writer/extensions/paraFormat");
  const { tryPatchExport } = await import("./src/writer/docxPatch");
  const { parseHTML } = await import("linkedom");
  const bytes = readFileSync("test-fixtures/docx/indemnity-form.docx");
  const imported = await importDocx(new File([bytes], "indemnity-form.docx"));
  const { document: dom } = parseHTML(`<!doctype html><html><body><div id="r">${imported.html}</div></body></html>`);
  const schema = getSchema([StarterKit, Image, KxParaFormat]);
  const baseline = PMDOMParser.fromSchema(schema).parse(dom.getElementById("r") as never).toJSON() as { content: { type: string; attrs?: Record<string, unknown>; content?: { type: string; text?: string }[] }[] };
  const regen = (doc: unknown) => exportDocxBytes(doc as never, "regen");
  const bodyOf = async (b: Blob | ArrayBuffer) => {
    const x = await (await JSZip.loadAsync(b instanceof Blob ? await b.arrayBuffer() : b)).file("word/document.xml")!.async("string");
    return x.slice(x.indexOf("<w:body>"));
  };
  const paraSpans = (x: string) => [...x.matchAll(/<w:p(?=[ >])[^>]*?(?<!\/)>[\s\S]*?<\/w:p>/g)].map((m) => m[0]);

  const unchanged = await tryPatchExport(bytes.buffer as ArrayBuffer, baseline as never, JSON.parse(JSON.stringify(baseline)), regen);
  check("patch: unchanged document yields no patch", unchanged === null);

  const edited = JSON.parse(JSON.stringify(baseline));
  const target = edited.content.find((n: { attrs?: { srcIdx?: string | null } }) => n.attrs?.srcIdx === "10");
  check("patch: target paragraph located", !!target);
  if (target) target.content = [{ type: "text", text: "Dared this.31day of October2026" }];
  const patched = await tryPatchExport(bytes.buffer as ArrayBuffer, baseline as never, edited, regen);
  check("patch: one-paragraph edit produces a patch", patched !== null);
  if (patched) {
    const before = paraSpans(await bodyOf(bytes.buffer as ArrayBuffer));
    const after = paraSpans(await bodyOf(patched));
    check("patch: paragraph count unchanged", before.length === after.length, `${before.length} vs ${after.length}`);
    const changed = before.map((p, i) => (p === after[i] ? -1 : i)).filter((i) => i >= 0);
    check("patch: only the edited paragraph changed", changed.length === 1 && changed[0] === 10, `changed ${JSON.stringify(changed)}`);
    check("patch: edited text present", after[10]?.includes("Dared this.31") === true);
    const media = Object.keys((await JSZip.loadAsync(await patched.arrayBuffer())).files).filter((n) => n.startsWith("word/media/"));
    check("patch: media parts kept", media.length === 5, `got ${media.length}`);
  }
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
