import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { parseInput } from "../sheets/model";

/** Shared line extraction — groups text items by baseline y. */
async function pageLines(page: PDFPageProxy): Promise<{ x: number; s: string; h: number }[][]> {
  const tc = await page.getTextContent();
  const buckets = new Map<number, { x: number; s: string; h: number }[]>();
  for (const it of tc.items as { str?: string; transform?: number[] }[]) {
    if (!it.str?.trim() || !it.transform) continue;
    const y = Math.round(it.transform[5]);
    const key = [...buckets.keys()].find((k) => Math.abs(k - y) < 2.5) ?? y;
    const arr = buckets.get(key) ?? [];
    arr.push({ x: it.transform[4], s: it.str, h: Math.hypot(it.transform[2], it.transform[3]) });
    buckets.set(key, arr);
  }
  return [...buckets.entries()].sort((a, b) => b[0] - a[0])
    .map(([, items]) => items.sort((a, b) => a.x - b.x));
}

const download = (blob: Blob, name: string) => {
  void import("../lib/saveFile").then((m) => m.saveFile(blob, name));
};

/** PDF-13.2 — each page becomes a worksheet; items land in columns by x-bucket. */
export async function exportPdfToXlsx(doc: PDFDocumentProxy, fileName: string): Promise<void> {
  const XLSX = await import("xlsx-js-style");
  const wb = XLSX.utils.book_new();
  for (let p = 1; p <= doc.numPages; p++) {
    const lines = await pageLines(await doc.getPage(p));
    // headers/titles render in larger fonts — flag them for bold
    const hs = lines.flat().map((i) => i.h).sort((a, b) => a - b);
    const median = hs[Math.floor(hs.length / 2)] || 0;
    const rows: string[][] = [];
    const bold = new Set<string>();
    lines.forEach((items, r) => {
      const row: string[] = [];
      for (const it of items) {
        const c = Math.round(it.x / 60);
        row[c] = (row[c] ?? "") + it.s;
        if (median && it.h > median * 1.15) bold.add(`${r}:${c}`);
      }
      rows.push(row);
    });
    const ws = XLSX.utils.aoa_to_sheet(rows);
    for (const ref of Object.keys(ws)) {
      if (ref.startsWith("!")) continue;
      const x = ws[ref];
      if (x.t === "s" && typeof x.v === "string") {
        const parsed = parseInput(x.v); // typed values: dates/currency/numbers stay computable
        if (parsed.v !== x.v || parsed.s?.fmt) {
          x.v = parsed.v as string | number | boolean;
          x.t = typeof parsed.v === "number" ? "n" : typeof parsed.v === "boolean" ? "b" : "s";
          if (parsed.s?.fmt) x.z = parsed.s.fmt;
        }
      }
      const { r, c } = XLSX.utils.decode_cell(ref);
      if (bold.has(`${r}:${c}`)) x.s = { ...(x.s ?? {}), font: { ...(x.s?.font ?? {}), bold: true } };
    }
    XLSX.utils.book_append_sheet(wb, ws, `p${p}`.slice(0, 31));
  }
  // writeFile() anchor-clicks internally — dead in the native WebView
  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
  download(new Blob([bytes as unknown as ArrayBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    fileName.replace(/\.pdf$/i, "") + ".xlsx");
}

/** PDF-13.2 — each page renders to an image and fills a slide. */
export async function exportPdfToPptx(doc: PDFDocumentProxy, fileName: string): Promise<void> {
  const pptxgen = (await import("pptxgenjs")).default;
  const pptx = new pptxgen();
  const v1 = (await doc.getPage(1)).getViewport({ scale: 1 });
  pptx.defineLayout({ name: "PDF", width: v1.width / 72, height: v1.height / 72 });
  pptx.layout = "PDF";
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const v = page.getViewport({ scale: 1.5 });
    const c = document.createElement("canvas");
    c.width = v.width; c.height = v.height;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvas: c, viewport: v }).promise;
    pptx.addSlide().addImage({ data: c.toDataURL("image/jpeg", 0.85), x: 0, y: 0, w: "100%", h: "100%" });
  }
  // same story — writeFile anchor-clicks; take the blob and saveFile it
  const blob = (await pptx.write({ outputType: "blob" })) as Blob;
  download(blob, fileName.replace(/\.pdf$/i, "") + ".pptx");
}

/** PDF-13.2 — text-only exports. */
export async function exportPdfToText(doc: PDFDocumentProxy, fileName: string, html: boolean): Promise<void> {
  const pages: string[][] = [];
  for (let p = 1; p <= doc.numPages; p++)
    pages.push((await pageLines(await doc.getPage(p))).map((items) => items.map((i) => i.s).join(" ")));
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = html
    ? `<!doctype html><meta charset="utf-8"><title>${esc(fileName)}</title><style>body{font-family:Georgia,serif;max-width:700px;margin:40px auto;line-height:1.6;color:#222}.pg{color:#999;font-size:12px;margin-top:32px}</style>`
      + pages.map((ls, i) => `<div class="pg">— page ${i + 1} —</div>` + ls.map((l) => `<p>${esc(l)}</p>`).join("\n")).join("\n")
    : pages.map((ls, i) => `--- page ${i + 1} ---\n` + ls.join("\n")).join("\n\n");
  download(new Blob([body], { type: html ? "text/html" : "text/plain" }), fileName.replace(/\.pdf$/i, "") + (html ? ".html" : ".txt"));
}
