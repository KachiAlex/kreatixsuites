import type * as XLSX from "xlsx-js-style";

/** CJS interop — the dynamic import exposes the lib under .default */
const xlsxLib = async (): Promise<typeof XLSX> => {
  const m = await import("xlsx-js-style");
  return ((m as { default?: typeof XLSX }).default ?? m) as typeof XLSX;
};
import type { CellData, SheetData, Workbook, Validation, Range } from "./model";
import { toA1, parseA1, rangeRefs, parseRange, shiftForFill, adjustForRowsCols } from "./model";
import { evaluateSheet, evaluateSheetIn, toR1C1, type EvalResult } from "./engine";

const evalsFor = (sheet: SheetData, wb?: Workbook) =>
  wb ? evaluateSheetIn(wb, sheet.name) : evaluateSheet(sheet.cells);

// ---------- CSV ----------

export function sheetToCSV(sheet: SheetData, wb?: Workbook): string {
  const refs = Object.keys(sheet.cells);
  if (!refs.length) return "";
  const parsed = refs.map((r) => parseA1(r)!);
  const maxC = Math.max(...parsed.map((p) => p.col));
  const maxR = Math.max(...parsed.map((p) => p.row));
  const evals = evalsFor(sheet, wb);
  const rows: string[] = [];
  for (let r = 0; r <= maxR; r++) {
    const row: string[] = [];
    for (let c = 0; c <= maxC; c++) {
      const cell = sheet.cells[toA1(c, r)];
      const res = evals.get(toA1(c, r));
      const raw = cell?.f ? res?.value : cell ? cell.v : res?.value;
      const v = Array.isArray(raw) ? (raw as unknown[][])[0]?.[0] : raw;
      const s = v === null || v === undefined ? "" : String(v);
      row.push(/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    }
    rows.push(row.join(","));
  }
  return rows.join("\r\n");
}

export function csvToSheet(name: string, text: string): SheetData {
  const cells: Record<string, CellData> = {};
  const rows: string[][] = [];
  let cur: string[] = [], field = "", inQ = false;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQ = false;
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { cur.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r" || i === text.length) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      cur.push(field); field = "";
      rows.push(cur); cur = [];
    } else field += ch;
  }
  rows.forEach((cols, r) => cols.forEach((raw, c) => {
    if (raw !== "") cells[toA1(c, r)] = { v: raw };
  }));
  return { name, cells };
}

// ---------- XLSX (KBS-SHEETS-001) ----------

/** Workbook → .xlsx bytes (no download side effect — used by tests + export). */
export async function workbookToXLSXBytes(wb: Workbook): Promise<Uint8Array> {
  const XLSX = await xlsxLib();
  const out = buildBook(XLSX, wb);
  return XLSX.write(out, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

export async function workbookToXLSX(wb: Workbook, filename: string) {
  const XLSX = await xlsxLib();
  const out = buildBook(XLSX, wb);
  XLSX.writeFile(out, filename.replace(/\.[^.]+$/, "") + ".xlsx");
}

/** ODS export (S8.4) — same workbook build, ods bookType. */
export async function workbookToODS(wb: Workbook, filename: string) {
  const XLSX = await xlsxLib();
  const out = buildBook(XLSX, wb);
  XLSX.writeFile(out, filename.replace(/\.[^.]+$/, "") + ".ods", { bookType: "ods" });
}

/** Kreatix CellStyle → xlsx-js-style `cell.s`. */
function styleToXLSX(s: CellData["s"]): NonNullable<XLSX.CellObject["s"]> {
  const o: Record<string, unknown> = {};
  if (!s) return o;
  if (s.b || s.i || s.u || s.st || s.font || s.size || s.color)
    o.font = {
      ...(s.b ? { bold: true } : {}), ...(s.i ? { italic: true } : {}),
      ...(s.u ? { underline: true } : {}), ...(s.st ? { strike: true } : {}),
      ...(s.font ? { name: s.font } : {}), ...(s.size ? { sz: s.size } : {}),
      ...(s.color ? { color: { rgb: s.color.replace("#", "") } } : {}),
    };
  if (s.bg) o.fill = { patternType: "solid", fgColor: { rgb: s.bg.replace("#", "") } };
  if (s.align || s.valign || s.wrap || s.indent || s.rotate)
    o.alignment = {
      ...(s.align ? { horizontal: s.align } : {}),
      ...(s.valign ? { vertical: s.valign === "top" ? "top" : s.valign === "bottom" ? "bottom" : "center" } : {}),
      ...(s.wrap ? { wrapText: true } : {}),
      ...(s.indent ? { indent: s.indent } : {}),
      ...(s.rotate ? { textRotation: s.rotate } : {}),
    };
  if (s.borders) {
    const edge = (e?: { w?: number; style?: string; color?: string }) =>
      e ? { style: e.w && e.w > 1 ? "medium" : e.style === "dashed" ? "dashed" : e.style === "dotted" ? "dotted" : "thin",
            ...(e.color ? { color: { rgb: e.color.replace("#", "") } } : {}) } : undefined;
    const b = { top: edge(s.borders.top), right: edge(s.borders.right), bottom: edge(s.borders.bottom), left: edge(s.borders.left) };
    if (b.top || b.right || b.bottom || b.left) o.border = b;
  }
  if (s.fmt) o.numFmt = s.fmt;
  return o as NonNullable<XLSX.CellObject["s"]>;
}

/** xlsx-js-style `cell.s` + `z` → Kreatix CellStyle (import side: only
 *  fill/numFmt reliably surface through the reader). */
function styleFromXLSX(x: XLSX.CellObject): CellData["s"] | undefined {
  const xs = x.s as { fgColor?: { rgb?: string }; patternType?: string } | undefined;
  const s: NonNullable<CellData["s"]> = {};
  const rgb = xs?.fgColor?.rgb;
  if (xs?.patternType === "solid" && rgb) s.bg = `#${rgb.slice(-6)}`;
  if (x.z && x.z !== "General") s.fmt = String(x.z);
  return Object.keys(s).length ? s : undefined;
}

function buildBook(XLSX: typeof import("xlsx-js-style"), wb: Workbook) {
  const out = XLSX.utils.book_new();
  if (wb.props)
    out.Props = {
      Title: wb.props.title, Subject: wb.props.subject, Author: wb.props.author,
      Company: wb.props.company, Keywords: wb.props.keywords, CreatedDate: new Date(),
    };
  for (const sheet of wb.sheets) {
    const evals = evalsFor(sheet, wb);
    const ws: XLSX.WorkSheet = {};
    const refs = Object.keys(sheet.cells);
    const parsed = refs.map((r) => parseA1(r)!);
    const maxC = Math.max(0, ...parsed.map((p) => p.col));
    const maxR = Math.max(0, ...parsed.map((p) => p.row));
    ws["!ref"] = XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: maxC, r: maxR } });
    for (const ref of refs) {
      const cell = sheet.cells[ref];
      const res = evals.get(ref);
      const v = cell.f ? res?.value : cell.v;
      const x: XLSX.CellObject =
        typeof v === "number" ? { t: "n", v } :
        typeof v === "boolean" ? { t: "b", v } :
        v === null || v === undefined ? { t: "z" } :
        { t: "s", v: String(v) };
      if (cell.f && x.t !== "z") x.f = cell.f;
      const xs = styleToXLSX(cell.s);
      if (Object.keys(xs).length) x.s = xs;
      ws[ref] = x;
    }
    // grid chrome → xlsx: col widths, freeze, merges, autofilter, hidden rows/cols
    const maxCol = Math.max(maxC, ...Object.keys(sheet.colWidths ?? {}).map(Number), ...(sheet.hiddenCols ?? []));
    const maxRow = Math.max(maxR, ...Object.keys(sheet.rowHeights ?? {}).map(Number), ...(sheet.hiddenRows ?? []));
    if (sheet.colWidths || sheet.hiddenCols?.length)
      ws["!cols"] = Array.from({ length: maxCol + 1 }, (_, c) => {
        const w = sheet.colWidths?.[c];
        const hidden = sheet.hiddenCols?.includes(c) || undefined;
        return w || hidden ? { wpx: w ?? 100, hidden } : {};
      });
    if (sheet.rowHeights || sheet.hiddenRows?.length)
      ws["!rows"] = Array.from({ length: maxRow + 1 }, (_, r) => {
        const h = sheet.rowHeights?.[r];
        const hidden = sheet.hiddenRows?.includes(r) || undefined;
        return h || hidden ? { hpx: h ?? 26, hidden } : {};
      });
    if (sheet.merges?.length)
      ws["!merges"] = sheet.merges.map((m) => ({ s: { c: m.c1, r: m.r1 }, e: { c: m.c2, r: m.r2 } }));
    if (sheet.freeze && (sheet.freeze.rows || sheet.freeze.cols))
      ws["!freeze"] = { xSplit: sheet.freeze.cols, ySplit: sheet.freeze.rows } as never;
    if (sheet.filter) {
      const fr = parseRange(sheet.filter.range);
      if (fr) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { c: fr.c1, r: fr.r1 }, e: { c: fr.c2, r: fr.r2 } }) };
    }
    XLSX.utils.book_append_sheet(out, ws, sheet.name.slice(0, 31));
  }
  return out;
}

