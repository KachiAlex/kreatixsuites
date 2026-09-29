import { Parser } from "hot-formula-parser";
import type { CellData, Workbook, SheetData, Range } from "./model";
import { toA1, parseA1, parseRange, colIndex } from "./model";

export interface EvalResult {
  value: unknown;
  error: string | null;
  /** set on spill-target results — the anchor ref whose formula spilled here */
  spillFrom?: string;
}

/** Dynamic-array spill bookkeeping (S11.1): targets maps each covered ref to
 *  its anchor + offset; blocked marks anchors whose extent hits occupied
 *  cells or another spill. */
interface SpillMaps {
  targets: Map<string, { anchor: string; dr: number; dc: number }>;
  blocked: Set<string>;
}

const MAX_DEPTH = 64;
const err = (e: string): EvalResult => ({ value: null, error: e });

// utf8-safe base64 (storing raw expressions inside string literals)
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const unb64 = (s: string) => decodeURIComponent(escape(atob(s)));

/** Find the end of the first argument of a call starting at `argStart`
 *  (index just past the opening paren). Returns index of the top-level
 *  `,` or `)` that terminates it. */
function firstArgEnd(f: string, argStart: number): number {
  let depth = 0, inQ = false;
  for (let j = argStart; j < f.length; j++) {
    const ch = f[j];
    if (inQ) { if (ch === '"') inQ = false; continue; }
    if (ch === '"') inQ = true;
    else if (ch === "(") depth++;
    else if (ch === ")") { if (depth === 0) return j; depth--; }
    else if (ch === "," && depth === 0) return j;
  }
  return f.length;
}

/** Rewrite a two-arg lazy function `NAME(expr, fallback)` →
 *  `KXNAME("base64(expr)", fallback)` so arg eval errors don't abort. */
function rewriteLazyIf(f: string, name: string): string {
  const tag = `${name}(`;
  let out = "", i = 0;
  const lc = f.toUpperCase();
  while (true) {
    let at = -1;
    for (let k = i; ; ) {
      const hit = lc.indexOf(tag, k);
      if (hit < 0) break;
      // don't match KXNAME( itself or XNAME( as suffix of longer ident
      const prev = hit > 0 ? f[hit - 1] : "";
      if (!/[A-Za-z0-9_.]/.test(prev)) { at = hit; break; }
      k = hit + 1;
    }
    if (at < 0) { out += f.slice(i); break; }
    const argStart = at + tag.length;
    const j = firstArgEnd(f, argStart);
    if (f[j] !== ",") { out += f.slice(i, j); i = j; continue; } // single arg — leave it
    const rawA = f.slice(argStart, j).trim();
    out += f.slice(i, at) + `KX${name}("${b64(rawA)}",`;
    i = j + 1;
  }
  return out;
}

// ---------- formula preprocessing ----------
// hot-formula-parser knows nothing about sheet qualifiers or named ranges.
// Rewrite them into resolvable calls before parsing:
//   Sheet2!A1          → KXREF("Sheet2","A1")
//   'My Sheet'!A1:B2   → KXRANGE("My Sheet","A1","B2")
//   TaxRate            → (A1:B3)   via workbook.names
// Stored formulas keep the original text; rewrite happens per eval only.

/** Rewrite OFFSET(ref,…) → KXOFFSET("sheet","ref",…) — the fn needs the ref
 *  itself, not its evaluated value, so we rewrite before parsing. */
function rewriteOffset(f: string): string {
  let out = "";
  let i = 0;
  const lc = f.toUpperCase();
  while (true) {
    const at = lc.indexOf("OFFSET(", i);
    if (at < 0) { out += f.slice(i); break; }
    const argStart = at + 7;
    // first argument = text up to the first top-level comma
    let depth = 0, j = argStart;
    for (; j < f.length; j++) {
      const ch = f[j];
      if (ch === "(") depth++;
      else if (ch === ")") { if (depth === 0) break; depth--; }
      else if (ch === "," && depth === 0) break;
    }
    const first = f.slice(argStart, j).trim();
    const ref = first.match(/^(?:(?:'([^']+)'|([A-Za-z_][\w.]*))!)?\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/) || first.match(/^(?:'([^']+)'|([A-Za-z_][\w.]*))!/);
    if (!ref || !ref[3]) { out += f.slice(i, j); i = j; continue; }
    const sheet = ref[1] ?? ref[2] ?? "";
    const a1 = `${ref[3]}${ref[4]}`;
    const rng = ref[5] ? `:${ref[5]}${ref[6]}` : "";
    out += f.slice(i, at) + `KXOFFSET("${sheet.replace(/"/g, '""')}","${a1}${rng}"`;
    i = j; // separator/close-paren stays — rest of the call passes through

  }
  return out;
}

/** Rewrite sheet-qualified refs + named ranges for parsing.
 *  Double-quoted segments (string literals) are never touched — so
 *  INDIRECT("Sheet2!A1") keeps its text intact. */
export function preprocessFormula(f: string, names?: Record<string, string>): string {
  // lazy error-catchers first (their arg must stay raw text)
  let pre = rewriteLazyIf(f, "IFERROR");
  pre = rewriteLazyIf(pre, "IFNA");
  // OFFSET first — its ref arg must stay a ref, not a KXREF call
  const withOffset = rewriteOffset(pre);
  const withFxt = rewriteFormulatext(withOffset);
  // name-binding / lambda forms — whole arglist stashed for lazy eval
  let lazy = withFxt;
  for (const nm of ["LET", "MAP", "BYROW", "BYCOL", "MAKEARRAY", "REDUCE", "SCAN", "LAMBDA", "SUBTOTAL"])
    lazy = rewriteCallLazy(lazy, nm);
  // split on "..." literals; rewrite only the plain segments
  const out = lazy.split(/("[^"]*")/).map((seg, i) => {
    if (i % 2 === 1) return seg;
    let s = seg;
    // named ranges first — the substituted ref may itself be sheet-qualified
    // and must be caught by the KXREF rewrite below
    if (names) {
      for (const [nm, ref] of Object.entries(names)) {
        const re = new RegExp(`(?<![A-Za-z0-9_.$!"'])${nm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_.$(!])`, "g");
        s = s.replace(re, `(${ref})`);
      }
    }
    // spill refs — Sheet!A1# → KXSPILLQ, A1# → KXSPILL. Must precede the
    // qualified-ref rewrite so the trailing # isn't orphaned.
    s = s.replace(
      /(?:'([^']+)'|([A-Za-z_][\w.]*))!(\$?[A-Za-z]{1,3}\$?\d+)#|(?<![A-Za-z0-9_$!.])(\$?[A-Za-z]{1,3}\$?\d+)#/g,
      (_m, qs: string | undefined, ps: string | undefined, qref: string, uref: string) =>
        qs !== undefined || ps !== undefined
          ? `KXSPILLQ("${(qs ?? ps)!.replace(/"/g, '""')}","${qref.replace(/\$/g, "")}")`
          : `KXSPILL("${uref.replace(/\$/g, "")}")`,
    );
    // implicit intersection: @[Sheet!]A1[:B2] → KXAT — resolves to the cell
    // sharing the formula's row/column at eval time
    s = s.replace(
      /@(?:'([^']+)'|([A-Za-z_][\w.]*))!(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)|@(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)/g,
      (_m, qs: string | undefined, ps: string | undefined, qref: string, uref: string) =>
        qref !== undefined
          ? `KXAT("${(qs ?? ps)!.replace(/"/g, '""')}","${qref.replace(/\$/g, "")}")`
          : `KXAT("","${uref.replace(/\$/g, "")}")`,
    );
    // structured table refs (S12.1) — T[[#spec],[Col]], T[@C], T[C], T[#spec], [@C]
    s = s.replace(/([A-Za-z_][\w.]*)\[\[([^\[\]]+)\],\[([^\]]+)\]\]/g,
      (_m, t: string, spec: string, col: string) => `KXTBLC("${t}","${spec.trim()}","${col.trim()}")`);
    s = s.replace(/([A-Za-z_][\w.]*)\[@([^\]]+)\]/g,
      (_m, t: string, col: string) => `KXTHIS("${t}","${col.trim()}")`);
    s = s.replace(/([A-Za-z_][\w.]*)\[([^\][@]+)\]/g,
      (_m, t: string, spec: string) => `KXTBL("${t}","${spec.trim()}")`);
    s = s.replace(/(?<![\w$!'\]"])\[@([^\]]+)\]/g,
      (_m, col: string) => `KXTHIS("","${col.trim()}")`);
    // range comparisons broadcast elementwise — B1:B3>10 → KXCMP(...) so
    // FILTER masks and array predicates work like Excel's
    const cmpRe = /((?:'([^']+)'|([A-Za-z_][\w.]*))!)?(\$?[A-Za-z]{1,3}\$?\d+:\$?[A-Za-z]{1,3}\$?\d+)\s*(>=|<=|<>|>|<|=)\s*("[^"]*"|'[^']*'|[^\s,;()]+)/g;
    s = s.replace(cmpRe, (_m, _q: string | undefined, qs: string | undefined, ps: string | undefined, rng: string, op: string, rhs: string) =>
      `KXCMP("${(qs ?? ps ?? "").replace(/"/g, '""')}","${rng.replace(/\$/g, "")}","${op}","${b64(rhs)}")`,
    );
    s = s.replace(
      /(?:'([^']+)'|([A-Za-z_][\w.]*))!\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?/g,
      (_m, qs: string | undefined, ps: string | undefined, c1: string, r1: string, c2?: string, r2?: string) => {
        const sheet = (qs ?? ps)!;
        const ref = `${c1}${r1}`;
        return c2 ? `KXRANGE("${sheet.replace(/"/g, '""')}","${ref}","${c2}${r2}")`
                  : `KXREF("${sheet.replace(/"/g, '""')}","${ref}")`;
      },
    );
    // intersection operator: `A1:B2 B2:C3` → KXINT (Excel's space operator;
    // empty overlap → #NULL!)
    s = s.replace(
      /(?<![\w$.!:'"])([\$]?[A-Za-z]{1,3}[\$]?\d+(?::[\$]?[A-Za-z]{1,3}[\$]?\d+)?)( +)([\$]?[A-Za-z]{1,3}[\$]?\d+(?::[\$]?[A-Za-z]{1,3}[\$]?\d+)?)(?![\w$:(])/g,
      (_m, a: string, _ws: string, b: string) => `KXINT("${a}","${b}")`,
    );
    return s;
  }).join("");
  return out;
}

