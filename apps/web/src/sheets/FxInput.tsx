// Formula-aware input: function/name/sheet autocomplete, signature hints,
// F4 $-anchor cycling. Used by the in-cell editor and the formula bar.
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { SUPPORTED_FORMULAS } from "hot-formula-parser";
import type { Workbook } from "./model";
import { tokenAtCaret, cycleAnchors } from "./engine";

// fns we added on top of hot-formula-parser's set
const EXTRA = [
  "VLOOKUP", "HLOOKUP", "INDEX", "MATCH", "OFFSET", "INDIRECT", "LOOKUP",
  "XLOOKUP", "IFS", "TEXTJOIN", "CONCAT", "DATEDIF", "SEQUENCE", "RANDARRAY",
  "IFERROR", "IFNA", "NA",
];

const HINTS: Record<string, string> = {
  SUM: "SUM(n1, [n2], …)", AVERAGE: "AVERAGE(n1, [n2], …)", COUNT: "COUNT(v1, [v2], …)",
  COUNTA: "COUNTA(v1, [v2], …)", MAX: "MAX(n1, [n2], …)", MIN: "MIN(n1, [n2], …)",
  IF: "IF(test, if_true, [if_false])", IFS: "IFS(test1, val1, [test2, val2], …)",
  IFERROR: "IFERROR(value, fallback)", IFNA: "IFNA(value, if_na)",
  AND: "AND(test1, [test2], …)", OR: "OR(test1, [test2], …)", NOT: "NOT(test)",
  VLOOKUP: "VLOOKUP(key, table, col, [approx])", HLOOKUP: "HLOOKUP(key, table, row, [approx])",
  XLOOKUP: "XLOOKUP(key, lookup, return, [if_na], [match_mode])",
  LOOKUP: "LOOKUP(key, lookup_vector, [return_vector])",
  INDEX: "INDEX(range, row, [col])", MATCH: "MATCH(key, range, [0|1|-1])",
  OFFSET: "OFFSET(ref, rows, cols, [height], [width])", INDIRECT: "INDIRECT(\"A1\" | \"Sheet!A1\")",
  SUMIF: "SUMIF(range, criteria, [sum_range])", SUMIFS: "SUMIFS(sum_range, crit_range1, crit1, …)",
  COUNTIF: "COUNTIF(range, criteria)", COUNTIFS: "COUNTIFS(range1, crit1, …)",
  AVERAGEIF: "AVERAGEIF(range, criteria, [avg_range])",
  CONCAT: "CONCAT(t1, [t2], …)", TEXTJOIN: "TEXTJOIN(delim, ignore_empty, t1, …)",
  LEFT: "LEFT(text, [n])", RIGHT: "RIGHT(text, [n])", MID: "MID(text, start, n)",
  LEN: "LEN(text)", TRIM: "TRIM(text)", UPPER: "UPPER(text)", LOWER: "LOWER(text)",
  SUBSTITUTE: "SUBSTITUTE(text, old, new, [occurrence])", TEXT: "TEXT(value, format)",
  VALUE: "VALUE(text)", FIND: "FIND(find, within, [start])", REPLACE: "REPLACE(old, start, n, new)",
  DATE: "DATE(year, month, day)", TODAY: "TODAY()", NOW: "NOW()",
  YEAR: "YEAR(date)", MONTH: "MONTH(date)", DAY: "DAY(date)", EOMONTH: "EOMONTH(start, months)",
  DATEDIF: "DATEDIF(start, end, \"y\"|\"m\"|\"d\")", EDATE: "EDATE(start, months)",
  ROUND: "ROUND(n, digits)", ROUNDUP: "ROUNDUP(n, digits)", ROUNDDOWN: "ROUNDDOWN(n, digits)",
  ABS: "ABS(n)", MOD: "MOD(n, d)", POWER: "POWER(n, p)", SQRT: "SQRT(n)",
  RAND: "RAND()", RANDBETWEEN: "RANDBETWEEN(low, high)", RANDARRAY: "RANDARRAY([rows], [cols])",
  SEQUENCE: "SEQUENCE(rows, [cols], [start], [step])",
  PMT: "PMT(rate, nper, pv, [fv], [type])", NPV: "NPV(rate, v1, …)", IRR: "IRR(values, [guess])",
  MEDIAN: "MEDIAN(n1, …)", STDEV: "STDEV(n1, …)", VAR: "VAR(n1, …)",
};

interface Suggestion { label: string; insert: string; kind: "fn" | "name" | "sheet" }