export async function xlsxToWorkbook(file: File): Promise<Workbook> {
  const XLSX = await xlsxLib();
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { cellFormula: true, cellStyles: true });
  const sheets: SheetData[] = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const cells: Record<string, CellData> = {};
    for (const ref of Object.keys(ws)) {
      if (ref.startsWith("!")) continue;
      const x = ws[ref] as XLSX.CellObject;
      const cell: CellData = {};
      if (x.f) cell.f = x.f;
      if (x.v !== undefined) cell.v = x.v as string | number | boolean;
      const st = styleFromXLSX(x);
      if (st) cell.s = st;
      if (cell.f || cell.v !== undefined || cell.s) cells[ref] = cell;
    }
    const sheet: SheetData = { name, cells };
    if (ws["!merges"]?.length)
      sheet.merges = ws["!merges"].map((m) => ({ c1: m.s.c, r1: m.s.r, c2: m.e.c, r2: m.e.r }));
    if (ws["!cols"]) {
      sheet.colWidths = {};
      sheet.hiddenCols = [];
      ws["!cols"].forEach((c, i) => {
        const px = c?.wpx ?? (c?.wch ? Math.round(c.wch * 7.5) : undefined);
        if (px) sheet.colWidths![i] = px;
        if (c?.hidden) sheet.hiddenCols!.push(i);
      });
      if (!sheet.hiddenCols.length) delete sheet.hiddenCols;
      if (!Object.keys(sheet.colWidths).length) delete sheet.colWidths;
    }
    if (ws["!rows"]) {
      sheet.rowHeights = {};
      sheet.hiddenRows = [];
      ws["!rows"].forEach((r, i) => {
        const px = r?.hpx ?? (r?.hpt ? Math.round(r.hpt / 0.75) : undefined);
        if (px) sheet.rowHeights![i] = px;
        if (r?.hidden) sheet.hiddenRows!.push(i);
      });
      if (!sheet.hiddenRows.length) delete sheet.hiddenRows;
      if (!Object.keys(sheet.rowHeights).length) delete sheet.rowHeights;
    }
    if (ws["!autofilter"]?.ref) sheet.filter = { range: ws["!autofilter"].ref, cols: {} };
    return sheet;
  });
  return { sheets: sheets.length ? sheets : [{ name: "Sheet1", cells: {} }] };
}

// ---------- clipboard TSV (copy/paste, KBS-SHARED-013) ----------

/** Internal copy buffer — carries formulas + styles for Paste Special.
 *  (System clipboard only gets TSV; this lives for the session.) */
export interface CopiedCell { v?: CellData["v"]; f?: string; s?: CellData["s"]; eval?: unknown }
let copyBuffer: { cells: CopiedCell[][]; w: number; h: number; origin: { col: number; row: number } } | null = null;
export const setCopyBuffer = (b: typeof copyBuffer) => { copyBuffer = b; };
export const getCopyBuffer = () => copyBuffer;

/** Cells (raw + evaluated) for a range, row-major. */
export function rangeToCells(sheet: SheetData, range: { c1: number; r1: number; c2: number; r2: number }, wb?: Workbook): CopiedCell[][] {
  const evals = evalsFor(sheet, wb);
  const out: CopiedCell[][] = [];
  for (let r = range.r1; r <= range.r2; r++) {
    const row: CopiedCell[] = [];
    for (let c = range.c1; c <= range.c2; c++) {
      const ref = toA1(c, r);
      const cell = sheet.cells[ref];
      const res = evals.get(ref);
      row.push(cell ? { v: cell.v, f: cell.f, s: cell.s ? { ...cell.s } : undefined, eval: res?.value } : { eval: null });
    }
    out.push(row);
  }
  return out;
}

export type PasteMode = "all" | "values" | "formats" | "formulas" | "transpose";
export type PasteOp = "none" | "add" | "sub" | "mul" | "div";

/** Apply the internal copy buffer onto `anchor` in `dst.cells`. */
export function pasteCells(
  dst: Record<string, CellData>,
  anchor: { col: number; row: number },
  buf: NonNullable<ReturnType<typeof getCopyBuffer>>,
  mode: PasteMode = "all",
  op: PasteOp = "none",
  evals?: Map<string, { value: unknown; error: string | null }>,
): void {
  const src = mode === "transpose"
    ? buf.cells[0].map((_, ci) => buf.cells.map((row) => row[ci]))
    : buf.cells;
  const applyOp = (base: unknown, inc: unknown): CellData["v"] => {
    if (op === "none") return inc as CellData["v"];
    const a = Number(base) || 0, b = Number(inc) || 0;
    return op === "add" ? a + b : op === "sub" ? a - b : op === "mul" ? a * b : b === 0 ? "#DIV/0!" : a / b;
  };
  const dCol = anchor.col - buf.origin.col, dRow = anchor.row - buf.origin.row;
  src.forEach((row, ri) => row.forEach((cell, ci) => {
    const ref = toA1(anchor.col + ci, anchor.row + ri);
    const prev = dst[ref];
    const f = cell.f ? shiftForFill(cell.f, dCol, dRow) : undefined;
    if (mode === "formats") {
      if (prev || cell.s) dst[ref] = { ...prev, s: cell.s ? { ...cell.s } : undefined };
      return;
    }
    if (op !== "none") {
      // arithmetic paste — operate on evaluated source value vs dest value
      const base = prev?.f ? evals?.get(ref)?.value ?? prev.v : prev?.v;
      dst[ref] = { ...prev, v: applyOp(base ?? null, cell.eval), f: undefined };
      return;
    }
    if (mode === "values") dst[ref] = { ...prev, v: (cell.eval ?? cell.v) as CellData["v"], f: undefined };
    else if (mode === "formulas") dst[ref] = { v: cell.v, f, s: prev?.s };
    else dst[ref] = { v: cell.v, f, s: cell.s ? { ...cell.s } : undefined };
  }));
}