/** Split a top-level comma-separated arg list (paren/quote aware). */
function splitTopArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, inQ = false, cur = "";
  for (const ch of s) {
    if (inQ) { cur += ch; if (ch === '"') inQ = false; continue; }
    if (ch === '"') { inQ = true; cur += ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim() !== "" || out.length) out.push(cur);
  return out;
}

/** Rewrite CALL(...) → KXNAME("base64(arglist)") — the whole arg list is
 *  stashed as text so the handler can eval args lazily / treat identifiers
 *  as bound names (LET, LAMBDA-helpers). */
function rewriteCallLazy(f: string, name: string): string {
  const tag = `${name}(`;
  let out = "", i = 0;
  const lc = f.toUpperCase();
  while (true) {
    let at = -1;
    for (let k = i; ; ) {
      const hit = lc.indexOf(tag, k);
      if (hit < 0) break;
      const prev = hit > 0 ? f[hit - 1] : "";
      if (!/[A-Za-z0-9_.]/.test(prev)) { at = hit; break; }
      k = hit + 1;
    }
    if (at < 0) { out += f.slice(i); break; }
    const argStart = at + tag.length;
    let depth = 0, inQ = false, j = argStart;
    for (; j < f.length; j++) {
      const ch = f[j];
      if (inQ) { if (ch === '"') inQ = false; continue; }
      if (ch === '"') { inQ = true; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") { if (!depth) break; depth--; }
    }
    if (j >= f.length) { out += f.slice(i); break; }
    out += f.slice(i, at) + `KX${name}("${b64(f.slice(argStart, j))}")`;
    i = j + 1;
  }
  return out;
}

/** FORMULATEXT(ref) needs the formula text, not the value — rewrite to
 *  KXFORMULATEXT("sheet","ref") like OFFSET. */
function rewriteFormulatext(f: string): string {
  let out = "";
  let i = 0;
  const lc = f.toUpperCase();
  while (true) {
    const at = lc.indexOf("FORMULATEXT(", i);
    if (at < 0) { out += f.slice(i); break; }
    const j = firstArgEnd(f, at + 12);
    const first = f.slice(at + 12, j).trim();
    const m = first.match(/^(?:(?:'([^']+)'|([A-Za-z_][\w.]*))!)?\$?([A-Za-z]{1,3})\$?(\d+)$/);
    if (!m) { out += f.slice(i, j); i = j; continue; }
    const sheet = (m[1] ?? m[2] ?? "").replace(/"/g, '""');
    out += f.slice(i, at) + `KXFORMULATEXT("${sheet}","${m[3]}${m[4]}")`;
    i = j + 1;
  }
  return out;
}

/** Sheet-qualified refs in a formula — for rename/insert-delete rewriting. */
export function* sheetRefsOf(f: string): Generator<{ sheet: string; ref: string; span: [number, number] }> {
  for (const m of f.matchAll(/(?:'([^']+)'|([A-Za-z_][\w.]*))!\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?/g)) {
    yield { sheet: m[1] ?? m[2], ref: m[0].split("!")[1], span: [m.index!, m.index! + m[0].length] };
  }
}

// ---------- formula-editor helpers (autocomplete + F4) ----------

/** All refs a formula reads — `{sheet:null}` = same-sheet. For auditing. */
export function refsInFormula(f: string): { sheet: string | null; range: { c1: number; r1: number; c2: number; r2: number } }[] {
  const out: { sheet: string | null; range: { c1: number; r1: number; c2: number; r2: number } }[] = [];
  // strip string literals first
  const noStr = f.replace(/"(?:[^"]|"")*"/g, " ");
  const tmp = noStr.replace(
    /(?:'([^']+)'|([A-Za-z_][\w.]*))!(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)/g,
    (_m, qs: string | undefined, ps: string | undefined, ref: string) => {
      const r = parseRange(ref.replace(/\$/g, ""));
      if (r) out.push({ sheet: qs ?? ps ?? null, range: r });
      return " ";
    },
  );
  for (const m of tmp.matchAll(/(?<![A-Za-z0-9_$!.])(\$?[A-Za-z]{1,3}\$?\d+)(?::(\$?[A-Za-z]{1,3}\$?\d+))?(?![\w$:(])/g)) {
    const r = parseRange(`${m[1]}:${m[2] ?? m[1]}`.replace(/\$/g, ""));
    if (r) out.push({ sheet: null, range: r });
  }
  return out;
}

/** Identifier-ish token immediately left of the caret (for autocomplete). */
export function tokenAtCaret(v: string, caret: number): { start: number; text: string } | null {
  const m = v.slice(0, caret).match(/[A-Za-z_][\w.]*$/);
  return m ? { start: caret - m[0].length, text: m[0] } : null;
}

/** F4 — cycle the ref under/just-left-of the caret through
 *  A1 → $A$1 → A$1 → $A1 → A1. Only fires when the caret is inside or
 *  immediately after a ref token. */
export function cycleAnchors(v: string, caret: number): { text: string; caret: number } | null {
  const re = /(\$?)([A-Za-z]{1,3})(\$?)(\d+)/g;
  for (const m of v.matchAll(re)) {
    const s = m.index!, e = s + m[0].length;
    if (caret < s || caret > e) continue;
    // don't touch fn names, qualified sheet names, or mid-word hits
    if (s > 0 && /[A-Za-z0-9_.$]/.test(v[s - 1])) continue;
    if (v[e] === "(") continue;
    const [, dc, cl, dr, rn] = m;
    const colAbs = !!dc, rowAbs = !!dr;
    const [nc, nr]: [boolean, boolean] =
      !colAbs && !rowAbs ? [true, true] :
      colAbs && rowAbs ? [false, true] :
      !colAbs && rowAbs ? [true, false] : [false, false];
    const rep = `${nc ? "$" : ""}${cl}${nr ? "$" : ""}${rn}`;
    return { text: v.slice(0, s) + rep + v.slice(e), caret: s + rep.length };
  }
  return null;
}

// ---------- extra functions (the Excel set hot-formula-parser lacks) ----------
// Each receives evaluated params (ranges arrive as 2-D arrays).

const flat = (xs: unknown[]): unknown[] =>
  xs.flatMap((x) => Array.isArray(x) ? flat(x) : [x]);

const num = (v: unknown): number | EvalResult => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(String(v).replace(/,/g, ""));
  return isNaN(n) ? err("#VALUE!") : n;
};

const dnum = (v: unknown): number | EvalResult => {
  const n = num(v);
  if (typeof n === "number") return n;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? err("#VALUE!") : Math.round((d.getTime() - Date.UTC(1899, 11, 30)) / 86400000);
};

type Resolver = (sheet: string | null, ref: string) => EvalResult;
type RangeResolver = (sheet: string | null, a: string, b?: string) => unknown[][];

/** Loose equality the way Excel compares lookup keys. */
const sameKey = (a: unknown, b: unknown): boolean => {
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return String(a).toLowerCase() === String(b).toLowerCase();
};

/** Coerce a scalar/flat-array/matrix to a 2-D matrix. */
const asMat = (a: unknown): unknown[][] =>
  Array.isArray(a) ? (Array.isArray(a[0]) ? (a as unknown[][]) : [(a as unknown[][])]) : [[a]];

const transpose = (m: unknown[][]): unknown[][] =>
  m[0]?.map((_, c) => m.map((r) => r[c])) ?? [];

/** Excel ordering for sort: numbers < text (ci) < booleans < blanks/errors. */
const cmpVals = (a: unknown, b: unknown): number => {
  const rank = (v: unknown) =>
    typeof v === "number" ? 0 : typeof v === "string" && v !== "" ? 1
    : typeof v === "boolean" ? 2 : 3;
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "number") return a - (b as number);
  if (typeof a === "string") return a.localeCompare(b as string, undefined, { sensitivity: "base" });
  return 0;
};

/** Excel D-function core: aggregate `field` over db rows matching criteria
 *  headers+rows. Criteria values support ">5", "<>x", plain equality. */