export function FxInput({ wb, className, wrapStyle, inputStyle, inputRef, value, onValue, onKeyDown, onBlur, disabled, placeholder, autoFocus }: {
  wb?: Workbook;
  className?: string;
  wrapStyle?: CSSProperties;
  inputStyle?: CSSProperties;
  inputRef?: RefObject<HTMLInputElement | null>;
  value: string;
  onValue: (v: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [caret, setCaret] = useState(0);
  const [hi, setHi] = useState(0);
  const localRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? localRef;

  const isFormula = value.startsWith("=");
  const token = useMemo(() => (isFormula ? tokenAtCaret(value, caret) : null), [isFormula, value, caret]);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!token || token.text.length < 1) return [];
    const up = token.text.toUpperCase();
    const out: Suggestion[] = [];
    const fns = new Set<string>([...SUPPORTED_FORMULAS, ...EXTRA].map((f) => f.toUpperCase()));
    for (const f of fns) if (f.startsWith(up) && !f.startsWith("KX")) out.push({ label: f, insert: `${f}(`, kind: "fn" });
    for (const n of Object.keys(wb?.names ?? {}))
      if (n.toUpperCase().startsWith(up)) out.push({ label: n, insert: n, kind: "name" });
    for (const s of wb?.sheets ?? []) {
      if (s.name.toUpperCase().startsWith(up)) {
        const q = /[\s]/.test(s.name) || /^\d/.test(s.name) ? `'${s.name}'` : s.name;
        out.push({ label: `${s.name}!`, insert: `${q}!`, kind: "sheet" });
      }
    }
    return out.slice(0, 9);
  }, [token, wb]);

  // signature hint: innermost open call before the caret
  const hint = useMemo(() => {
    if (!isFormula) return null;
    let depth = 0, open: string | null = null;
    const left = value.slice(0, caret);
    for (let i = left.length - 1; i >= 0; i--) {
      const ch = left[i];
      if (ch === ")") depth++;
      else if (ch === "(") {
        if (depth === 0) {
          const m = left.slice(0, i).match(/([A-Za-z_][\w.]*)$/);
          if (m) { open = m[1].toUpperCase(); break; }
        } else depth--;
      }
    }
    return open ? HINTS[open] ?? `${open}(…)` : null;
  }, [isFormula, value, caret]);

  const accept = (sug: Suggestion) => {
    if (!token) return;
    const next = value.slice(0, token.start) + sug.insert + value.slice(caret);
    onValue(next);
    const nc = token.start + sug.insert.length;
    setCaret(nc);
    setHi(0);
    requestAnimationFrame(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(nc, nc); } });
  };

  const showSug = isFormula && suggestions.length > 0;

  return (
    <span className="fx-wrap" style={{ position: "relative", display: "inline-flex", flex: wrapStyle?.flex ?? "none", ...wrapStyle }}>
      <input ref={ref} className={className} style={{ width: "100%", ...inputStyle }}
        value={value} disabled={disabled} placeholder={placeholder} autoFocus={autoFocus}
        onChange={(e) => { onValue(e.target.value); setCaret(e.target.selectionStart ?? 0); setHi(0); }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={(e) => {
          if (e.key === "F4" && isFormula) {
            const el = e.currentTarget;
            const c = cycleAnchors(value.slice(1), (el.selectionStart ?? 1) - 1);
            if (c) {
              e.preventDefault();
              onValue("=" + c.text);
              requestAnimationFrame(() => el.setSelectionRange(c.caret + 1, c.caret + 1));
              return;
            }
          }
          if (showSug) {
            if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => (h + 1) % suggestions.length); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => (h - 1 + suggestions.length) % suggestions.length); return; }
            if (e.key === "Tab" || (e.key === "Enter" && token)) {
              e.preventDefault();
              accept(suggestions[Math.min(hi, suggestions.length - 1)]);
              return;
            }
          }
          onKeyDown?.(e);
        }}
        onBlur={onBlur} />
      {(showSug || hint) && (
        <div className="fx-pop">
          {showSug && suggestions.map((s, i) => (
            <div key={s.label} className={`fx-sug ${i === hi ? "hi" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); accept(s); }}>
              <span className={`fx-kind ${s.kind}`}>{s.kind === "fn" ? "ƒx" : s.kind === "name" ? "≡" : "▤"}</span>
              {s.label}
              {s.kind === "fn" && HINTS[s.label] && <span className="fx-sig">{HINTS[s.label]}</span>}
            </div>
          ))}
          {hint && <div className="fx-hint">{hint}</div>}
        </div>
      )}
    </span>
  );
}
