import type { PdfAnn } from "./model";

type P4 = [number, number, number, number];

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const unesc = (s: string) => s.replace(/\\([\\()])/g, "$1");
const num = (n: number) => +n.toFixed(3);

/** [x,y,w,h] → FDF /Rect [x1 y1 x2 y2] (lower-left, upper-right) */
const rectStr = ([x, y, w, h]: P4) => `[${num(x)} ${num(y)} ${num(x + w)} ${num(y + h)}]`;
/** highlight-family quad points per rect: TL TR BL BR in PDF space */
const quadStr = ([x, y, w, h]: P4) => `${num(x)} ${num(y + h)} ${num(x + w)} ${num(y + h)} ${num(x)} ${num(y)} ${num(x + w)} ${num(y)}`;
const colStr = (hex?: string) => {
  const m = /^#?([0-9a-f]{6})/i.exec(hex ?? "")?.[1] ?? "F2782E";
  return `[${num(parseInt(m.slice(0, 2), 16) / 255)} ${num(parseInt(m.slice(2, 4), 16) / 255)} ${num(parseInt(m.slice(4, 6), 16) / 255)}]`;
};

const SUB: Record<string, string> = {
  highlight: "Highlight", underline: "Underline", strikeout: "StrikeOut", squiggly: "Squiggly",
  freehand: "Ink", polyline: "Ink", rect: "Square", ellipse: "Circle", cloud: "Polygon",
  line: "Line", arrow: "Line", callout: "FreeText", note: "Text", textbox: "FreeText",
  caret: "Caret", replace: "StrikeOut", stamp: "Stamp", redact: "Redact",
};

/**
 * PDF-12.2 — export Kreatix annotations as an .fdf (Forms Data Format) file,
 * the interchange Acrobat uses for comments. Signatures/images/whiteout have
 * no standard FDF form and are skipped.
 */
