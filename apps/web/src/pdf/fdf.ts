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
const xAttr = (tag: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1];

/** shared record for one parsed annotation, whichever container syntax it came from */
interface AnnRec {
  sub: string; page: number; contents: string; author: string;
  colorNums: number[]; quadNums: number[]; rectNums: number[];
  lineNums: number[]; inkNums: number[];
  isReplace?: boolean; hasLE?: boolean; stampName?: string;
}

const toAnn = (r: AnnRec): PdfAnn | null => {
  const rects: P4[] = [];
  if (r.quadNums.length >= 8 && r.quadNums.length % 8 === 0)
    for (let i = 0; i < r.quadNums.length; i += 8) {
      const [x1, y1, x2, , , , x4, y4] = r.quadNums.slice(i, i + 8);
      rects.push([Math.min(x1, x4), Math.min(y1, y4), Math.abs(x2 - x1), Math.abs(y1 - y4)]);
    }
  else if (r.rectNums.length === 4) rects.push([Math.min(r.rectNums[0], r.rectNums[2]), Math.min(r.rectNums[1], r.rectNums[3]), Math.abs(r.rectNums[2] - r.rectNums[0]), Math.abs(r.rectNums[3] - r.rectNums[1])]);

  const color = r.colorNums.length === 3 && r.colorNums.every((n) => !isNaN(n))
    ? `#${r.colorNums.map((n) => Math.round(n * 255).toString(16).padStart(2, "0")).join("")}` : undefined;
  const base = { id: crypto.randomUUID().slice(0, 8), page: r.page, color, text: r.contents || undefined, author: r.author || undefined, createdAt: new Date().toISOString() };
  switch (r.sub) {
    case "Highlight": return { ...base, type: "highlight", rects };
    case "Underline": return { ...base, type: "underline", rects };
    case "StrikeOut": return { ...base, type: r.isReplace ? "replace" : "strikeout", rects };
    case "Squiggly": return { ...base, type: "squiggly", rects };
    case "Redact": return { ...base, type: "redact", rects };
    case "Square": return { ...base, type: "rect", rects };
    case "Circle": return { ...base, type: "ellipse", rects };
    case "Polygon": return { ...base, type: "cloud", rects };
    case "Text": return { ...base, type: "note", points: [[r.rectNums[0] ?? 0, r.rectNums[3] ?? 0]], rects: undefined };
    case "Caret": return { ...base, type: "caret", points: [[r.rectNums[0] ?? 0, r.rectNums[1] ?? 0]], rects: undefined };
    case "FreeText": return { ...base, type: "textbox", rects };
    case "Stamp": return { ...base, type: "stamp", rects, text: r.contents || r.stampName || "STAMP" };
    case "Ink": {
      const pts: [number, number][] = [];
      for (let i = 0; i + 1 < r.inkNums.length; i += 2) pts.push([r.inkNums[i], r.inkNums[i + 1]]);
      return pts.length > 1 ? { ...base, type: "freehand", points: pts } : null;
    }
    case "Line":
      return r.lineNums.length === 4
        ? { ...base, type: r.hasLE ? "arrow" : "line", points: [[r.lineNums[0], r.lineNums[1]], [r.lineNums[2], r.lineNums[3]]] }
        : null;
    default: return null;
  }
};

const nums = (s: string | undefined | null) => (s ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number);

