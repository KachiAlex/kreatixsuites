import type * as XLSX from "xlsx";
import type { CellData, SheetData, Workbook } from "./model";
import { toA1, parseA1, rangeRefs, parseRange } from "./model";
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
    return { name, cells };
  });
  return { sheets: sheets.length ? sheets : [{ name: "Sheet1", cells: {} }] };
}

// ---------- clipboard TSV (copy/paste, KBS-SHARED-013) ----------

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
