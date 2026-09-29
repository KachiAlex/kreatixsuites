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
  merges?: Range[];
  freeze?: { rows: number; cols: number };
  colWidths?: Record<number, number>;
}

export interface Workbook {
  sheets: SheetData[];
  /** Named ranges: "TaxRate" → "Sheet1!$B$2" or "Sheet1!$B$2:$D$2" */
  names?: Record<string, string>;
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
}
