// Kreatix Sheets — workbook data model (stored as file content JSON)

export interface BorderEdge {
  /** px width: 1 hairline, 2 medium, 3 thick */
  w?: 1 | 2 | 3;
  style?: "solid" | "dashed" | "dotted" | "double";
  color?: string;
}

export interface CellStyle {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  st?: boolean;          // strikethrough
  font?: string;         // font family
  size?: number;         // pt
  color?: string;
  bg?: string;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  wrap?: boolean;
  indent?: number;       // 0-15 (each ≈ 1ch * 2)
  shrink?: boolean;      // shrink to fit
  rotate?: number;       // degrees, -90..90 (or 90 vertical-stack handled as 90)
  fmt?: string;          // preset id or custom format code (S4.5)
  borders?: { top?: BorderEdge; right?: BorderEdge; bottom?: BorderEdge; left?: BorderEdge };
}

/** v = literal value, f = formula (without '='), s = style */
export interface CellData {
  v?: string | number | boolean | null;
  f?: string;
  s?: CellStyle;
  /** change stamp — last writer (S9.2 change-history markup) */
  h?: { by: string; at: number };
}

export interface CondFormat {
  range: string;
  /** default "value" — legacy {op,value,bg} threshold rules keep working */
  type?: "value" | "text" | "topn" | "formula" | "databar" | "colorscale" | "iconset";
  op?: ">" | "<" | ">=" | "<=" | "=" | "!=";
  value?: number;
  bg?: string;
  /** type "text": match the displayed text */
  textOp?: "contains" | "notcontains" | "starts" | "ends" | "=";
  text?: string;
  /** type "topn": top (or bottom) N values */
  n?: number;
  bottom?: boolean;
  /** type "formula": refs relative to range top-left, shifted per cell */
  f?: string;
  /** type "databar": bar fill color */
  bar?: string;
  /** type "colorscale": 2- or 3-stop scale (midColor optional) */
  minColor?: string;
  midColor?: string;
  maxColor?: string;
  /** type "iconset" */
  icons?: "arrows" | "traffic" | "stars";
}

export interface ChartSpec {
  id: string;
  type: "bar" | "line" | "pie" | "area" | "scatter" | "stacked" | "combo" | "doughnut";
  range: string;
  title?: string;
  xTitle?: string;
  yTitle?: string;
  legend?: "bottom" | "right" | "none";
  dataLabels?: boolean;
  x: number;
  y: number;
}

/** In-cell mini chart (S7.3): rendered inside the target cell. */
export interface Sparkline {
  range: string;
  type: "line" | "bar" | "winloss";
  color?: string;
}

/** Data validation rule applied to a range (S3.4). */
export interface Validation {
  range: string;
  type: "list" | "number" | "date" | "text_len" | "any";
  /** list: "a,b,c" literal or "=Sheet!A1:A5" / "A1:A5" / named range */
  list?: string;
  /** comparison for number/date/text_len */
  op?: "between" | "notbetween" | ">" | "<" | ">=" | "<=" | "=" | "!=";
  min?: string;
  max?: string;
  inputMsg?: string;
  errorMsg?: string;
  errorStyle?: "stop" | "warn";
  /** if set, validation violations are allowed but flagged */
  showInvalid?: boolean;
}

export interface SheetData {
  name: string;
  cells: Record<string, CellData>;
  cf?: CondFormat[];
  charts?: ChartSpec[];
  merges?: Range[];
  freeze?: { rows: number; cols: number };
  colWidths?: Record<number, number>;
  rowHeights?: Record<number, number>;
  hiddenRows?: number[];
  hiddenCols?: number[];
  hidden?: boolean;
  tabColor?: string;
  validations?: Validation[];
  /** non-threaded cell notes (S3.5): ref → text */
  notes?: Record<string, string>;
  /** AutoFilter: dropdown criteria per column in `range` (header row = range.r1) */
  filter?: {
    range: string;
    /** col index → criterion */
    cols: Record<number, FilterCrit>;
  };
  /** rows currently hidden by the active filter (recomputed on apply/data change) */
  filteredRows?: number[];
  /** Table objects (S5.4) */
  tables?: TableSpec[];
  /** in-cell sparklines: ref → spec (S7.3) */
  sparklines?: Record<string, Sparkline>;
  /** sheet protection (S9.2): locked cells except `allowRanges` */
  protected?: boolean;
  allowRanges?: string[];
}

