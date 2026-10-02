// Kreatix PDF — "Save into the file": write our annotation/field layer into the
// PDF's own structures (real /Annots entries + AcroForm fields + field /V
// values) so the work is visible — and editable — in Foxit, Acrobat, and
// browsers, not just in our overlay. The JSON layer stays authoritative for
// our editor; `embedded` markers track which objects are already in the file
// so re-saves update them in place instead of duplicating.

import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PDFDict as LibDict, PDFRef as LibRef } from "pdf-lib";
import type { PdfAnn, PdfDoc, PdfField } from "./model";

type Lib = typeof import("pdf-lib");
type LibDoc = Awaited<ReturnType<Lib["PDFDocument"]["load"]>>;

/** /NM prefix on every annotation we embed — lets us find, update, and remove
 *  them in the raw file on later saves. */
const TAG = "kx:";

const hexRgb = (hex?: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})/i.exec(hex ?? "")?.[1] ?? "F2782E";
  return [parseInt(m.slice(0, 2), 16) / 255, parseInt(m.slice(2, 4), 16) / 255, parseInt(m.slice(4, 6), 16) / 255];
};
const safe = (s: string) => s.replace(/[^\x20-\x7E\xA1-\xFF]/g, "?");
const nowStr = () => {
  const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** FreeText default-appearance font resources */
const DA_FONT: Record<string, string> = { helv: "Helv", times: "TiRo", courier: "Cour", ding: "ZaDb" };

/** Standard stamp appearances every viewer renders natively */
const STAMP_NAMES: Record<string, string> = {
  APPROVED: "Approved", DRAFT: "Draft", CONFIDENTIAL: "Confidential", FINAL: "Final",
  EXPIRED: "Expired", "FOR COMMENT": "ForComment", "NOT APPROVED": "NotApproved",
  "TOP SECRET": "TopSecret", SOLD: "Sold", "AS IS": "AsIs", DEPARTMENTAL: "Departmental",
  EXPERIMENTAL: "Experimental", "FOR PUBLIC RELEASE": "ForPublicRelease",
  "NOT FOR PUBLIC RELEASE": "NotForPublicRelease",
};

/** Our AnnType → PDF /Subtype (also used by the viewer to suppress embedded
 *  annots from pdf.js's own annotation layer) */
export const SUBTYPE: Partial<Record<PdfAnn["type"], string>> = {
  highlight: "Highlight", underline: "Underline", strikeout: "StrikeOut", squiggly: "Squiggly",
  freehand: "Ink", polyline: "PolyLine", rect: "Square", ellipse: "Circle",
  line: "Line", arrow: "Line", cloud: "Square",
  textbox: "FreeText", callout: "FreeText", check: "FreeText", cross: "FreeText",
  note: "Text", caret: "Caret", replace: "Caret", stamp: "Stamp", whiteout: "Square",
};
// sign/image are Stamps with a custom appearance — handled separately

const quadPoints = (rects: [number, number, number, number][]) =>
  rects.flatMap(([x, y, w, h]) => [x, y + h, x + w, y + h, x, y, x + w, y]);

const boundsOf = (pts: [number, number][]): number[] => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

const boundsOfRects = (rs: [number, number, number, number][]): number[] => {
  const xs = rs.flatMap((r) => [r[0], r[0] + r[2]]), ys = rs.flatMap((r) => [r[1], r[1] + r[3]]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

/** The [x1,y1,x2,y2] /Rect an annotation gets when embedded — used by the
 *  viewer to match pdf.js annotations for suppression. */
export const annotRectOf = (a: PdfAnn): number[] | null => {
  if (a.type === "note" || a.type === "caret") {
    const [px, py] = a.points?.[0] ?? [0, 0];
    return a.type === "note" ? [px - 6, py - 6, px + 7, py + 7] : [px, py, px + 8, py + 10];
  }
  if (a.type === "replace" && a.rects?.[0]) {
    const [x, y, w, h] = a.rects[0];
    return [x, y, x + w, y + h];
  }
  if (a.rects?.length) return boundsOfRects(a.rects);
  if (a.points?.length) return boundsOf(a.points);
  return null;
};

/** PDF /Subtype → pdf.js annotationType enum — for suppression matching */
export const PDFJS_TYPE: Record<string, number> = {
  Text: 1, FreeText: 3, Line: 4, Square: 5, Circle: 6, PolyLine: 8,
  Highlight: 9, Underline: 10, Squiggly: 11, StrikeOut: 12, Stamp: 13,
  Caret: 14, Ink: 15, Widget: 20,
};

/** Normalize our stored pdf-lib ref ("23 0 R") to every id form pdf.js might
 *  produce ("23R" / "23R0"). */
export const pdfjsIdsOf = (embedded: string): string[] => {
  const m = /^(\d+) (\d+) R$/.exec(embedded);
  return m ? (m[2] === "0" ? [`${m[1]}R`, `${m[1]}R0`] : [`${m[1]}R${m[2]}`]) : [];
};

/**
 * Build the /Annot dictionary entries for one annotation (plain JS — ctx.obj
 * converts). Returns null when the type can't be expressed as an annotation.
 */
const annotEntries = (
  a: PdfAnn, L: Lib,
): Record<string, unknown> | null => {
  const { PDFName, PDFHexString } = L;
  const col = hexRgb(a.color);
  const base: Record<string, unknown> = {
    Type: PDFName.of("Annot"), NM: PDFHexString.fromText(`${TAG}${a.id}`), F: 4 /* print */,
    T: PDFHexString.fromText(a.author ?? "Kreatix"),
    M: PDFHexString.fromText(nowStr()),
  };
  if (a.text) base.Contents = PDFHexString.fromText(a.text);
  const r0 = a.rects?.[0];
  const rectArr = r0 ? [r0[0], r0[1], r0[0] + r0[2], r0[1] + r0[3]] : null;

  switch (a.type) {
    case "highlight": case "underline": case "strikeout": case "squiggly": {
      if (!a.rects?.length) return null;
      const rr = a.rects;
      return { ...base, Subtype: PDFName.of(SUBTYPE[a.type]!), Rect: boundsOfRects(rr), QuadPoints: quadPoints(rr), C: col, CA: a.type === "highlight" ? 0.35 : 0.9 };
    }
    case "freehand": {
      const pts = a.points ?? [];
      if (pts.length < 2) return null;
      return { ...base, Subtype: PDFName.of("Ink"), Rect: boundsOf(pts), InkList: [pts.flat()], C: col, BS: { W: 1.8 } };
    }
    case "polyline": {
      const pts = a.points ?? [];
      if (pts.length < 2) return null;
      return { ...base, Subtype: PDFName.of("PolyLine"), Rect: boundsOf(pts), Vertices: pts.flat(), C: col, BS: { W: 1.4 } };
    }
    case "rect": case "ellipse": {
      if (!rectArr) return null;
      return { ...base, Subtype: PDFName.of(SUBTYPE[a.type]!), Rect: rectArr, C: col, BS: { W: 1.4 } };
    }
    case "line": case "arrow": {
      const pts = a.points ?? [];
      if (pts.length < 2) return null;
      return {
        ...base, Subtype: PDFName.of("Line"), Rect: boundsOf(pts), L: pts.flat(), C: col, BS: { W: 1.4 },
        LE: a.type === "arrow" ? [PDFName.of("None"), PDFName.of("OpenArrow")] : undefined,
      };
    }
    case "whiteout": {
      if (!rectArr) return null;
      return { ...base, Subtype: PDFName.of("Square"), Rect: rectArr, C: [1, 1, 1], IC: [1, 1, 1], BS: { W: 0.5 } };
    }
    case "cloud": {
      if (!rectArr) return null;
      return { ...base, Subtype: PDFName.of("Square"), Rect: rectArr, C: col, BS: { W: 1.4 }, BE: { S: PDFName.of("C"), I: 2 } };
    }
    case "textbox": case "callout": {
      if (!rectArr || !r0) return null;
      const [x, y, w, h] = r0;
      const sz = a.fontSize ?? 11;
      const entries: Record<string, unknown> = {
        ...base, Subtype: PDFName.of("FreeText"), Rect: rectArr,
        DA: PDFHexString.fromText(`/${DA_FONT[a.font ?? "helv"]} ${sz} Tf 0.09 0.09 0.09 rg`),
        Q: 0, Contents: PDFHexString.fromText(a.text ?? ""),
        C: a.type === "callout" ? col : [1, 1, 1], // background box
      };
      if (a.type === "callout") {
        const [tx, ty] = a.points?.[0] ?? [x, y];
        entries.CL = [tx, ty, x + w / 2, y + h / 2];
      }
      return entries;
    }
    case "check": case "cross": {
      if (!rectArr || !r0) return null;
      return {
        ...base, Subtype: PDFName.of("FreeText"), Rect: rectArr,
        DA: PDFHexString.fromText(`/ZaDb ${Math.max(8, r0[3] * 0.9)} Tf ${col[0].toFixed(2)} ${col[1].toFixed(2)} ${col[2].toFixed(2)} rg`),
        Contents: PDFHexString.fromText(a.type === "check" ? "4" : "8"), // ZapfDingbats ✔ / ✖
      };
    }
    case "note": {
      const [px, py] = a.points?.[0] ?? [0, 0];
      return { ...base, Subtype: PDFName.of("Text"), Rect: [px - 6, py - 6, px + 7, py + 7], Name: PDFName.of("Comment"), C: col };
    }
    case "caret": case "replace": {
      const r = a.type === "caret" ? a.points?.[0] : a.rects?.[0];
      if (!r) return null;
      const [x, y] = a.type === "caret" ? [r[0], r[1]] : [r[0], r[1]];
      const w = a.type === "replace" ? (a.rects?.[0]?.[2] ?? 10) : 8;
      const h = a.type === "replace" ? (a.rects?.[0]?.[3] ?? 10) : 10;
      const text = a.type === "replace" ? `Replace with: ${a.text ?? ""}` : a.text;
      return {
        ...base, Subtype: PDFName.of("Caret"), Rect: [x, y, x + w, y + h], C: col,
        Contents: PDFHexString.fromText(text ?? ""), RD: [1, 1, 1, 1],
      };
    }
    case "stamp": {
      if (!rectArr) return null;
      const std = STAMP_NAMES[(a.text ?? "").toUpperCase()];
      if (std) return { ...base, Subtype: PDFName.of("Stamp"), Rect: rectArr, Name: PDFName.of(std) };
      // non-standard stamp text → FreeText renders the actual label
      return {
        ...base, Subtype: PDFName.of("FreeText"), Rect: rectArr,
        DA: PDFHexString.fromText(`/Helv ${Math.max(10, (r0?.[3] ?? 18) * 0.55)} Tf ${col[0].toFixed(2)} ${col[1].toFixed(2)} ${col[2].toFixed(2)} rg`),
        Contents: PDFHexString.fromText(safe(a.text ?? "")), C: col,
      };
    }
    default:
      return null; // sign/image need appearance streams — built by the caller
  }
};

/** Signature/image → Stamp annotation with an appearance stream containing the image. */
const embedImageAnnot = async (
  a: PdfAnn, L: Lib, src: LibDoc, pageNode: { addAnnot: (r: LibRef) => void },
): Promise<string | null> => {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(a.img ?? "");
  const r0 = a.rects?.[0];
  if (!m || !r0) return null;
  const { PDFName, PDFHexString } = L;
  try {
    const img = m[1] === "png" ? await src.embedPng(m[2]) : await src.embedJpg(m[2]);
    const [, , w, h] = r0;
    const ap = src.context.flateStream(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`, {
      Type: PDFName.of("XObject"), Subtype: PDFName.of("Form"),
      BBox: src.context.obj([0, 0, w, h]),
      Resources: src.context.obj({ XObject: { Im0: img.ref }, ProcSet: [PDFName.of("PDF"), PDFName.of("ImageC")] }),
    });
    const apRef = src.context.register(ap);
    const dict = src.context.obj({
      Type: PDFName.of("Annot"), Subtype: PDFName.of("Stamp"),
      NM: PDFHexString.fromText(`${TAG}${a.id}`), F: 4, M: PDFHexString.fromText(nowStr()),
      T: PDFHexString.fromText(a.author ?? "Kreatix"),
      Rect: [r0[0], r0[1], r0[0] + w, r0[1] + h],
      AP: { N: apRef },
    });
    const ref = src.context.register(dict);
    pageNode.addAnnot(ref);
    return ref.toString();
  } catch { return null; }
};

/** Escape a string for a PDF literal (…) text object. */
const pdfStr = (s: string) =>
  safe(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** Types that get a generated /AP stream — viewers that don't synthesize
 *  appearances for non-widget annots (some converters, printers, older
 *  renderers) otherwise show nothing even though the annot is in the file.
 *  note/caret/replace render natively everywhere; sign/image build their own
 *  AP in embedImageAnnot. */
const AP_TYPES = new Set<PdfAnn["type"]>([
  "freehand", "polyline", "line", "arrow", "rect", "ellipse", "cloud", "whiteout",
  "highlight", "underline", "strikeout", "squiggly",
  "textbox", "callout", "check", "cross", "stamp",
]);

/** Build the /AP normal-appearance stream (a Form XObject whose BBox equals
 *  the annot /Rect, painted in absolute page coordinates) for one annotation.
 *  Returns the registered stream ref, or null when not applicable. */
const makeAppearance = (
  a: PdfAnn, L: Lib, src: LibDoc, rect: number[],
  fonts: { helv: { ref: LibRef; widthOfTextAtSize: (t: string, s: number) => number }; ding: { ref: LibRef } },
): LibRef | null => {
  const { PDFName } = L;
  const n = (v: number) => Number(v.toFixed(2));
  const [R, G, B] = hexRgb(a.color).map(n);
  const path = (pts: [number, number][]) =>
    pts.map((p, i) => `${n(p[0])} ${n(p[1])} ${i ? "l" : "m"}`).join(" ");
  const r0 = a.rects?.[0];
  let ops = "", ca = 1;

  switch (a.type) {
    case "freehand": {
      const pts = a.points ?? [];
      if (pts.length < 2) return null;
      ops = `${R} ${G} ${B} RG 1.8 w 1 J 1 j ${path(pts)} S`;
      break;
    }
    case "polyline": {
      const pts = a.points ?? [];
      if (pts.length < 2) return null;
      ops = `${R} ${G} ${B} RG 1.4 w 1 J 1 j ${path(pts)} S`;
      break;
    }
    case "line": case "arrow": {
      const pts = a.points ?? [];
      if (pts.length < 2) return null;
      ops = `${R} ${G} ${B} RG 1.4 w ${path(pts)} S`;
      if (a.type === "arrow") {
        const p = pts[pts.length - 2], q = pts[pts.length - 1];
        const ang = Math.atan2(q[1] - p[1], q[0] - p[0]), hl = 8;
        const p1 = [q[0] + hl * Math.cos(ang + Math.PI * 0.82), q[1] + hl * Math.sin(ang + Math.PI * 0.82)];
        const p2 = [q[0] + hl * Math.cos(ang - Math.PI * 0.82), q[1] + hl * Math.sin(ang - Math.PI * 0.82)];
        ops += ` ${R} ${G} ${B} rg ${n(q[0])} ${n(q[1])} m ${n(p1[0])} ${n(p1[1])} l ${n(p2[0])} ${n(p2[1])} l f`;
      }
      break;
    }
    case "rect": case "whiteout": case "cloud": {
      if (!r0) return null;
      const [x, y, w, h] = r0;
      ops = a.type === "whiteout"
        ? `1 1 1 rg ${n(x)} ${n(y)} ${n(w)} ${n(h)} re f 0.8 0.8 0.8 RG 0.5 w ${n(x)} ${n(y)} ${n(w)} ${n(h)} re S`
        : `${R} ${G} ${B} RG 1.4 w ${n(x)} ${n(y)} ${n(w)} ${n(h)} re S`;
      break;
    }
    case "ellipse": {
      if (!r0) return null;
      const [x, y, w, h] = r0, k = 0.5523, rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry;
      ops = `${R} ${G} ${B} RG 1.4 w ${n(cx + rx)} ${n(cy)} m` +
        ` ${n(cx + rx)} ${n(cy + ry * k)} ${n(cx + rx * k)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} c` +
        ` ${n(cx - rx * k)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + ry * k)} ${n(cx - rx)} ${n(cy)} c` +
        ` ${n(cx - rx)} ${n(cy - ry * k)} ${n(cx - rx * k)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} c` +
        ` ${n(cx + rx * k)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - ry * k)} ${n(cx + rx)} ${n(cy)} c S`;
      break;
    }
    case "highlight": {
      if (!a.rects?.length) return null;
      ca = 0.35;
      ops = `${R} ${G} ${B} rg ` + a.rects.map(([x, y, w, h]) => `${n(x)} ${n(y)} ${n(w)} ${n(h)} re f`).join(" ");
      break;
    }
    case "underline": case "strikeout": case "squiggly": {
      if (!a.rects?.length) return null;
      ca = 0.9;
      const parts: string[] = [`${R} ${G} ${B} RG ${a.type === "squiggly" ? 1 : 1.2} w`];
      for (const [x, y, w, h] of a.rects) {
        if (a.type === "squiggly") {
          const pts: [number, number][] = [];
          for (let px = x; px <= x + w; px += 2.4) pts.push([px, y + (pts.length % 2 ? 0 : 1.6)]);
          pts.push([x + w, y]);
          parts.push(path(pts) + " S");
        } else {
          const ly = a.type === "underline" ? y : y + h / 2;
          parts.push(`${n(x)} ${n(ly)} m ${n(x + w)} ${n(ly)} l S`);
        }
      }
      ops = parts.join(" ");
      break;
    }
    case "textbox": case "callout": {
      if (!r0) return null;
      const [x, y, w, h] = r0;
      const sz = a.fontSize ?? 11;
      const bg = a.type === "callout" ? `${R} ${G} ${B} rg` : `1 1 1 rg`;
      ops = `${bg} ${n(x)} ${n(y)} ${n(w)} ${n(h)} re f ` +
        `${R} ${G} ${B} RG ${a.type === "callout" ? 1.2 : 0.5} w ${n(x)} ${n(y)} ${n(w)} ${n(h)} re S ` +
        `${n(x)} ${n(y)} ${n(w)} ${n(h)} re W n ` +
        `BT /F1 ${n(sz)} Tf 0.09 0.09 0.09 rg ${n(x + 3)} ${n(y + h - sz - 2)} Td ${n(sz * 1.25)} TL ` +
        safe(a.text ?? "").split("\n").map((l) => `(${pdfStr(l)}) Tj T*`).join(" ") + " ET";
      if (a.type === "callout") {
        const [tx, ty] = a.points?.[0] ?? [x, y];
        ops += ` ${R} ${G} ${B} RG 1.2 w ${n(tx)} ${n(ty)} m ${n(x + w / 2)} ${n(y + h / 2)} l S`;
      }
      break;
    }
    case "check": case "cross": {
      if (!r0) return null;
      const [x, y, w, h] = r0;
      const sz = Math.max(8, h * 0.9);
      ops = `BT /FD ${n(sz)} Tf ${R} ${G} ${B} rg ${n(x + (w - sz * 0.6) / 2)} ${n(y + (h - sz) / 2)} Td (${a.type === "check" ? "4" : "8"}) Tj ET`;
      break;
    }
    case "stamp": {
      if (!r0) return null;
      const std = STAMP_NAMES[(a.text ?? "").toUpperCase()];
      if (std) return null; // standard stamps render natively from /Name
      const [x, y, w, h] = r0;
      const label = safe(a.text ?? "").toUpperCase();
      const fs = Math.min(16, (w - 8) / Math.max(1, fonts.helv.widthOfTextAtSize(label, 1)));
      const tw = fonts.helv.widthOfTextAtSize(label, fs);
      ops = `${R} ${G} ${B} RG 2 w ${n(x)} ${n(y)} ${n(w)} ${n(h)} re S ` +
        `BT /F1 ${n(fs)} Tf ${R} ${G} ${B} rg ${n(x + (w - tw) / 2)} ${n(y + h / 2 - fs * 0.36)} Td (${pdfStr(label)}) Tj ET`;
      break;
    }
    default:
      return null;
  }

  const resources: Record<string, unknown> = {
    ProcSet: [PDFName.of("PDF"), PDFName.of("Text")],
    ExtGState: { GS0: { Type: PDFName.of("ExtGState"), CA: ca, ca } },
    Font: { F1: fonts.helv.ref, FD: fonts.ding.ref },
  };
  const bbox = [rect[0] - 3, rect[1] - 3, rect[2] + 3, rect[3] + 3]; // stroke bleed
  const stream = src.context.flateStream(ops, {
    Type: PDFName.of("XObject"), Subtype: PDFName.of("Form"),
    BBox: src.context.obj(bbox), Matrix: src.context.obj([1, 0, 0, 1, 0, 0]),
    Resources: src.context.obj(resources as never),
  });
  return src.context.register(stream);
};

const parseRef = (s?: string): [number, number] | null => {
  const m = /^(\d+) (\d+) R$/.exec(s ?? "");
  return m ? [Number(m[1]), Number(m[2])] : null;
};

const dictTag = (L: Lib, ctx: LibDoc["context"], ref: unknown): string | null => {
  try {
    const d = ctx.lookup(ref as never) as LibDict;
    const nm = d.get(L.PDFName.of("NM"));
    const s = (nm as { decodeText?: () => string } | undefined)?.decodeText?.()
      ?? (nm as { asString?: () => string } | undefined)?.asString?.() ?? "";
    return s.startsWith(TAG) ? s.slice(TAG.length) : null;
  } catch { return null; }
};

/** Write every authored field as a real AcroForm field (or update an existing
 *  one) + push stored form values into native fields' /V. */
const embedFields = async (
  src: LibDoc, L: Lib, fields: PdfField[], embeddedNames: string[], pdfjs: PDFDocumentProxy | null,
  formValues: Record<string, unknown>,
): Promise<PdfField[]> => {
  const out = fields.map((f) => ({ ...f }));
  try {
    const form = src.getForm();
    const helv = await src.embedFont(L.StandardFonts.Helvetica);
    const pages = src.getPages();
    const has = (name: string) => { try { return !!form.getField(name); } catch { return false; } };

    // fields deleted from the model but still in the file → remove
    const keep = new Set(out.filter((f) => f.kind !== "signature" && f.kind !== "barcode").map((f) => f.embedded ?? f.name));
    for (const name of embeddedNames) {
      if (!keep.has(name)) { try { form.removeField(form.getField(name)); } catch { /* already gone */ } }
    }

    for (const f of out) {
      const pg = pages[f.page - 1];
      if (!pg) continue;
      const [x, y, w, h] = f.rect;
      try {
        if (f.kind === "signature" || f.kind === "barcode") {
          // drawn content, not a real field — only bake once
          if (!f.embedded) {
            if (f.kind === "signature") {
              if (f.value) { const sig = await src.embedPng(String(f.value).split(",")[1]); pg.drawImage(sig, { x, y, width: w, height: h }); }
              pg.drawRectangle({ x, y, width: w, height: h, borderWidth: 1, borderColor: L.rgb(0.5, 0.5, 0.5) });
            } else {
              pg.drawRectangle({ x, y, width: w, height: h, borderWidth: 1, borderColor: L.rgb(0.5, 0.5, 0.5) });
              let bx = x + 2;
              for (const c of String(f.value ?? "")) {
                const bw = (c.charCodeAt(0) % 3) + 1;
                if (bx + bw > x + w - 2) break;
                pg.drawRectangle({ x: bx, y: y + 2, width: bw, height: h - 8, color: L.rgb(0, 0, 0) });
                bx += bw + 1.5;
              }
              if (f.value) pg.drawText(String(f.value), { x: x + 2, y: y + 2, size: Math.min(6, h / 4), font: helv, color: L.rgb(0, 0, 0) });
            }
            f.embedded = "drawn";
          }
          continue;
        }
        if (f.embedded && has(f.embedded)) {
          // update the existing field's value in place
          const v = f.value ?? f.defaultValue;
          try { if (f.kind === "text") form.getTextField(f.embedded).setText(String(v ?? "")); } catch { /* type drifted */ }
          try { if (f.kind === "checkbox") { if (v) form.getCheckBox(f.embedded).check(); else form.getCheckBox(f.embedded).uncheck(); } } catch { /* */ }
          try { if (f.kind === "radio" && v) form.getRadioGroup(f.group ?? f.embedded).select(String(f.name)); } catch { /* */ }
          try { if ((f.kind === "dropdown" || f.kind === "list") && v != null && v !== "") {
            const sel = String(v).split("\n")[0];
            if (f.kind === "list") form.getOptionList(f.embedded).select(sel);
            else form.getDropdown(f.embedded).select(sel);
          } } catch { /* */ }
          continue;
        }
        // create
        if (f.kind === "text") {
          const tf = form.createTextField(f.name);
          tf.addToPage(pg, { x, y, width: w, height: h, borderWidth: 1 });
          if (f.required) tf.enableRequired();
          if (f.comb) { try { tf.setMaxLength(f.comb); tf.enableCombing(); } catch { /* */ } }
          const v = String(f.value ?? "") || f.defaultValue;
          if (v) tf.setText(v);
          f.embedded = f.name;
        } else if (f.kind === "checkbox") {
          const cb = form.createCheckBox(f.name);
          cb.addToPage(pg, { x, y, width: w, height: h });
          if (f.required) cb.enableRequired();
          if (f.value) cb.check();
          f.embedded = f.name;
        } else if (f.kind === "radio") {
          const gname = f.group ?? f.name;
          const rg = (() => { try { return form.getRadioGroup(gname); } catch { return form.createRadioGroup(gname); } })();
          rg.addOptionToPage(f.name, pg, { x, y, width: w, height: h });
          if (f.value) try { rg.select(f.name); } catch { /* option missing */ }
          f.embedded = gname; // the AcroForm field is the group — suppress/recreate by group name
        } else {
          const opts = f.options?.length ? f.options : [" "];
          const dd = f.kind === "list" ? form.createOptionList(f.name) : form.createDropdown(f.name);
          dd.addToPage(pg, { x, y, width: w, height: h });
          dd.addOptions(opts);
          if (f.required) dd.enableRequired();
          if (f.value) try { dd.select(String(f.value).split("\n")[0]); } catch { /* option missing */ }
          f.embedded = f.name;
        }
      } catch { /* skip malformed field */ }
    }
    if (out.length || embeddedNames.length) form.updateFieldAppearances(helv);

    // values typed into NATIVE fields live in pdf.js annotationStorage — write /V
    if (pdfjs) {
      const idToName = new Map<string, string>();
      for (let p = 1; p <= pdfjs.numPages; p++) {
        for (const a of await (await pdfjs.getPage(p)).getAnnotations()) {
          if (a.fieldName && a.id) idToName.set(a.id, a.fieldName);
        }
      }
      for (const [key, raw] of Object.entries(formValues)) {
        const name = idToName.get(key);
        if (!name) continue;
        const v = (raw as { value?: unknown })?.value ?? raw;
        try { form.getTextField(name).setText(String(v ?? "")); continue; } catch { /* */ }
        try { if (v) form.getCheckBox(name).check(); else form.getCheckBox(name).uncheck(); continue; } catch { /* */ }
        for (const g of ["getDropdown", "getOptionList", "getRadioGroup"] as const) {
          try { (form[g](name) as { select: (v: string) => void }).select(String(v)); break; } catch { /* next */ }
        }
      }
    }
  } catch { /* no AcroForm support in this doc — fields stay overlay-only */ }
  return out;
};

export interface EmbedResult {
  bytes: Uint8Array;
  doc: PdfDoc;
}

/**
 * Produce new PDF bytes containing every annotation as a real /Annot and every
 * authored field as a real AcroForm field. Returns the bytes plus a PdfDoc with
 * `embedded` markers so later saves update in place and deleted marks are
 * removed from the file.
 *
 * `rasters`: 1-based page → PNG data URL for redacted pages (content removal).
 */
export async function embedIntoPdf(
  bytes: ArrayBuffer,
  pdfDoc: PdfDoc,
  formValues: Record<string, unknown>,
  pdfjs: PDFDocumentProxy | null,
  rasters?: Record<number, string>,
): Promise<EmbedResult> {
  const L = await import("pdf-lib");
  const { PDFDocument, PDFName } = L;
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });

  // ---- redact: rasterize the page, drop the marks (true removal, same as export) ----
  const rasterized = new Set<number>();
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
        rasterized.add(i + 1);
      } catch { /* leave page as-is */ }
    }
  }

  const next: PdfDoc = structuredClone(pdfDoc);
  // redact anns are consumed by rasterization — drop them only when the page
  // was actually rasterized, otherwise keep the mark visible in our layer
  next.annotations = next.annotations.filter((a) => a.type !== "redact" || !rasterized.has(a.page));
  const liveIds = new Set(next.annotations.map((a) => a.id));

  const pages = src.getPages();
  const obj = (v: unknown) => src.context.obj(v as never) as never;

  // fonts shared by every generated /AP stream
  const apFonts = {
    helv: await src.embedFont(L.StandardFonts.Helvetica),
    ding: await src.embedFont(L.StandardFonts.ZapfDingbats),
  };

  // ---- reconcile annotations: remove ours that were deleted, update moved ones ----
  for (let i = 0; i < pages.length; i++) {
    const leaf = pages[i].node;
    const annots = leaf.Annots();
    if (!annots) continue;
    for (let k = annots.size() - 1; k >= 0; k--) {
      const ref = annots.get(k) as LibRef;
      const annId = dictTag(L, src.context, ref);
      if (annId !== null && !liveIds.has(annId)) annots.remove(k);
    }
  }

  // ---- embed / update each annotation ----
  for (const a of next.annotations) {
    const page = pages[a.page - 1];
    if (!page) continue;
    try {
      // sign/image are Stamps w/ appearance streams
      if (a.type === "sign" || a.type === "image") {
        const refStr = parseRef(a.embedded);
        if (refStr) { /* image annots are static — nothing to update unless moved */
          const r0 = a.rects?.[0];
          if (r0) {
            const d = src.context.lookup(L.PDFRef.of(refStr[0], refStr[1])) as LibDict;
            d.set(PDFName.of("Rect"), obj([r0[0], r0[1], r0[0] + r0[2], r0[1] + r0[3]]));
          }
          continue;
        }
        const r = await embedImageAnnot(a, L, src, page.node);
        if (r) a.embedded = r;
        continue;
      }

      const entries = annotEntries(a, L);
      if (!entries) continue;
      // appearance stream — annots without /AP render invisible in viewers
      // that don't synthesize appearances for non-widget annots
      if (AP_TYPES.has(a.type)) {
        const rect = (entries.Rect as number[] | undefined) ?? annotRectOf(a);
        if (rect?.length === 4) {
          const ap = makeAppearance(a, L, src, rect, apFonts);
          if (ap) entries.AP = { N: ap };
        }
      }
      const refStr = parseRef(a.embedded);
      if (refStr) {
        // update the existing annot dict in place (moved/edited)
        try {
          const d = src.context.lookup(L.PDFRef.of(refStr[0], refStr[1])) as LibDict;
          const fresh = src.context.obj(entries as never) as unknown as LibDict;
          for (const [k, v] of fresh.entries()) d.set(k, v);
          continue;
        } catch { /* ref lost — fall through and re-create */ }
        a.embedded = undefined;
      }
      const ref = src.context.register(src.context.obj(entries as never));
      page.node.addAnnot(ref);
      a.embedded = ref.toString();
    } catch { /* skip malformed ann */ }
  }

  // ---- fields + native form values ----
  next.fields = await embedFields(src, L, next.fields ?? [], next.embeddedFieldNames ?? [], pdfjs, formValues);
  next.embeddedFieldNames = next.fields.map((f) => f.embedded).filter((s): s is string => !!s && s !== "drawn");

  return { bytes: await src.save(), doc: next };
}