/** Parse an FDF or XFDF file back into Kreatix annotations (standard markups). */
export function parseFdf(text: string): PdfAnn[] {
  if (/<\s*xfdf[\s>]/i.test(text)) return parseXfdf(text);
  const out: PdfAnn[] = [];
  for (const m of text.matchAll(/<<(.*?)>>/gs)) {
    const o = m[1];
    if (!/\/Subtype\s*\/\w+/.test(o)) continue;
    const ann = toAnn({
      sub: grab(o, /\/Subtype\s*\/(\w+)/) ?? "",
      page: Number(grab(o, /\/Page\s+(\d+)/) ?? "0") + 1,
      contents: unesc(grab(o, /\/Contents\s*\(((?:\\.|[^\\)])*)\)/) ?? ""),
      author: unesc(grab(o, /\/T\s*\(((?:\\.|[^\\)])*)\)/) ?? ""),
      colorNums: nums(grab(o, /\/C\s*\[([^\]]*)\]/)),
      quadNums: nums(grab(o, /\/QuadPoints\s*\[([^\]]*)\]/)),
      rectNums: nums(grab(o, /\/Rect\s*\[([^\]]*)\]/)),
      lineNums: nums(grab(o, /\/L\s*\[([^\]]*)\]/)),
      inkNums: nums(grab(o, /\/InkList\s*\[\[([^\]]*)\]\]/)),
      isReplace: /\/Subj\s*\(Replace\)/.test(o),
      hasLE: /\/LE\s*\[/.test(o),
      stampName: grab(o, /\/Name\s*\/(\w+)/),
    });
    if (ann) out.push(ann);
  }
  return out;
}

/** XFDF (XML form of FDF) — <annots><highlight|strikeout|… …/></annots>.
 *  Regex-parsed to stay DOMParser-free for the Node test harness. */
function parseXfdf(xml: string): PdfAnn[] {
  const out: PdfAnn[] = [];
  const TAG: Record<string, string> = {
    highlight: "Highlight", underline: "Underline", strikeout: "StrikeOut", squiggly: "Squiggly",
    redact: "Redact", square: "Square", circle: "Circle", polygon: "Polygon", polyline: "PolyLine",
    text: "Text", caret: "Caret", freetext: "FreeText", stamp: "Stamp", ink: "Ink", line: "Line",
  };
  const unx = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
  const hexColor = (v: string | undefined): number[] => {
    const m = v && /^#?([0-9a-f]{6})/i.exec(v);
    return m ? [parseInt(m[1].slice(0, 2), 16) / 255, parseInt(m[1].slice(2, 4), 16) / 255, parseInt(m[1].slice(4, 6), 16) / 255] : [];
  };
  // only the <annots> body — matching the outer <xfdf>/<fields> elements would
  // greedily consume the annotations inside them
  const body = /<annots\b[^>]*>([\s\S]*?)<\/annots>/i.exec(xml)?.[1] ?? "";
  for (const m of body.matchAll(/<(\w+)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
    const tagName = m[1].toLowerCase();
    const sub = TAG[tagName] === "PolyLine" ? "Ink" : TAG[tagName];
    if (!sub) continue;
    const attrs = m[2] ?? "", inner = m[3] ?? "";
    const a = (n: string) => xAttr(attrs, n);
    const contents = unx(grab(inner, /<contents[^>]*>([\s\S]*?)<\/contents>/i)?.trim() ?? a("contents") ?? "");
    const line: number[] = [];
    const s = nums(a("start")), e = nums(a("end"));
    if (s.length === 2 && e.length === 2) line.push(s[0], s[1], e[0], e[1]);
    const inkNums: number[] = [];
    for (const g of inner.matchAll(/<gesture[^>]*>([\s\S]*?)<\/gesture>/gi))
      for (const pair of g[1].trim().split(";")) {
        const p = nums(pair);
        if (p.length >= 2) inkNums.push(p[0], p[1]);
      }
    // <polyline coords="x1,y1;x2,y2;…"> feeds the same point list
    if (tagName === "polyline")
      for (const pair of (a("coords") ?? "").trim().split(";")) {
        const p = nums(pair);
        if (p.length >= 2) inkNums.push(p[0], p[1]);
      }
    const ann = toAnn({
      sub,
      page: Number(a("page") ?? "0") + 1,
      contents,
      author: unx(a("title") ?? ""),
      colorNums: hexColor(a("color")),
      quadNums: nums(a("coords")),
      rectNums: nums(a("rect")),
      lineNums: line,
      inkNums,
      isReplace: /replace/i.test(a("subject") ?? ""),
      hasLE: /OpenArrow|Arrow/.test(a("head") ?? "") || /OpenArrow|Arrow/.test(a("tail") ?? ""),
      stampName: a("icon") ?? a("name"),
    });
    if (ann) out.push(ann);
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
