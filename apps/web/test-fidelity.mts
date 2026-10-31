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
  const target = edited.content.find((n: { attrs?: { srcIdx?: string | null } }) => n.attrs?.srcIdx === "11");
  check("patch: target paragraph located", !!target);
  if (target) target.content = [{ type: "text", text: "Name: Esther Isioma Akoma Jr" }];
  const patched = await tryPatchExport(bytes.buffer as ArrayBuffer, baseline as never, edited, regen);
  check("patch: one-paragraph edit produces a patch", patched !== null);
  const drawingEdit = JSON.parse(JSON.stringify(baseline));
  const sig = drawingEdit.content.find((n: { attrs?: { srcIdx?: string | null } }) => n.attrs?.srcIdx === "10");
  if (sig) sig.content = [{ type: "text", text: "changed text in a drawing paragraph" }];
  check("patch: drawing paragraph edit refused (falls back, never drops pictures)",
    (await tryPatchExport(bytes.buffer as ArrayBuffer, baseline as never, drawingEdit, regen)) === null);
  if (patched) {
    const before = paraSpans(await bodyOf(bytes.buffer as ArrayBuffer));
    const after = paraSpans(await bodyOf(patched));
    check("patch: paragraph count unchanged", before.length === after.length, `${before.length} vs ${after.length}`);
    const changed = before.map((p, i) => (p === after[i] ? -1 : i)).filter((i) => i >= 0);
    check("patch: only the edited paragraph changed", changed.length === 1 && changed[0] === 11, `changed ${JSON.stringify(changed)}`);
    check("patch: edited text present", after[11]?.includes("Akoma Jr") === true);
    check("patch: signature paragraph kept byte-identical", after[10] === before[10]);
    const media = Object.keys((await JSZip.loadAsync(await patched.arrayBuffer())).files).filter((n) => n.startsWith("word/media/"));
    check("patch: media parts kept", media.length === 5, `got ${media.length}`);
  }
}

