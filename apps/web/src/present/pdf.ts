// Deck → PDF export. Each visible slide is rasterized (same foreignObject
// path as the video exporter) and placed on a slide-sized PDF page. This is
// also the mobile print path — Android WebView has no window.print().
import type { Deck } from "./model";
import { rasterizeSlides } from "./video";
import { saveFile } from "../lib/saveFile";

const imgToPng = async (img: HTMLImageElement, w: number, h: number): Promise<Uint8Array> => {
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  cv.getContext("2d")!.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, "image/png"));
  if (!blob) throw new Error("raster failed");
  return new Uint8Array(await blob.arrayBuffer());
};

/** Export the deck's visible slides as a PDF — one slide per page. */
export async function exportDeckPdf(deck: Deck, title: string, onProgress?: (msg: string) => void): Promise<void> {
  const { dims, frames } = await rasterizeSlides(deck, onProgress);
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  // CSS px → pt (96dpi → 72dpi)
  const pw = dims.w * 0.75, ph = dims.h * 0.75;
  for (const f of frames) {
    const png = await pdf.embedPng(await imgToPng(f, dims.w, dims.h));
    const page = pdf.addPage([pw, ph]);
    page.drawImage(png, { x: 0, y: 0, width: pw, height: ph });
  }
  const out = await pdf.save();
  void saveFile(new Blob([out.buffer as ArrayBuffer], { type: "application/pdf" }),
    `${title.replace(/\.[^.]+$/, "")}.pdf`);
}
