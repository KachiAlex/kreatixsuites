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
  align?: "left" | "center" | "right" | "justify" | "distributed" | "fill" | "centerAcross";
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
  /** S17.2 — pasted/inserted image (data URL) rendered inside the cell */
  img?: string;
  /** S18.1 — rich data type (stock/geography-style entity). Formulas read
   *  fields via `A1.Prop`; the cell displays `name` with a kind glyph. */
  ent?: { kind: string; name: string; props: Record<string, unknown> };
  /** S19.1 — hyperlink target: absolute URL or internal "#Sheet!A1" ref */
  link?: string;
  /** S19.10 — in-cell rich text: styled runs that concatenate to `v`.
   *  Only valid when `v` is a plain string; formulas/formatting ignore it. */
  rt?: RichRun[];
}

/** A run of cell text with an optional style override (S19.10). */
export interface RichRun { t: string; s?: Partial<CellStyle>; }

/** Canonical key for a run style — ignores empty/unset values so
 *  {b:true} merges cleanly with {} and {u:false}. */
export function richStyleKey(s?: Partial<CellStyle>): string {
  const e = Object.entries(s ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== false && v !== "")
    .sort(([a], [b]) => a.localeCompare(b));
  return e.length ? JSON.stringify(e) : "";
}
const cleanStyle = (s: Partial<CellStyle>): Partial<CellStyle> | undefined =>
  richStyleKey(s) ? s : undefined;

/** Apply `style` to the [from,to) char range of `text`, given existing
 *  `runs` (may be undefined). Splits runs at the boundaries, overlays the
 *  style (a false/"" value deletes that property), merges same-style
 *  neighbours. Returns undefined when everything ends unstyled — callers
 *  should then drop `rt` to keep the cell lean. */
export function richStyleRuns(
  text: string, runs: RichRun[] | undefined,
  from: number, to: number, style: Partial<CellStyle>,
): RichRun[] | undefined {
  const base: RichRun[] = runs?.length && runs.map((r) => r.t).join("") === text
    ? runs.map((r) => ({ t: r.t, s: r.s ? { ...r.s } : undefined }))
    : [{ t: text }];
  const lo = Math.max(0, from), hi = Math.min(text.length, to);
  const out: RichRun[] = [];
  let pos = 0;
  for (const r of base) {
    const len = r.t.length;
    // split points of this run relative to the absolute [lo,hi) window
    const c0 = Math.max(0, Math.min(len, lo - pos));
    const c1 = Math.max(c0, Math.min(len, hi - pos));
    for (const [a, b, styled] of [[0, c0, false], [c0, c1, true], [c1, len, false]] as const) {
      if (b <= a) continue;
      const merged = styled
        ? cleanStyle({ ...(r.s ?? {}), ...Object.fromEntries(
            Object.entries(style).map(([k, v]) => [k, v === false || v === "" || v === undefined
              ? undefined : v])),
          })
        : r.s;
      out.push({ t: r.t.slice(a, b), s: merged });
    }
    pos += len;
  }
  // merge adjacent runs with identical styles
  const merged: RichRun[] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && richStyleKey(last.s) === richStyleKey(r.s)) last.t += r.t;
    else merged.push(r);
  }
  return merged.some((r) => r.s) ? merged : undefined;
}

/** True when the runs exactly represent `text` (guard for stale rt). */
export const richRunsMatch = (rt: RichRun[] | undefined, v: unknown): rt is RichRun[] =>
  !!rt?.length && typeof v === "string" && rt.map((r) => r.t).join("") === v;

/** Re-map runs across a text edit: finds the common prefix/suffix between
 *  the old and new text and carries run styles across; the inserted/changed
 *  middle inherits the style at the edit point (Excel extends the run the
 *  caret sits in). Returns undefined when the runs don't match `oldText`. */