{
  const { tryPatchExport: tp2 } = await import("./src/writer/docxPatch");
  const { DOMParser: PM2 } = await import("@tiptap/pm/model");
  const { getSchema: gs2 } = await import("@tiptap/core");
  const SK2 = (await import("@tiptap/starter-kit")).default;
  const IM2 = (await import("@tiptap/extension-image")).default;
  const { KxParaFormat: KP2 } = await import("./src/writer/extensions/paraFormat");
  const { parseHTML: ph2 } = await import("linkedom");
  const bytes2 = readFileSync("test-fixtures/docx/indemnity-form.docx");
  const imp2 = await importDocx(new File([bytes2], "f.docx"));
  const { document: d3 } = ph2(`<!doctype html><html><body><div id="r">${imp2.html}</div></body></html>`);
  const sch2 = gs2([SK2, IM2, KP2]);
  const base2 = PM2.fromSchema(sch2).parse(d3.getElementById("r") as never).toJSON() as any;
  const sigIdx = base2.content.findIndex((n: any) => n.attrs?.srcIdx === "10");
  const pics = async (b: ArrayBuffer | Blob) => {
    const x = await (await JSZip.loadAsync(b instanceof Blob ? await b.arrayBuffer() : b)).file("word/document.xml")!.async("string");
    const p = [...x.matchAll(/<w:p(?=[ >])[^>]*?(?<!\/)>[\s\S]*?<\/w:p>/g)][10][0];
    return { embeds: [...p.matchAll(/r:embed="([^"]+)"/g)].map((m) => m[1]).join(","), text: [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("") };
  };
  const origPic = await pics(bytes2.buffer as ArrayBuffer);
  check("sig: original has three picture embeds", origPic.embeds.split(",").length === 3, origPic.embeds);
  for (const [label, from, to] of [["before first picture", "Dared this.30", "Dared this.31"], ["after last picture", "26", "2027"]] as const) {
    const ed = JSON.parse(JSON.stringify(base2));
    const n = ed.content[sigIdx];
    const text = (n.content ?? []).map((c: any) => c.text ?? "").join("");
    n.content = [{ type: "text", text: text.replace(from, to) }];
    const out = await tp2(bytes2.buffer as ArrayBuffer, base2, ed, async (dd: any) => exportDocxBytes(dd, "regen"));
    if (!out) { check("sig " + label + ": patch produced", false, "fell back"); continue; }
    const after = await pics(out);
    check("sig " + label + ": pictures kept in order", after.embeds === origPic.embeds, after.embeds);
    check("sig " + label + ": edited text", after.text.includes(to), after.text);
  }
}
{
  const { tryPatchExport: tp3 } = await import("./src/writer/docxPatch");
  const { DOMParser: PM3 } = await import("@tiptap/pm/model");
  const { getSchema: gs3 } = await import("@tiptap/core");
  const SK3 = (await import("@tiptap/starter-kit")).default;
  const IM3 = (await import("@tiptap/extension-image")).default;
  const { KxParaFormat: KP3 } = await import("./src/writer/extensions/paraFormat");
  const { parseHTML: ph3 } = await import("linkedom");
  const bytes3 = readFileSync("test-fixtures/docx/indemnity-form.docx");
  const imp3 = await importDocx(new File([bytes3], "f.docx"));
  const { document: d4 } = ph3(`<!doctype html><html><body><div id="r">${imp3.html}</div></body></html>`);
  const base3 = PM3.fromSchema(gs3([SK3, IM3, KP3])).parse(d4.getElementById("r") as never).toJSON() as any;
  const p3Idx = base3.content.findIndex((n: any) => n.attrs?.srcIdx === "3");
  const ed3 = JSON.parse(JSON.stringify(base3));
  const node3 = ed3.content[p3Idx];
  node3.content = node3.content.map((c: any) => (c.text ? { ...c, text: c.text.replace("Akoma", "Mordi") } : c));
  const out3 = await tp3(bytes3.buffer as ArrayBuffer, base3, ed3, async (dd: any) => exportDocxBytes(dd, "regen"));
  check("name edit in paragraph 3 produces a patch", out3 !== null);
  if (out3) {
    const x3 = await (await JSZip.loadAsync(await out3.arrayBuffer())).file("word/document.xml")!.async("string");
    const paraSpans = (x: string) => x.split("</w:p>").slice(0, -1).map((s) => s.slice(Math.max(s.lastIndexOf("<w:p>"), s.lastIndexOf("<w:p "))) + "</w:p>");
    const pp = paraSpans(x3)[3];
    const origP3 = paraSpans(await (await JSZip.loadAsync(bytes3)).file("word/document.xml")!.async("string"))[3];
    check("name edit: picture count kept in paragraph 3", (pp.match(/<w:drawing/g) || []).length === (origP3.match(/<w:drawing/g) || []).length, String((pp.match(/<w:drawing/g) || []).length));
    check("name edit: Mordi present", pp.includes("Mordi"));
    const origX = await (await JSZip.loadAsync(bytes3)).file("word/document.xml")!.async("string");
    const paraAt = (xml: string, i: number) => paraSpans(xml)[i];
    check("name edit: signature paragraph untouched", paraAt(origX, 10) === paraAt(x3, 10));
  }
}
{
  const { tryPatchExport: tpF } = await import("./src/writer/docxPatch");
  const { DOMParser: PMF } = await import("@tiptap/pm/model");
  const { getSchema: gsF } = await import("@tiptap/core");
  const SKF = (await import("@tiptap/starter-kit")).default;
  const IMF = (await import("@tiptap/extension-image")).default;
  const { KxParaFormat: KPF } = await import("./src/writer/extensions/paraFormat");
  const { parseHTML: phF } = await import("linkedom");
  const bytesF = readFileSync("test-fixtures/docx/indemnity-form.docx");
  const impF = await importDocx(new File([bytesF], "f.docx"));
  const { document: dF } = phF(`<!doctype html><html><body><div id="r">${impF.html}</div></body></html>`);
  const baseF = PMF.fromSchema(gsF([SKF, IMF, KPF])).parse(dF.getElementById("r") as never).toJSON() as any;
  const edF = JSON.parse(JSON.stringify(baseF));
  const nF = edF.content.find((x: any) => x.attrs?.srcIdx === "3");
  const tF = nF.content.find((c: any) => c.text?.includes("Akoma"));
  const iF = tF.text.indexOf("Akoma");
  const preF = tF.text.slice(0, iF), afterF = tF.text.slice(iF + 5);
  const mkF = tF.marks ?? [];
  nF.content.splice(nF.content.indexOf(tF), 1,
    { type: "text", text: preF, marks: mkF },
    { type: "text", text: "Akoma", marks: [...mkF, { type: "bold" }, { type: "italic" }] },
    { type: "text", text: afterF, marks: mkF });
  const outF = await tpF(bytesF.buffer as ArrayBuffer, baseF, edF, async (dd: any) => exportDocxBytes(dd, "regen"));
  check("format edit: bold+italic phrase produces a patch", outF !== null);
  if (outF) {
    const xF = await (await JSZip.loadAsync(await outF.arrayBuffer())).file("word/document.xml")!.async("string");
    const bodyF = xF.slice(xF.indexOf("<w:body>"));
    const pF = [...bodyF.matchAll(/<w:p(?=[ >])[^>]*?(?<!\/)>[\s\S]*?<\/w:p>/g)][3][0];
    const runAt = pF.indexOf(">Akoma<");
    const runStart = pF.lastIndexOf("<w:r>", runAt);
    const run = pF.slice(runStart, runAt + 8);
    check("format edit: Akoma run carries bold and italic", run.includes("<w:b/>") && run.includes("<w:i/>"), run.slice(0, 200));
    check("format edit: pictures in paragraph kept", (pF.match(/<w:drawing/g) || []).length === 2, String((pF.match(/<w:drawing/g) || []).length));
    const joined = [...pF.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
    check("format edit: text unchanged", joined.includes("Esther Isioma Akoma(the MSISDN owner)"), joined.slice(0, 80));
  }
}

{
  const { carryPicturesIntoRebuild: cpC } = await import("./src/writer/docxPatch");
  const { DOMParser: PMC } = await import("@tiptap/pm/model");
  const { getSchema: gsC } = await import("@tiptap/core");
  const SKC = (await import("@tiptap/starter-kit")).default;
  const IMC = (await import("@tiptap/extension-image")).default;
  const { KxParaFormat: KPC } = await import("./src/writer/extensions/paraFormat");
  const { parseHTML: phC } = await import("linkedom");
  const bytesK = readFileSync("test-fixtures/docx/indemnity-form.docx");
  const impK = await importDocx(new File([bytesK], "f.docx"));
  const { document: dK } = phC(`<!doctype html><html><body><div id="r">${impK.html}</div></body></html>`);
  const baseK = PMC.fromSchema(gsC([SKC, IMC, KPC])).parse(dK.getElementById("r") as never).toJSON() as any;
  const editK = JSON.parse(JSON.stringify(baseK));
  const nK = editK.content.flatMap((x: any) => [x, ...(x.content ?? []).flatMap((y: any) => [y, ...(y.content ?? [])])]).find((x: any) => x.attrs?.srcIdx === "3");
  const tK = nK.content.find((c: any) => c.text?.includes("Akoma"));
  tK.text = tK.text.replace("Akoma", "Mordi");

  const verify = async (label: string, current: any) => {
    const rebuilt = await exportDocxBytes(current, "conv");
    const out = await cpC(rebuilt, bytesK.buffer as ArrayBuffer, baseK, current);
    const zK = await JSZip.loadAsync(await out.arrayBuffer());
    const docK = await zK.file("word/document.xml")!.async("string");
    const relsK = await zK.file("word/_rels/document.xml.rels")!.async("string");
    const drawings = (docK.match(/<w:drawing/g) || []).length;
    check(`${label}: all 7 drawings carried`, drawings === 7, String(drawings));
    const embeds = [...docK.matchAll(/r:embed="([^"]+)"/g)].map((m) => m[1]);
    const missing = embeds.filter((id) => !relsK.includes(`Id="${id}"`));
    check(`${label}: every r:embed has a relationship`, embeds.length > 0 && missing.length === 0, JSON.stringify(missing));
    const targets = [...relsK.matchAll(/Target="(media\/[^"]+)"/g)].map((m) => m[1]);
    const absent = targets.filter((t) => !zK.file(`word/${t}`));
    check(`${label}: every picture target exists`, targets.length > 0 && absent.length === 0, JSON.stringify(absent));
    const ids = [...docK.matchAll(/<w:bookmarkStart[^>]*w:id="(\d+)"/g)].map((m) => m[1]);
    check(`${label}: bookmark ids unique`, new Set(ids).size === ids.length);
    const numNeeded = [...new Set([...docK.matchAll(/<w:numId w:val="(\d+)"/g)].map((m) => m[1]).filter((n) => n !== "0"))];
    const numPart = await zK.file("word/numbering.xml")!.async("string");
    const numMissing = numNeeded.filter((n) => !numPart.includes(`<w:num w:numId="${n}"`));
    check(`${label}: every list reference has a definition`, numNeeded.length > 0 && numMissing.length === 0, JSON.stringify(numMissing));
  };
  await verify("converted, unchanged", baseK);
  await verify("converted, name edited", editK);
}

{
  const { tryPatchExport: tpL } = await import("./src/writer/docxPatch");
  const { DOMParser: PML } = await import("@tiptap/pm/model");
  const { getSchema: gsL } = await import("@tiptap/core");
  const SKL = (await import("@tiptap/starter-kit")).default;
  const IML = (await import("@tiptap/extension-image")).default;
  const { KxParaFormat: KPL } = await import("./src/writer/extensions/paraFormat");
  const { parseHTML: phL } = await import("linkedom");
  const bytesL = readFileSync("test-fixtures/docx/indemnity-form.docx");
  const impL = await importDocx(new File([bytesL], "f.docx"));
  const { document: dL } = phL(`<!doctype html><html><body><div id="r">${impL.html}</div></body></html>`);
  const baseL = PML.fromSchema(gsL([SKL, IML, KPL])).parse(dL.getElementById("r") as never).toJSON() as any;
  const findItem = (n: any, idx: string): any => {
    if (n.type === "listItem" && n.attrs?.srcIdx === idx) return n;
    for (const c of n.content ?? []) { const f = findItem(c, idx); if (f) return f; }
    return null;
  };
  const editL = JSON.parse(JSON.stringify(baseL));
  const item = findItem(editL, "5");
  check("list: item 5 located", !!item);
  const txt = item.content[0].content.find((c: any) => c.text?.includes("undertake") || c.text?.includes("agree"));
  txt.text = txt.text.replace("undertake", "undertake jointly");
  const outL = await tpL(bytesL.buffer as ArrayBuffer, baseL, editL, async (dd: any) => exportDocxBytes(dd, "regen"));
  check("list: text edit inside a list item produces a patch", outL !== null);
  if (outL) {
    const xL = await (await JSZip.loadAsync(await outL.arrayBuffer())).file("word/document.xml")!.async("string");
    const bodyL = xL.slice(xL.indexOf("<w:body>"));
    const pL = [...bodyL.matchAll(/<w:p(?=[ >])[^>]*?(?<!\/)>[\s\S]*?<\/w:p>/g)][5][0];
    const joinedL = [...pL.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
    check("list: edited text present", joinedL.includes("undertake jointly"), joinedL.slice(0, 60));
    check("list: numbering kept on the item", pL.includes("<w:numPr>"));
  }
  const removed = JSON.parse(JSON.stringify(baseL));
  const ol = removed.content.find((n: any) => n.type === "orderedList");
  ol.content.splice(1, 1);
  const outR = await tpL(bytesL.buffer as ArrayBuffer, baseL, removed, async (dd: any) => exportDocxBytes(dd, "regen"));
  check("list: deleting a list item is refused (structure changed)", outR === null);
}

{
  const { tryPatchExport: tpS } = await import("./src/writer/docxPatch");
  const { DOMParser: PMS } = await import("@tiptap/pm/model");
  const { getSchema: gsS } = await import("@tiptap/core");
  const SKS = (await import("@tiptap/starter-kit")).default;
  const IMS = (await import("@tiptap/extension-image")).default;
  const { KxParaFormat: KPS } = await import("./src/writer/extensions/paraFormat");
  const { parseHTML: phS } = await import("linkedom");
  const bytesS = readFileSync("test-fixtures/docx/indemnity-form.docx");
  const impS = await importDocx(new File([bytesS], "f.docx"));
  const { document: dS } = phS(`<!doctype html><html><body><div id="r">${impS.html}</div></body></html>`);
  const baseS = PMS.fromSchema(gsS([SKS, IMS, KPS])).parse(dS.getElementById("r") as never).toJSON() as any;
  const paraCount = async (b: Blob) => {
    const x = await (await JSZip.loadAsync(await b.arrayBuffer())).file("word/document.xml")!.async("string");
    return x.slice(x.indexOf("<w:body>")).match(/<w:p(?=[ >])[^>]*?(?<!\/)>/g)!.length;
  };
  const regenS = async (dd: any) => exportDocxBytes(dd, "regen");
  const topIdx = (d: any, idx: string) => d.content.findIndex((n: any) => n.attrs?.srcIdx === idx);
  const copyOf = () => JSON.parse(JSON.stringify(baseS));
  const baseCount = 13; // paragraphs in the original document body (checked above)

  // split: "Name: Esther Isioma Akoma" → "Name: Esther" + "Isioma Akoma"
  const split = copyOf();
  const nameNode = split.content[topIdx(split, "11")];
  const nt = nameNode.content[0];
  nameNode.content = [{ type: "text", text: "Name: Esther", marks: nt.marks ?? [] }];
  split.content.splice(topIdx(split, "11") + 1, 0, { type: "paragraph", attrs: { srcIdx: null, styleName: null }, content: [{ type: "text", text: " Isioma Akoma", marks: nt.marks ?? [] }] });
  const outSplit = await tpS(bytesS.buffer as ArrayBuffer, baseS, split, regenS);
  check("split: patch produced", outSplit !== null);
  if (outSplit) {
    check("split: one paragraph added", (await paraCount(outSplit)) === baseCount + 1);
    const sx = await (await JSZip.loadAsync(await outSplit.arrayBuffer())).file("word/document.xml")!.async("string");
    const sp = sx.slice(sx.indexOf("<w:body>")).match(/<w:p(?=[ >])[^>]*?(?<!\/)>[\s\S]*?<\/w:p>/g)!;
    const txtOf = (p: string) => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
    const k = sp.findIndex((p) => txtOf(p).includes("Name: Esther"));
    check("split: halves in order", k >= 0 && txtOf(sp[k + 1] ?? "").includes("Isioma Akoma"), txtOf(sp[k + 1] ?? "").slice(0, 40));
  }

  // delete: the plain "Signature" paragraph (srcIdx 12) has no pictures
  const del = copyOf();
  del.content.splice(topIdx(del, "12"), 1);
  const outDel = await tpS(bytesS.buffer as ArrayBuffer, baseS, del, regenS);
  check("delete: patch produced", outDel !== null);
  if (outDel) check("delete: one paragraph removed", (await paraCount(outDel)) === baseCount - 1);

  // copy: duplicate srcIdx 11 right after itself — the copy is new content
  const cp = copyOf();
  const orig11 = cp.content[topIdx(cp, "11")];
  cp.content.splice(topIdx(cp, "11") + 1, 0, JSON.parse(JSON.stringify(orig11)));
  const outCp = await tpS(bytesS.buffer as ArrayBuffer, baseS, cp, regenS);
  check("copy: patch produced", outCp !== null);
  if (outCp) check("copy: one paragraph added", (await paraCount(outCp)) === baseCount + 1);

  // insert at the very start has no anchor paragraph: refused
  const start = copyOf();
  start.content.unshift({ type: "paragraph", attrs: { srcIdx: null }, content: [{ type: "text", text: "New first line" }] });
  check("insert at start: refused", (await tpS(bytesS.buffer as ArrayBuffer, baseS, start, regenS)) === null);

  // move: swap two top-level paragraphs (srcIdx 11 and 12): refused
  const mv = copyOf();
  const a11 = topIdx(mv, "11"), a12 = topIdx(mv, "12");
  [mv.content[a11], mv.content[a12]] = [mv.content[a12], mv.content[a11]];
  check("move: refused", (await tpS(bytesS.buffer as ArrayBuffer, baseS, mv, regenS)) === null);

  // a brand-new table appended after the last paragraph grafts into the package
  const tbl = (cell: string) => ({
    type: "table", attrs: { srcIdx: null },
    content: [{ type: "tableRow", content: [
      { type: "tableCell", attrs: {}, content: [{ type: "paragraph", content: [{ type: "text", text: cell }] }] },
      { type: "tableCell", attrs: {}, content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
    ] }],
  });
  const app = copyOf();
  app.content.push(tbl("cell-A"), { type: "paragraph", attrs: { srcIdx: null }, content: [{ type: "text", text: "After the table" }] });
  const outT = await tpS(bytesS.buffer as ArrayBuffer, baseS, app, regenS);
  check("table append: patch produced", outT !== null);
  if (outT) {
    const tx = await (await JSZip.loadAsync(await outT.arrayBuffer())).file("word/document.xml")!.async("string");
    const srcX = await (await JSZip.loadAsync(bytesS.buffer as ArrayBuffer)).file("word/document.xml")!.async("string");
    const tblCount = (x: string) => (x.match(/<w:tbl(?=[ >])/g) ?? []).length;
    check("table append: one table grafted", tblCount(tx) === tblCount(srcX) + 1, `${tblCount(srcX)} -> ${tblCount(tx)}`);
    check("table append: cell text present", tx.includes("cell-A"));
    check("table append: trailing paragraph present", tx.includes("After the table"));
    check("table append: original paragraphs kept", [...tx.matchAll(/<w:p(?=[ >])[^>]*?(?<!\/)>[\s\S]*?<\/w:p>/g)].length === baseCount + 3);
  }

  // a new table at the very start has no anchor paragraph: refused
  const t0 = copyOf();
  t0.content.unshift(tbl("X"));
  check("table insert at start: refused", (await tpS(bytesS.buffer as ArrayBuffer, baseS, t0, regenS)) === null);

  // a new table right after a list block has no paragraph anchor: refused
  const tl = copyOf();
  const li = tl.content.findIndex((n: any) => n.type === "orderedList");
  tl.content.splice(li + 1, 0, tbl("X"));
  check("table insert after list: refused", (await tpS(bytesS.buffer as ArrayBuffer, baseS, tl, regenS)) === null);

  // moving the original list to the end is refused
  const mvL = copyOf();
  const li2 = mvL.content.findIndex((n: any) => n.type === "orderedList");
  mvL.content.push(...mvL.content.splice(li2, 1));
  check("list move to end: refused", (await tpS(bytesS.buffer as ArrayBuffer, baseS, mvL, regenS)) === null);

  // paragraph formatting: centering a paragraph merges w:jc into its original pPr
  const fmt = copyOf();
  fmt.content[topIdx(fmt, "11")].attrs = { ...fmt.content[topIdx(fmt, "11")].attrs, textAlign: "center" };
  const outF = await tpS(bytesS.buffer as ArrayBuffer, baseS, fmt, regenS);
  check("fmt: alignment change produces a patch", outF !== null);
  if (outF) {
    const fx2 = await (await JSZip.loadAsync(await outF.arrayBuffer())).file("word/document.xml")!.async("string");
    const paras = fx2.slice(fx2.indexOf("<w:body>")).match(/<w:p(?=[ >])[^>]*?(?<!\/)>[\s\S]*?<\/w:p>/g)!;
    const edited = paras.find((p) => p.includes("Name:"));
    check("fmt: the edited paragraph carries centered justification", edited?.includes('<w:jc w:val="center"') === true, edited?.match(/<w:jc[^/]*\/>/)?.[0] ?? "none");
  }

  // indent change: w:ind merges in alongside kept original properties
  const ind = copyOf();
  ind.content[topIdx(ind, "12")].attrs = { ...ind.content[topIdx(ind, "12")].attrs, indentPx: 96 };
  const outI = await tpS(bytesS.buffer as ArrayBuffer, baseS, ind, regenS);
  check("fmt: indent change produces a patch", outI !== null);
  if (outI) {
    const ix = await (await JSZip.loadAsync(await outI.arrayBuffer())).file("word/document.xml")!.async("string");
    const paras = ix.slice(ix.indexOf("<w:body>")).match(/<w:p(?=[ >])[^>]*?(?<!\/)>[\s\S]*?<\/w:p>/g)!;
    check("fmt: indented paragraph has w:ind", paras.some((p) => p.includes("<w:ind")));
  }

  // formatting change on a list paragraph is still refused
  const lf = copyOf();
  const li3 = lf.content.find((n: any) => n.type === "orderedList").content[0];
  li3.content[0].attrs = { ...li3.content[0].attrs, textAlign: "center" };
  check("fmt: list paragraph formatting refused", (await tpS(bytesS.buffer as ArrayBuffer, baseS, lf, regenS)) === null);
}

{
  // in-place table cell edits: the fixture's first block is a 1x2 table whose
  // cell paragraphs carry srcIdx — a text-only edit patches inside the table
  const { tryPatchExport: tpT } = await import("./src/writer/docxPatch");
  const { DOMParser: PMT } = await import("@tiptap/pm/model");
  const { getSchema: gsT } = await import("@tiptap/core");
  const SKT = (await import("@tiptap/starter-kit")).default;
  const IMT = (await import("@tiptap/extension-image")).default;
  const { KxParaFormat: KPT } = await import("./src/writer/extensions/paraFormat");
  const { KxTable, KxTableRow, KxTableHeader, KxTableCell } = await import("./src/writer/extensions/table");
  const { parseHTML: phT } = await import("linkedom");
  const bytesT = readFileSync("test-fixtures/docx/indemnity-form.docx");
  const impT = await importDocx(new File([bytesT], "f.docx"));
  const { document: dT } = phT(`<!doctype html><html><body><div id="r">${impT.html}</div></body></html>`);
  const schemaT = gsT([SKT, IMT, KPT, KxTable, KxTableRow, KxTableHeader, KxTableCell]);
  const baseT = PMT.fromSchema(schemaT).parse(dT.getElementById("r") as never).toJSON() as any;
  check("cell: first block is a table", baseT.content[0]?.type === "table");
  const cellPara = (n: any, idx: string): any => {
    if (n.type === "paragraph" && n.attrs?.srcIdx === idx) return n;
    for (const c of n.content ?? []) { const f = cellPara(c, idx); if (f) return f; }
    return null;
  };
  const regenT = async (dd: any) => exportDocxBytes(dd, "regen");

  const editT = JSON.parse(JSON.stringify(baseT));
  const cp0 = cellPara(editT, "0");
  check("cell: paragraph 0 located inside the table", !!cp0 && (cp0.content ?? []).some((c: any) => c.text?.includes("MTN")));
  const ct = cp0.content.find((c: any) => c.text?.includes("MTN"));
  ct.text = ct.text.replace("MTN", "MTNN");
  const outC = await tpT(bytesT.buffer as ArrayBuffer, baseT, editT, regenT);
  check("cell: text edit inside a table cell produces a patch", outC !== null);
  if (outC) {
    const cx = await (await JSZip.loadAsync(await outC.arrayBuffer())).file("word/document.xml")!.async("string");
    const tblXml = cx.slice(cx.indexOf("<w:tbl"), cx.indexOf("</w:tbl>"));
    const srcT = await (await JSZip.loadAsync(bytesT.buffer as ArrayBuffer)).file("word/document.xml")!.async("string");
    const srcTbl = srcT.slice(srcT.indexOf("<w:tbl"), srcT.indexOf("</w:tbl>"));
    check("cell: edited cell text present", tblXml.includes("MTNN"));
    check("cell: table structure kept", (tblXml.match(/<w:tc(?=[ >])/g) ?? []).length === (srcTbl.match(/<w:tc(?=[ >])/g) ?? []).length);
  }

  // formatting change inside a cell is refused — the patch only rewrites text
  const fmtT = JSON.parse(JSON.stringify(baseT));
  cellPara(fmtT, "0").attrs = { ...cellPara(fmtT, "0").attrs, textAlign: "center" };
  check("cell: formatting change refused", (await tpT(bytesT.buffer as ArrayBuffer, baseT, fmtT, regenT)) === null);

  // a new row changes the table skeleton: refused, not grafted
  const rowT = JSON.parse(JSON.stringify(baseT));
  rowT.content[0].content.push(JSON.parse(JSON.stringify(rowT.content[0].content[0])));
  check("cell: added row refused", (await tpT(bytesT.buffer as ArrayBuffer, baseT, rowT, regenT)) === null);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