export function exportFdf(anns: PdfAnn[], fileName: string): void {
  const objs: string[] = [];
  for (const a of anns) {
    const sub = SUB[a.type];
    if (!sub) continue;
    const parts: string[] = [`/Type /Annot /Subtype /${sub}`, `/Page ${a.page - 1}`, `/C ${colStr(a.color)}`];
    if (a.author) parts.push(`/T (${esc(a.author)})`);
    if (a.createdAt) parts.push(`/M (D:${a.createdAt.replace(/[-:TZ.]/g, "").slice(0, 14)})`);
    if (a.text) parts.push(`/Contents (${esc(a.text)})`);
    if (a.type === "replace") parts.push(`/Subj (Replace)`);
    if (a.rects?.length) {
      parts.push(`/Rect ${rectStr(a.rects[0])}`);
      if (a.rects.length > 1 || /highlight|underline|strikeout|squiggly|replace|redact/.test(a.type))
        parts.push(`/QuadPoints [${a.rects.map(quadStr).join(" ")}]`);
    }
    if ((a.type === "line" || a.type === "arrow") && a.points?.length === 2)
      parts.push(`/L [${a.points[0].map(num).join(" ")} ${a.points[1].map(num).join(" ")}]`);
    if (a.type === "arrow") parts.push(`/LE [/OpenArrow]`);
    if ((a.type === "freehand" || a.type === "polyline") && a.points?.length)
      parts.push(`/InkList [[${a.points.map((p) => p.map(num).join(" ")).join(" ")}]]`);
    if (a.type === "cloud") parts.push(`/IT /Cloud`);
    if (a.type === "stamp") parts.push(`/Name /${(a.text ?? "Draft").replace(/[^A-Za-z]/g, "")}`);
    objs.push(`<< ${parts.join(" ")} >>`);
  }
  const fdf = `%FDF-1.2\n1 0 obj\n<< /FDF << /Annots [\n${objs.join("\n")}\n] >> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`;
  const url = URL.createObjectURL(new Blob([fdf], { type: "application/vnd.fdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName.replace(/\.pdf$/i, "") + ".fdf";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const grab = (src: string, re: RegExp) => re.exec(src)?.[1];

/** Parse an FDF file back into Kreatix annotations (subset: standard markups). */
export function parseFdf(text: string): PdfAnn[] {
  const out: PdfAnn[] = [];
  for (const m of text.matchAll(/<<(.*?)>>/gs)) {
    const o = m[1];
    if (!/\/Subtype\s*\/\w+/.test(o)) continue;
    const sub = grab(o, /\/Subtype\s*\/(\w+)/) ?? "";
    const page = Number(grab(o, /\/Page\s+(\d+)/) ?? "0") + 1;
    const contents = unesc(grab(o, /\/Contents\s*\(((?:\\.|[^\\)])*)\)/) ?? "");
    const author = unesc(grab(o, /\/T\s*\(((?:\\.|[^\\)])*)\)/) ?? "");
    const cNums = (grab(o, /\/C\s*\[([^\]]*)\]/) ?? "").trim().split(/\s+/).map(Number);
    const color = cNums.length === 3 && cNums.every((n) => !isNaN(n))
      ? `#${cNums.map((n) => Math.round(n * 255).toString(16).padStart(2, "0")).join("")}` : undefined;
    const quadRaw = (grab(o, /\/QuadPoints\s*\[([^\]]*)\]/) ?? "").trim().split(/\s+/).map(Number);
    const rectNums = (grab(o, /\/Rect\s*\[([^\]]*)\]/) ?? "").trim().split(/\s+/).map(Number);
    const lineNums = (grab(o, /\/L\s*\[([^\]]*)\]/) ?? "").trim().split(/\s+/).map(Number);
    const inkRaw = grab(o, /\/InkList\s*\[\[([^\]]*)\]\]/);

    const rects: P4[] = [];
    if (quadRaw.length >= 8 && quadRaw.length % 8 === 0)
      for (let i = 0; i < quadRaw.length; i += 8) {
        const [x1, y1, x2, , , , x4, y4] = quadRaw.slice(i, i + 8);
        rects.push([Math.min(x1, x4), Math.min(y1, y4), Math.abs(x2 - x1), Math.abs(y1 - y4)]);
      }
    else if (rectNums.length === 4) rects.push([Math.min(rectNums[0], rectNums[2]), Math.min(rectNums[1], rectNums[3]), Math.abs(rectNums[2] - rectNums[0]), Math.abs(rectNums[3] - rectNums[1])]);

    const base = { id: crypto.randomUUID().slice(0, 8), page, color, text: contents || undefined, author: author || undefined, createdAt: new Date().toISOString() };
    const isReplace = /\/Subj\s*\(Replace\)/.test(o);
    switch (sub) {
      case "Highlight": out.push({ ...base, type: "highlight", rects }); break;
      case "Underline": out.push({ ...base, type: "underline", rects }); break;
      case "StrikeOut": out.push({ ...base, type: isReplace ? "replace" : "strikeout", rects }); break;
      case "Squiggly": out.push({ ...base, type: "squiggly", rects }); break;
      case "Redact": out.push({ ...base, type: "redact", rects }); break;
      case "Square": out.push({ ...base, type: "rect", rects }); break;
      case "Circle": out.push({ ...base, type: "ellipse", rects }); break;
      case "Polygon": out.push({ ...base, type: "cloud", rects }); break;
      case "Text": out.push({ ...base, type: "note", points: [[rectNums[0] ?? 0, rectNums[3] ?? 0]], rects: undefined }); break;
      case "Caret": out.push({ ...base, type: "caret", points: [[rectNums[0] ?? 0, rectNums[1] ?? 0]], rects: undefined }); break;
      case "FreeText": out.push({ ...base, type: "textbox", rects }); break;
      case "Stamp": out.push({ ...base, type: "stamp", rects, text: contents || "STAMP" }); break;
      case "Ink": {
        const nums = (inkRaw ?? "").trim().split(/\s+/).map(Number);
        const pts: [number, number][] = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
        if (pts.length > 1) out.push({ ...base, type: "freehand", points: pts });
        break;
      }
      case "Line": {
        if (lineNums.length === 4)
          out.push({ ...base, type: /\/LE\s*\[/.test(o) ? "arrow" : "line", points: [[lineNums[0], lineNums[1]], [lineNums[2], lineNums[3]]] });
        break;
      }
    }
  }
  return out;
}

/**
 * FDF form-data export — Acrobat's "Export Form Data". Emits the /Fields
 * array with each field's /T name and /V value; Acrobat can import this to
 * fill the same form fields in another copy of the document.
 */
export function exportFormFdf(
  fields: { name: string; value: string | boolean | string[] }[],
  fileName: string,
): void {
  const rows = fields
    .filter((f) => f.value !== undefined && f.value !== null && f.value !== "" && f.value !== false)
    .map((f) => {
      const v = f.value === true ? "/Yes"
        : Array.isArray(f.value) ? `[${f.value.map((s) => `(${esc(s)})`).join(" ")}]`
        : `(${esc(String(f.value))})`;
      return `<< /T (${esc(f.name)}) /V ${v} >>`;
    });
  const fdf = `%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [\n${rows.join("\n")}\n] >> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`;
  const url = URL.createObjectURL(new Blob([fdf], { type: "application/vnd.fdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName.replace(/\.pdf$/i, "") + "-formdata.fdf";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
