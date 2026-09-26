// Kreatix Sheets — workbook data model (stored as file content JSON)

export interface CellStyle {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  color?: string;
  bg?: string;
  align?: "left" | "center" | "right";
  fmt?: string;
}

/** v = literal value, f = formula (without '='), s = style */
export interface CellData {
  v?: string | number | boolean | null;
  f?: string;
  s?: CellStyle;
}

export interface CondFormat {
  range: string;
  op: ">" | "<" | ">=" | "<=" | "=" | "!=";
  value: number;
  bg: string;
}

export interface ChartSpec {
  id: string;
  type: "bar" | "line" | "pie" | "area";
  range: string;
  title?: string;
  x: number;
  y: number;
}

export interface SheetData {
  name: string;
  cells: Record<string, CellData>;
  cf?: CondFormat[];
  charts?: ChartSpec[];
  freeze?: { rows: number; cols: number };
  colWidths?: Record<number, number>;
}

export interface Workbook {
  sheets: SheetData[];
}

export interface Ref { col: number; row: number }
export interface Range { c1: number; r1: number; c2: number; r2: number }

export const ROW_H = 26;
export const COL_W = 100;
export const HEADER_W = 42;

export function colLabel(n: number): string {
  let s = "";
  n += 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function colIndex(label: string): number {
  let n = 0;
  for (const ch of label.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export const toA1 = (c: number, r: number) => `${colLabel(c)}${r + 1}`;

export function parseA1(ref: string): Ref | null {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref.trim());
  if (!m) return null;
  return { col: colIndex(m[1]), row: Number(m[2]) - 1 };
}

export function parseRange(ref: string): Range | null {
  const parts = ref.split(":");
  if (parts.length === 1) {
    const a = parseA1(parts[0]);
    return a ? { c1: a.col, r1: a.row, c2: a.col, r2: a.row } : null;
  }
  const a = parseA1(parts[0]);
  const b = parseA1(parts[1]);
  if (!a || !b) return null;
  return {
    c1: Math.min(a.col, b.col), r1: Math.min(a.row, b.row),
    c2: Math.max(a.col, b.col), r2: Math.max(a.row, b.row),
  };
}

export function rangeToA1(r: Range): string {
  return r.c1 === r.c2 && r.r1 === r.r2 ? toA1(r.c1, r.r1) : `${toA1(r.c1, r.r1)}:${toA1(r.c2, r.r2)}`;
}

export function* rangeRefs(r: Range): Generator<string> {
  for (let row = r.r1; row <= r.r2; row++)
    for (let col = r.c1; col <= r.c2; col++) yield toA1(col, row);
}

/** Interpret typed input: numbers, booleans, percent, formula, else text */
export function parseInput(raw: string): CellData {
  const t = raw.trim();
  if (t === "") return {};
  if (t.startsWith("=")) return { f: t.slice(1) };
  if (/^-?[\d,]*\.?\d+%$/.test(t)) return { v: Number(t.replace(/[%,]/g, "")) / 100 };
  if (/^-?[\d,]*\.?\d+$/.test(t)) return { v: Number(t.replace(/,/g, "")) };
  if (/^(true|false)$/i.test(t)) return { v: /^t/i.test(t) };
  return { v: raw };
}

/** Raw text shown when a cell is being edited */
export function cellEditText(c: CellData | undefined): string {
  if (!c) return "";
  if (c.f) return `=${c.f}`;
  return c.v === null || c.v === undefined ? "" : String(c.v);
}
