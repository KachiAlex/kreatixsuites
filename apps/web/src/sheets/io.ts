import type * as XLSX from "xlsx";
import type { CellData, SheetData, Workbook, Validation } from "./model";
import { toA1, parseA1, rangeRefs, parseRange, shiftForFill } from "./model";
import { evaluateSheet, evaluateSheetIn } from "./engine";

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
      const v = cell?.f ? res?.value : cell?.v;
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
  const XLSX = await import("xlsx");
  const out = buildBook(XLSX, wb);
  return XLSX.write(out, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

export async function workbookToXLSX(wb: Workbook, filename: string) {
  const XLSX = await import("xlsx");
  const out = buildBook(XLSX, wb);
  XLSX.writeFile(out, filename.replace(/\.[^.]+$/, "") + ".xlsx");
}

function buildBook(XLSX: typeof import("xlsx"), wb: Workbook) {
  const out = XLSX.utils.book_new();
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
      ws[ref] = x;
    }
    // grid chrome → xlsx: col widths, freeze, merges, autofilter, hidden rows/cols
    if (sheet.colWidths && Object.keys(sheet.colWidths).length)
      ws["!cols"] = Array.from({ length: maxC + 1 }, (_, c) => {
        const w = sheet.colWidths![c];
        const hidden = sheet.hiddenCols?.includes(c);
        return w || hidden ? { wch: Math.max(1, Math.round((w ?? 100) / 9)), hidden } : {};
      });
    if (sheet.rowHeights || sheet.hiddenRows?.length)
      ws["!rows"] = Array.from({ length: maxR + 1 }, (_, r) => {
        const h = sheet.rowHeights?.[r];
        const hidden = sheet.hiddenRows?.includes(r);
        return h || hidden ? { hpt: Math.round((h ?? 26) * 0.75), hidden } : {};
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
  const XLSX = await import("xlsx");
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { cellFormula: true });
  const sheets: SheetData[] = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const cells: Record<string, CellData> = {};
    for (const ref of Object.keys(ws)) {
      if (ref.startsWith("!")) continue;
      const x = ws[ref] as XLSX.CellObject;
      const cell: CellData = {};
      if (x.f) cell.f = x.f;
      if (x.v !== undefined) cell.v = x.v as string | number | boolean;
      if (cell.f || cell.v !== undefined) cells[ref] = cell;
    }
    const sheet: SheetData = { name, cells };
    if (ws["!merges"]?.length)
      sheet.merges = ws["!merges"].map((m) => ({ c1: m.s.c, r1: m.s.r, c2: m.e.c, r2: m.e.r }));
    if (ws["!cols"]) {
      sheet.colWidths = {};
      sheet.hiddenCols = [];
      ws["!cols"].forEach((c, i) => {
        if (c?.wch) sheet.colWidths![i] = Math.round(c.wch * 9);
        if (c?.hidden) sheet.hiddenCols!.push(i);
      });
      if (!sheet.hiddenCols.length) delete sheet.hiddenCols;
    }
    if (ws["!rows"]) {
      sheet.rowHeights = {};
      sheet.hiddenRows = [];
      ws["!rows"].forEach((r, i) => {
        if (r?.hpt) sheet.rowHeights![i] = Math.round(r.hpt / 0.75);
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