const dbAgg = (p: unknown[], op: string): unknown => {
  const db = asMat(p[0]);
  const headers = db[0] ?? [];
  const rows = db.slice(1);
  let ci: number;
  if (typeof p[1] === "number") ci = p[1] - 1;
  else ci = headers.findIndex((h) => sameKey(h, p[1]));
  if (ci < 0) return "#VALUE!";
  const crit = asMat(p[2]);
  const ch = crit[0] ?? [];
  const critIdx = ch.map((h) => headers.findIndex((x) => sameKey(x, h)));
  const match = (cell: unknown, cond: unknown): boolean => {
    const s = String(cond ?? "");
    const m = s.match(/^(>=|<=|<>|>|<|=)?(.*)$/);
    if (!m || s === "") return true;
    const rhs = m[2], na = Number(cell), nb = Number(rhs);
    const numy = !isNaN(na) && !isNaN(nb) && rhs !== "" && cell !== null && cell !== "";
    switch (m[1] ?? "=") {
      case ">": return numy && na > nb;
      case "<": return numy && na < nb;
      case ">=": return numy && na >= nb;
      case "<=": return numy && na <= nb;
      case "<>": return !sameKey(cell, rhs);
      default: return sameKey(cell, rhs);
    }
  };
  const hits = rows.filter((row) =>
    crit.slice(1).some((cr) =>
      cr.every((cond, k) => critIdx[k] < 0 || match(row[critIdx[k]], cond))));
  const vals = hits.map((r) => r[ci]);
  switch (op) {
    case "sum": return vals.reduce<number>((a, v) => a + (typeof num(v) === "number" ? num(v) as number : 0), 0);
    case "count": return vals.filter((v) => typeof v === "number").length;
    case "counta": return vals.filter((v) => v !== null && v !== "" && v !== undefined).length;
    case "avg": { const ns = vals.map(Number).filter((n) => !isNaN(n)); return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : "#DIV/0!"; }
    case "min": return vals.length ? Math.min(...vals.map(Number)) : 0;
    case "max": return vals.length ? Math.max(...vals.map(Number)) : 0;
    case "get": return hits.length === 1 ? hits[0][ci] : hits.length > 1 ? "#NUM!" : "#VALUE!";
    case "product": return vals.reduce<number>((a, v) => a * Number(v), 1);
    default: return "#VALUE!";
  }
};

/** Least-squares forecast: FORECAST.LINEAR(x, ys, xs). */
const forecastLinear = (p: unknown[]): unknown => {
  const x = Number(p[0]);
  const ys = flat(asMat(p[1])).map(Number), xs = flat(asMat(p[2])).map(Number);
  const n = Math.min(ys.length, xs.length);
  if (!n) return "#DIV/0!";
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  if (!sxx) return "#DIV/0!";
  return my + (sxy / sxx) * (x - mx);
};