export function richRunsForEdit(oldText: string, rt: RichRun[] | undefined, newText: string): RichRun[] | undefined {
  if (!richRunsMatch(rt, oldText)) return undefined;
  let p = 0;
  const maxP = Math.min(oldText.length, newText.length);
  while (p < maxP && oldText.charCodeAt(p) === newText.charCodeAt(p)) p++;
  let s = 0;
  const maxS = Math.min(oldText.length - p, newText.length - p);
  while (s < maxS && oldText.charCodeAt(oldText.length - 1 - s) === newText.charCodeAt(newText.length - 1 - s)) s++;
  // style at the edit point — the run containing char p-1 falls back to p
  let insStyle: Partial<CellStyle> | undefined;
  {
    let pos = 0;
    for (const r of rt) {
      if (p > 0 ? pos <= p - 1 && p - 1 < pos + r.t.length : p < pos + r.t.length) { insStyle = r.s; break; }
      pos += r.t.length;
    }
  }
  const out: RichRun[] = [];
  let pos = 0;
  for (const r of rt) {
    const a = pos, b = pos + r.t.length;
    // prefix slice ∩ [0,p) — same chars in the new text
    if (a < p) out.push({ t: r.t.slice(0, Math.min(r.t.length, p - a)), s: r.s });
    // suffix slice ∩ [oldLen-s, oldLen) → maps to newLen-s
    const sufFrom = Math.max(a, oldText.length - s);
    if (sufFrom < b) {
      const off = newText.length - oldText.length;
      out.push({ t: newText.slice(sufFrom + off, b + off), s: r.s });
    }
    pos = b;
  }
  const mid = newText.slice(p, newText.length - s);
  // find insertion index: after the prefix runs
  let idx = 0, acc = 0;
  while (idx < out.length && acc + out[idx].t.length <= p) { acc += out[idx].t.length; idx++; }
  if (mid) out.splice(idx, 0, { t: mid, s: insStyle });
  // merge same-style neighbours
  const merged: RichRun[] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (r.t === "") continue;
    if (last && richStyleKey(last.s) === richStyleKey(r.s)) last.t += r.t;
    else merged.push(r);
  }
  return merged.length && merged.some((r) => r.s) ? merged : undefined;
}

/** S19.1 — floating object layered over the grid (images for now; the
 *  shape is deliberately extensible to text boxes later). Coordinates are
 *  px offsets from the grid's top-left (below the headers). */
export interface SheetObject {
  id: string;
  kind: "image";
  /** data URL or external image URL */
  src: string;
  x: number; y: number; w: number; h: number;
  name?: string;
  /** alt text for accessibility */
  alt?: string;
}

/** S19.6 — a named what-if scenario: cell snapshots applied on demand.
 *  `cells` maps A1 refs to the values they should take when shown. */
export interface Scenario {
  name: string;
  cells: Record<string, string | number | boolean | null>;
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
  type: "bar" | "line" | "pie" | "area" | "scatter" | "stacked" | "combo" | "doughnut"
    | "waterfall" | "funnel" | "histogram" | "treemap" | "radar" | "stock" | "boxwhisker";
  range: string;
  /** S13.4 — index into sheet.pivots; the chart's data range follows the
   *  pivot's materialized span (header + data cells, totals excluded) */
  pivot?: number;
  title?: string;
  xTitle?: string;
  yTitle?: string;
  legend?: "bottom" | "right" | "none";
  dataLabels?: boolean;
  /** S14.2 — overlays */
  trendline?: "linear" | "exponential" | null;
  /** per-point error bars: "stddev" (series SD) or a fixed ± amount */
  errorBars?: "stddev" | number;
  /** series index rendered against a secondary (right) axis */
  axis2?: number;
  /** y-axis bounds override */
  yMin?: number;
  yMax?: number;
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
  /** Slicers (S12.2) — interactive per-column filters; `col` is absolute,
   *  applies to the filter/table data range containing it */
  slicers?: { col: number; title: string; sel: string[] }[];
  /** Table objects (S5.4) */
  tables?: TableSpec[];
  /** in-cell sparklines: ref → spec (S7.3) */
  sparklines?: Record<string, Sparkline>;
  /** Outline grouping (S12.3) — index → nesting level (1-based).
   *  Collapsed lists hold the LAST row/col index of each collapsed group. */
  outlineRows?: Record<number, number>;
  outlineCols?: Record<number, number>;
  collapsedRows?: number[];
  collapsedCols?: number[];
  /** pivot tables (S10.1) — output materialized into cells */
  pivots?: PivotSpec[];
  /** S16.1 — row index where a horizontal split begins; grid renders two
   *  independently-scrolled panes above/below this row */
  splitRow?: number;
  /** sheet protection (S9.2): locked cells except `allowRanges` */
  protected?: boolean;
  /** S15.2 — entries may be plain ranges (everyone may edit) or scoped to
   *  user ids/emails and/or roles */
  allowRanges?: (string | AllowRange)[];
  /** S15.3 — record changes into `changeLog` for accept/reject review */
  trackChanges?: boolean;
  changeLog?: { ref: string; prev?: CellData; next?: CellData; by?: string; at: number }[];
  /** S19.1 — floating objects layered over the grid */
  objects?: SheetObject[];
  /** S19.6 — what-if scenarios */
  scenarios?: Scenario[];
  /** S19.16 — threaded cell comments (discussion-style, alongside `notes`) */
  comments?: Record<string, CommentThread>;
}