export interface FilterCrit {
  type: "values" | "cond";
  /** values mode: set of shown display values */
  values?: string[];
  /** cond mode: comparison ops */
  op1?: string;
  v1?: string;
  op2?: string;
  v2?: string;
  and?: boolean;
}

export interface TableSpec {
  name: string;
  range: string;
  style?: "plain" | "banded" | "accent" | "dark";
  /** render a totals row below the range; per-col aggregation */
  totals?: Record<number, "sum" | "avg" | "count" | "min" | "max" | "none">;
}

export interface Workbook {
  sheets: SheetData[];
  /** Named ranges: "TaxRate" → "Sheet1!$B$2" or "Sheet1!$B$2:$D$2" */
  names?: Record<string, string>;
  /** Workbook properties (S8.4) — exported to XLSX/ODS docProps */
  props?: { title?: string; subject?: string; author?: string; company?: string; keywords?: string };
  /** Print/page setup (S8.3) */
  print?: { orientation?: "portrait" | "landscape"; area?: string; gridlines?: boolean; fitWidth?: boolean };
}

export interface Ref { col: number; row: number }
export interface Range { c1: number; r1: number; c2: number; r2: number }

/** Validations covering a ref. */
/** Is `ref` inside any of the given A1 ranges? */
export function refInRanges(ref: string, ranges: string[]): boolean {
  const p = parseA1(ref);
  if (!p) return false;
  return ranges.some((r) => {
    const rr = parseRange(r);
    return !!rr && p.col >= rr.c1 && p.col <= rr.c2 && p.row >= rr.r1 && p.row <= rr.r2;
  });
}

/** Protected-sheet check: locked unless the ref sits in an allowed range. */
export function cellLocked(sheet: SheetData, ref: string): boolean {
  return !!sheet.protected && !refInRanges(ref, sheet.allowRanges ?? []);
}

export function validationsAt(sheet: SheetData, ref: string): Validation[] {
  const p = parseA1(ref);
  if (!p) return [];
  return (sheet.validations ?? []).filter((v) => {
    const r = parseRange(v.range);
    return !!r && p.col >= r.c1 && p.col <= r.c2 && p.row >= r.r1 && p.row <= r.r2;
  });
}

/** Check a stored value against a rule. Blanks always pass (Excel's
 *  "ignore blank" default). `list` = resolved items for type "list". */
export function validateValue(v: CellData["v"] | undefined, val: Validation, list?: string[] | null): boolean {
  if (v === null || v === undefined || v === "") return true;
  const num = (s: string | undefined) => (s === undefined || s === "" ? NaN : Number(s));
  const cmp = (n: number, a: number, b: number): boolean => {
    switch (val.op ?? "between") {
      case "between": return n >= a && n <= b;
      case "notbetween": return !(n >= a && n <= b);
      case ">": return n > a;
      case "<": return n < a;
      case ">=": return n >= a;
      case "<=": return n <= a;
      case "=": return n === a;
      case "!=": return n !== a;
    }
  };
  switch (val.type) {
    case "list":
      return !!list && list.some((i) => i.toLowerCase() === String(v).toLowerCase());
    case "number": {
      const n = Number(v);
      return !isNaN(n) && cmp(n, num(val.min), num(val.max));
    }
    case "date": {
      const t = Date.parse(String(v));
      if (isNaN(t)) return false;
      const a = val.min ? Date.parse(val.min) : NaN;
      const b = val.max ? Date.parse(val.max) : NaN;
      return cmp(t, a, b);
    }
    case "text_len":
      return cmp(String(v).length, num(val.min), num(val.max));
    default:
      return true;
  }
}

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

// ---------- named ranges ----------

/** Excel rules: letter/_/\ start, then letters/digits/._; must not look
 *  like a cell ref (A1, R1C1) or be a bare R/C. */