/** Build the function pack bound to this workbook's resolvers. */
export function extraFunctions(
  evalRef: Resolver,
  evalRange: RangeResolver,
  ctx: { sheet: string; sheetCount?: number },
): Record<string, (p: unknown[]) => unknown> {
  const lookupArr = (a: unknown): unknown[] => Array.isArray(a) ? flat(a as unknown[]) : [a];

  return {
    NA: () => "#N/A",
    // VLOOKUP(key, table, colIdx [, approx])
    VLOOKUP: (p) => {
      const [lv, table, ci, approx] = p as [unknown, unknown[][], number, unknown];
      if (!Array.isArray(table)) return "#N/A";
      const c = Number(ci);
      if (c < 1 || (table[0] && c > table[0].length)) return "#REF!";
      if (approx === undefined || approx === true || approx === 1) {
        let pick: unknown = "#N/A";
        for (const row of table) { if (Number(row[0]) <= Number(lv) || sameKey(row[0], lv)) pick = row[c - 1]; else break; }
        return pick;
      }
      for (const row of table) if (sameKey(row[0], lv)) return row[c - 1] ?? "#REF!";
      return "#N/A";
    },
    HLOOKUP: (p) => {
      const [lv, table, ri, approx] = p as [unknown, unknown[][], number, unknown];
      if (!Array.isArray(table) || !table.length) return "#N/A";
      const r = Number(ri);
      if (r < 1 || r > table.length) return "#REF!";
      const head = table[0];
      if (approx === undefined || approx === true || approx === 1) {
        let pick: unknown = "#N/A";
        for (let c = 0; c < head.length; c++) { if (Number(head[c]) <= Number(lv) || sameKey(head[c], lv)) pick = table[r - 1][c]; else break; }
        return pick;
      }
      for (let c = 0; c < head.length; c++) if (sameKey(head[c], lv)) return table[r - 1][c] ?? "#REF!";
      return "#N/A";
    },
    // MATCH(key, vector [, type]) → 1-based position
    MATCH: (p) => {
      const [lv, arr, type] = p;
      const vec = lookupArr(arr);
      const t = Number(type ?? 1);
      if (t === 0) { const i = vec.findIndex((v) => sameKey(v, lv)); return i < 0 ? "#N/A" : i + 1; }
      if (t === -1) { const i = vec.findIndex((v) => Number(v) <= Number(lv)); return i < 0 ? "#N/A" : i + 1; }
      let last = -1;
      for (let i = 0; i < vec.length; i++) { if (Number(vec[i]) <= Number(lv)) last = i; else break; }
      return last < 0 ? "#N/A" : last + 1;
    },
    // INDEX(range, row [, col]) — scalar extract
    INDEX: (p) => {
      const [arr, r, c] = p as [unknown[][], number, number?];
      if (!Array.isArray(arr)) return "#VALUE!";
      const row = Number(r) || 0, col = Number(c) || 0;
      if (row && arr[row - 1]) {
        const rw = arr[row - 1];
        return col ? (rw[col - 1] ?? "#REF!") : (rw.length === 1 ? rw[0] : rw);
      }
      if (!row && col) {
        const colArr = arr.map((rw) => rw[col - 1]);
        return colArr.length === 1 ? colArr[0] : colArr;
      }
      return "#REF!";
    },
    // INDIRECT("A1" | "Sheet!A1") — resolve a ref built as text
    INDIRECT: (p) => {
      const s = String(p[0] ?? "");
      const q = s.match(/^(?:'([^']+)'|([A-Za-z_][\w.]*))!(.+)$/);
      const sheet = q ? (q[1] ?? q[2]) : ctx.sheet;
      const ref = (q ? q[3] : s).replace(/\$/g, "").toUpperCase();
      if (ref.includes(":")) {
        const [a, b] = ref.split(":");
        return evalRange(sheet, a, b);
      }
      const r = evalRef(sheet, ref);
      return r.error ?? r.value;
    },
    // OFFSET is rewritten at preprocess time (needs the ref, not its value)
    LOOKUP: (p) => {
      const [lv, arr, res] = p;
      const vec = lookupArr(arr);
      const ret = res === undefined ? vec : lookupArr(res);
      const cmp = typeof lv === "number" ? (a: unknown, b: unknown) => Number(a) - Number(b) : (a: unknown, b: unknown) => String(a).localeCompare(String(b));
      let pick: unknown = "#N/A";
      for (let i = 0; i < vec.length; i++) {
        if (cmp(vec[i], lv) <= 0) pick = ret[Math.min(i, ret.length - 1)];
        else break;
      }
      return pick;
    },
    XLOOKUP: (p) => {
      const [lv, arr, ret, ifna, matchMode] = p;
      const vec = lookupArr(arr), out = lookupArr(ret);
      const mm = Number(matchMode) || 0;
      const isNum = typeof lv === "number";
      for (let i = 0; i < vec.length; i++) {
        const v = vec[i];
        const hit = mm === 0 ? (isNum ? v === lv : String(v).toLowerCase() === String(lv).toLowerCase())
          : mm === -1 ? Number(v) <= Number(lv)
          : mm === 1 ? Number(v) >= Number(lv) : false;
        if (hit) return out[Math.min(i, out.length - 1)] ?? "#N/A";
      }
      return ifna ?? "#N/A";
    },
    IFS: (p) => {
      for (let i = 0; i + 1 < p.length; i += 2) if (p[i]) return p[i + 1];
      return "#N/A";
    },
    TEXTJOIN: (p) => {
      const [delim, ignoreEmpty, ...rest] = p;
      return flat(rest).filter((v) => !(ignoreEmpty && (v === "" || v === null || v === undefined))).join(String(delim));
    },
    CONCAT: (p) => flat(p).join(""),
    // ---- S11.4 function-library gap-fills ----
    // TEXTBEFORE / TEXTAFTER(text, delim [,instance=-?]) — nth occurrence
    TEXTBEFORE: (p) => {
      const t = String(p[0] ?? ""), d = String(p[1] ?? "");
      if (!d) return "#N/A";
      const n = Number(p[2] ?? 1);
      const idxs: number[] = [];
      for (let i = t.indexOf(d); i >= 0; i = t.indexOf(d, i + 1)) idxs.push(i);
      const at = n >= 0 ? idxs[n - 1] : idxs[idxs.length + n];
      return at === undefined ? "#N/A" : t.slice(0, at);
    },
    TEXTAFTER: (p) => {
      const t = String(p[0] ?? ""), d = String(p[1] ?? "");
      if (!d) return "#N/A";
      const n = Number(p[2] ?? 1);
      const idxs: number[] = [];
      for (let i = t.indexOf(d); i >= 0; i = t.indexOf(d, i + 1)) idxs.push(i);
      const at = n >= 0 ? idxs[n - 1] : idxs[idxs.length + n];
      return at === undefined ? "#N/A" : t.slice(at + d.length);
    },
    VALUETOTEXT: (p) => {
      const v = p[0];
      if (v === null || v === undefined) return "";
      if (Array.isArray(v)) return flat(v).map((x) => String(x ?? "")).join(", ");
      return String(v);
    },
    ISOMITTED: () => false,
    SHEET: () => 1,
    SHEETS: () => ctx.sheetCount ?? 1,
    // date math on serials — EDATE/EOMONTH/YEARFRAC/WORKDAY/NETWORKDAYS
    EDATE: (p) => {
      const a = dnum(p[0]); if (typeof a !== "number") return a.error;
      const m = Number(p[1]) || 0;
      const d = new Date((a - 25569) * 86400000);
      const day = d.getUTCDate();
      d.setUTCMonth(d.getUTCMonth() + Math.trunc(m));
      if (d.getUTCDate() !== day) d.setUTCDate(0); // clamp to month end
      return Math.round(d.getTime() / 86400000 + 25569);
    },
    EOMONTH: (p) => {
      const a = dnum(p[0]); if (typeof a !== "number") return a.error;
      const d = new Date((a - 25569) * 86400000);
      d.setUTCMonth(d.getUTCMonth() + Math.trunc(Number(p[1]) || 0) + 1, 1);
      d.setUTCDate(0);
      return Math.round(d.getTime() / 86400000 + 25569);
    },
    YEARFRAC: (p) => {
      const a = dnum(p[0]); if (typeof a !== "number") return a.error;
      const b = dnum(p[1]); if (typeof b !== "number") return b.error;
      return Math.abs(b - a) / (Number(p[2]) === 4 ? 360 : 365);
    },
    WORKDAY: (p) => {
      const a = dnum(p[0]); if (typeof a !== "number") return a.error;
      let n = Math.trunc(Number(p[1]) || 0);
      const hol = new Set(flat(asMat(p[2])).map((v) => dnum(v)).filter((x) => typeof x === "number"));
      const d = new Date((a - 25569) * 86400000);
      while (n) {
        d.setUTCDate(d.getUTCDate() + Math.sign(n));
        const dow = d.getUTCDay();
        const ser = Math.round(d.getTime() / 86400000 + 25569);
        if (dow !== 0 && dow !== 6 && !hol.has(ser)) n -= Math.sign(n);
      }
      return Math.round(d.getTime() / 86400000 + 25569);
    },
    NETWORKDAYS: (p) => {
      const a = dnum(p[0]); if (typeof a !== "number") return a.error;
      const b = dnum(p[1]); if (typeof b !== "number") return b.error;
      const hol = new Set(flat(asMat(p[2])).map((v) => dnum(v)).filter((x) => typeof x === "number"));
      let n = 0;
      const dir = b >= a ? 1 : -1;
      for (let d = a; dir > 0 ? d <= b : d >= b; d += dir) {
        const dow = new Date((d - 25569) * 86400000).getUTCDay();
        if (dow !== 0 && dow !== 6 && !hol.has(d)) n += dir;
      }
      return n;
    },
    // database functions — DSUM(database, field, criteria)
    DSUM: (p) => dbAgg(p, "sum"), DCOUNT: (p) => dbAgg(p, "count"),
    DCOUNTA: (p) => dbAgg(p, "counta"), DAVERAGE: (p) => dbAgg(p, "avg"),
    DMIN: (p) => dbAgg(p, "min"), DMAX: (p) => dbAgg(p, "max"),
    DGET: (p) => dbAgg(p, "get"), DPRODUCT: (p) => dbAgg(p, "product"),
    // FORECAST.LINEAR(x, ys, xs) — least-squares; plain FORECAST aliases it
    "FORECAST.LINEAR": (p) => forecastLinear(p),
    FORECAST: (p) => forecastLinear(p),
    DATEDIF: (p) => {
      const a = dnum(p[0]); if (typeof a !== "number") return a.error;
      const b = dnum(p[1]); if (typeof b !== "number") return b.error;
      const u = String(p[2] ?? "d").toLowerCase();
      if (b < a) return "#NUM!";
      if (u === "d") return b - a;
      if (u === "m") return Math.floor(b / 30.436875) - Math.floor(a / 30.436875);
      if (u === "y") return Math.floor((b - a) / 365.25);
      return "#NUM!";
    },
    SEQUENCE: (p) => {
      const [rows, cols, start, step] = p.map(Number);
      const out: number[][] = [];
      for (let r = 0; r < (rows || 1); r++) {
        out.push([]);
        for (let c = 0; c < (cols || 1); c++) out[r].push((start || 1) + (r * (cols || 1) + c) * (step || 1));
      }
      return out;
    },
    RANDARRAY: (p) => {
      const [rows, cols] = p.map(Number);
      return Array.from({ length: rows || 1 }, () => Array.from({ length: cols || 1 }, () => Math.random()));
    },

    // ---- dynamic-array functions (S11.2) — all return matrices that spill ----
    UNIQUE: (p) => {
      const byCol = !!p[1], once = !!p[2];
      const rows = byCol ? transpose(asMat(p[0])) : asMat(p[0]);
      const counts = new Map<string, number>();
      const keep: unknown[][] = [];
      for (const row of rows) {
        const k = JSON.stringify(row);
        const n = counts.get(k) ?? 0;
        counts.set(k, n + 1);
        if (!n) keep.push(row);
      }
      const out = once ? keep.filter((r) => counts.get(JSON.stringify(r)) === 1) : keep;
      return byCol ? transpose(out) : out;
    },
    // SORT(arr [,colIdx=1][,asc=1][,byCol])
    SORT: (p) => {
      const byCol = !!p[3];
      const rows = byCol ? transpose(asMat(p[0])) : asMat(p[0]);
      const idx = (Number(p[1]) || 1) - 1;
      const asc = (Number(p[2] ?? 1) >= 0) ? 1 : -1;
      const out = [...rows].sort((a, b) => cmpVals(a[idx], b[idx]) * asc);
      return byCol ? transpose(out) : out;
    },
    // SORTBY(arr, by1, asc1, by2, asc2, …)
    SORTBY: (p) => {
      const m = asMat(p[0]);
      const keys: { v: unknown[]; asc: number }[] = [];
      for (let i = 1; i < p.length; i += 2)
        keys.push({ v: flat(asMat(p[i])), asc: (Number(p[i + 1] ?? 1) >= 0) ? 1 : -1 });
      const order = m.map((_, i) => i).sort((ia, ib) => {
        for (const k of keys) {
          const d = cmpVals(k.v[ia], k.v[ib]);
          if (d) return d * k.asc;
        }
        return 0;
      });
      return order.map((i) => m[i]);
    },
    // FILTER(arr, include [,ifEmpty]) — rows or cols whose flag is truthy
    FILTER: (p) => {
      const m = asMat(p[0]);
      const inc = flat(asMat(p[1]));
      const truthy = (v: unknown) => !!v && v !== 0;
      if (inc.length === m.length) {
        const out = m.filter((_, i) => truthy(inc[i]));
        return out.length ? out : (p[2] ?? "#CALC!");
      }
      const keep = [...Array(m[0]?.length ?? 0).keys()].filter((i) => truthy(inc[i]));
      const out = m.map((row) => keep.map((i) => row[i]));
      return out.length && keep.length ? out : (p[2] ?? "#CALC!");
    },
    TRANSPOSE: (p) => transpose(asMat(p[0])),
    // TAKE/DROP(arr, rows [, cols]) — negative counts from the end
    TAKE: (p) => {
      const m = asMat(p[0]);
      const r = Number(p[1]), c = p[2] === undefined ? m[0]?.length ?? 0 : Number(p[2]);
      const rows = r >= 0 ? m.slice(0, r) : m.slice(r);
      return rows.map((row) => (c >= 0 ? row.slice(0, c) : row.slice(c)));
    },
    DROP: (p) => {
      const m = asMat(p[0]);
      const r = Number(p[1]), c = p[2] === undefined ? 0 : Number(p[2]);
      const rows = r >= 0 ? m.slice(r) : m.slice(0, r);
      return rows.map((row) => (c === 0 ? row : c > 0 ? row.slice(c) : row.slice(0, c)));
    },
    // CHOOSEROWS/CHOOSECOLS(arr, n1 [,n2…]) — 1-based, negatives from end
    CHOOSEROWS: (p) => {
      const m = asMat(p[0]);
      const pick = (n: number) => (n < 0 ? m[m.length + n] : m[n - 1]);
      return (p.slice(1).map(Number)).map((n) => pick(n) ?? ["#REF!"]);
    },
    CHOOSECOLS: (p) => {
      const m = asMat(p[0]);
      const pick = (n: number, row: unknown[]) => (n < 0 ? row[row.length + n] : row[n - 1]);
      const idxs = p.slice(1).map(Number);
      return m.map((row) => idxs.map((n) => pick(n, row) ?? "#REF!"));
    },
    HSTACK: (p) => {
      const mats = p.map(asMat);
      const rows = Math.max(...mats.map((m) => m.length));
      const out: unknown[][] = [];
      for (let r = 0; r < rows; r++) {
        const row: unknown[] = [];
        for (const m of mats) row.push(...(r < m.length ? m[r] : Array(m[0]?.length ?? 0).fill("#N/A")));
        out.push(row);
      }
      return out;
    },
    VSTACK: (p) => {
      const mats = p.map(asMat);
      const cols = Math.max(...mats.map((m) => m[0]?.length ?? 0));
      const out: unknown[][] = [];
      for (const m of mats)
        for (const row of m)
          out.push([...row, ...Array(Math.max(0, cols - row.length)).fill("#N/A")]);
      return out;
    },
    // TOCOL/TOROW(arr [,ignore]) — 1 = skip blanks, 2 = skip errors, 3 = both
    TOCOL: (p) => {
      const skip = Number(p[1]) || 0;
      const keep = (v: unknown) =>
        !((skip & 1) && (v === null || v === undefined || v === "")) &&
        !((skip & 2) && typeof v === "string" && v.startsWith("#"));
      return flat(asMat(p[0])).filter(keep).map((v) => [v]);
    },
    TOROW: (p) => {
      const skip = Number(p[1]) || 0;
      const keep = (v: unknown) =>
        !((skip & 1) && (v === null || v === undefined || v === "")) &&
        !((skip & 2) && typeof v === "string" && v.startsWith("#"));
      return [flat(asMat(p[0])).filter(keep)];
    },
    WRAPROWS: (p) => {
      const vec = flat(asMat(p[0])), len = Number(p[1]) || 1;
      const pad = p[2];
      const out: unknown[][] = [];
      for (let i = 0; i < vec.length; i += len) {
        const row = vec.slice(i, i + len);
        while (row.length < len) row.push(pad ?? "#N/A");
        out.push(row);
      }
      return out;
    },
    WRAPCOLS: (p) => {
      const vec = flat(asMat(p[0])), len = Number(p[1]) || 1;
      const pad = p[2];
      const ncol = Math.ceil(vec.length / len);
      const out: unknown[][] = Array.from({ length: len }, () => []);
      for (let i = 0; i < vec.length; i++) out[i % len].push(vec[i]);
      for (const row of out) while (row.length < ncol) row.push(pad ?? "#N/A");
      return out;
    },
    // EXPAND(arr, rows [,cols] [,pad])
    EXPAND: (p) => {
      const m = asMat(p[0]);
      const rows = Math.max(Number(p[1]) || 0, m.length);
      const cols = Math.max(Number(p[2]) || m[0]?.length || 0, m[0]?.length ?? 0);
      const pad = p[3] !== undefined ? p[3] : "#N/A";
      return Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => (r < m.length && c < (m[r]?.length ?? 0) ? m[r][c] : pad)));
    },
    // TEXTSPLIT(text, colDelim [,rowDelim]) — matrix result
    TEXTSPLIT: (p) => {
      const text = String(p[0] ?? "");
      const cd = p[1] !== undefined ? String(p[1]) : null;
      const rd = p[2] !== undefined ? String(p[2]) : null;
      const rows = rd ? text.split(rd) : [text];
      return rows.map((r) => (cd ? r.split(cd) : [r]));
    },
    ARRAYTOTEXT: (p) => flat(asMat(p[0])).map((v) => String(v ?? "")).join(", "),
    FORMULATEXT: (p) => {
      // arg arrives as a value via callCellValue — ref text not recoverable
      // through hfp; handled by KXFORMULATEXT rewrite if needed. Fallback:
      return typeof p[0] === "string" ? p[0] : "#N/A";
    },
  };
}

