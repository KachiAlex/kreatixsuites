import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PdfAnn } from "./model";

type RGB = { r: number; g: number; b: number };
const hexToRgb = (hex?: string): RGB => {
  const m = /^#?([0-9a-f]{6})/i.exec(hex ?? "")?.[1] ?? "F2782E";
  return { r: parseInt(m.slice(0, 2), 16) / 255, g: parseInt(m.slice(2, 4), 16) / 255, b: parseInt(m.slice(4, 6), 16) / 255 };
};

// WinAnsi can't encode most non-latin glyphs — sanitize for the standard fonts
const safe = (s: string) => s.replace(/[^\x20-\x7E\xA1-\xFF]/g, "?");

/** PDF-1b — page chrome options for export (page numbers, watermark, header/footer) */
export interface FlattenOpts {
  pageNumbers?: boolean;
  watermark?: string;        // diagonal text, e.g. "DRAFT" / "CONFIDENTIAL"
  header?: string;           // centered top-of-page line
  footer?: string;           // centered bottom-of-page line (drawn above page number)
}

/**
 * Bake Kreatix annotations into the PDF content stream and fill + flatten
 * AcroForm fields — returns the finished PDF bytes (KBS-PDF-004).
 */
export async function buildFlattenedPdf(
  bytes: ArrayBuffer,
  anns: PdfAnn[],
  formValues: Record<string, unknown>,
  pdfDoc: PDFDocumentProxy | null,
  opts: FlattenOpts = {},
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb, degrees } = await import("pdf-lib");
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const helv = await src.embedFont(StandardFonts.Helvetica);
  const helvB = await src.embedFont(StandardFonts.HelveticaBold);

  // ---- fill + flatten AcroForm fields ----
  try {
    const form = src.getForm();
    if (pdfDoc) {
      // annotationStorage keys are annotation ids ("25R") — map to field names
      const idToName = new Map<string, string>();
      for (let p = 1; p <= pdfDoc.numPages; p++) {
        for (const a of await (await pdfDoc.getPage(p)).getAnnotations()) {
          if (a.fieldName && a.id) idToName.set(a.id, a.fieldName);
        }
      }
      for (const [key, raw] of Object.entries(formValues)) {
        const name = idToName.get(key);
        if (!name) continue;
        const v = (raw as { value?: unknown })?.value ?? raw;
        try {
          form.getTextField(name).setText(String(v ?? ""));
          continue;
        } catch { /* not a text field */ }
        try {
          if (v) form.getCheckBox(name).check(); else form.getCheckBox(name).uncheck();
          continue;
        } catch { /* not a checkbox */ }
        for (const getter of ["getDropdown", "getOptionList", "getRadioGroup"] as const) {
          try { (form[getter](name) as { select: (v: string) => void }).select(String(v)); break; } catch { /* next */ }
        }
      }
      form.updateFieldAppearances(helv);
    }
    form.flatten();
  } catch { /* no fields or unsupported — annotations still bake */ }

  // ---- draw annotations into content streams ----
  const pages = src.getPages();
  for (const a of anns) {
    const page = pages[a.page - 1];
    if (!page) continue;
    const c = hexToRgb(a.color);
    const col = rgb(c.r, c.g, c.b);
    const bw = 1.4;
    try {
      switch (a.type) {
        case "highlight":
          for (const [x, y, w, h] of a.rects ?? []) {
            page.drawRectangle({ x, y, width: w, height: h, color: col, opacity: 0.35 });
          }
          break;
        case "underline":
          for (const [x, y, w] of a.rects ?? []) {
            page.drawLine({ start: { x, y: y + 1.2 }, end: { x: x + w, y: y + 1.2 }, thickness: 1.2, color: col });
          }
          break;
        case "strikeout":
          for (const [x, y, w, h] of a.rects ?? []) {
            const ly = y + h * 0.42;
            page.drawLine({ start: { x, y: ly }, end: { x: x + w, y: ly }, thickness: 1.2, color: col });
          }
          break;
        case "squiggly":
          for (const [x, y, w] of a.rects ?? []) {
            const ly = y - 0.8, step = 3.2, amp = 1.6;
            let d = `M ${x} ${ly}`;
            for (let px = step, up = true; px < w + step; px += step, up = !up)
              d += ` l ${Math.min(step, x + w - (px - step)).toFixed(1)} ${up ? -amp : amp}`;
            page.drawSvgPath(d, { borderColor: col, borderWidth: 1.1 });
          }
          break;
        case "polyline": {
          const pts = a.points ?? [];
          if (pts.length > 1)
            page.drawSvgPath(pts.map(([x, y], i) => `${i ? "L" : "M"} ${x} ${y}`).join(" "), { borderColor: col, borderWidth: bw });
          break;
        }
        case "cloud": {
          // scalloped border: arcs along each edge, bulging outward (CCW trace in y-up space)
          const [x, y, w, h] = a.rects![0];
          const b = 5;
          let d = `M ${x} ${y}`;
          const bump = (x1: number, y1: number, x2: number, y2: number) => {
            const n = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / (1.7 * b)));
            const ux = (x2 - x1) / n, uy = (y2 - y1) / n;
            for (let i = 0; i < n; i++) d += ` a ${b} ${b} 0 0 0 ${ux.toFixed(1)} ${uy.toFixed(1)}`;
          };
          bump(x, y, x + w, y); bump(x + w, y, x + w, y + h); bump(x + w, y + h, x, y + h); bump(x, y + h, x, y);
          page.drawSvgPath(d + " Z", { borderColor: col, borderWidth: bw });
          break;
        }
        case "callout": {
          const [x, y, w, h] = a.rects![0];
          const [tx, ty] = a.points?.[0] ?? [x, y];
          const cx = x + w / 2, cy = y + h / 2, dx = tx - cx, dy = ty - cy;
          const t = Math.min(dx ? (w / 2) / Math.abs(dx) : Infinity, dy ? (h / 2) / Math.abs(dy) : Infinity);
          page.drawLine({ start: { x: tx, y: ty }, end: { x: cx + dx * t, y: cy + dy * t }, thickness: bw, color: col });
          page.drawRectangle({ x, y, width: w, height: h, color: rgb(1, 1, 1), borderColor: col, borderWidth: bw });
          let cy2 = y + h - 11;
          for (const line of safe(a.text ?? "").split("\n")) {
            if (cy2 < y + 4) break;
            page.drawText(line.slice(0, Math.floor(w / 4.6)), { x: x + 3, y: cy2, size: 9, font: helv, color: rgb(0.09, 0.09, 0.09) });
            cy2 -= 11;
          }
          break;
        }
        case "freehand": {
          const pts = a.points ?? [];
          if (pts.length > 1) {
            const d = pts.map(([x, y], i) => `${i ? "L" : "M"} ${x} ${y}`).join(" ");
            page.drawSvgPath(d, { borderColor: col, borderWidth: 1.8 });
          }
          break;
        }
        case "rect": {
          const [x, y, w, h] = a.rects![0];
          page.drawRectangle({ x, y, width: w, height: h, borderColor: col, borderWidth: bw });
          break;
        }
        case "ellipse": {
          const [x, y, w, h] = a.rects![0];
          page.drawEllipse({ x: x + w / 2, y: y + h / 2, xScale: w / 2, yScale: h / 2, borderColor: col, borderWidth: bw });
          break;
        }
        case "line":
        case "arrow": {
          const [[ax, ay], [bx, by]] = a.points!;
          page.drawLine({ start: { x: ax, y: ay }, end: { x: bx, y: by }, thickness: bw, color: col });
          if (a.type === "arrow") {
            const ang = Math.atan2(by - ay, bx - ax), hl = 8;
            const p1x = bx - hl * Math.cos(ang - 0.45), p1y = by - hl * Math.sin(ang - 0.45);
            const p2x = bx - hl * Math.cos(ang + 0.45), p2y = by - hl * Math.sin(ang + 0.45);
            page.drawSvgPath(`M ${bx} ${by} L ${p1x} ${p1y} L ${p2x} ${p2y} Z`, { color: col });
          }
          break;
        }
        case "stamp": {
          const [x, y, w, h] = a.rects![0];
          const label = safe(a.text ?? "").toUpperCase();
          const fs = Math.min(16, (w - 8) / Math.max(1, helvB.widthOfTextAtSize(label, 1)));
          const tw = helvB.widthOfTextAtSize(label, fs);
          page.drawRectangle({ x, y, width: w, height: h, borderColor: col, borderWidth: 2, borderOpacity: 0.9 });
          page.drawText(label, { x: x + (w - tw) / 2, y: y + h / 2 - fs * 0.36, size: fs, font: helvB, color: col, opacity: 0.85 });
          break;
        }
        case "textbox": {
          const [x, y, w, h] = a.rects![0];
          let ty = y + h - 11;
          for (const line of safe(a.text ?? "").split("\n")) {
            if (ty < y + 4) break;
            page.drawText(line.slice(0, Math.floor(w / 4.6)), { x: x + 3, y: ty, size: 9, font: helv, color: rgb(0.09, 0.09, 0.09) });
            ty -= 11;
          }
          break;
        }
        case "sign": {
          // PDF-2 — embed the signature PNG
          const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(a.img ?? "");
          if (!m) break;
          const img = m[1] === "png" ? await src.embedPng(m[2]) : await src.embedJpg(m[2]);
          const [x, y, w, h] = a.rects![0];
          page.drawImage(img, { x, y, width: w, height: h });
          break;
        }
        case "note": {
          const [nx, ny] = a.points?.[0] ?? [0, 0];
          page.drawRectangle({ x: nx - 6, y: ny - 6, width: 13, height: 13, color: col, borderColor: rgb(0.6, 0.5, 0), borderWidth: 0.8 });
          const t = safe(a.text ?? "");
          if (t) page.drawText(t.slice(0, 60), { x: nx + 10, y: ny - 3, size: 8, font: helv, color: rgb(0.35, 0.33, 0.31) });
          break;
        }
      }
    } catch { /* skip malformed ann rather than fail the export */ }
  }

  // ---- PDF-1b: page chrome — watermark, header/footer, page numbers ----
  pages.forEach((page, i) => {
    const { width: W, height: H } = page.getSize();
    try {
      if (opts.watermark?.trim()) {
        const t = safe(opts.watermark).toUpperCase();
        const size = Math.min(96, (W * 0.9) / Math.max(1, helvB.widthOfTextAtSize(t, 1)));
        const tw = helvB.widthOfTextAtSize(t, size);
        page.drawText(t, {
          x: W / 2 - tw / 2 + H * 0.18, y: H / 2 - size * 0.35 - W * 0.18,
          size, font: helvB, color: rgb(0.85, 0.2, 0.2), opacity: 0.18,
          rotate: degrees(45),
        });
      }
      if (opts.header?.trim())
        page.drawText(safe(opts.header), { x: (W - helv.widthOfTextAtSize(safe(opts.header), 9)) / 2, y: H - 24, size: 9, font: helv, color: rgb(0.35, 0.35, 0.35) });
      if (opts.footer?.trim())
        page.drawText(safe(opts.footer), { x: (W - helv.widthOfTextAtSize(safe(opts.footer), 9)) / 2, y: 28, size: 9, font: helv, color: rgb(0.35, 0.35, 0.35) });
      if (opts.pageNumbers) {
        const t = `${i + 1} / ${pages.length}`;
        page.drawText(t, { x: (W - helv.widthOfTextAtSize(t, 9)) / 2, y: 14, size: 9, font: helv, color: rgb(0.4, 0.4, 0.4) });
      }
    } catch { /* chrome draw failed — skip */ }
  });

  return src.save();
}

/** Build the flattened PDF and trigger a browser download. */
export async function exportFlattenedPdf(
  bytes: ArrayBuffer,
  anns: PdfAnn[],
  formValues: Record<string, unknown>,
  pdfDoc: PDFDocumentProxy | null,
  fileName: string,
  opts: FlattenOpts = {},
): Promise<void> {
  const out = await buildFlattenedPdf(bytes, anns, formValues, pdfDoc, opts);
  const url = URL.createObjectURL(new Blob([out.buffer as ArrayBuffer], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName.replace(/\.pdf$/i, "") + ".pdf";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