export function validRangeName(name: string): string | null {
  if (!/^[A-Za-z_\\][A-Za-z0-9_.\\]*$/.test(name)) return "Names must start with a letter or _ and contain only letters, digits, _ .";
  if (/^[A-Za-z]{1,3}\d{1,7}$/.test(name) || /^[RrCc]$/.test(name) || /^[Rr]\d+[Cc]\d+$/.test(name))
    return "That name looks like a cell reference";
  if (name.length > 255) return "Name too long";
  return null;
}

/** Validate a refers-to string like `Sheet1!$B$2` or `A1:C3`. */
export function validNameRef(ref: string, wb: Workbook): string | null {
  const m = ref.trim().match(/^(?:(?:'([^']+)'|([A-Za-z_][\w.]*))!)?(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)$/);
  if (!m) return "Enter a range like Sheet1!A1:B2";
  const sheet = m[1] ?? m[2];
  if (sheet && !wb.sheets.some((s) => s.name.toLowerCase() === sheet.toLowerCase()))
    return `No sheet named ${sheet}`;
  return null;
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

// ---------- merges ----------

export function mergeAt(merges: Range[] | undefined, c: number, r: number): Range | undefined {
  return merges?.find((m) => c >= m.c1 && c <= m.c2 && r >= m.r1 && r <= m.r2);
}

// ---------- formula reference translation ----------

export interface ParsedRef { col: number; row: number; colAbs: boolean; rowAbs: boolean }

const QUALIFIED_RE = /(?:'[^']+'|[A-Za-z_][\w.]*)!\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?/g;

/**
 * Rewrite every A1-style reference in a formula through `map`.
 * Returning null marks the ref as deleted -> "#REF!".
 * `$` flags are preserved; the map decides whether anchored axes shift.
 * Sheet-qualified refs (Sheet2!A1) are left untouched — shifting those is the
 * job of the sheet that owns them (see adjustForRowsCols).
 */
export function translateFormula(
  f: string,
  map: (r: ParsedRef) => { col: number; row: number } | null,
  opts?: { qualified?: boolean },
): string {
  const stashed: string[] = [];
  const tmp = f.replace(QUALIFIED_RE, (tok) => {
    let out = tok;
    if (opts?.qualified) {
      // fill-handle semantics: the sheet name stays, the ref part shifts
      const m = tok.match(/^(?:'[^']+'|[A-Za-z_][\w.]*)!(.+)$/);
      if (m) {
        const head = tok.slice(0, tok.length - m[1].length);
        const mapped = m[1].split(":").map((raw) => {
          const rm = raw.match(/^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/);
          if (!rm) return raw;
          const p = map({ col: colIndex(rm[2]), row: Number(rm[4]) - 1, colAbs: !!rm[1], rowAbs: !!rm[3] });
          return p === null ? "#REF!" : `${rm[1]}${colLabel(p.col)}${rm[3]}${p.row + 1}`;
        }).join(":");
        out = head + mapped;
      }
    }
    stashed.push(out);
    return `\x00${stashed.length - 1}\x00`;
  });
  const shifted = tmp.replace(
    /(?<![A-Za-z0-9_$!.\x00])(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?!\d)(?!\s*\()/g,
    (_m, dc: string, cl: string, dr: string, rn: string) => {
      const out = map({ col: colIndex(cl), row: Number(rn) - 1, colAbs: !!dc, rowAbs: !!dr });
      return out === null ? "#REF!" : `${dc}${colLabel(out.col)}${dr}${out.row + 1}`;
    },
  );
  return shifted.replace(/\x00(\d+)\x00/g, (_m, i) => stashed[Number(i)]);
}

/** Rewrite qualified refs to `sheetName` through `map` (other sheets' formulas
 *  that point into the sheet whose rows/cols moved). */
export function translateQualifiedRefs(
  f: string,
  sheetName: string,
  map: (p: { col: number; row: number }) => { col: number; row: number } | null,
): string {
  return f.replace(QUALIFIED_RE, (tok) => {
    const m = tok.match(/^(?:'([^']+)'|([A-Za-z_][\w.]*))!(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)$/);
    if (!m) return tok;
    const name = m[1] ?? m[2];
    if (name.toLowerCase() !== sheetName.toLowerCase()) return tok;
    const [a, b] = m[3].split(":");
    const pa = parseA1(a); const pb = b ? parseA1(b) : pa;
    if (!pa || !pb) return tok;
    const na = map({ col: pa.col, row: pa.row });
    const nb = map({ col: pb.col, row: pb.row });
    const q = name.includes(" ") ? `'${name}'` : name;
    if (!na || !nb) return `${q}!#REF!`;
    const emit = (raw: string, p: { col: number; row: number }) =>
      `${raw.startsWith("$") ? "$" : ""}${colLabel(p.col)}${/\$\d/.test(raw) ? "$" : ""}${p.row + 1}`;
    const ref = na.col === nb.col && na.row === nb.row ? emit(a, na) : `${emit(a, na)}:${emit(b, nb)}`;
    return `${q}!${ref}`;
  });
}

/** Rename a sheet — rewrites `Old!`/`'Old'!` refs in every formula. */
export function renameSheetRefs(wb: Workbook, oldName: string, newName: string): void {
  const q = newName.includes(" ") || /^\d/.test(newName) ? `'${newName}'` : newName;
  for (const s of wb.sheets) {
    for (const cell of Object.values(s.cells)) {
      if (!cell.f) continue;
      cell.f = cell.f.replace(/(?:'([^']+)'|([A-Za-z_][\w.]*))!/g, (m, qs, ps) =>
        (qs ?? ps).toLowerCase() === oldName.toLowerCase() ? `${q}!` : m);
    }
  }
  if (wb.names) {
    for (const k of Object.keys(wb.names)) {
      wb.names[k] = wb.names[k].replace(/^(?:'([^']+)'|([A-Za-z_][\w.]*))!/i,
        (m, qs, ps) => ((qs ?? ps) as string).toLowerCase() === oldName.toLowerCase() ? `${q}!` : m);
    }
  }
}

/** Fill-handle semantics: relative axes shift, `$`-anchored axes stay.
 *  Qualified refs shift their ref part too (Excel does this on fill). */
export function shiftForFill(f: string, dCol: number, dRow: number): string {
  return translateFormula(f, (r) => ({
    col: r.colAbs ? r.col : Math.max(0, r.col + dCol),
    row: r.rowAbs ? r.row : Math.max(0, r.row + dRow),
  }), { qualified: true });
}

function axisShift(axis: "row" | "col", at: number, count: number, band: "insert" | "delete") {
  return (p: { col: number; row: number }): { col: number; row: number } | null => {
    const pos = axis === "row" ? p.row : p.col;
    if (band === "insert") {
      return pos >= at ? { ...p, [axis]: pos + count } : p;
    }
    if (pos >= at && pos < at - count) return null; // inside deleted band
    return pos >= at - count ? { ...p, [axis]: pos + count } : p;
  };
}

function shiftRangeA1(rangeA1: string, map: (p: { col: number; row: number }) => { col: number; row: number } | null): string | null {
  const [a, b] = rangeA1.split(":");
  const pa = parseA1(a); const pb = b ? parseA1(b) : pa;
  if (!pa || !pb) return rangeA1;
  const na = map(pa); const nb = map(pb);
  if (!na || !nb) return null;
  return na.col === nb.col && na.row === nb.row ? toA1(na.col, na.row) : `${toA1(na.col, na.row)}:${toA1(nb.col, nb.row)}`;
}

/**
 * Insert (count > 0) or delete (count < 0) whole rows/cols at index `at`
 * in one sheet. Moves cells, rewrites formula refs (deleted-band refs
 * become #REF!) — including `Sheet!A1` refs in OTHER sheets — and shifts
 * merges / conditional-format ranges / chart ranges.
 */
export function adjustForRowsCols(sheet: SheetData, axis: "row" | "col", at: number, count: number,
  wb?: Workbook): void {
  const band = count > 0 ? "insert" : "delete";
  const map = axisShift(axis, at, count, band);
  const mapRef = (p: { col: number; row: number }) => map(p);

  const cells: Record<string, CellData> = {};
  for (const [ref, cell] of Object.entries(sheet.cells)) {
    const p = parseA1(ref)!;
    const np = map(p);
    if (np) cells[toA1(np.col, np.row)] = cell;
  }
  sheet.cells = cells;

  for (const cell of Object.values(sheet.cells)) {
    if (cell.f) cell.f = translateFormula(cell.f, (r) => map({ col: r.col, row: r.row }));
  }

  // qualified refs anywhere in the workbook pointing into this sheet
  // (including self-qualified refs like =S2!A1 inside S2)
  if (wb) {
    for (const s of wb.sheets) {
      for (const cell of Object.values(s.cells)) {
        if (cell.f) cell.f = translateQualifiedRefs(cell.f, sheet.name, mapRef);
      }
    }
  }

  sheet.merges = (sheet.merges ?? [])
    .map((m) => {
      const a = map({ col: m.c1, row: m.r1 });
      const b = map({ col: m.c2, row: m.r2 });
      if (!a || !b) return null;
      return { c1: Math.min(a.col, b.col), r1: Math.min(a.row, b.row), c2: Math.max(a.col, b.col), r2: Math.max(a.row, b.row) };
    })
    .filter((m): m is Range => !!m);

  sheet.cf = (sheet.cf ?? [])
    .map((r) => {
      const nr = shiftRangeA1(r.range, map);
      return nr ? { ...r, range: nr } : null;
    })
    .filter((r): r is CondFormat => !!r);

  for (const ch of sheet.charts ?? []) {
    const nr = shiftRangeA1(ch.range, map);
    if (nr) ch.range = nr;
  }

  // width/height/hidden indexes shift along the changed axis
  const remap = <T,>(rec: Record<number, T> | undefined, ax: "row" | "col"): Record<number, T> | undefined => {
    if (!rec || ax !== axis) return rec;
    const out: Record<number, T> = {};
    for (const [k, v] of Object.entries(rec)) {
      const i = Number(k);
      const p = map(axis === "row" ? { col: 0, row: i } : { col: i, row: 0 });
      if (p) out[axis === "row" ? p.row : p.col] = v;
    }
    return out;
  };
  sheet.colWidths = remap(sheet.colWidths, "col");
  sheet.rowHeights = remap(sheet.rowHeights, "row");
  const remapList = (list: number[] | undefined, ax: "row" | "col"): number[] | undefined => {
    if (!list || ax !== axis) return list;
    const out: number[] = [];
    for (const i of list) {
      const p = map(axis === "row" ? { col: 0, row: i } : { col: i, row: 0 });
      if (p) out.push(axis === "row" ? p.row : p.col);
    }
    return out.length ? out : undefined;
  };
  sheet.hiddenRows = remapList(sheet.hiddenRows, "row");
  sheet.hiddenCols = remapList(sheet.hiddenCols, "col");

  // notes follow their cells
  if (sheet.notes) {
    const notes: Record<string, string> = {};
    for (const [ref, text] of Object.entries(sheet.notes)) {
      const p = parseA1(ref);
      const np = p && map(p);
      if (np) notes[toA1(np.col, np.row)] = text;
    }
    sheet.notes = notes;
  }
  // sparklines follow their host cells; their source ranges shift too
  if (sheet.sparklines) {
    const sp: Record<string, Sparkline> = {};
    for (const [ref, spec] of Object.entries(sheet.sparklines)) {
      const p = parseA1(ref);
      const np = p && map(p);
      if (np) sp[toA1(np.col, np.row)] = { ...spec, range: shiftRangeA1(spec.range, map) ?? spec.range };
    }
    sheet.sparklines = sp;
  }
  // validation ranges shift too
  sheet.validations = (sheet.validations ?? [])
    .map((v) => {
      const nr = shiftRangeA1(v.range, map);
      return nr ? { ...v, range: nr } : null;
    })
    .filter((v): v is Validation => !!v);

  // autofilter: range shifts; col-keyed criteria shift on col edits; drop if range breaks
  if (sheet.filter) {
    const nr = shiftRangeA1(sheet.filter.range, map);
    if (!nr) sheet.filter = undefined;
    else {
      sheet.filter = { ...sheet.filter, range: nr, cols: { ...sheet.filter.cols } };
      if (axis === "col") {
        const cols: Record<number, FilterCrit> = {};
        for (const [k, v] of Object.entries(sheet.filter.cols)) {
          const p = map({ col: Number(k), row: 0 });
          if (p) cols[p.col] = v;
        }
        sheet.filter.cols = cols;
      }
    }
  }
  sheet.filteredRows = axis === "row" ? remapList(sheet.filteredRows, "row") : sheet.filteredRows;

  // table ranges shift too
  for (const t of sheet.tables ?? []) {
    const nr = shiftRangeA1(t.range, map);
    if (nr) t.range = nr;
    if (axis === "col" && t.totals) {
      const totals: NonNullable<TableSpec["totals"]> = {};
      for (const [k, v] of Object.entries(t.totals)) {
        const p = map({ col: Number(k), row: 0 });
        if (p) totals[p.col] = v;
      }
      t.totals = totals;
    }
  }
}

// ---------- fill series detection (S3.3) ----------

export type Series =
  | { kind: "num"; v0: number; step: number }
  | { kind: "text"; prefix: string; n0: number; step: number; pad: number }
  | { kind: "date"; t0: number; stepMs: number; fmt: "iso" | "slash" }
  | { kind: "list"; items: string[]; i0: number };

const MONTHS_S = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_L = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS_S = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAYS_L = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const LISTS = [MONTHS_S, MONTHS_L, DAYS_S, DAYS_L];

function parseDateStr(v: unknown): { t: number; fmt: "iso" | "slash" } | null {
  if (typeof v !== "string") return null;
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return { t: Date.UTC(+iso[1], +iso[2] - 1, +iso[3]), fmt: "iso" };
  const sl = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (sl) return { t: Date.UTC(+sl[3], +sl[1] - 1, +sl[2]), fmt: "slash" };
  return null;
}

/** Detect an auto-fill series from seed values (numbers, dates, "Item1" text, month/day names). */
export function detectSeries(vals: unknown[]): Series | null {
  const used = vals.filter((v) => v !== null && v !== undefined && v !== "");
  if (!used.length || used.length !== vals.length) return null; // gaps → plain copy
  // numbers
  if (used.every((v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))))) {
    const ns = used.map(Number);
    const step = ns.length > 1 ? (ns[ns.length - 1] - ns[0]) / (ns.length - 1) : 1;
    return { kind: "num", v0: ns[0], step };
  }
  // dates
  const ds = used.map(parseDateStr);
  if (ds.every(Boolean)) {
    const ts = ds.map((d) => d!.t);
    const step = ts.length > 1 ? (ts[ts.length - 1] - ts[0]) / (ts.length - 1) : 86400000;
    return { kind: "date", t0: ts[0], stepMs: step, fmt: ds[0]!.fmt };
  }
  // custom lists (months, days)
  for (const list of LISTS) {
    const i0 = list.findIndex((m) => m.toLowerCase() === String(used[0]).toLowerCase());
    if (i0 >= 0) return { kind: "list", items: list, i0 };
  }
  // text with trailing number: "Item1" → "Item2", "Item3"…
  const ms = used.map((v) => String(v).match(/^(.*?)(\d+)$/));
  if (ms.every(Boolean) && new Set(ms.map((m) => m![1])).size === 1) {
    const ns = ms.map((m) => Number(m![2]));
    const step = ns.length > 1 ? (ns[ns.length - 1] - ns[0]) / (ns.length - 1) : 1;
    return { kind: "text", prefix: ms[0]![1], n0: ns[0], step, pad: ms[0]![2].length };
  }
  return null;
}

export function seriesValue(ser: Series, i: number): CellData["v"] {
  switch (ser.kind) {
    case "num": {
      const n = ser.v0 + ser.step * i;
      return Math.round(n * 1e9) / 1e9;
    }
    case "text":
      return ser.prefix + String(Math.round(ser.n0 + ser.step * i)).padStart(ser.pad, "0");
    case "date": {
      const d = new Date(ser.t0 + ser.stepMs * i);
      const p = (n: number, l = 2) => String(n).padStart(l, "0");
      return ser.fmt === "iso"
        ? `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
        : `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
    }
    case "list":
      return ser.items[((ser.i0 + i) % ser.items.length + ser.items.length) % ser.items.length];
  }
}
