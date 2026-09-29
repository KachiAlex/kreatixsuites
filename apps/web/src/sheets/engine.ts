import { Parser } from "hot-formula-parser";
import type { CellData, Workbook } from "./model";
import { toA1, parseRange } from "./model";

export interface EvalResult {
  value: unknown;
  error: string | null;
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
  // split on "..." literals; rewrite only the plain segments
  const out = withOffset.split(/("[^"]*")/).map((seg, i) => {
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

/** Build the function pack bound to this workbook's resolvers. */
export function extraFunctions(
  evalRef: Resolver,
  evalRange: RangeResolver,
  ctx: { sheet: string },
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
function makeEvaluator(wb: Workbook) {
  const caches = new Map<string, Map<string, EvalResult>>();
  const visiting = new Set<string>();
  /** current-sheet context for INDIRECT-style functions */
  const ctx = { sheet: "" };
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
    if (!cell) out = { value: null, error: null };
    else if (!cell.f) out = { value: cell.v ?? null, error: null };
    else if (visiting.has(key) || depth > MAX_DEPTH) out = err("#CYCLE!");
    else {
      visiting.add(key);
      out = runFormula(cell.f, shName, depth);
      visiting.delete(key);
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

export function evaluateWorkbook(wb: Workbook): Map<string, Map<string, EvalResult>> {
  const e = makeEvaluator(wb);
  for (const sheet of wb.sheets) for (const ref of Object.keys(sheet.cells)) e.evalIn(sheet.name, ref, 0);
  return e.caches;
}

/** Prime the workbook once, then allow ad-hoc formula evaluation in a sheet's
 *  context — used by conditional-format formula rules and future features. */
export function createSheetEvaluator(wb: Workbook, sheetName: string) {
  const e = makeEvaluator(wb);
  for (const sheet of wb.sheets) for (const ref of Object.keys(sheet.cells)) e.evalIn(sheet.name, ref, 0);
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

export function displayValue(res: EvalResult | undefined, cell: CellData | undefined): string {
  if (!cell) return "";
  if (res?.error) return res.error;
  const v = cell.f ? res?.value : (res?.value ?? cell.v);
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return String((v as unknown[]).flat()[0] ?? "");
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}