// ---------- data validation helpers (S3.4) ----------

/** Resolve a list-validation spec to items: "a,b,c" literal, "=A1:A5" /
 *  "Sheet2!B2:B9" range, or a defined name pointing at either. */
export function listItems(val: Validation, wb: Workbook, sheetName: string): string[] {
  let spec = (val.list ?? "").trim();
  if (!spec) return [];
  const resolveRange = (s: string, depth: number): string[] | null => {
    if (depth > 3) return null;
    const q = s.match(/^(?:'([^']+)'|([A-Za-z_][\w.]*))!(.+)$/);
    const rangePart = (q ? q[3] : s).replace(/\$/g, "");
    const range = parseRange(rangePart);
    if (range) {
      const sn = q ? (q[1] ?? q[2]) : sheetName;
      const sh = wb.sheets.find((x) => x.name.toLowerCase() === sn.toLowerCase());
      if (!sh) return null;
      const ev = evalsFor(sh, wb);
      return Array.from(rangeRefs(range))
        .map((r) => ev.get(r)?.value ?? sh.cells[r]?.v)
        .filter((v): v is NonNullable<typeof v> => v !== null && v !== undefined && v !== "")
        .map(String);
    }
    const named = wb.names?.[s.replace(/^=/, "")] ?? wb.names?.[spec.replace(/^=/, "")];
    if (named) return resolveRange(named.replace(/^=/, ""), depth + 1);
    return null;
  };
  const items = resolveRange(spec.replace(/^=/, ""), 0);
  return items ?? spec.split(",").map((s) => s.trim()).filter(Boolean);
}

// ---------- autofilter (S5.1) ----------

const OPS: Record<string, (a: number, b: number) => boolean> = {
  "=": (a, b) => a === b, "!=": (a, b) => a !== b, ">": (a, b) => a > b,
  "<": (a, b) => a < b, ">=": (a, b) => a >= b, "<=": (a, b) => a <= b,
};

/** Evaluate one condition against a cell value (numeric if both parse, else string ops). */
export function evalCond(op: string, cell: unknown, target: string): boolean {
  const s = cell === null || cell === undefined ? "" : String(cell);
  if (op === "contains") return s.toLowerCase().includes(target.toLowerCase());
  if (op === "notcontains") return !s.toLowerCase().includes(target.toLowerCase());
  if (op === "starts") return s.toLowerCase().startsWith(target.toLowerCase());
  if (op === "ends") return s.toLowerCase().endsWith(target.toLowerCase());
  if (op === "blank") return s === "";
  if (op === "notblank") return s !== "";
  const cn = s.trim() === "" ? NaN : Number(s), tn = Number(target);
  if (!isNaN(cn) && !isNaN(tn)) return (OPS[op] ?? OPS["="])(cn, tn);
  const cmp = s.toLowerCase().localeCompare(target.toLowerCase());
  switch (op) {
    case "=": return cmp === 0;
    case "!=": return cmp !== 0;
    case ">": return cmp > 0;
    case "<": return cmp < 0;
    case ">=": return cmp >= 0;
    case "<=": return cmp <= 0;
    default: return true;
  }
}

/** Display string used for filter value lists (raw value text). */
const disp = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** Unique display values in `col` within the filter range (excl. header). */
export function filterValues(sheet: SheetData, wb: Workbook, range: { c1: number; r1: number; c2: number; r2: number }, col: number): string[] {
  const ev = evalsFor(sheet, wb);
  const seen = new Set<string>();
  for (let r = range.r1 + 1; r <= range.r2; r++) {
    const ref = toA1(col, r);
    seen.add(disp(sheet.cells[ref]?.f ? ev.get(ref)?.value : sheet.cells[ref]?.v ?? ""));
  }
  return [...seen].sort((a, b) => {
    const na = Number(a), nb = Number(b);
    return !isNaN(na) && !isNaN(nb) ? na - nb : a.localeCompare(b);
  });
}

/** Rows inside the filter range (excl. header) hidden by current criteria. */
export function computeFilteredRows(sheet: SheetData, wb: Workbook): number[] {
  const f = sheet.filter;
  if (!f) return [];
  const range = parseRange(f.range);
  if (!range) return [];
  const cols = Object.entries(f.cols ?? {}).filter(([, c]) => c);
  if (!cols.length) return [];
  const ev = evalsFor(sheet, wb);
  const hidden = new Set<number>();
  for (let r = range.r1 + 1; r <= range.r2; r++) {
    for (const [cs, crit] of cols) {
      const c = Number(cs);
      const ref = toA1(c, r);
      const val = sheet.cells[ref]?.f ? ev.get(ref)?.value : sheet.cells[ref]?.v;
      let pass = true;
      if (crit.type === "values") pass = !!crit.values?.includes(disp(val));
      else {
        const ok1 = crit.op1 ? evalCond(crit.op1, val, crit.v1 ?? "") : true;
        const has2 = !!crit.op2;
        const ok2 = has2 ? evalCond(crit.op2!, val, crit.v2 ?? "") : true;
        pass = has2 ? (crit.and ? ok1 && ok2 : ok1 || ok2) : ok1;
      }
      if (!pass) hidden.add(r);
    }
  }
  return [...hidden];
}

// ---------- conditional formatting (S6) ----------

export interface CfEffect { bg?: string; bar?: { pct: number; color: string }; icon?: string }

/** Resolve a sheet's CF rules into per-cell visual effects.
 *  value/text/topn/formula → bg; databar → in-cell bar; colorscale → lerped
 *  fill; iconset → "color|glyph". First matching bg rule wins per cell. */
