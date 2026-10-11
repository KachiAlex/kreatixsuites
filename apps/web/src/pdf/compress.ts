// PDF compression — two engines, honest trade-offs:
//   lossless  — rebuild via pdf-lib: drops orphaned objects, metadata,
//               thumbnails and embedded junk; pages stay fully vector/text.
//               Modest savings; can even grow on already-optimized files.
//   raster    — re-render each page via pdf.js → JPEG → rebuild. Big savings
//               on scan/image-heavy files, but pages become images (text is
//               no longer selectable/searchable). Two quality tiers.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { loadPdfForEdit } from "./pages";

export type CompressLevel = "lossless" | "balanced" | "strong";

export interface CompressResult {
  bytes: Uint8Array;
  before: number;
  after: number;
  /** true when pages were re-rendered to images (text no longer selectable) */
  rasterized: boolean;
}

const RASTER: Record<Exclude<CompressLevel, "lossless">, { dpi: number; q: number }> = {
  balanced: { dpi: 144, q: 0.72 },
  strong: { dpi: 96, q: 0.5 },
};

async function lossless(bytes: ArrayBuffer): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const src = await loadPdfForEdit(bytes);
  const out = await PDFDocument.create();
  // copying pages into a fresh doc leaves behind document-level baggage:
  // metadata stream, embedded files, page thumbnails, orphaned objects.
  const pages = await out.copyPages(src, src.getPageIndices());
  for (const p of pages) out.addPage(p);
  return out.save({ useObjectStreams: true });
}

async function raster(
  bytes: ArrayBuffer,
  { dpi, q }: { dpi: number; q: number },
  onPage?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const [pdfjs, { PDFDocument }] = await Promise.all([import("pdfjs-dist"), import("pdf-lib")]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  // pdf.js transfers the buffer to its worker — hand it a copy so the
  // caller's bytes stay usable.
  const src = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
  const out = await PDFDocument.create();
  const scale = dpi / 72;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  for (let i = 1; i <= src.numPages; i++) {
    const page = await src.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const view = page.getViewport({ scale });
    canvas.width = Math.ceil(view.width);
    canvas.height = Math.ceil(view.height);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, viewport: view }).promise;
    const jpeg = await out.embedJpg(canvas.toDataURL("image/jpeg", q));
    const outPage = out.addPage([base.width, base.height]);
    outPage.drawImage(jpeg, { x: 0, y: 0, width: base.width, height: base.height });
    onPage?.(i, src.numPages);
  }
  void src.cleanup();
  return out.save({ useObjectStreams: true });
}

export async function compressPdf(
  bytes: ArrayBuffer,
  level: CompressLevel,
  onPage?: (done: number, total: number) => void,
): Promise<CompressResult> {
  const res = level === "lossless"
    ? await lossless(bytes)
    : await raster(bytes, RASTER[level], onPage);
  return {
    bytes: res,
    before: bytes.byteLength,
    after: res.byteLength,
    rasterized: level !== "lossless",
  };
}
