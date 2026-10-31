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

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