export function cfEffects(
  sheet: SheetData,
  evals: Map<string, EvalResult>,
  evalFormula?: (f: string) => EvalResult,
): Map<string, CfEffect> {
  const map = new Map<string, CfEffect>();
  const lerp = (a: string, b: string, t: number) => {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const m = (sh: number) => Math.round(((pa >> sh) & 255) + (((pb >> sh) & 255) - ((pa >> sh) & 255)) * t);
    return `rgb(${m(16)},${m(8)},${m(0)})`;
  };
  const ICONS: Record<string, [string, string, string]> = {
    arrows: ["#C12E42|▼", "#B8860B|▬", "#1E8E3E|▲"],
    traffic: ["#C12E42|●", "#B8860B|●", "#1E8E3E|●"],
    stars: ["#A19A95|★", "#B8860B|★★", "#1E8E3E|★★★"],
  };
  const cellVal = (ref: string) => {
    const cell = sheet.cells[ref];
    return cell?.f ? evals.get(ref)?.value : cell?.v;
  };
  for (const rule of sheet.cf ?? []) {
    const range = parseRange(rule.range);
    if (!range) continue;
    const type = rule.type ?? "value";
    if (type === "databar" || type === "colorscale" || type === "iconset" || type === "topn") {
      const nums = new Map<string, number>();
      for (const ref of rangeRefs(range)) {
        const v = Number(cellVal(ref));
        if (!isNaN(v)) nums.set(ref, v);
      }
      if (!nums.size) continue;
      const vals = [...nums.values()];
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const span = hi - lo || 1;
      if (type === "databar") {
        for (const [ref, v] of nums) {
          const e = map.get(ref) ?? {};
          e.bar = { pct: Math.max(2, Math.round(((v - lo) / span) * 100)), color: rule.bar ?? "#3574E0" };
          map.set(ref, e);
        }
      } else if (type === "colorscale") {
        const c0 = rule.minColor ?? "#F8696B", c2 = rule.maxColor ?? "#63BE7B";
        const c1 = rule.midColor;
        for (const [ref, v] of nums) {
          const t = (v - lo) / span;
          const e = map.get(ref) ?? {};
          e.bg = c1 ? (t < 0.5 ? lerp(c0, c1, t * 2) : lerp(c1, c2, (t - 0.5) * 2)) : lerp(c0, c2, t);
          map.set(ref, e);
        }
      } else if (type === "iconset") {
        const set = ICONS[rule.icons ?? "arrows"];
        for (const [ref, v] of nums) {
          const t = (v - lo) / span;
          const [color, glyph] = set[t < 1 / 3 ? 0 : t < 2 / 3 ? 1 : 2].split("|");
          const e = map.get(ref) ?? {};
          e.icon = `${color}|${glyph}`;
          map.set(ref, e);
        }
      } else {
        const n = Math.max(1, rule.n ?? 10);
        const sorted = [...vals].sort((a, b) => a - b);
        const cut = rule.bottom ? sorted[Math.min(n, sorted.length) - 1] : sorted[Math.max(0, sorted.length - n)];
        for (const [ref, v] of nums) {
          if (rule.bottom ? v <= cut : v >= cut) {
            const e = map.get(ref) ?? {};
            if (!e.bg) e.bg = rule.bg ?? "#D4F5E2";
            map.set(ref, e);
          }
        }
      }
      continue;
    }
    for (const ref of rangeRefs(range)) {
      const e = map.get(ref) ?? {};
      if (e.bg) { map.set(ref, e); continue; }
      const raw = cellVal(ref);
      let ok = false;
      if (type === "text") {
        const s = String(raw ?? "").toLowerCase(), t = (rule.text ?? "").toLowerCase();
        ok = rule.textOp === "notcontains" ? !s.includes(t)
          : rule.textOp === "starts" ? s.startsWith(t)
          : rule.textOp === "ends" ? s.endsWith(t)
          : rule.textOp === "=" ? s === t
          : s.includes(t);
      } else if (type === "formula" && rule.f && evalFormula) {
        const at = parseA1(ref)!;
        const f2 = shiftForFill(rule.f, at.col - range.c1, at.row - range.r1);
        const res = evalFormula(f2);
        ok = !!(res.value ?? 0) && !res.error;
      } else {
        const v = Number(raw);
        if (isNaN(v)) continue;
        ok = rule.op === ">" ? v > rule.value! : rule.op === "<" ? v < rule.value!
          : rule.op === ">=" ? v >= rule.value! : rule.op === "<=" ? v <= rule.value!
          : rule.op === "=" ? v === rule.value : v !== rule.value!;
      }
      if (ok) { e.bg = rule.bg ?? "#D4F5E2"; map.set(ref, e); }
    }
  }
  return map;
}

// ---------- find & replace (S3.2) ----------

export interface FindHit { sheet: string; ref: string; text: string; inFormula: boolean }

/** Search the workbook. `inFormulas` also matches inside `f`; values match
 *  against both raw input and the evaluated result. */
export function findInWorkbook(
  wb: Workbook,
  query: string,
  opts: { matchCase?: boolean; inFormulas?: boolean } = {},
): FindHit[] {
  if (!query) return [];
  const q = opts.matchCase ? query : query.toLowerCase();
  const has = (s: string) => (opts.matchCase ? s : s.toLowerCase()).includes(q);
  const hits: FindHit[] = [];
  for (const sheet of wb.sheets) {
    const evals = evalsFor(sheet, wb);
    for (const [ref, cell] of Object.entries(sheet.cells)) {
      if (cell.f && (has(cell.f) || has(`=${cell.f}`))) {
        hits.push({ sheet: sheet.name, ref, text: `=${cell.f}`, inFormula: true });
        continue;
      }
      if (opts.inFormulas) continue; // "in formulas" mode skips plain values
      const ev = evals.get(ref)?.value;
      const disp = ev === null || ev === undefined ? (cell.v == null ? "" : String(cell.v)) : String(ev);
      if (cell.v != null && has(String(cell.v))) hits.push({ sheet: sheet.name, ref, text: String(cell.v), inFormula: false });
      else if (cell.f && has(disp)) hits.push({ sheet: sheet.name, ref, text: disp, inFormula: false });
      else if (!cell.f && disp && has(disp)) hits.push({ sheet: sheet.name, ref, text: disp, inFormula: false });
    }
  }
  hits.sort((a, b) => a.sheet.localeCompare(b.sheet) || (parseA1(a.ref)!.row - parseA1(b.ref)!.row) || (parseA1(a.ref)!.col - parseA1(b.ref)!.col));
  return hits;
}

/** Replace `query` in the stored content of one cell (formula text or value).
 *  Returns true if the cell changed. Numbers are re-parsed via `parseInput`-like
 *  coercion kept simple: if the result parses as a number, store a number. */
export function replaceInCell(cell: CellData, query: string, replacement: string, matchCase: boolean): boolean {
  const sub = (s: string) => matchCase ? s.split(query).join(replacement)
    : s.replace(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), replacement);
  if (cell.f && (matchCase ? cell.f.includes(query) : cell.f.toLowerCase().includes(query.toLowerCase()))) {
    cell.f = sub(cell.f);
    cell.v = undefined;
    return true;
  }
  if (cell.v != null && (matchCase ? String(cell.v).includes(query) : String(cell.v).toLowerCase().includes(query.toLowerCase()))) {
    const nv = sub(String(cell.v));
    cell.v = nv !== "" && !isNaN(Number(nv)) ? Number(nv) : nv;
    return true;
  }
  return false;
}

