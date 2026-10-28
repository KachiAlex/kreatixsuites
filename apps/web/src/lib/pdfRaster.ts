// Page-image PDF export shared by Writer and Sheets. The document is rendered
// in a hidden frame, each page range is captured as an image and placed on a
// PDF sheet. Output matches the on-screen layout on every platform (browser,
// desktop, Android WebView). Trade-off: text in the PDF is an image, so it
// can't be selected or searched.
import html2canvas from "html2canvas";
import { PDFDocument } from "pdf-lib";

/** CSS px → PDF points (96 px per inch, 72 pt per inch). */
export const PX_TO_PT = 0.75;

export interface RasterPage { top: number; height: number }

export interface RasterOptions {
  /** Width of the rendered document in CSS px. */
  widthPx: number;
  /** Sheet size in points. */
  sheetPt: { w: number; h: number };
  /** Blank space around the captured area on each sheet, in CSS px. */
  marginPx?: { x: number; y: number };
  /** Page ranges (CSS px within the rendered body) — one PDF sheet each. */
  pagesOf: (doc: Document) => RasterPage[];
}

const b64ToBytes = (dataUrl: string): Uint8Array => {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Y offset of an element edge, in CSS px from the body's top edge. */
export const bodyY = (doc: Document, el: Element, edge: "top" | "bottom"): number =>
  el.getBoundingClientRect()[edge] - doc.body.getBoundingClientRect().top;

/** Page ranges that break only between table rows — a row is never split. */
export const rowPages = (pageHeightPx: number) => (doc: Document): RasterPage[] => {
  const total = doc.body.getBoundingClientRect().height;
  const rowBottoms = [...doc.querySelectorAll("tr")].map((tr) => bodyY(doc, tr, "bottom")).sort((a, b) => a - b);
  const out: RasterPage[] = [];
  let top = 0;
  while (total - top > 1) {
    const limit = top + pageHeightPx;
    const fit = total > limit ? rowBottoms.filter((b) => b > top + 1 && b <= limit).pop() : undefined;
    const end = fit ?? Math.min(limit, total);
    out.push({ top, height: end - top });
    top = end;
  }
  return out;
};

export async function rasterPdf(html: string, opts: RasterOptions, progress?: (m: string) => void): Promise<Uint8Array> {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, {
    position: "fixed", left: "-100000px", top: "0", width: `${opts.widthPx}px`, height: "1px", border: "0",
  });
  frame.srcdoc = html;
  document.body.appendChild(frame);
  try {
    await new Promise<void>((resolve, reject) => {
      frame.onload = () => resolve();
      frame.onerror = () => reject(new Error("render failed"));
    });
    const doc = frame.contentDocument!;
    doc.body.style.margin = "0";
    doc.body.style.padding = "0";
    await doc.fonts?.ready;
    // wide content (a sheet wider than the page) is widened, then scaled to fit
    const widthPx = Math.max(opts.widthPx, doc.body.scrollWidth);
    frame.style.width = `${widthPx}px`;
    frame.style.height = `${doc.documentElement.scrollHeight}px`;

    const pages = opts.pagesOf(doc);
    const pdf = await PDFDocument.create();
    const { w, h } = opts.sheetPt;
    const mx = (opts.marginPx?.x ?? 0) * PX_TO_PT;
    const my = (opts.marginPx?.y ?? 0) * PX_TO_PT;
    for (const [i, p] of pages.entries()) {
      progress?.(`Rendering page ${i + 1} of ${pages.length}…`);
      const canvas = await html2canvas(doc.body, {
        x: 0, y: p.top, width: widthPx, height: p.height, windowWidth: widthPx,
        scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false,
      });
      const img = await pdf.embedJpg(b64ToBytes(canvas.toDataURL("image/jpeg", 0.92)));
      const sheet = pdf.addPage([w, h]);
      const fit = Math.min(1, (w - 2 * mx) / (widthPx * PX_TO_PT), (h - 2 * my) / (p.height * PX_TO_PT));
      const drawW = widthPx * PX_TO_PT * fit;
      const drawH = p.height * PX_TO_PT * fit;
      sheet.drawImage(img, { x: mx, y: h - my - drawH, width: drawW, height: drawH });
    }
    return pdf.save();
  } finally {
    frame.remove();
  }
}
