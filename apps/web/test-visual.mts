// Visual-diff harness — renders the original and the rebuilt export to PDF with
// LibreOffice, rasterizes each page with Poppler, and reports per-page pixel
// differences. Phase 0 measures and reports; later phases gate on the numbers.
// Run: npx tsx test-visual.mts   (needs LibreOffice soffice and Poppler pdftoppm)
import { DOMParser as LDParser, parseHTML } from "linkedom";
(globalThis as Record<string, unknown>).DOMParser ??= LDParser;
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getSchema } from "@tiptap/core";
import { DOMParser as PMDOMParser } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { KxParaFormat } from "./src/writer/extensions/paraFormat";
import { PNG } from "pngjs";
import { exportDocxBytes, importDocx } from "./src/writer/docx";

const SOFFICE = process.env.SOFFICE ?? "C:/Program Files/LibreOffice/program/soffice.exe";
const PDFTOPPM = process.env.PDFTOPPM ?? "C:/Users/opdli/AppData/Local/Microsoft/WinGet/Packages/oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe/poppler-25.07.0/Library/bin/pdftoppm.exe";
const OUT = resolve("visual-out");
const DPI = "100";
const PAGE_DIFF_LIMIT = Number(process.env.PAGE_DIFF_LIMIT ?? "0.02"); // 2% of pixels

mkdirSync(OUT, { recursive: true });
const { document } = parseHTML("<!doctype html><html><body></body></html>");
const schema = getSchema([StarterKit, Image, KxParaFormat]);

const toPdf = (docx: string, outDir: string) => {
  mkdirSync(outDir, { recursive: true });
  execFileSync(SOFFICE, ["--headless", "--convert-to", "pdf", "--outdir", outDir, docx], { stdio: "pipe", timeout: 180_000 });
  return join(outDir, basename(docx).replace(/\.docx$/i, ".pdf"));
};

const rasterize = (pdf: string, prefix: string) => {
  execFileSync(PDFTOPPM, ["-png", "-r", DPI, pdf, prefix], { stdio: "pipe", timeout: 180_000 });
  return readdirSync(join(prefix, "..")).filter((f) => f.startsWith(basename(prefix)) && f.endsWith(".png"))
    .sort().map((f) => join(prefix, "..", f));
};

const pageDiff = (a: string, b: string) => {
  const A = PNG.sync.read(readFileSync(a)), B = PNG.sync.read(readFileSync(b));
  const w = Math.max(A.width, B.width), h = Math.max(A.height, B.height);
  let diff = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inA = x < A.width && y < A.height, inB = x < B.width && y < B.height;
    const ia = (y * A.width + x) * 4, ib = (y * B.width + x) * 4;
    const pa = inA ? [A.data[ia], A.data[ia + 1], A.data[ia + 2]] : [255, 255, 255];
    const pb = inB ? [B.data[ib], B.data[ib + 1], B.data[ib + 2]] : [255, 255, 255];
    if (Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]) + Math.abs(pa[2] - pb[2]) > 60) diff++;
  }
  return diff / (w * h);
};

/** Rebuilt export of an imported document (the path used for edited documents). */
const rebuild = async (src: string) => {
  const r = await importDocx(new File([readFileSync(src)], basename(src)));
  const host = document.createElement("div");
  host.innerHTML = r.html as string;
  const json = PMDOMParser.fromSchema(schema).parse(host as never).toJSON();
  const rebuilt = await exportDocxBytes(json as never, basename(src));
  const { carryPicturesIntoRebuild } = await import("./src/writer/docxPatch");
  return carryPicturesIntoRebuild(rebuilt, readFileSync(src).buffer as ArrayBuffer, json as never, json as never);
};

const fixtures = readdirSync("test-fixtures/docx").filter((f) => f.endsWith(".docx")).map((f) => join("test-fixtures/docx", f));
let failing = 0;
for (const fx of fixtures) {
  const name = basename(fx, ".docx");
  const work = join(OUT, name);
  mkdirSync(work, { recursive: true });
  const exported = join(work, `${name}.rebuilt.docx`);
  writeFileSync(exported, Buffer.from(await (await rebuild(fx)).arrayBuffer()));
  const patchedPath = join(work, `${name}.patched.docx`);
  const { tryPatchExport } = await import("./src/writer/docxPatch");
  const orig = readFileSync(fx);
  const base = await importDocx(new File([orig], basename(fx)));
  const { document: d2 } = parseHTML(`<!doctype html><html><body><div id="r">${base.html}</div></body></html>`);
  const sch = (await import("@tiptap/core")).getSchema([StarterKit, Image, (await import("./src/writer/extensions/paraFormat")).KxParaFormat]);
  const bjson = PMDOMParser.fromSchema(sch).parse(d2.getElementById("r") as never).toJSON() as { content: { attrs?: Record<string, unknown>; content?: { type: string; text?: string }[] }[] };
  const edited = JSON.parse(JSON.stringify(bjson));
  const tgt = edited.content.find((n) => n.attrs?.srcIdx === "11");
  if (tgt) tgt.content = [{ type: "text", text: "Name: Esther Isioma Akoma Jr" }];
  const pb = await tryPatchExport(orig.buffer.slice(orig.byteOffset, orig.byteOffset + orig.byteLength) as ArrayBuffer, bjson as never, edited as never, async (dd) => exportDocxBytes(dd as never, "regen"));
  if (pb) writeFileSync(patchedPath, Buffer.from(await pb.arrayBuffer()));
  console.log("patched export produced:", !!pb);

  const origPdf = toPdf(resolve(fx), join(work, "orig"));
  const expPdf = toPdf(resolve(exported), join(work, "rebuilt"));
  const origPages = rasterize(origPdf, join(work, "orig", "page"));
  const expPages = rasterize(expPdf, join(work, "rebuilt", "page"));
  if (existsSync(join(work, `${name}.patched.docx`))) {
    const pp = toPdf(resolve(join(work, `${name}.patched.docx`)), join(work, "patched"));
    const pagesP = rasterize(pp, join(work, "patched", "page"));
    const dP = pagesP.map((f, i) => (origPages[i] ? pageDiff(origPages[i], f) : 1));
    console.log(`  patched export pages: ${pagesP.length}, per-page diff vs original: ${dP.map((d) => (d * 100).toFixed(2) + "%").join(", ")}`);
  }

  console.log(`\n${name}: original ${origPages.length} pages, rebuilt ${expPages.length} pages`);
  if (origPages.length !== expPages.length) { failing++; console.log("  FAIL page count differs"); }
  const n = Math.min(origPages.length, expPages.length);
  for (let i = 0; i < n; i++) {
    const d = pageDiff(origPages[i], expPages[i]);
    const ok = d <= PAGE_DIFF_LIMIT;
    if (!ok) failing++;
    console.log(`  page ${i + 1}: ${(d * 100).toFixed(2)}% differing pixels ${ok ? "ok" : "OVER LIMIT"}`);
  }
}
console.log(`\n${failing === 0 ? "PASS" : "REPORT"}: ${failing} page/count issue(s), limit ${(PAGE_DIFF_LIMIT * 100).toFixed(1)}%`);
// Phase 0 reports; the gate becomes blocking in Phase 1.
process.exit(0);