export function rangeToTSV(sheet: SheetData, range: { c1: number; r1: number; c2: number; r2: number }, wb?: Workbook): string {
  const evals = evalsFor(sheet, wb);
  const rows: string[] = [];
  for (let r = range.r1; r <= range.r2; r++) {
    const cols: string[] = [];
    for (let c = range.c1; c <= range.c2; c++) {
      const ref = toA1(c, r);
      const cell = sheet.cells[ref];
      const res = evals.get(ref);
      const v = cell?.f ? res?.value : cell?.v;
      cols.push(v === null || v === undefined ? "" : String(v));
    }
    rows.push(cols.join("\t"));
  }
  return rows.join("\n");
}

export function tsvToCells(text: string, anchor: { col: number; row: number }): Record<string, CellData> {
  const cells: Record<string, CellData> = {};
  text.replace(/\r/g, "").split("\n").forEach((line, ri) => {
    line.split("\t").forEach((raw, ci) => {
      if (raw !== "") cells[toA1(anchor.col + ci, anchor.row + ri)] = { v: raw };
    });
  });
  return cells;
}

export function usedRangeA1(cells: Record<string, CellData>): string {
  const refs = Object.keys(cells);
  if (!refs.length) return "A1";
  const p = refs.map((r) => parseA1(r)!);
  const min = { c: Math.min(...p.map((x) => x.col)), r: Math.min(...p.map((x) => x.row)) };
  const max = { c: Math.max(...p.map((x) => x.col)), r: Math.max(...p.map((x) => x.row)) };
  return `${toA1(min.c, min.r)}:${toA1(max.c, max.r)}`;
}

export { rangeRefs, parseRange };

// ---------- print / PDF (S8.3) ----------

import { formatValue } from "./format";

export interface PrintOpts {
  orientation?: "portrait" | "landscape";
  gridlines?: boolean;
  fitWidth?: boolean;
  /** print area "A1:H40" — defaults to used range */
  area?: string;
  title?: string;
}

