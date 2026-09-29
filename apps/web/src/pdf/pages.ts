// PDF-1 — page organization engine.
// All ops produce NEW pdf bytes via pdf-lib (original upload stays an immutable
// version; we push the result as a new raw-PDF version via PUT /pdf-bytes).
// Annotation page remapping lives here too so ops stay atomic.
import type { PdfAnn } from "./model";

type Rect4 = [number, number, number, number];

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
  const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
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
  const { PDFDocument } = await import("pdf-lib");
  const dst = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const src = await PDFDocument.load(other, { ignoreEncryption: true });
  const pages = await dst.copyPages(src, src.getPageIndices());
  for (const p of pages) dst.addPage(p);
  return { bytes: await dst.save(), count: pages.length };
}

/** Pull selected pages into a standalone PDF (download). */
export async function extractPages(bytes: ArrayBuffer, pages: number[]): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
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

export function downloadPdf(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