// ---------- evaluator ----------

export interface SheetEval {
  /** map of ref → result for this sheet */
  results: Map<string, EvalResult>;
}

/**
 * Evaluate the whole workbook (all sheets, cross-sheet refs resolved,
 * named ranges substituted). Returns sheetName → ref → result.
 */
function makeEvaluator(wb: Workbook, spills?: SpillMaps, prior?: Map<string, EvalResult>) {
  const caches = new Map<string, Map<string, EvalResult>>();
  const visiting = new Set<string>();
  /** current-sheet + current-cell context for INDIRECT/KXAT-style functions */
  const ctx = { sheet: "", selfRef: "", sheetCount: 0 };
  const sheetOf = (name: string | null): Record<string, CellData> =>
    (name ? wb.sheets.find((s) => s.name.toLowerCase() === name.toLowerCase()) : null)?.cells ?? {};
  const evalRangeOf = (sheet: string | null, a: string, b?: string): unknown[][] => {
    const r = parseRange(`${a}:${b ?? a}`);
    const m: unknown[][] = [];
    if (!r) return m;
    for (let row = r.r1; row <= r.r2; row++) {
      m.push([]);
      for (let c = r.c1; c <= r.c2; c++) {
        const res = evalIn(sheet, toA1(c, row), 0);
        m[m.length - 1].push(res.error ?? res.value ?? null);
      }
    }
    return m;
  };
  ctx.sheetCount = wb.sheets.length; // shared mutable ctx — fns read ctx.sheet live
  const fns = extraFunctions((sheet, ref) => evalIn(sheet, ref, 0), evalRangeOf, ctx);

  function evalIn(sheetName: string | null, ref: string, depth: number): EvalResult {
    const cells = sheetOf(sheetName);
    const key = `${sheetName ?? ""}!${ref}`;
    const shName = sheetName ?? "";
    let cache = caches.get(shName);
    if (!cache) { cache = new Map(); caches.set(shName, cache); }
    const cached = cache.get(ref);
    if (cached) return cached;
    const cell = cells[ref];
    let out: EvalResult;
    if (!cell) {
      // spill target? resolve through the anchor's matrix
      const sp = spills?.targets.get(`${shName}\x01${ref}`);
      if (sp) {
        const [ash, aref] = sp.anchor.split("\x01");
        const ar = evalIn(ash, aref, depth + 1);
        const m = ar.value as unknown[][];
        out = ar.error ? err(ar.error)
          : { value: Array.isArray(m) && Array.isArray(m[sp.dr]) ? m[sp.dr][sp.dc] ?? null : null, error: null, spillFrom: aref };
      } else out = { value: null, error: null };
    }
    else if (!cell.f) out = { value: cell.v ?? null, error: null };
    else if (visiting.has(key) || depth > MAX_DEPTH) {
      // iterative calc: cycles feed back the previous pass's value
      out = wb.calc?.iterative ? (prior?.get(key) ?? { value: 0, error: null }) : err("#CYCLE!");
    }
    else {
      visiting.add(key);
      ctx.selfRef = ref;
      out = runFormula(cell.f, shName, depth);
      visiting.delete(key);
      if (spills?.blocked.has(`${shName}\x01${ref}`)) out = err("#SPILL!");
    }
    cache.set(ref, out);
    return out;
  }

  function runFormula(formula: string, sheetName: string, depth: number): EvalResult {
    ctx.sheet = sheetName;
    const parser = new Parser();
    parser.on("callCellValue", (coord, done) => {
      const r = evalIn(sheetName, toA1(coord.column.index, coord.row.index), depth + 1);
      done(r.error ?? r.value ?? null);
    });
    parser.on("callRangeValue", (start, end, done) => {
      const matrix: unknown[][] = [];
      for (let r = start.row.index; r <= end.row.index; r++) {
        const row: unknown[] = [];
        for (let c = start.column.index; c <= end.column.index; c++) {
          const res = evalIn(sheetName, toA1(c, r), depth + 1);
          row.push(res.error ?? res.value ?? null);
        }
        matrix.push(row);
      }
      done(matrix);
    });
    // KX sentinel fns produced by the sheet-ref rewrite
    const hasSheet = (n: string) => wb.sheets.some((s) => s.name.toLowerCase() === n.toLowerCase());
    parser.setFunction("KXREF", (p) => {
      const sn = String(p[0]);
      if (!hasSheet(sn)) return "#REF!";
      const r = evalIn(sn, String(p[1]).replace(/\$/g, "").toUpperCase(), depth + 1);
      return r.error ?? r.value;
    });
    // lazy error catchers — arg was stashed as base64 text by the rewriter.
    // hfp surfaces errors either as `error` or as an error-typed value.
    parser.setFunction("KXIFERROR", (p) => {
      const r = runFormula(unb64(String(p[0])), ctx.sheet, depth + 1);
      const e = r.error ?? (typeof r.value === "string" && r.value.startsWith("#") ? r.value : null);
      return e ? p[1] : r.value;
    });
    parser.setFunction("KXIFNA", (p) => {
      const r = runFormula(unb64(String(p[0])), ctx.sheet, depth + 1);
      const e = r.error ?? (typeof r.value === "string" && r.value.startsWith("#") ? r.value : null);
      return e === "#N/A" ? p[1] : (r.error ?? r.value);
    });
    parser.setFunction("KXOFFSET", (p) => {
      // rewritten from OFFSET(ref,r,c[,h,w]) by preprocessFormula
      const sheet = String(p[0] ?? "") || ctx.sheet;
      const base = parseRange(String(p[1]).replace(/\$/g, ""));
      if (!base) return "#REF!";
      const dr = Number(p[2]) || 0, dc = Number(p[3]) || 0;
      const h = p[4] !== undefined && p[4] !== "" ? Number(p[4]) : base.r2 - base.r1 + 1;
      const w = p[5] !== undefined && p[5] !== "" ? Number(p[5]) : base.c2 - base.c1 + 1;
      const r = { c1: base.c1 + dc, r1: base.r1 + dr, c2: base.c1 + dc + w - 1, r2: base.r1 + dr + h - 1 };
      if (r.c1 < 0 || r.r1 < 0 || r.c2 < r.c1 || r.r2 < r.r1) return "#REF!";
      const m: unknown[][] = [];
      for (let row = r.r1; row <= r.r2; row++) {
        m.push([]);
        for (let c = r.c1; c <= r.c2; c++) {
          const res = evalIn(sheet, toA1(c, row), depth + 1);
          m[m.length - 1].push(res.error ?? res.value ?? null);
        }
      }
      return m.length === 1 && m[0].length === 1 ? m[0][0] : m;
    });
    // intersection operator — KXINT("A1:B2","B2:C3") → overlap or #NULL!
    parser.setFunction("KXINT", (p) => {
      const ra = parseRange(String(p[0]).replace(/\$/g, ""));
      const rb = parseRange(String(p[1]).replace(/\$/g, ""));
      if (!ra || !rb) return "#NULL!";
      const c1 = Math.max(ra.c1, rb.c1), r1 = Math.max(ra.r1, rb.r1);
      const c2 = Math.min(ra.c2, rb.c2), r2 = Math.min(ra.r2, rb.r2);
      if (c2 < c1 || r2 < r1) return "#NULL!";
      const m: unknown[][] = [];
      for (let row = r1; row <= r2; row++) {
        m.push([]);
        for (let c = c1; c <= c2; c++) {
          const res = evalIn(ctx.sheet, toA1(c, row), depth + 1);
          m[m.length - 1].push(res.error ?? res.value ?? null);
        }
      }
      return m.length === 1 && m[0].length === 1 ? m[0][0] : m;
    });
    parser.setFunction("KXRANGE", (p) => {
      if (!hasSheet(String(p[0]))) return "#REF!";
      const r = parseRange(`${p[1]}:${p[2]}`);
      if (!r) return "#REF!";
      const m: unknown[][] = [];
      for (let row = r.r1; row <= r.r2; row++) {
        m.push([]);
        for (let c = r.c1; c <= r.c2; c++) {
          const res = evalIn(String(p[0]), toA1(c, row), depth + 1);
          m[m.length - 1].push(res.error ?? res.value ?? null);
        }
      }
      return m;
    });
    // spill refs — A1# / Sheet!A1# → the anchor's whole spilled matrix
    const spillOf = (sn: string, ref: string) => {
      if (!hasSheet(sn)) return "#REF!";
      const res = evalIn(sn, ref.replace(/\$/g, "").toUpperCase(), depth + 1);
      if (res.error) return res.error;
      return Array.isArray(res.value) ? res.value : res.value ?? "#REF!";
    };
    parser.setFunction("KXSPILL", (p) => spillOf(ctx.sheet, String(p[0])));
    parser.setFunction("KXSPILLQ", (p) => spillOf(String(p[0]), String(p[1])));
    // FORMULATEXT — rewritten to carry sheet+ref; returns the formula text
    parser.setFunction("KXFORMULATEXT", (p) => {
      const sn = String(p[0]) || ctx.sheet;
      const ref = String(p[1]).replace(/\$/g, "").toUpperCase();
      const sh = wb.sheets.find((s) => s.name.toLowerCase() === sn.toLowerCase());
      const f = sh?.cells[ref]?.f;
      return f ? `=${f}` : "#N/A";
    });
    // broadcast comparison — KXCMP("sheet","A1:B3",">","b64(rhs)") evaluates
    // the range elementwise against the (scalar or matrix) rhs
    parser.setFunction("KXCMP", (p) => {
      const sn = String(p[0] ?? "") || ctx.sheet;
      const r = parseRange(String(p[1]).replace(/\$/g, ""));
      if (!r) return "#REF!";
      const rhsRes = runFormula(unb64(String(p[3])), ctx.sheet, depth + 1);
      const rhs = rhsRes.error ?? rhsRes.value;
      const rm = Array.isArray(rhs) && Array.isArray(rhs[0]) ? rhs as unknown[][] : null;
      const cmp = (a: unknown, b: unknown, op: string): unknown => {
        if (typeof b === "string" && b.startsWith("#")) return b;
        const na = Number(a), nb = Number(b);
        const numy = a !== null && b !== null && a !== "" && b !== "" && !isNaN(na) && !isNaN(nb);
        const sa = String(a ?? ""), sb = String(b ?? "");
        switch (op) {
          case ">": return numy ? na > nb : sa > sb;
          case "<": return numy ? na < nb : sa < sb;
          case ">=": return numy ? na >= nb : sa >= sb;
          case "<=": return numy ? na <= nb : sa <= sb;
          case "=": return sameKey(a, b);
          case "<>": return !sameKey(a, b);
          default: return "#VALUE!";
        }
      };
      const out: unknown[][] = [];
      for (let row = r.r1; row <= r.r2; row++) {
        out.push([]);
        for (let c = r.c1; c <= r.c2; c++) {
          const res = evalIn(sn, toA1(c, row), depth + 1);
          const rv = rm ? rm[row - r.r1]?.[c - r.c1] ?? "#N/A" : rhs;
          out[out.length - 1].push(res.error ? res.error : cmp(res.value, rv, String(p[2])));
        }
      }
      return out.length === 1 && out[0].length === 1 ? out[0][0] : out;
    });
    // ---- name-binding + lambda forms (S11.3) — arglists arrive as base64 ----
    const litOf = (v: unknown): string => {
      if (v === null || v === undefined || v === "") return "0"; // Excel blank→0
      if (typeof v === "number") return String(v);
      if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
      if (Array.isArray(v)) return `HSTACK(${flat(v).map(litOf).join(",")})`;
      return `"${String(v).replace(/"/g, '""')}"`;
    };
    const substNames = (body: string, vals: Record<string, string>): string => {
      let out = body;
      for (const [nm, lit] of Object.entries(vals)) {
        const re = new RegExp(`(?<![A-Za-z0-9_.$!"'])${nm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.$(!])`, "gi");
        out = out.split(/("[^"]*")/).map((seg, i) => i % 2 ? seg : seg.replace(re, `(${lit})`)).join("");
      }
      return out;
    };
    const evalSub = (expr: string): unknown => {
      const r = runFormula(expr, ctx.sheet, depth + 1);
      return r.error ?? r.value;
    };
    const stripParens = (s: string): string => {
      s = s.trim();
      while (s.startsWith("(") && s.endsWith(")")) {
        let d = 0, ok = true;
        for (let i = 0; i < s.length; i++) {
          if (s[i] === "(") d++;
          else if (s[i] === ")") { d--; if (!d && i < s.length - 1) { ok = false; break; } }
        }
        if (ok) s = s.slice(1, -1).trim(); else break;
      }
      return s;
    };
    // invoke a LAMBDA(param…, body) text with concrete values
    const lambdaCall = (lambdaExpr: string, vals: unknown[]): unknown => {
      const le = stripParens(lambdaExpr);
      if (!/^lambda\s*\(/i.test(le)) return "#CALC!";
      const inner = le.replace(/^lambda\s*\(/i, "").replace(/\)\s*$/, "");
      const args = splitTopArgs(inner);
      const names = args.slice(0, -1).map((a) => a.trim().toLowerCase());
      const body = args[args.length - 1];
      const binds: Record<string, string> = {};
      names.forEach((n, i) => { binds[n] = litOf(vals[i]); });
      return evalSub(substNames(body, binds));
    };
    // LET(n1, e1, n2, e2, …, body) — earlier names visible to later exprs
    parser.setFunction("KXLET", (p) => {
      const args = splitTopArgs(unb64(String(p[0])));
      if (args.length < 3) return "#VALUE!";
      const vals: Record<string, string> = {};
      for (let i = 0; i + 1 < args.length; i += 2) {
        const nm = args[i].trim().toLowerCase();
        const expr = args[i + 1].trim();
        // LAMBDA binds as raw text so the name can be used as a function
        if (/^lambda\s*\(/i.test(stripParens(expr))) vals[nm] = stripParens(expr);
        else {
          const r = runFormula(substNames(expr, vals), ctx.sheet, depth + 1);
          if (r.error) return r.error;
          const v = r.value;
          // bare refs re-inject as live references (blank/type fidelity)
          vals[nm] = /^\$?[A-Za-z]{1,3}\$?\d+$/.test(expr) ? expr : litOf(v);
        }
      }
      const body = args[args.length - 1];
      const r = runFormula(substNames(body, vals), ctx.sheet, depth + 1);
      return r.error ?? r.value;
    });
    parser.setFunction("KXLAMBDA", () => "#CALC!"); // bare lambda isn't a value
    // MAP(arr1 [,arr2…], LAMBDA(…)) — elementwise over the first array's dims
    parser.setFunction("KXMAP", (p) => {
      const args = splitTopArgs(unb64(String(p[0])));
      if (args.length < 2) return "#VALUE!";
      const lambda = args[args.length - 1];
      const mats = args.slice(0, -1).map((a) => asMat(evalSub(a)));
      return mats[0].map((row, r) =>
        row.map((_, c) => lambdaCall(lambda, mats.map((m) => m[r]?.[c] ?? null))));
    });
    // BYROW(arr, LAMBDA(row,…)) — lambda sees the row as a vector
    parser.setFunction("KXBYROW", (p) => {
      const args = splitTopArgs(unb64(String(p[0])));
      const m = asMat(evalSub(args[0]));
      return m.map((row) => [lambdaCall(args[1], [row])]);
    });
    parser.setFunction("KXBYCOL", (p) => {
      const args = splitTopArgs(unb64(String(p[0])));
      const m = asMat(evalSub(args[0]));
      const cols = m[0]?.length ?? 0;
      return [Array.from({ length: cols }, (_, c) => lambdaCall(args[1], [m.map((row) => row[c])]))];
    });
    // MAKEARRAY(rows, cols, LAMBDA(r,c,…)) — 1-based indexes
    parser.setFunction("KXMAKEARRAY", (p) => {
      const args = splitTopArgs(unb64(String(p[0])));
      const nr = Number(evalSub(args[0])) || 0, nc = Number(evalSub(args[1])) || 0;
      return Array.from({ length: nr }, (_, r) =>
        Array.from({ length: nc }, (_, c) => lambdaCall(args[2], [r + 1, c + 1])));
    });
    // REDUCE(init, arr, LAMBDA(acc,v,…)) / SCAN — fold / running accumulation
    parser.setFunction("KXREDUCE", (p) => {
      const args = splitTopArgs(unb64(String(p[0])));
      let acc = evalSub(args[0]);
      for (const v of flat(asMat(evalSub(args[1])))) acc = lambdaCall(args[2], [acc, v]);
      return acc;
    });
    parser.setFunction("KXSCAN", (p) => {
      const args = splitTopArgs(unb64(String(p[0])));
      let acc = evalSub(args[0]);
      return [flat(asMat(evalSub(args[1]))).map((v) => (acc = lambdaCall(args[2], [acc, v])))];
    });
    // ---- structured table refs (S12.1) ----
    const findTable = (tname: string): { sheet: string; t: NonNullable<SheetData["tables"]>[number]; r: Range } | null => {
      for (const s of wb.sheets) {
        const t = s.tables?.find((x) => x.name.toLowerCase() === tname.toLowerCase());
        if (t) { const r = parseRange(t.range); if (r) return { sheet: s.name, t, r }; }
      }
      return null;
    };
    // column offset inside the table whose header cell text matches `name`
    const tblColIdx = (f: NonNullable<ReturnType<typeof findTable>>, name: string): number => {
      for (let c = f.r.c1; c <= f.r.c2; c++) {
        const res = evalIn(f.sheet, toA1(c, f.r.r1), depth + 1);
        if (sameKey(res.value, name)) return c - f.r.c1;
      }
      return -1;
    };
    // computed totals-row values per column spec
    const tblTotalsRow = (f: NonNullable<ReturnType<typeof findTable>>): unknown[] => {
      const out: unknown[] = [];
      for (let c = f.r.c1; c <= f.r.c2; c++) {
        const agg = f.t.totals?.[c - f.r.c1];
        if (!agg || agg === "none") { out.push(""); continue; }
        const vals: number[] = [];
        for (let row = f.r.r1 + 1; row <= f.r.r2; row++) {
          const v = evalIn(f.sheet, toA1(c, row), depth + 1).value;
          if (typeof v === "number") vals.push(v);
        }
        out.push(agg === "sum" ? vals.reduce((a, b) => a + b, 0)
          : agg === "avg" ? (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : "")
          : agg === "count" ? vals.length
          : agg === "min" ? (vals.length ? Math.min(...vals) : "")
          : vals.length ? Math.max(...vals) : "");
      }
      return out;
    };
    const tblMat = (f: NonNullable<ReturnType<typeof findTable>>, c1: number, c2: number, r1: number, r2: number): unknown[][] =>
      evalRangeOf(f.sheet, toA1(c1, r1), toA1(c2, r2));
    parser.setFunction("KXTBL", (p) => {
      const f = findTable(String(p[0]));
      if (!f) return "#REF!";
      const spec = String(p[1]).trim();
      if (spec.startsWith("#")) {
        const s2 = spec.slice(1).toLowerCase();
        if (s2 === "all") { const m = tblMat(f, f.r.c1, f.r.c2, f.r.r1, f.r.r2); if (f.t.totals) m.push(tblTotalsRow(f)); return m; }
        if (s2 === "headers") return tblMat(f, f.r.c1, f.r.c2, f.r.r1, f.r.r1);
        if (s2 === "data") return tblMat(f, f.r.c1, f.r.c2, f.r.r1 + 1, f.r.r2);
        if (s2 === "totals") return f.t.totals ? [tblTotalsRow(f)] : "#REF!";
        if (s2 === "this row") {
          const self = parseA1(ctx.selfRef);
          return self && self.row > f.r.r1 && self.row <= f.r.r2 ? tblMat(f, f.r.c1, f.r.c2, self.row, self.row) : "#VALUE!";
        }
        return "#REF!";
      }
      const ci = tblColIdx(f, spec);
      return ci < 0 ? "#REF!" : tblMat(f, f.r.c1 + ci, f.r.c1 + ci, f.r.r1 + 1, f.r.r2);
    });
    parser.setFunction("KXTBLC", (p) => {
      const f = findTable(String(p[0]));
      if (!f) return "#REF!";
      const spec = String(p[1]).trim().toLowerCase(), col = String(p[2]).trim();
      const ci = tblColIdx(f, col);
      if (ci < 0) return "#REF!";
      if (spec === "#headers") return tblMat(f, f.r.c1 + ci, f.r.c1 + ci, f.r.r1, f.r.r1);
      if (spec === "#totals") return f.t.totals ? [[tblTotalsRow(f)[ci]]] : "#REF!";
      if (spec === "#all") return tblMat(f, f.r.c1 + ci, f.r.c1 + ci, f.r.r1, f.r.r2);
      if (spec === "#this row") {
        const self = parseA1(ctx.selfRef);
        return self ? evalIn(f.sheet, toA1(f.r.c1 + ci, self.row), depth + 1).value : "#VALUE!";
      }
      return "#REF!";
    });
    // [@Col] / T[@Col] — the host row intersected with the table column
    parser.setFunction("KXTHIS", (p) => {
      const self = parseA1(ctx.selfRef);
      if (!self) return "#VALUE!";
      const tname = String(p[0]);
      let f = tname ? findTable(tname) : null;
      if (!f) {
        // bare @Col — the table on this sheet whose data rows share the
        // host row (Excel matches by row intersection, not containment)
        const s = wb.sheets.find((x) => x.name === ctx.sheet);
        for (const t of s?.tables ?? []) {
          const r = parseRange(t.range);
          if (r && self.row > r.r1 && self.row <= r.r2) {
            f = { sheet: s!.name, t, r };
            break;
          }
        }
      }
      if (!f) return "#REF!";
      const ci = tblColIdx(f, String(p[1]).trim());
      if (ci < 0) return "#REF!";
      const res = evalIn(f.sheet, toA1(f.r.c1 + ci, self.row), depth + 1);
      return res.error ?? res.value;
    });
    // SUBTOTAL(code, range…) — 1-11 exclude filtered rows, 101-111 also
    // exclude manually hidden rows; fn codes: 1 avg,2 count,3 counta,
    // 4 max,5 min,6 product,9 sum,10 var,11 varp
    parser.setFunction("KXSUBTOTAL", (p) => {
      const args = splitTopArgs(unb64(String(p[0])));
      const code = Number(evalSub(args[0]));
      const fnCode = code > 100 ? code - 100 : code;
      const skipManual = code > 100;
      const vals: unknown[] = [];
      for (const a of args.slice(1)) {
        const m = a.trim().match(/^(?:(?:'([^']+)'|([\w.]+))!)?(\$?[A-Za-z]{1,3}\$?\d+)(?::(\$?[A-Za-z]{1,3}\$?\d+))?$/);
        if (!m) { vals.push(evalSub(a)); continue; } // scalar / expression
        const sn = m[1] ?? m[2] ?? ctx.sheet;
        const r = parseRange(`${m[3]}:${m[4] ?? m[3]}`.replace(/\$/g, ""));
        if (!r) return "#REF!";
        const sh = wb.sheets.find((s) => s.name === sn);
        const hidden = new Set<number>([
          ...(sh?.filteredRows ?? []),
          ...(skipManual ? (sh?.hiddenRows ?? []) : []),
        ]);
        for (let row = r.r1; row <= r.r2; row++) {
          if (hidden.has(row)) continue;
          for (let c = r.c1; c <= r.c2; c++)
            vals.push(evalIn(sn, toA1(c, row), depth + 1).value);
        }
      }
      const ns = vals.filter((v): v is number => typeof v === "number");
      const nzs = vals.filter((v) => v !== null && v !== undefined && v !== "");
      switch (fnCode) {
        case 1: return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : "#DIV/0!";
        case 2: return ns.length;
        case 3: return nzs.length;
        case 4: return ns.length ? Math.max(...ns) : 0;
        case 5: return ns.length ? Math.min(...ns) : 0;
        case 6: return ns.reduce((a, b) => a * b, 1);
        case 9: return ns.reduce((a, b) => a + b, 0);
        case 10: case 11: {
          if (ns.length < (fnCode === 10 ? 2 : 1)) return "#DIV/0!";
          const mean = ns.reduce((a, b) => a + b, 0) / ns.length;
          const v = ns.reduce((a, b) => a + (b - mean) ** 2, 0);
          return fnCode === 10 ? v / (ns.length - 1) : v / ns.length;
        }
        default: return "#VALUE!";
      }
    });
    // implicit intersection — @range resolves to the cell sharing the
    // formula's row (column ranges) or column (row ranges)
    parser.setFunction("KXAT", (p) => {
      const sheet = String(p[0] ?? "") || ctx.sheet;
      const r = parseRange(String(p[1]).replace(/\$/g, ""));
      const self = ctx.selfRef ? parseA1(ctx.selfRef) : null;
      if (!r || !self) return "#VALUE!";
      const col = r.c1 === r.c2 ? r.c1
        : self.col >= r.c1 && self.col <= r.c2 ? self.col : null;
      const row = r.r1 === r.r2 ? r.r1
        : self.row >= r.r1 && self.row <= r.r2 ? self.row : null;
      if (col === null || row === null) return "#VALUE!";
      const res = evalIn(sheet, toA1(col, row), depth + 1);
      return res.error ?? res.value;
    });
    for (const [name, fn] of Object.entries(fns)) parser.setFunction(name, fn);
    try {
      const { error, result } = parser.parse(preprocessFormula(formula, wb.names));
      return error ? { value: null, error } : { value: result ?? null, error: null };
    } catch {
      return err("#ERROR!");
    }
  }

  return { caches, evalIn, runFormula };
}

/** Detect dynamic-array spills: any formula whose result is a >1×1 matrix
 *  spills into the cells down/right of its anchor. Occupied targets (any
 *  cell content) or overlap with an earlier spill mark the anchor #SPILL!. */
function computeSpills(wb: Workbook, e: ReturnType<typeof makeEvaluator>): SpillMaps {
  const targets = new Map<string, { anchor: string; dr: number; dc: number }>();
  const blocked = new Set<string>();
  for (const sheet of wb.sheets) {
    const refs = Object.keys(sheet.cells)
      .map((r) => ({ ref: r, p: parseA1(r)! }))
      .sort((a, b) => a.p.row - b.p.row || a.p.col - b.p.col);
    for (const { ref } of refs) {
      const cell = sheet.cells[ref];
      if (!cell?.f) continue;
      const key = `${sheet.name}\x01${ref}`;
      const res = e.evalIn(sheet.name, ref, 0);
      const v = res?.value;
      if (res?.error || !Array.isArray(v) || !Array.isArray(v[0])) continue;
      const m = v as unknown[][];
      if (m.length <= 1 && (m[0]?.length ?? 0) <= 1) continue;
      const at = parseA1(ref)!;
      const mine: [string, number, number][] = [];
      let bad = false;
      for (let dr = 0; dr < m.length && !bad; dr++)
        for (let dc = 0; dc < (m[dr]?.length ?? 0) && !bad; dc++) {
          if (!dr && !dc) continue;
          const t = toA1(at.col + dc, at.row + dr);
          const tc = sheet.cells[t];
          const tk = `${sheet.name}\x01${t}`;
          if ((tc && (tc.f || (tc.v !== null && tc.v !== undefined && tc.v !== ""))) || targets.has(tk)) bad = true;
          else mine.push([tk, dr, dc]);
        }
      if (bad) blocked.add(key);
      else for (const [tk, dr, dc] of mine) targets.set(tk, { anchor: key, dr, dc });
    }
  }
  return { targets, blocked };
}

/** Full workbook eval with spill support — pass 1 discovers matrices and
 *  computes spill extents, pass 2 re-evaluates so dependents can read
 *  spill targets through the spill map. */
function evaluateAll(wb: Workbook): { caches: Map<string, Map<string, EvalResult>>; runFormula: ReturnType<typeof makeEvaluator>["runFormula"] } {
  // S11.5 iterative calc: re-run passes until convergence (or maxIterations)
  if (wb.calc?.iterative) {
    const maxIter = wb.calc.maxIterations ?? 100;
    const maxChange = wb.calc.maxChange ?? 0.001;
    let prior = new Map<string, EvalResult>();
    let e = makeEvaluator(wb, undefined, prior);
    let next = prior;
    for (let i = 0; i < maxIter; i++) {
      for (const s of wb.sheets) for (const ref of Object.keys(s.cells)) e.evalIn(s.name, ref, 0);
      let maxD = 0;
      next = new Map<string, EvalResult>();
      for (const [sn, cache] of e.caches) for (const [ref, res] of cache) {
        const k = `${sn}!${ref}`;
        next.set(k, res);
        const pv = prior.get(k)?.value;
        if (typeof res.value === "number" && typeof pv === "number")
          maxD = Math.max(maxD, Math.abs(res.value - pv));
        else if (res.value !== pv) maxD = Infinity; // non-numeric change
      }
      if (maxD <= maxChange) break;
      prior = next;
      e = makeEvaluator(wb, undefined, prior);
    }
    const spills = computeSpills(wb, e);
    if (!spills.targets.size && !spills.blocked.size) return e;
    const p2 = makeEvaluator(wb, spills, next);
    for (const s of wb.sheets) for (const ref of Object.keys(s.cells)) p2.evalIn(s.name, ref, 0);
    for (const tk of spills.targets.keys()) {
      const [sn, ref] = tk.split("\x01");
      p2.evalIn(sn, ref, 0);
    }
    return p2;
  }
  const p1 = makeEvaluator(wb);
  for (const s of wb.sheets) for (const ref of Object.keys(s.cells)) p1.evalIn(s.name, ref, 0);
  const spills = computeSpills(wb, p1);
  if (!spills.targets.size && !spills.blocked.size) return p1;
  const p2 = makeEvaluator(wb, spills);
  for (const s of wb.sheets) for (const ref of Object.keys(s.cells)) p2.evalIn(s.name, ref, 0);
  // materialize spill-target entries so renders/exports see them
  for (const tk of spills.targets.keys()) {
    const [sn, ref] = tk.split("\x01");
    p2.evalIn(sn, ref, 0);
  }
  return p2;
}

export function evaluateWorkbook(wb: Workbook): Map<string, Map<string, EvalResult>> {
  return evaluateAll(wb).caches;
}

/** Prime the workbook once, then allow ad-hoc formula evaluation in a sheet's
 *  context — used by conditional-format formula rules and future features. */
export function createSheetEvaluator(wb: Workbook, sheetName: string) {
  const e = evaluateAll(wb);
  return {
    values: e.caches.get(sheetName) ?? new Map<string, EvalResult>(),
    evalFormula: (f: string) => e.runFormula(f, sheetName, 0),
  };
}

/** Back-compat single-sheet eval (no cross-sheet refs resolve). */
export function evaluateSheet(cells: Record<string, CellData>): Map<string, EvalResult> {
  const wb: Workbook = { sheets: [{ name: "", cells }] };
  return evaluateWorkbook(wb).get("")!;
}

/** Evaluate one sheet inside a workbook (cross-sheet refs resolve). */
export function evaluateSheetIn(wb: Workbook, sheetName: string): Map<string, EvalResult> {
  return evaluateWorkbook(wb).get(sheetName) ?? new Map();
}

/** S11.6 — explain a formula: evaluate the whole expression plus each
 *  top-level argument of the outermost call, so the inspector can step
 *  through inputs → outputs like Excel's Evaluate Formula. */
export function explainFormula(
  wb: Workbook, sheetName: string, formula: string,
): { final: EvalResult; parts: { expr: string; result: EvalResult }[] } {
  const e = evaluateAll(wb);
  const final = e.runFormula(formula, sheetName, 0);
  const parts: { expr: string; result: EvalResult }[] = [];
  const f = formula.trim();
  const m = f.match(/^[A-Za-z_][\w.]*\(/);
  if (m) {
    const inner = f.slice(m[0].length, f.endsWith(")") ? -1 : undefined);
    for (const arg of splitTopArgs(inner)) {
      if (!arg.trim()) continue;
      parts.push({ expr: arg.trim(), result: e.runFormula(arg.trim(), sheetName, 0) });
    }
  }
  return { final, parts };
}

/** Normalize an A1 formula to R1C1-relative form (host ref = R0C0) so two
 *  cells' formulas can be compared structurally — used by the inconsistent-
 *  formula error rule. */
export function toR1C1(formula: string, host: string): string {
  const hp = parseA1(host.replace(/\$/g, ""));
  if (!hp) return formula;
  return formula.split(/("[^"]*")/).map((seg, i) => {
    if (i % 2) return seg;
    return seg.replace(/(\$?)([A-Za-z]{1,3})(\$?)(\d+)/g, (_m, ca, cs, ra, rs) => {
      const col = colIndex(cs.toUpperCase()), row = parseInt(rs, 10) - 1;
      const c = ca ? `C${col}` : `C[${col - hp.col}]`;
      const r = ra ? `R${row + 1}` : `R[${row - hp.row}]`;
      return r + c;
    });
  }).join("");
}

export function displayValue(res: EvalResult | undefined, cell: CellData | undefined): string {
  if (!cell) {
    if (res?.error) return res.error;
    const v = res?.value;
    if (Array.isArray(v)) return String((v as unknown[][])[0]?.[0] ?? "");
    return v === null || v === undefined ? "" : String(v);
  }
  if (res?.error) return res.error;
  const v = cell.f ? res?.value : (res?.value ?? cell.v);
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return String((v as unknown[]).flat()[0] ?? "");
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}