/** Render a sheet range to a standalone print-ready HTML document. */
export function sheetToPrintHTML(sheet: SheetData, wb: Workbook | undefined, opts: PrintOpts = {}): string {
  const evals = evalsFor(sheet, wb);
  const rng = (opts.area ? parseRange(opts.area) : null) ?? parseRange(usedRangeA1(sheet.cells)) ?? { c1: 0, r1: 0, c2: 0, r2: 0 };
  const hiddenR = new Set([...(sheet.hiddenRows ?? []), ...(sheet.filteredRows ?? [])]);
  const hiddenC = new Set(sheet.hiddenCols ?? []);
  const covered = new Map<string, { c1: number; r1: number; c2: number; r2: number }>();
  const heads = new Set<string>();
  for (const m of sheet.merges ?? []) {
    heads.add(toA1(m.c1, m.r1));
    for (const ref of rangeRefs(m)) if (ref !== toA1(m.c1, m.r1)) covered.set(ref, m);
  }
  const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const edge = (e?: { w?: number; style?: string; color?: string }) =>
    e ? `${e.w ?? 1}px ${e.style ?? "solid"} ${e.color ?? "#26221F"}` : "";
  const rows: string[] = [];
  for (let r = rng.r1; r <= rng.r2; r++) {
    if (hiddenR.has(r)) continue;
    const tds: string[] = [];
    for (let c = rng.c1; c <= rng.c2; c++) {
      if (hiddenC.has(c)) continue;
      const ref = toA1(c, r);
      if (covered.has(ref)) continue;
      const cell = sheet.cells[ref];
      const res = evals.get(ref);
      const s = cell?.s ?? {};
      const text = formatValue(cell?.f ? res?.value : cell?.v, s.fmt);
      const m = sheet.merges?.find((mm) => mm.c1 === c && mm.r1 === r);
      const css = [
        opts.gridlines ? "border:1px solid #D8D2CC" : "",
        s.b ? "font-weight:700" : "", s.i ? "font-style:italic" : "",
        s.u ? "text-decoration:underline" : "", s.st ? "text-decoration:line-through" : "",
        s.u && s.st ? "text-decoration:underline line-through" : "",
        s.font ? `font-family:${s.font}` : "", s.size ? `font-size:${s.size}pt` : "",
        s.color ? `color:${s.color}` : "", s.bg ? `background:${s.bg}` : "",
        `text-align:${s.align ?? (typeof (cell?.f ? res?.value : cell?.v) === "number" ? "right" : "left")}`,
        s.valign ? `vertical-align:${s.valign}` : "",
        s.wrap ? "white-space:normal" : "white-space:nowrap",
        edge(s.borders?.top) ? `border-top:${edge(s.borders?.top)}` : "",
        edge(s.borders?.bottom) ? `border-bottom:${edge(s.borders?.bottom)}` : "",
        edge(s.borders?.left) ? `border-left:${edge(s.borders?.left)}` : "",
        edge(s.borders?.right) ? `border-right:${edge(s.borders?.right)}` : "",
      ].filter(Boolean).join(";");
      const span = m ? ` colspan="${m.c2 - m.c1 + 1}" rowspan="${m.r2 - m.r1 + 1}"` : "";
      tds.push(`<td${span} style="${css}">${esc(text)}</td>`);
    }
    rows.push(`<tr style="height:${(sheet.rowHeights?.[r] ?? 26) * 0.75}pt">${tds.join("")}</tr>`);
  }
  const colgroup = Array.from({ length: rng.c2 - rng.c1 + 1 }, (_, i) => {
    const c = rng.c1 + i;
    return hiddenC.has(c) ? "" : `<col style="width:${Math.round((sheet.colWidths?.[c] ?? 100) * 0.75)}pt">`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(opts.title ?? sheet.name)}</title>
<style>
@page { size: ${opts.orientation ?? "portrait"}; margin: 0.6in }
body { font-family: Inter, Calibri, Arial, sans-serif; font-size: 10pt; color: #26221F }
table { border-collapse: collapse; ${opts.fitWidth ? "width:100%;table-layout:fixed" : ""} }
td { padding: 2px 6px; overflow: hidden }
h1 { font-size: 14pt; margin: 0 0 10px }
</style></head><body>
<h1>${esc(opts.title ?? sheet.name)}</h1>
<table><colgroup>${colgroup}</colgroup>${rows.join("\n")}</table>
<script>window.onload = () => { window.print(); }<\/script>
</body></html>`;
}

/** Open the sheet in a print window → user picks printer or Save-as-PDF. */
export function printSheet(sheet: SheetData, wb: Workbook | undefined, opts: PrintOpts = {}) {
  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) return;
  w.document.write(sheetToPrintHTML(sheet, wb, opts));
  w.document.close();
}

// ---------- PivotTables (S10.1) ----------

import type { PivotSpec } from "./model";
import { displayValue } from "./engine";

type Agg = PivotSpec["vals"][number]["agg"];

const aggregate = (vals: number[], agg: Agg): number => {
  if (!vals.length) return agg === "count" ? 0 : 0;
  switch (agg) {
    case "sum": return vals.reduce((a, b) => a + b, 0);
    case "count": return vals.length;
    case "avg": return vals.reduce((a, b) => a + b, 0) / vals.length;
    case "min": return Math.min(...vals);
    case "max": return Math.max(...vals);
  }
};

const AGG_LABEL: Record<Agg, string> = { sum: "Sum", count: "Count", avg: "Average", min: "Min", max: "Max" };

/**
 * Compute a pivot table's output cells. Layout (anchored at spec.at):
 *   [row field headers…] [col-key headers…] [Grand Total]
 *   [row key…]           [aggregates…]      [row total]
 *   [Grand Total]        [col totals…]      [grand total]
 * With multiple val fields and no col fields, each val gets its own column;
 * with col fields, columns are (colKey × valField) combos.
 * Returns the cell map + span, or null if the spec/source is invalid.
 */
export function buildPivotCells(
  wb: Workbook,
  host: SheetData,
  spec: PivotSpec,
): { cells: Record<string, CellData>; rows: number; cols: number } | null {
  const at = parseA1(spec.at);
  if (!at) return null;
  // resolve source sheet — qualified "Sheet!A1:D10" or unqualified (host)
  let src = spec.src;
  let srcSheet = host;
  const bang = src.indexOf("!");
  if (bang >= 0) {
    const name = src.slice(0, bang).replace(/^'|'$/g, "").replace(/''/g, "'");
    srcSheet = wb.sheets.find((s) => s.name === name) ?? host;
    src = src.slice(bang + 1);
  }
  const range = parseRange(src);
  if (!range) return null;
  const evals = evalsFor(srcSheet, wb);
  const cellText = (c: number, r: number): string => {
    const ref = toA1(c, r);
    const cell = srcSheet.cells[ref];
    return cell?.f ? displayValue(evals.get(ref), cell) : cell?.v == null ? "" : String(cell.v);
  };
  const cellNum = (c: number, r: number): number | null => {
    const ref = toA1(c, r);
    const cell = srcSheet.cells[ref];
    const v = cell?.f ? evals.get(ref)?.value : cell?.v;
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return Number.isFinite(n) ? (n as number) : null;
  };
  // fields from header row
  const fields: string[] = [];
  for (let c = range.c1; c <= range.c2; c++) fields.push(cellText(c, range.r1) || `Col ${c - range.c1 + 1}`);
  const fieldIdx = (name: string) => fields.indexOf(name);
  const rowIdx = spec.rows.map(fieldIdx).filter((i) => i >= 0);
  const colIdx = spec.cols.map(fieldIdx).filter((i) => i >= 0);
  const valIdx = spec.vals.map((v) => ({ ...v, i: fieldIdx(v.field) })).filter((v) => v.i >= 0);
  if (!valIdx.length || (!rowIdx.length && !colIdx.length)) return null;

  // gather data rows
  type Group = Map<string, { key: string[]; vals: number[][] }>;
  const rowGroups: Group = new Map();   // rowTuple -> per-val-field numbers
  const colGroups: Group = new Map();
  const cellGroups = new Map<string, Map<string, number[][]>>(); // rowKey -> colKey -> numbers
  for (let r = range.r1 + 1; r <= range.r2; r++) {
    const rk = rowIdx.map((i) => cellText(range.c1 + i, r));
    const ck = colIdx.map((i) => cellText(range.c1 + i, r));
    const nums = valIdx.map((v) => cellNum(range.c1 + v.i, r)).map((n) => (n == null ? [] : [n]));
    const rKey = rk.join("\x01");
    const cKey = ck.join("\x01");
    if (!rowGroups.has(rKey)) rowGroups.set(rKey, { key: rk, vals: valIdx.map(() => []) });
    if (!colGroups.has(cKey)) colGroups.set(cKey, { key: ck, vals: valIdx.map(() => []) });
    if (!cellGroups.has(rKey)) cellGroups.set(rKey, new Map());
    const cg = cellGroups.get(rKey)!;
    if (!cg.has(cKey)) cg.set(cKey, valIdx.map(() => []));
    const rg = rowGroups.get(rKey)!, cgv = cg.get(cKey)!, gg = colGroups.get(cKey)!;
    nums.forEach((ns, i) => { rg.vals[i].push(...ns); cgv[i].push(...ns); gg.vals[i].push(...ns); });
  }
  const rowKeys = [...rowGroups.values()].sort((a, b) => a.key.join("").localeCompare(b.key.join("")));
  const colKeys = [...colGroups.values()].sort((a, b) => a.key.join("").localeCompare(b.key.join("")));

  const H: CellData["s"] = { b: true, bg: "#E8E4DE" };
  const TOT: CellData["s"] = { b: true, bg: "#F4F1EC" };
  const out: Record<string, CellData> = {};
  const put = (dr: number, dc: number, cell: CellData) => { out[toA1(at.col + dc, at.row + dr)] = cell; };

  const nRowHdr = Math.max(rowIdx.length, 1);
  // data columns: colFields ? colKey × vals : vals
  const dataCols: { label: string; ck: string | null; vi: number }[] = [];
  if (colIdx.length)
    for (const ck of colKeys) for (let vi = 0; vi < valIdx.length; vi++)
      dataCols.push({ label: `${ck.key.join(" / ")} — ${AGG_LABEL[valIdx[vi].agg]} ${valIdx[vi].field}`, ck: ck.key.join("\x01"), vi });
  else
    for (let vi = 0; vi < valIdx.length; vi++)
      dataCols.push({ label: `${AGG_LABEL[valIdx[vi].agg]} ${valIdx[vi].field}`, ck: null, vi });

  // header row: row-field names | data col labels | Grand Total
  spec.rows.forEach((f, i) => put(0, i, { v: f, s: H }));
  if (!rowIdx.length) put(0, 0, { v: "", s: H });
  dataCols.forEach((d, i) => put(0, nRowHdr + i, { v: d.label, s: H }));
  put(0, nRowHdr + dataCols.length, { v: "Grand Total", s: H });

  // data rows
  rowKeys.forEach((rk, ri) => {
    rk.key.forEach((part, i) => {
      // blank repeated outer keys (Excel-style nesting)
      const repeat = ri > 0 && rowKeys[ri - 1].key.slice(0, i + 1).join("\x01") === rk.key.slice(0, i + 1).join("\x01");
      put(1 + ri, i, { v: repeat ? "" : part, s: i === rk.key.length - 1 ? undefined : { b: true } });
    });
    const rowKey = rk.key.join("\x01");
    dataCols.forEach((d, i) => {
      const grp = d.ck == null ? rowGroups.get(rowKey)!.vals[d.vi] : cellGroups.get(rowKey)?.get(d.ck)?.[d.vi] ?? [];
      put(1 + ri, nRowHdr + i, { v: grp.length ? aggregate(grp, valIdx[d.vi].agg) : "" });
    });
    // row grand total = first val field aggregated over the whole row group
    put(1 + ri, nRowHdr + dataCols.length,
      { v: aggregate(rowGroups.get(rowKey)!.vals[0], valIdx[0].agg), s: TOT });
  });

  // grand total row
  const gtRow = 1 + rowKeys.length;
  put(gtRow, 0, { v: "Grand Total", s: TOT });
  dataCols.forEach((d, i) => {
    const vals = d.ck == null
      ? [...rowGroups.values()].flatMap((g) => g.vals[d.vi])
      : colGroups.get(d.ck)!.vals[d.vi];
    put(gtRow, nRowHdr + i, { v: vals.length ? aggregate(vals, valIdx[d.vi].agg) : "", s: TOT });
  });
  const all = [...rowGroups.values()].flatMap((g) => g.vals[0]);
  put(gtRow, nRowHdr + dataCols.length, { v: aggregate(all, valIdx[0].agg), s: TOT });

  return { cells: out, rows: gtRow + 1, cols: nRowHdr + dataCols.length + 1 };
}

// ---------- Goal Seek (S10.2) ----------

/**
 * Find x such that evalTarget(x) ≈ goal. Hybrid secant/bisection, ~60 iters.
 * evalTarget returns the target cell's numeric value for a candidate input,
 * or null/NaN when unevaluable. Returns the input value or null.
 */
export function solveGoalSeek(evalTarget: (x: number) => number | null, goal: number, guess = 0): number | null {
  const f = (x: number) => {
    const v = evalTarget(x);
    return v == null || !Number.isFinite(v) ? null : v - goal;
  };
  let x0 = guess, x1 = guess === 0 ? 1 : guess * 1.01 + 0.01;
  let f0 = f(x0), f1 = f(x1);
  if (f0 === null && f1 === null) return null;
  for (let i = 0; i < 60; i++) {
    if (f0 !== null && Math.abs(f0) < 1e-7) return x0;
    if (f1 !== null && Math.abs(f1) < 1e-7) return x1;
    if (f0 !== null && f1 !== null && f1 !== f0) {
      const x2 = x1 - (f1 * (x1 - x0)) / (f1 - f0);
      const f2 = f(x2);
      x0 = x1; f0 = f1; x1 = x2; f1 = f2;
    } else {
      // bisection fallback — widen the bracket
      const span = Math.abs(x1 - x0) || 1;
      const cands = [x1 + span, x1 - span, x1 * 2, x1 / 2, x1 + span * 4, x1 - span * 4];
      let found = false;
      for (const c of cands) {
        const fc = f(c);
        if (fc === null) continue;
        if (f1 !== null && fc * f1 < 0) { x0 = x1; f0 = f1; x1 = c; f1 = fc; found = true; break; }
        if (f0 !== null && f0 * fc < 0) { x1 = c; f1 = fc; found = true; break; }
      }
      if (!found) { x1 += span; f1 = f(x1); }
    }
    if (Math.abs(x1 - x0) < 1e-10 && f1 !== null && Math.abs(f1) < 1e-6) return x1;
  }
  return f1 !== null && Math.abs(f1) < 1e-4 ? x1 : null;
}

// ---------- S11.6 error-checking rules ----------

export interface ErrorFinding {
  ref: string;
  rule: "error" | "inconsistent" | "numAsText" | "unprotectedFormula";
  msg: string;
}

/** Scan a sheet for Excel-style green-triangle conditions. Needs the sheet's
 *  evaluated results to spot error values; structural rules work on cells. */
export function errorCheck(
  sheet: SheetData, evals: Map<string, EvalResult>, protectedSheet = false,
): ErrorFinding[] {
  const out: ErrorFinding[] = [];
  const cells = sheet.cells;
  for (const [ref, cell] of Object.entries(cells)) {
    const res = evals.get(ref);
    if (res?.error) {
      out.push({ ref, rule: "error", msg: `Cell evaluates to ${res.error}` });
      continue;
    }
    // number stored as text
    if (!cell.f && typeof cell.v === "string" && /^-?\d+(\.\d+)?$/.test(cell.v.trim()))
      out.push({ ref, rule: "numAsText", msg: "Number stored as text" });
    // formula on protected sheet that isn't in an allow-range
    if (protectedSheet && cell.f)
      out.push({ ref, rule: "unprotectedFormula", msg: "Formula cell is locked on a protected sheet" });
  }
  // inconsistent formula: same column, formula cell whose R1C1 form differs
  // from both vertical neighbors (when both neighbors agree with each other)
  const byCol = new Map<number, { row: number; ref: string; r1c1: string }[]>();
  for (const [ref, cell] of Object.entries(cells)) {
    if (!cell.f) continue;
    const p = parseA1(ref); if (!p) continue;
    const list = byCol.get(p.col) ?? [];
    list.push({ row: p.row, ref, r1c1: toR1C1(cell.f, ref) });
    byCol.set(p.col, list);
  }
  for (const list of byCol.values()) {
    list.sort((a, b) => a.row - b.row);
    for (let i = 1; i < list.length - 1; i++) {
      const [prev, cur, next] = [list[i - 1], list[i], list[i + 1]];
      if (prev.row === cur.row - 1 && next.row === cur.row + 1
        && prev.r1c1 === next.r1c1 && cur.r1c1 !== prev.r1c1)
        out.push({ ref: cur.ref, rule: "inconsistent", msg: "Inconsistent formula — differs from cells above and below" });
    }
  }
  return out.sort((a, b) => {
    const pa = parseA1(a.ref)!, pb = parseA1(b.ref)!;
    return pa.row - pb.row || pa.col - pb.col;
  });
}

// ---------- S12.6: flash fill + go-to-special + column autocomplete ----------

/** Infer a transform from one (example → source row values) pair.
 *  Returns a function applying the same transform to other rows, or null. */
export function flashFillTemplate(src: string[], example: string): ((vals: string[]) => string | null) | null {
  const ex = example.trim();
  type T = (v: string[]) => string | null;
  const cands: T[] = [];
  for (let i = 0; i < src.length; i++) {
    const s = src[i];
    if (s === ex) cands.push((v) => v[i] ?? null);
    if (s.toUpperCase() === ex && s !== ex) cands.push((v) => v[i]?.toUpperCase() ?? null);
    if (s.toLowerCase() === ex && s !== ex) cands.push((v) => v[i]?.toLowerCase() ?? null);
    if (s.split(/\s+/)[0] === ex && s.includes(" "))
      cands.push((v) => v[i]?.split(/\s+/)[0] ?? null);
    if (s.split(/\s+/).at(-1) === ex && s.includes(" "))
      cands.push((v) => v[i]?.split(/\s+/).at(-1) ?? null);
    const dm = s.match(/\d+/);
    if (dm && dm[0] === ex && s !== ex)
      cands.push((v) => v[i]?.match(/\d+/)?.[0] ?? null);
    if (s.startsWith(ex) && s.length > ex.length) {
      const n = ex.length;
      cands.push((v) => v[i]?.length > n ? v[i].slice(0, n) : null);
    }
    if (s.endsWith(ex) && s.length > ex.length) {
      const n = ex.length;
      cands.push((v) => v[i]?.length > n ? v[i].slice(-n) : null);
    }
    // concat of two fields with a separator
    for (let k = 0; k < src.length; k++) {
      if (k === i) continue;
      for (const sep of [" ", "_", "-", ".", ", ", ""]) {
        if (s + sep + src[k] === ex)
          cands.push((v) => v[i] !== undefined && v[k] !== undefined ? v[i] + sep + v[k] : null);
        if (src[k] + sep + s === ex)
          cands.push((v) => v[i] !== undefined && v[k] !== undefined ? v[k] + sep + v[i] : null);
      }
    }
  }
  return cands[0] ?? null;
}

/** Go To Special — return refs matching a class within `range`. */
export function goToSpecial(
  sheet: SheetData, evals: Map<string, EvalResult>, range: { c1: number; r1: number; c2: number; r2: number },
  kind: "blanks" | "formulas" | "constants" | "errors" | "notes",
): string[] {
  const out: string[] = [];
  for (const ref of rangeRefs(range)) {
    const cell = sheet.cells[ref];
    switch (kind) {
      case "blanks": if (!cell || (cell.v === undefined && !cell.f)) out.push(ref); break;
      case "formulas": if (cell?.f) out.push(ref); break;
      case "constants": if (cell && !cell.f && cell.v !== undefined && cell.v !== null && cell.v !== "") out.push(ref); break;
      case "errors": if (evals.get(ref)?.error) out.push(ref); break;
      case "notes": if (sheet.notes?.[ref]) out.push(ref); break;
    }
  }
  return out;
}

/** Distinct text values already present in a column (for autocomplete). */
export function columnSuggestions(sheet: SheetData, col: number, limit = 8): string[] {
  const seen = new Set<string>();
  for (const [ref, cell] of Object.entries(sheet.cells)) {
    const p = parseA1(ref);
    if (!p || p.col !== col || cell.f) continue;
    if (typeof cell.v === "string" && cell.v.trim() !== "") seen.add(cell.v);
    if (seen.size >= 200) break;
  }
  return [...seen].slice(0, limit);
}

// ---------- S12.3: subtotal insertion ----------

const SUBTOTAL_LABEL: Record<number, string> = {
  1: "Average", 2: "Count", 3: "Count", 4: "Max", 5: "Min",
  6: "Product", 9: "Sum", 10: "Var", 11: "VarP",
};

/** Insert SUBTOTAL rows at each change of the key column's value inside
 *  `range`, and outline-group the member rows. Operates bottom-up so row
 *  inserts don't disturb later boundaries. */
export function applySubtotals(
  sheet: SheetData, wb: Workbook, range: Range, keyCol: number, fnCode: number, aggCols: number[],
): void {
  const ev = evaluateSheetIn(wb, sheet.name);
  const val = (r: number, c: number) => {
    const cell = sheet.cells[toA1(c, r)];
    return cell?.f ? ev.get(toA1(c, r))?.value : cell?.v;
  };
  // group boundaries: contiguous runs of equal key value
  const groups: [number, number][] = [];
  let start = range.r1, prev = val(range.r1, keyCol);
  for (let r = range.r1 + 1; r <= range.r2 + 1; r++) {
    const k = r <= range.r2 ? val(r, keyCol) : Symbol("end");
    if (k !== prev) { groups.push([start, r - 1]); start = r; prev = k; }
  }
  // bottom-up so inserts don't shift earlier boundaries
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const [gs, ge] = groups[gi];
    adjustForRowsCols(sheet, "row", ge + 1, 1, wb);
    const keyText = String(val(ge, keyCol) ?? "");
    sheet.cells[toA1(keyCol, ge + 1)] = { v: `${keyText} ${SUBTOTAL_LABEL[fnCode] ?? "Total"}`, s: { b: true } };
    for (const c of aggCols) {
      const rng = `${toA1(c, gs)}:${toA1(c, ge)}`;
      sheet.cells[toA1(c, ge + 1)] = { f: `SUBTOTAL(${fnCode},${rng})`, s: { b: true } };
    }
    // outline-group the member rows
    sheet.outlineRows = { ...(sheet.outlineRows ?? {}) };
    for (let r = gs; r <= ge; r++) sheet.outlineRows[r] = 1;
  }
  // grand total row at the very bottom
  const end = range.r2 + groups.length;
  adjustForRowsCols(sheet, "row", end + 1, 1, wb);
  sheet.cells[toA1(keyCol, end + 1)] = { v: "Grand Total", s: { b: true } };
  for (const c of aggCols) {
    const rng = `${toA1(c, range.r1)}:${toA1(c, end)}`;
    sheet.cells[toA1(c, end + 1)] = { f: `SUBTOTAL(${fnCode},${rng})`, s: { b: true } };
  }
}

// ---------- S12.2: slicers ----------

/** Rows hidden by slicer selections — each slicer keeps rows whose value in
 *  its column is in `sel`. Applies over the autofilter range (or table range,
 *  or used range) covering the slicer's column. */
export function slicerHiddenRows(sheet: SheetData, wb: Workbook): number[] {
  if (!sheet.slicers?.length) return [];
  const ev = evalsFor(sheet, wb);
  const hidden = new Set<number>();
  for (const sl of sheet.slicers) {
    if (!sl.sel.length) continue; // nothing selected = show all
    // data extent: autofilter range if it covers the col, else table, else used range
    let r1 = 0, r2 = -1;
    const fr = sheet.filter ? parseRange(sheet.filter.range) : null;
    const tr = (sheet.tables ?? []).map((t) => parseRange(t.range)).find((r) => r && sl.col >= r.c1 && sl.col <= r.c2);
    if (fr && sl.col >= fr.c1 && sl.col <= fr.c2) { r1 = fr.r1 + 1; r2 = fr.r2; }
    else if (tr) { r1 = tr.r1 + 1; r2 = tr.r2; }
    else {
      for (const ref of Object.keys(sheet.cells)) {
        const p = parseA1(ref); if (!p) continue;
        r2 = Math.max(r2, p.row);
      }
    }
    for (let r = r1; r <= r2; r++) {
      const ref = toA1(sl.col, r);
      const cell = sheet.cells[ref];
      const v = cell?.f ? ev.get(ref)?.value : cell?.v;
      if (!sl.sel.includes(String(v ?? ""))) hidden.add(r);
    }
  }
  return [...hidden];
}

/** Distinct display values in a column over the data extent (for slicer lists). */
export function slicerValues(sheet: SheetData, wb: Workbook, col: number): string[] {
  const fr = sheet.filter ? parseRange(sheet.filter.range) : null;
  const tr = (sheet.tables ?? []).map((t) => parseRange(t.range)).find((r) => r && col >= r.c1 && col <= r.c2);
  let r1 = 0, r2 = 0;
  if (fr && col >= fr.c1 && col <= fr.c2) { r1 = fr.r1 + 1; r2 = fr.r2; }
  else if (tr) { r1 = tr.r1 + 1; r2 = tr.r2; }
  else { for (const ref of Object.keys(sheet.cells)) { const p = parseA1(ref); if (p) r2 = Math.max(r2, p.row); } }
  const ev = evalsFor(sheet, wb);
  const seen = new Set<string>();
  for (let r = r1; r <= r2; r++) {
    const ref = toA1(col, r);
    const cell = sheet.cells[ref];
    seen.add(String((cell?.f ? ev.get(ref)?.value : cell?.v) ?? ""));
  }
  return [...seen];
}
