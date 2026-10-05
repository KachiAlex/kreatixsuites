import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PdfAnn, PdfField, OcrWord } from "./model";
import { loadPdfForEdit } from "./pages";
import { saveFile } from "../lib/saveFile";

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
  sanitize?: boolean;        // strip metadata (title/author/creator/dates)
  optimize?: boolean;        // object streams = smaller output
  /** PDF-9.4 — Bates numbering: e.g. { prefix:"CASE-", start:1, digits:5 } → "CASE-00001" */
  bates?: { prefix: string; start: number; digits: number };
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
  fields: PdfField[] = [],
  /** PDF-7 — pages that must be content-replaced by a raster (true redaction):
   * 1-based page → PNG data URL of the rendered page */
  rasters?: Record<number, string>,
  /** PDF-8.3 — OCR word boxes baked as invisible text → searchable output */
  ocr?: Record<string, OcrWord[]>,
): Promise<Uint8Array> {
  const { StandardFonts, rgb, degrees } = await import("pdf-lib");
  const src = await loadPdfForEdit(bytes);
  const helv = await src.embedFont(StandardFonts.Helvetica);
  const helvB = await src.embedFont(StandardFonts.HelveticaBold);
  // PDF-8.4 — textbox font selection
  const annFonts = {
    helv, helvB,
    times: await src.embedFont(StandardFonts.TimesRoman),
    courier: await src.embedFont(StandardFonts.Courier),
  };
  // check/cross fill marks render as ZapfDingbats glyphs 4/8
  const ding = await src.embedFont(StandardFonts.ZapfDingbats);

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
    // authored fields already embedded in the bytes (Save-into-file) — sync
    // their latest values, skip re-creating them
    for (const f of fields) {
      if (!f.embedded || f.embedded === "drawn") continue;
      const v = f.value ?? f.defaultValue;
      try {
        if (f.kind === "text") form.getTextField(f.embedded).setText(String(v ?? ""));
        else if (f.kind === "checkbox") { if (v) form.getCheckBox(f.embedded).check(); else form.getCheckBox(f.embedded).uncheck(); }
        else if (f.kind === "radio" && v) form.getRadioGroup(f.group ?? f.embedded).select(f.name);
        else if ((f.kind === "dropdown" || f.kind === "list") && v) {
          const sel = String(v).split("\n")[0];
          if (f.kind === "list") form.getOptionList(f.embedded).select(sel);
          else form.getDropdown(f.embedded).select(sel);
        }
      } catch { /* field missing or renamed — leave as-is */ }
    }
    // PDF-6 — authored fields become real AcroForm fields
    const allPages = src.getPages();
    for (const f of fields) {
      if (f.embedded) continue; // already a real field (or drawn) in the bytes
      const pg = allPages[f.page - 1];
      if (!pg) continue;
      const [x, y, w, h] = f.rect;
      try {
        if (f.kind === "text") {
          const tf = form.createTextField(f.name);
          tf.addToPage(pg, { x, y, width: w, height: h, borderWidth: 1 });
          if (f.required) tf.enableRequired();
          if (f.comb) { try { tf.setMaxLength(f.comb); tf.enableCombing(); } catch { /* comb unsupported */ } }
          const v = String(f.value ?? "") || f.defaultValue;
          if (v) tf.setText(v);
        } else if (f.kind === "checkbox") {
          const cb = form.createCheckBox(f.name);
          cb.addToPage(pg, { x, y, width: w, height: h });
          if (f.required) cb.enableRequired();
          if (f.value) cb.check();
        } else if (f.kind === "radio") {
          const rg = (() => { try { return form.getRadioGroup(f.group ?? f.name); } catch { return form.createRadioGroup(f.group ?? f.name); } })();
          rg.addOptionToPage(f.name, pg, { x, y, width: w, height: h });
          if (f.value) try { rg.select(f.name); } catch { /* option missing */ }
        } else if (f.kind === "signature") {
          // drawn signature baked as an image (not a cryptographic /Sig field)
          if (f.value) {
            const sig = await src.embedPng(String(f.value).split(",")[1]);
            pg.drawImage(sig, { x, y, width: w, height: h });
          }
          pg.drawRectangle({ x, y, width: w, height: h, borderWidth: 1, borderColor: rgb(0.5, 0.5, 0.5) });
        } else if (f.kind === "barcode") {
          // pseudo-barcode — bars derived from character codes (not a real symbology)
          pg.drawRectangle({ x, y, width: w, height: h, borderWidth: 1, borderColor: rgb(0.5, 0.5, 0.5) });
          let bx = x + 2;
          for (const c of String(f.value ?? "")) {
            const bw = (c.charCodeAt(0) % 3) + 1;
            if (bx + bw > x + w - 2) break;
            pg.drawRectangle({ x: bx, y: y + 2, width: bw, height: h - 8, color: rgb(0, 0, 0) });
            bx += bw + 1.5;
          }
          if (f.value) pg.drawText(String(f.value), { x: x + 2, y: y + 2, size: Math.min(6, h / 4), font: helv, color: rgb(0, 0, 0) });
        } else {
          const opts = f.options?.length ? f.options : [" "];
          const dd = f.kind === "list" ? form.createOptionList(f.name) : form.createDropdown(f.name);
          dd.addToPage(pg, { x, y, width: w, height: h });
          dd.addOptions(opts);
          if (f.required) dd.enableRequired();
          if (f.value) try { dd.select(String(f.value).split("\n")[0]); } catch { /* option missing */ }
        }
      } catch { /* skip malformed field */ }
    }
    if (fields.length) form.updateFieldAppearances(helv);
    form.flatten();
  } catch { /* no fields or unsupported — annotations still bake */ }

  // ---- PDF-8.3: OCR layer — invisible text makes scans searchable in the export ----
  if (ocr) {
    for (const [pn, words] of Object.entries(ocr)) {
      const pg = src.getPages()[Number(pn) - 1];
      if (!pg) continue;
      for (const w of words) {
        try {
          pg.drawText(safe(w.text), { x: w.x, y: w.y, size: Math.max(4, w.h * 0.8), font: helv, opacity: 0 });
        } catch { /* skip word */ }
      }
    }
  }

  // ---- PDF-7: true redaction — replace redacted pages with a flat image ----
  // Removing the page object drops its original content stream entirely, so the
  // underlying text/vectors can no longer be selected, copied, or extracted.
  if (rasters && Object.keys(rasters).length) {
    for (const [pn, dataUrl] of Object.entries(rasters)) {
      const i = Number(pn) - 1;
      const orig = src.getPages()[i];
      if (!orig) continue;
      try {
        const { width, height } = orig.getSize();
        const img = await src.embedPng(dataUrl.split(",")[1]);
        src.removePage(i);
        const np = src.insertPage(i, [width, height]);
        np.drawImage(img, { x: 0, y: 0, width, height });
      } catch { /* rasterization failed — leave page as-is */ }
    }
  }

  // ---- draw annotations into content streams ----
  const pages = src.getPages();
  for (const a of anns) {
    if (a.embedded) continue; // already a real /Annot in the bytes (Save-into-file)
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
        case "whiteout": {
          for (const [x, y, w, h] of a.rects ?? [])
            page.drawRectangle({ x, y, width: w, height: h, color: rgb(1, 1, 1) });
          break;
        }
        case "check":
        case "cross": {
          const [x, y, , h] = a.rects![0];
          page.drawText(a.type === "check" ? "4" : "8",
            { x, y: y + 1, size: Math.max(8, h * 0.9), font: ding, color: col });
          break;
        }
        case "redact": {
          for (const [x, y, w, h] of a.rects ?? [])
            page.drawRectangle({ x, y, width: w, height: h, color: rgb(0.09, 0.09, 0.09) });
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
          const f = annFonts[a.font ?? "helv"] ?? helv;
          const sz = a.fontSize ?? 9;
          const adv = sz * 1.25;
          let ty = y + h - adv;
          for (const line of safe(a.text ?? "").split("\n")) {
            if (ty < y + 3) break;
            page.drawText(line.slice(0, Math.max(4, Math.floor(w / (sz * 0.52)))), { x: x + 3, y: ty, size: sz, font: f, color: rgb(0.09, 0.09, 0.09) });
            ty -= adv;
          }
          break;
        }
        case "sign":
        case "image": {
          // PDF-2 signature / PDF-4 placed image — embed the PNG/JPEG
          const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(a.img ?? "");
          if (!m) break;
          const img = m[1] === "png" ? await src.embedPng(m[2]) : await src.embedJpg(m[2]);
          const [x, y, w, h] = a.rects![0];
          page.drawImage(img, { x, y, width: w, height: h });
          break;
        }
        case "caret": {
          // proofing mark — caret at the insertion point + note text beside it
          const [nx, ny] = a.points?.[0] ?? [0, 0];
          page.drawText("^", { x: nx - 2, y: ny - 2, size: 10, font: helvB, color: col });
          const t = safe(a.text ?? "");
          if (t) page.drawText(`insert: ${t.slice(0, 60)}`, { x: nx + 8, y: ny - 3, size: 8, font: helv, color: rgb(0.35, 0.33, 0.31) });
          break;
        }
        case "replace": {
          for (const [x, y, w, h] of a.rects ?? []) {
            const ly = y + h * 0.42;
            page.drawLine({ start: { x, y: ly }, end: { x: x + w, y: ly }, thickness: 1.2, color: col });
          }
          const t = safe(a.text ?? "");
          const last = a.rects?.[a.rects.length - 1];
          if (t && last) page.drawText(`-> ${t.slice(0, 60)}`, { x: last[0] + last[2] + 4, y: last[1] + last[3] * 0.4, size: 8, font: helv, color: col });
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
      if (opts.bates) {
        const t = safe(`${opts.bates.prefix}${String(opts.bates.start + i).padStart(opts.bates.digits, "0")}`);
        page.drawText(t, { x: W - helv.widthOfTextAtSize(t, 9) - 24, y: 14, size: 9, font: helv, color: rgb(0.4, 0.4, 0.4) });
      }
    } catch { /* chrome draw failed — skip */ }
  });

  // ---- PDF-7: sanitize metadata + optimize ----
  if (opts.sanitize) {
    try {
      src.setTitle(""); src.setAuthor(""); src.setSubject(""); src.setKeywords([]);
      src.setCreator(""); src.setProducer("");
      src.setCreationDate(new Date(0)); src.setModificationDate(new Date(0));
    } catch { /* metadata APIs are best-effort */ }
  }
  return src.save({ useObjectStreams: !!opts.optimize });
}

/** Build the flattened PDF and trigger a browser download. */
export async function exportFlattenedPdf(
  bytes: ArrayBuffer,
  anns: PdfAnn[],
  formValues: Record<string, unknown>,
  pdfDoc: PDFDocumentProxy | null,
  fileName: string,
  opts: FlattenOpts = {},
  fields: PdfField[] = [],
  rasters?: Record<number, string>,
  ocr?: Record<string, OcrWord[]>,
): Promise<void> {
  const out = await buildFlattenedPdf(bytes, anns, formValues, pdfDoc, opts, fields, rasters, ocr);
  void saveFile(new Blob([out.buffer as ArrayBuffer], { type: "application/pdf" }), fileName.replace(/\.pdf$/i, "") + ".pdf");
}