/** S19.16 — a comment thread anchored to a cell. */
export interface CommentThread {
  by?: string;
  at: number;
  resolved?: boolean;
  replies: { by?: string; at: number; text: string }[];
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

/** PivotTable spec (S10.1) — output is materialized into cells at `at`;
 *  `span` records the last-written output extent so refresh can clear it. */
export interface PivotSpec {
  /** source range incl. header row, e.g. "A1:D100" (may be qualified) */
  src: string;
  /** output anchor cell, e.g. "F2" */
  at: string;
  /** row-area fields (header names), outermost first */
  rows: string[];
  /** column-area fields */
  cols: string[];
  /** value fields + aggregation; `showAs` post-processes the aggregate
   *  (S13.2): % of grand/col/row total, running total, difference vs base */
  vals: {
    field: string; agg: "sum" | "count" | "avg" | "min" | "max";
    showAs?: "value" | "%total" | "%col" | "%row" | "running" | "diff";
    base?: string;
  }[];
  /** report-filter area (S13.1) — keep only rows where field ∈ sel */
  filters?: { field: string; sel: string[] }[];
  /** calculated fields (S13.2) — per-source-row expression over field names */
  calcFields?: { name: string; formula: string }[];
  /** key grouping (S13.3) — bucket a field's values before aggregation */
  groups?: { field: string; kind: "month" | "quarter" | "year" | "num"; size?: number }[];
  /** refresh materialized output when the workbook opens */
  refreshOnOpen?: boolean;
  /** last materialized extent {rows, cols} — cleared on refresh/move */
  span?: { r: number; c: number };
}

export interface Workbook {
  sheets: SheetData[];
  /** Named ranges: "TaxRate" → "Sheet1!$B$2" or "Sheet1!$B$2:$D$2" */
  names?: Record<string, string>;
  /** Workbook properties (S8.4) — exported to XLSX/ODS docProps */
  props?: { title?: string; subject?: string; author?: string; company?: string; keywords?: string };
  /** Print/page setup (S8.3 + S16.2) */
  print?: {
    orientation?: "portrait" | "landscape"; area?: string; gridlines?: boolean; fitWidth?: boolean;
    /** rows repeated on every page, e.g. "1:2" (1-based row numbers) */
    titleRows?: string;
    /** cols repeated on every page, e.g. "A:A" */
    titleCols?: string;
    /** header/footer text — &P = page, &N = pages, &D = date, &T = title */
    header?: string; footer?: string;
    /** print scale percent (10–400); overrides fitWidth when set */
    scale?: number;
  };
  /** Calculation options (S11.5): manual mode defers recompute until F9/Calc-Now;
   *  iterative allows intentional circular references to converge. */
  calc?: {
    mode?: "auto" | "manual" | "autoNoTables";
    iterative?: boolean;
    maxIterations?: number;
    maxChange?: number;
  };
  /** S15.1 — lock workbook structure (no sheet add/remove/rename/reorder) */
  protectStructure?: boolean;
  /** S15.1 — SHA-256 hex of the open password; gate the editor until unlocked */
  passwordHash?: string;
  /** S17.3 — external-workbook value cache: file name → last-fetched workbook */
  externs?: Record<string, Workbook>;
  /** S16.1 — named custom views: per-sheet display snapshots */
  views?: {
    name: string;
    sheet: string;
    state: {
      hiddenRows?: number[]; hiddenCols?: number[];
      freeze?: { rows: number; cols: number }; splitRow?: number;
      zoom?: number;
    };
  }[];
  /** S18.2 — saved Office Scripts-style automation scripts */
  scripts?: { name: string; code: string }[];
  /** S18.3 — Get & Transform queries (connect → transform → load) */
  queries?: QuerySpec[];
}

export type QueryStep =
  | { op: "filter"; col: number; cmp: "=" | "!=" | ">" | "<" | ">=" | "<=" | "contains" | "starts"; value: string }
  | { op: "keepCols"; cols: number[] }
  | { op: "dropCols"; cols: number[] }
  | { op: "rename"; col: number; name: string }
  | { op: "sort"; col: number; dir: 1 | -1 }
  | { op: "skip"; n: number }
  | { op: "take"; n: number }
  | { op: "distinct" }
  | { op: "groupBy"; col: number; agg: "sum" | "count" | "avg" | "min" | "max"; valCol: number }
  | { op: "cast"; col: number; to: "number" | "text" | "bool" };

export interface QuerySpec {
  name: string;
  source: { kind: "csv" | "tsv" | "json"; text?: string; url?: string; jsonPath?: string };
  steps: QueryStep[];
  /** sheet name to load results into (created/replaced) */
  destSheet?: string;
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

/** Rows/cols hidden by collapsed outline groups. `collapsedRows` entries are
 *  the index of a group's LAST member row; members are the contiguous rows
 *  at-or-before that index sharing its level. */
export function outlineHidden(sheet: SheetData, axis: "row" | "col"): number[] {
  const lv = axis === "row" ? sheet.outlineRows : sheet.outlineCols;
  const collapsed = axis === "row" ? sheet.collapsedRows : sheet.collapsedCols;
  if (!lv || !collapsed?.length) return [];
  const hidden = new Set<number>();
  for (const end of collapsed) {
    const lvl = lv[end] ?? 1;
    for (let i = end; i >= 0 && (lv[i] ?? 0) >= lvl; i--) hidden.add(i);
  }
  return [...hidden];
}

/** Toggle a collapse marker — `end` is the last member index of a group. */
export function toggleOutline(sheet: SheetData, axis: "row" | "col", end: number): void {
  const key = axis === "row" ? "collapsedRows" : "collapsedCols";
  const cur = new Set(sheet[key] ?? []);
  if (cur.has(end)) cur.delete(end); else cur.add(end);
  sheet[key] = cur.size ? [...cur].sort((a, b) => a - b) : undefined;
}

/** Per-user/per-role editable range inside a protected sheet (S15.2). */
export interface AllowRange {
  range: string;
  /** user ids or emails permitted to edit; omit = anyone */
  users?: string[];
  /** user roles permitted to edit; omit = any role */
  roles?: string[];
}

/** Protected-sheet check: locked unless the ref sits in a range the user may edit. */
export function cellLocked(sheet: SheetData, ref: string, user?: { id?: string; email?: string; role?: string } | null): boolean {
  if (!sheet.protected) return false;
  const p = parseA1(ref);
  if (!p) return false;
  return !(sheet.allowRanges ?? []).some((entry) => {
    const ar: AllowRange = typeof entry === "string" ? { range: entry } : entry;
    const rr = parseRange(ar.range);
    if (!rr || p.col < rr.c1 || p.col > rr.c2 || p.row < rr.r1 || p.row > rr.r2) return false;
    if (!ar.users && !ar.roles) return true;
    if (!user) return false;
    if (ar.roles?.includes(user.role ?? "")) return true;
    return !!ar.users?.includes(user.id ?? "") || !!ar.users?.includes(user.email ?? "");
  });
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

/** S12.4 — insert/delete cells inside `zone`, shifting the rest of the
 *  column-band down/right (insert) or up/left (delete). Formulas anywhere
 *  in the sheet that reference moved cells get remapped; references into a
 *  deleted zone become #REF!. Merges intersecting the zone are dropped. */
export function shiftCells(
  sheet: SheetData, zone: Range, dir: "down" | "right" | "up" | "left",
): void {
  const h = zone.c2 - zone.c1 + 1, v = zone.r2 - zone.r1 + 1;
  const dC = dir === "right" ? h : dir === "left" ? -h : 0;
  const dR = dir === "down" ? v : dir === "up" ? -v : 0;
  const inZone = (p: Ref) =>
    p.col >= zone.c1 && p.col <= zone.c2 && p.row >= zone.r1 && p.row <= zone.r2;
  const vertical = dir === "down" || dir === "up";
  // does an original position sit in the band that physically moved?
  const moves = (p: Ref): boolean =>
    vertical ? p.col >= zone.c1 && p.col <= zone.c2 && p.row >= zone.r1
             : p.row >= zone.r1 && p.row <= zone.r2 && p.col >= zone.c1;
  const ins = dir === "down" || dir === "right";
  const next: Record<string, CellData> = {};
  for (const [ref, cell] of Object.entries(sheet.cells)) {
    const p = parseA1(ref);
    if (!p) { next[ref] = cell; continue; }
    if (!ins && inZone(p)) continue; // inside deleted zone
    if (moves(p)) {
      const np = { col: p.col + dC, row: p.row + dR };
      if (np.col >= 0 && np.row >= 0) next[toA1(np.col, np.row)] = cell;
    } else next[ref] = cell;
  }
  // remap formula refs pointing at positions that moved (or were deleted)
  const remap = (f: string): string =>
    f.split(/("[^"]*")/).map((seg, i) => i % 2 ? seg : seg.replace(
      /((?:'[^']+'|[A-Za-z_][\w.]*)!)?(\$?)([A-Za-z]{1,3})(\$?)(\d+)/g,
      (m, q, ca, cl, ra, rs) => {
        if (q && q !== `'${sheet.name}'!` && q !== `${sheet.name}!`) return m;
        const p = { col: colIndex(cl.toUpperCase()), row: parseInt(rs, 10) - 1 };
        if (!ins && inZone(p)) return "#REF!";
        if (!moves(p)) return m;
        const np = { col: p.col + dC, row: p.row + dR };
        if (np.col < 0 || np.row < 0) return "#REF!";
        return `${q ?? ""}${ca}${colLabel(np.col)}${ra}${np.row + 1}`;
      })).join("");
  for (const cell of Object.values(next)) if (cell.f) cell.f = remap(cell.f);
  sheet.cells = next;
  // merges fully inside the moved band shift with it; partial overlaps drop
  sheet.merges = (sheet.merges ?? []).flatMap((m) => {
    const inside = ins
      ? (vertical ? m.c1 >= zone.c1 && m.c2 <= zone.c2 && m.r1 >= zone.r1
                  : m.r1 >= zone.r1 && m.r2 <= zone.r2 && m.c1 >= zone.c1)
      : (vertical ? m.c1 >= zone.c1 && m.c2 <= zone.c2 && m.r1 > zone.r2
                  : m.r1 >= zone.r1 && m.r2 <= zone.r2 && m.c1 > zone.c2);
    if (inside) {
      const nm = { c1: m.c1 + dC, c2: m.c2 + dC, r1: m.r1 + dR, r2: m.r2 + dR };
      return nm.c1 >= 0 && nm.r1 >= 0 ? [nm] : [];
    }
    const overlaps = !(m.c2 < zone.c1 || m.c1 > zone.c2 || m.r2 < zone.r1 || m.r1 > zone.r2);
    return overlaps ? [] : [m];
  });
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

  // pivot tables: output anchor follows the cell map; src range shifts too
  for (const pv of sheet.pivots ?? []) {
    const p = parseA1(pv.at);
    const np = p && map(p);
    if (np) pv.at = toA1(np.col, np.row);
    const nr = shiftRangeA1(pv.src, map);
    if (nr) pv.src = nr;
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
