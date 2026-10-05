// PDF-1 — page organization engine.
// All ops produce NEW pdf bytes via pdf-lib (original upload stays an immutable
// version; we push the result as a new raw-PDF version via PUT /pdf-bytes).
// Annotation page remapping lives here too so ops stay atomic.
import type { PdfAnn } from "./model";

type Rect4 = [number, number, number, number];

/** Load a PDF for editing — rejects encrypted sources. ignoreEncryption reads
 *  the structure fine, but page content streams stay encrypted, so copying or
 *  re-saving would emit garbage. Fail loudly instead of corrupting output. */
export async function loadPdfForEdit(bytes: ArrayBuffer | Uint8Array) {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes as ArrayBuffer, { ignoreEncryption: true });
  if (doc.isEncrypted)
    throw new Error("This PDF is password-protected. Save a copy without the password and try again.");
  return doc;
}

/** rotate an [x,y,w,h] rect + points by deg ∈ {90,180,270} within page W×H */
function rotRect([x, y, w, h]: Rect4, deg: number, W: number, H: number): Rect4 {
  if (deg === 90) return [H - y - h, x, h, w];
  if (deg === 180) return [W - x - w, H - y - h, w, h];
  if (deg === 270) return [y, W - x - w, h, w];
  return [x, y, w, h];
}
const rotPt = ([x, y]: [number, number], deg: number, W: number, H: number): [number, number] =>
  deg === 90 ? [H - y, x] : deg === 180 ? [W - x, H - y] : deg === 270 ? [y, W - x] : [x, y];

/** remap annotations after a page-list change.
 *  order: new index (0-based) → old index (0-based); missing old pages = deleted.
 *  rots: old index → additional rotation applied (90/180/270), with page dims. */
export function remapAnns(
  anns: PdfAnn[],
  order: number[],
  rots: Map<number, { deg: number; w: number; h: number }> = new Map(),
): PdfAnn[] {
  const oldToNew = new Map<number, number>();
  order.forEach((old, ni) => oldToNew.set(old, ni));
  const out: PdfAnn[] = [];
  for (const a of anns) {
    const ni = oldToNew.get(a.page - 1);
    if (ni === undefined) continue; // deleted page — annotation drops with it
    const rot = rots.get(a.page - 1);
    const next: PdfAnn = { ...a, page: ni + 1 };
    if (rot && rot.deg % 360 !== 0) {
      if (a.rects) next.rects = a.rects.map((r) => rotRect(r, rot.deg, rot.w, rot.h));
      if (a.points) next.points = a.points.map((p) => rotPt(p, rot.deg, rot.w, rot.h));
    }
    out.push(next);
  }
  return out;
}

/** Rebuild the PDF from an explicit new page order.
 *  order[i] = { src: old index (0-based) } or { blank: {w,h} }.
 *  rots: old index → extra rotation (90/180/270) applied to that page. */
export async function reorganizePdf(
  bytes: ArrayBuffer,
  order: ({ src: number } | { blank: { w: number; h: number } })[],
  rots: Map<number, number> = new Map(),
): Promise<Uint8Array> {
  const { PDFDocument, degrees } = await import("pdf-lib");
  const srcDoc = await loadPdfForEdit(bytes);
  const out = await PDFDocument.create();
  const srcIdx = order.filter((e): e is { src: number } => "src" in e).map((e) => e.src);
  const copied = await out.copyPages(srcDoc, srcIdx);
  let ci = 0;
  for (const e of order) {
    if ("blank" in e) {
      out.addPage([e.blank.w, e.blank.h]);
      continue;
    }
    const page = copied[ci++];
    const extra = rots.get(e.src) ?? 0;
    if (extra) page.setRotation(degrees((page.getRotation().angle + extra) % 360));
    out.addPage(page);
  }
  return out.save();
}

/** Append another PDF's pages to this one (merge). Returns new bytes + ann order (identity + none for appended). */
export async function mergePdf(bytes: ArrayBuffer, other: ArrayBuffer): Promise<{ bytes: Uint8Array; count: number }> {
  const dst = await loadPdfForEdit(bytes);
  const src = await loadPdfForEdit(other);
  const pages = await dst.copyPages(src, src.getPageIndices());
  for (const p of pages) dst.addPage(p);
  return { bytes: await dst.save(), count: pages.length };
}

/** Pull selected pages into a standalone PDF (download). */
export async function extractPages(bytes: ArrayBuffer, pages: number[]): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const srcDoc = await loadPdfForEdit(bytes);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(srcDoc, pages.map((p) => p - 1));
  for (const p of copied) out.addPage(p);
  return out.save();
}

/** Split the PDF into two downloads at `at` (1-based; pages [1..at), [at..N]). */
export async function splitPdf(bytes: ArrayBuffer, at: number, total: number): Promise<[Uint8Array, Uint8Array]> {
  const a = await extractPages(bytes, Array.from({ length: Math.max(0, at - 1) }, (_, i) => i + 1));
  const b = await extractPages(bytes, Array.from({ length: Math.max(0, total - at + 1) }, (_, i) => at + i));
  return [a, b];
}

/** pdf-lib only embeds PNG/JPEG — rasterize other formats (webp/gif/bmp/svg)
 *  through a canvas so they still become pages instead of being skipped. */
async function toPngBytes(dataUrl: string): Promise<string | null> {
  if (typeof Image === "undefined" || typeof document === "undefined") return null;
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("undecodable image")); img.src = dataUrl; });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext("2d")?.drawImage(img, 0, 0);
    const m = /^data:image\/png;base64,(.+)$/.exec(c.toDataURL("image/png"));
    return m?.[1] ?? null;
  } catch { return null; }
}

/**
 * PDF-13.3 — append image files as new pages (one image per page, sized to the
 * image at 72dpi). Returns new pdf bytes. Throws if any image can't be
 * converted — a silent skip would report success while adding no page.
 */
export async function appendImagePages(bytes: ArrayBuffer, images: { dataUrl: string; w: number; h: number }[]): Promise<Uint8Array> {
  const doc = await loadPdfForEdit(bytes);
  for (const im of images) {
    let m = /^data:image\/(png|jpe?g);base64,(.+)$/.exec(im.dataUrl);
    if (!m) {
      const png = await toPngBytes(im.dataUrl);
      if (png) m = ["", "png", png] as unknown as RegExpExecArray;
    }
    if (!m) throw new Error(`Unsupported image format: ${im.dataUrl.slice(5, 30)}`);
    const img = m[1] === "png" ? await doc.embedPng(m[2]) : await doc.embedJpg(m[2]);
    const w = Math.min(im.w, 1440), h = im.h * (w / im.w);
    const page = doc.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return doc.save();
}

/** PDF-13.5 — embed arbitrary files as PDF attachments. */
export async function attachFilesToPdf(
  bytes: ArrayBuffer,
  files: { name: string; data: Uint8Array; mime?: string }[],
): Promise<Uint8Array> {
  const doc = await loadPdfForEdit(bytes);
  for (const f of files)
    await doc.attach(f.data, f.name, {
      mimeType: f.mime || "application/octet-stream",
      description: f.name,
      creationDate: new Date(),
      modificationDate: new Date(),
    });
  return doc.save();
}

/** PDF-13.5 — portfolio: attach files + prepend a cover page listing them. */
export async function makePortfolio(
  bytes: ArrayBuffer,
  files: { name: string; data: Uint8Array; mime?: string }[],
  title = "PDF Portfolio",
): Promise<Uint8Array> {
  const { StandardFonts, rgb } = await import("pdf-lib");
  const doc = await loadPdfForEdit(bytes);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const body = await doc.embedFont(StandardFonts.Helvetica);
  for (const f of files)
    await doc.attach(f.data, f.name, {
      mimeType: f.mime || "application/octet-stream",
      description: f.name,
      creationDate: new Date(),
      modificationDate: new Date(),
    });
  const cover = doc.insertPage(0, [612, 792]);
  cover.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(0.96, 0.95, 0.94) });
  cover.drawText(title.slice(0, 60), { x: 60, y: 720, size: 26, font, color: rgb(0.1, 0.1, 0.1) });
  cover.drawText(`${files.length} embedded file(s) — open the attachments pane to extract`, {
    x: 60, y: 692, size: 10, font: body, color: rgb(0.4, 0.4, 0.4),
  });
  let y = 650;
  for (const f of files) {
    if (y < 60) break;
    cover.drawText(`•  ${f.name.slice(0, 70)}  (${(f.data.length / 1024).toFixed(1)} KB)`, {
      x: 72, y, size: 12, font: body, color: rgb(0.15, 0.15, 0.15),
    });
    y -= 20;
  }
  return doc.save();
}

/** PDF-13.4 — build a simple multi-page PDF from a web page's title + text. */
export async function webTextToPdf(title: string, url: string, text: string): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const W = 612, H = 792, M = 60, LH = 14;
  const wrap = (s: string, max = 95) => {
    const out: string[] = [];
    for (const para of s.split("\n")) {
      let line = "";
      for (const wd of para.split(/\s+/)) {
        if ((line + " " + wd).trim().length > max) { out.push(line.trimEnd()); line = wd; }
        else line += " " + wd;
      }
      out.push(line.trimEnd());
    }
    return out;
  };
  let page = doc.addPage([W, H]);
  let y = H - M;
  page.drawText(title.slice(0, 70), { x: M, y, size: 18, font, color: rgb(0.1, 0.1, 0.1) });
  y -= 24;
  page.drawText(url.slice(0, 100), { x: M, y, size: 9, font: body, color: rgb(0.35, 0.5, 0.8) });
  y -= 28;
  for (const line of wrap(text)) {
    if (y < M) { page = doc.addPage([W, H]); y = H - M; }
    if (line) page.drawText(line.slice(0, 110), { x: M, y, size: 10, font: body, color: rgb(0.12, 0.12, 0.12) });
    y -= LH;
  }
  return doc.save();
}

export function downloadPdf(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
