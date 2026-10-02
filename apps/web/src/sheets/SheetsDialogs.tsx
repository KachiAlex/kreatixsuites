// Kreatix Sheets — dialogs for the Excel-parity batch (S19):
//   Insert Link, Insert Symbol, Function Wizard, floating Picture,
//   Scenario Manager, Data Table, Solver, spell-check panel.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { SUPPORTED_FORMULAS } from "hot-formula-parser";
import type { CellData, CellStyle, CommentThread, RichRun, Scenario, SheetData, SheetObject, Workbook } from "./model";
import { parseA1, parseRange, richStyleKey } from "./model";
import { SYMBOL_GROUPS } from "../writer/SpecialChars";
import { checkWord, suggest, addToDict, getCustomDict, spellcheckText, docVocabulary } from "../writer/proofing";
import { refsInRangeText, runDataTable, runSolver, type SolverConstraint } from "./whatif";
import type { ReactNode } from "react";

const inp: CSSProperties = { width: "100%", padding: "6px 8px", border: "1px solid var(--line,#E0DCD8)", borderRadius: 6, fontSize: 12, boxSizing: "border-box" };
const sel: CSSProperties = { padding: "6px 8px", border: "1px solid var(--line,#E0DCD8)", borderRadius: 6, fontSize: 12, background: "var(--surface)" };
const Back = ({ onClose, children, width }: { onClose: () => void; children: ReactNode; width?: number }) => (
  <div className="dlg-back" onClick={onClose}>
    <div className="dlg" style={width ? { width } : undefined} onClick={(e) => e.stopPropagation()}>{children}</div>
  </div>
);

// ---------- S19.1 Insert Link ----------

export function LinkDialog({ wb, sheetName, initialText, initialLink, onInsert, onRemove, onClose }: {
  wb: Workbook; sheetName: string;
  initialText?: string; initialLink?: string;
  onInsert: (text: string, link: string) => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initialText ?? "");
  const [url, setUrl] = useState(initialLink ?? "");
  const internal = url.startsWith("#");
  const [dest, setDest] = useState(() => internal ? url.slice(1) : `${sheetName}!A1`);
  const ok = internal ? !!parseRefListDest(dest, wb) : url.trim().length > 0;
  return (
    <Back onClose={onClose} width={400}>
      <h3>Insert link</h3>
      <label className="frow" style={{ display: "block", fontSize: 12 }}>
        Text to display
        <input style={inp} value={text} onChange={(e) => setText(e.target.value)} placeholder="Link text" autoFocus />
      </label>
      <div className="frow" style={{ gap: 12, margin: "10px 0 6px" }}>
        <label style={{ fontSize: 12 }}><input type="radio" checked={!internal} onChange={() => setUrl(url.startsWith("#") ? "" : url)} /> Web address</label>
        <label style={{ fontSize: 12 }}><input type="radio" checked={internal} onChange={() => setUrl(`#${dest}`)} /> Place in this workbook</label>
      </div>
      {!internal ? (
        <input style={inp} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" />
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <select style={sel} value={dest.split("!")[0]} onChange={(e) => {
            const ref = dest.includes("!") ? dest.split("!")[1] : "A1";
            setDest(`${e.target.value}!${ref}`); setUrl(`#${e.target.value}!${ref}`);
          }}>
            {wb.sheets.map((s) => <option key={s.name}>{s.name}</option>)}
          </select>
          <input style={{ ...inp, width: 110 }} value={dest.split("!")[1] ?? "A1"} onChange={(e) => {
            setDest(`${dest.split("!")[0]}!${e.target.value.toUpperCase()}`);
            setUrl(`#${dest.split("!")[0]}!${e.target.value.toUpperCase()}`);
          }} placeholder="A1" />
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        {onRemove && <button className="btn-ghost btn-sm" style={{ marginRight: "auto" }} onClick={() => { onRemove(); onClose(); }}>Remove link</button>}
        <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
        <button className="btn-primary btn-sm" disabled={!ok} onClick={() => { onInsert(text.trim() || url, internal ? `#${dest}` : url.trim()); onClose(); }}>Insert</button>
      </div>
    </Back>
  );
}
const parseRefListDest = (dest: string, wb: Workbook) => {
  const [sn, ref] = dest.split("!");
  if (!wb.sheets.some((s) => s.name === sn)) return null;
  return ref?.includes(":") ? parseRange(ref) : parseA1(ref ?? "");
};

// ---------- S19.16 Threaded cell comments ----------

export function CommentDialog({ cellRef, thread, me, canEdit, onReply, onResolve, onDelete, onClose }: {
  cellRef: string;
  thread?: CommentThread;
  me: string;
  canEdit: boolean;
  onReply: (text: string) => void;
  onResolve?: (resolved: boolean) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const replies = thread?.replies ?? [];
  return (
    <Back onClose={onClose} width={360}>
      <h3>Comments — {cellRef}</h3>
      {thread?.resolved && <p style={{ fontSize: 11, color: "#1E7B3C", margin: "0 0 6px" }}>✓ Resolved</p>}
      <div style={{ maxHeight: 260, overflowY: "auto" }}>
        {replies.length === 0 && <p style={{ fontSize: 12, color: "var(--muted)" }}>No comments yet — start the thread below.</p>}
        {replies.map((r, i) => (
          <div key={i} style={{ padding: "7px 0", borderBottom: "1px solid var(--line,#EEE)" }}>
            <div style={{ fontSize: 10, color: "var(--muted)" }}>
              <b style={{ color: "var(--ink)" }}>{r.by || "Anonymous"}</b> · {new Date(r.at).toLocaleString()}
            </div>
            <div style={{ fontSize: 12, marginTop: 2, whiteSpace: "pre-wrap" }}>{r.text}</div>
          </div>
        ))}
      </div>
      {canEdit && (
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <input style={{ ...inp, flex: 1 }} value={text} placeholder={replies.length ? "Reply…" : `Comment as ${me}…`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) { onReply(text.trim()); setText(""); } }} />
          <button className="btn-primary btn-sm" disabled={!text.trim()}
            onClick={() => { onReply(text.trim()); setText(""); }}>Post</button>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        {onDelete && <button className="btn-ghost btn-sm" style={{ marginRight: "auto" }} onClick={() => { onDelete(); onClose(); }}>Delete thread</button>}
        {onResolve && <button className="btn-ghost btn-sm" onClick={() => onResolve(!thread?.resolved)}>{thread?.resolved ? "Reopen" : "Resolve"}</button>}
        <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
      </div>
    </Back>
  );
}

// ---------- S19.5 Insert Symbol ----------

export function SymbolDialog({ onPick, onClose }: { onPick: (ch: string) => void; onClose: () => void }) {
  const [group, setGroup] = useState<keyof typeof SYMBOL_GROUPS>("Symbols");
  return (
    <Back onClose={onClose} width={360}>
      <h3>Insert symbol</h3>
      <div className="sc-tabs">
        {(Object.keys(SYMBOL_GROUPS) as (keyof typeof SYMBOL_GROUPS)[]).map((g) => (
          <button key={g} className={`sc-tab ${group === g ? "on" : ""}`} onClick={() => setGroup(g)}>{g}</button>
        ))}
      </div>
      <div className="sc-grid">
        {SYMBOL_GROUPS[group].map((ch) => (
          <button key={ch} className="sc-char" onClick={() => { onPick(ch); onClose(); }}>{ch}</button>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
        <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
      </div>
    </Back>
  );
}

// ---------- S19.10 In-cell rich text ----------

/** Convert run styles → inline CSS for the editor's initial markup. */
const runToStyle = (s?: Partial<CellStyle>): string => !s ? "" : [
  s.b ? "font-weight:700" : "", s.i ? "font-style:italic" : "",
  s.u || s.st ? `text-decoration:${[s.u ? "underline" : "", s.st ? "line-through" : ""].filter(Boolean).join(" ")}` : "",
  s.color ? `color:${s.color}` : "", s.bg ? `background:${s.bg}` : "",
  s.font ? `font-family:${s.font}` : "", s.size ? `font-size:${s.size}px` : "",
].filter(Boolean).join(";");

const escHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Walk the editor DOM → runs via computed styles, diffed against the
 *  baseline (the container's own defaults). Deterministic regardless of the
 *  markup execCommand produced. */
function domToRuns(root: HTMLElement): RichRun[] {
  const base = getComputedStyle(root);
  const out: RichRun[] = [];
  const walk = (el: Node) => {
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node as HTMLElement).tagName;
        if (tag === "BR") { out.push({ t: "\n" }); continue; }
        // contentEditable wraps Enter-lines in <div>/<p> — a boundary newline
        if ((tag === "DIV" || tag === "P") && node.previousSibling) out.push({ t: "\n" });
      }
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent ?? "";
        if (!t) continue;
        const cs = getComputedStyle(node.parentElement ?? root);
        const s: Partial<CellStyle> = {};
        if (Number(cs.fontWeight) >= 600 || cs.fontWeight === "bold") s.b = true;
        if (cs.fontStyle === "italic") s.i = true;
        if (cs.textDecorationLine.includes("underline")) s.u = true;
        if (cs.textDecorationLine.includes("line-through")) s.st = true;
        if (cs.color !== base.color) s.color = cs.color;
        if (cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent" && cs.backgroundColor !== base.backgroundColor) s.bg = cs.backgroundColor;
        if (cs.fontFamily !== base.fontFamily) s.font = cs.fontFamily.replace(/^["']|["']$/g, "");
        if (parseFloat(cs.fontSize) !== parseFloat(base.fontSize)) s.size = parseFloat(cs.fontSize);
        out.push({ t, s: richStyleKey(s) ? s : undefined });
      } else walk(node);
    }
  };
  walk(root);
  // merge adjacent identical runs
  const merged: RichRun[] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && richStyleKey(last.s) === richStyleKey(r.s)) last.t += r.t;
    else merged.push(r);
  }
  return merged;
}

export function RichTextDialog({ cell, onSave, onClose }: {
  cell: CellData | undefined;
  onSave: (text: string, rt?: RichRun[]) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => {
    const v = cell?.v;
    const rt = cell?.rt;
    if (typeof v !== "string") return escHtml(String(v ?? ""));
    if (rt?.length && rt.map((r) => r.t).join("") === v)
      return rt.map((r) => r.s ? `<span style="${runToStyle(r.s)}">${escHtml(r.t)}</span>` : escHtml(r.t)).join("");
    return escHtml(v);
  }, [cell]);
  useEffect(() => { document.execCommand("styleWithCSS", false, "true"); ref.current?.focus(); }, []);
  const fmt = (cmd: string, val?: string) => { ref.current?.focus(); document.execCommand(cmd, false, val); };
  const save = () => {
    const el = ref.current;
    if (!el) return;
    const text = el.innerText.replace(/\n$/, "");
    const rt = domToRuns(el);
    onSave(text, rt.some((r) => r.s) ? rt : undefined);
    onClose();
  };
  return (
    <Back onClose={onClose} width={440}>
      <h3>Format cell text</h3>
      <div className="frow" style={{ gap: 4, marginTop: 6 }}>
        <button className="btn-ghost btn-sm" style={{ fontWeight: 700 }} onMouseDown={(e) => e.preventDefault()} onClick={() => fmt("bold")}>B</button>
        <button className="btn-ghost btn-sm" style={{ fontStyle: "italic" }} onMouseDown={(e) => e.preventDefault()} onClick={() => fmt("italic")}>I</button>
        <button className="btn-ghost btn-sm" style={{ textDecoration: "underline" }} onMouseDown={(e) => e.preventDefault()} onClick={() => fmt("underline")}>U</button>
        <button className="btn-ghost btn-sm" style={{ textDecoration: "line-through" }} onMouseDown={(e) => e.preventDefault()} onClick={() => fmt("strikeThrough")}>S</button>
        <label className="btn-ghost btn-sm" style={{ cursor: "pointer", padding: "3px 8px" }} title="Text color">A
          <input type="color" style={{ position: "absolute", opacity: 0, width: 0 }} onChange={(e) => fmt("foreColor", e.target.value)} /></label>
        <label className="btn-ghost btn-sm" style={{ cursor: "pointer", padding: "3px 8px" }} title="Highlight">▨
          <input type="color" style={{ position: "absolute", opacity: 0, width: 0 }} onChange={(e) => fmt("hiliteColor", e.target.value)} /></label>
        <select style={sel} onChange={(e) => e.target.value && fmt("fontName", e.target.value)} defaultValue="">
          <option value="">Font…</option>
          {["Inter", "Arial", "Calibri", "Cambria", "Consolas", "Courier New", "Georgia", "Segoe UI", "Times New Roman", "Verdana"].map((f) => <option key={f}>{f}</option>)}
        </select>
        <select style={sel} onChange={(e) => e.target.value && fmt("fontSize", e.target.value)} defaultValue="">
          <option value="">Size…</option>
          {[["1", "8"], ["2", "10"], ["3", "12"], ["4", "14"], ["5", "18"], ["6", "24"], ["7", "32"]].map(([l, px]) => <option key={l} value={l}>{px}px</option>)}
        </select>
      </div>
      <div ref={ref} contentEditable suppressContentEditableWarning
        style={{ minHeight: 70, marginTop: 10, padding: 8, border: "1px solid var(--line,#E0DCD8)", borderRadius: 6, fontSize: 13, outline: "none", whiteSpace: "pre-wrap" }}
        dangerouslySetInnerHTML={{ __html: html }} />
      <p style={{ fontSize: 11, color: "var(--muted)", margin: "6px 0 0" }}>
        Select text, then apply formatting — saves as rich runs on the cell.
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
        <button className="btn-primary btn-sm" onClick={save}>Save</button>
      </div>
    </Back>
  );
}

// ---------- S19.8 Function Wizard ----------

interface FnMeta { cat: string; sig: string; desc: string; args: string[] }
const FN_META: Record<string, FnMeta> = {
  SUM: { cat: "Math", sig: "SUM(n1, [n2], …)", desc: "Adds all the numbers in a range of cells.", args: ["number1", "number2"] },
  AVERAGE: { cat: "Statistical", sig: "AVERAGE(n1, [n2], …)", desc: "Returns the average (arithmetic mean) of its arguments.", args: ["number1", "number2"] },
  COUNT: { cat: "Statistical", sig: "COUNT(v1, [v2], …)", desc: "Counts how many numbers are in the list of arguments.", args: ["value1", "value2"] },
  COUNTA: { cat: "Statistical", sig: "COUNTA(v1, [v2], …)", desc: "Counts how many values are in the list of arguments.", args: ["value1", "value2"] },
  COUNTIF: { cat: "Statistical", sig: "COUNTIF(range, criteria)", desc: "Counts the number of cells that meet a criterion.", args: ["range", "criteria"] },
  COUNTIFS: { cat: "Statistical", sig: "COUNTIFS(range1, crit1, …)", desc: "Counts cells that meet multiple criteria.", args: ["criteria_range1", "criteria1"] },
  MAX: { cat: "Statistical", sig: "MAX(n1, [n2], …)", desc: "Returns the largest value in a set of values.", args: ["number1", "number2"] },
  MIN: { cat: "Statistical", sig: "MIN(n1, [n2], …)", desc: "Returns the smallest value in a set of values.", args: ["number1", "number2"] },
  MEDIAN: { cat: "Statistical", sig: "MEDIAN(n1, …)", desc: "Returns the median of the given numbers.", args: ["number1"] },
  STDEV: { cat: "Statistical", sig: "STDEV(n1, …)", desc: "Estimates standard deviation based on a sample.", args: ["number1"] },
  IF: { cat: "Logical", sig: "IF(test, if_true, [if_false])", desc: "Returns one value if a condition is true and another if it's false.", args: ["logical_test", "value_if_true", "value_if_false"] },
  IFS: { cat: "Logical", sig: "IFS(test1, val1, …)", desc: "Checks whether one or more conditions are met and returns the value of the first TRUE condition.", args: ["logical_test1", "value_if_true1"] },
  AND: { cat: "Logical", sig: "AND(t1, [t2], …)", desc: "Returns TRUE if all of its arguments are TRUE.", args: ["logical1", "logical2"] },
  OR: { cat: "Logical", sig: "OR(t1, [t2], …)", desc: "Returns TRUE if any argument is TRUE.", args: ["logical1", "logical2"] },
  NOT: { cat: "Logical", sig: "NOT(test)", desc: "Reverses the logic of its argument.", args: ["logical"] },
  IFERROR: { cat: "Logical", sig: "IFERROR(value, fallback)", desc: "Returns a value you specify if a formula evaluates to an error; otherwise, returns the result.", args: ["value", "value_if_error"] },
  IFNA: { cat: "Logical", sig: "IFNA(value, if_na)", desc: "Returns the value you specify if the expression resolves to #N/A.", args: ["value", "value_if_na"] },
  VLOOKUP: { cat: "Lookup", sig: "VLOOKUP(key, table, col, [approx])", desc: "Looks for a value in the leftmost column of a table and returns a value in the same row from a column you specify.", args: ["lookup_value", "table_array", "col_index_num", "range_lookup"] },
  HLOOKUP: { cat: "Lookup", sig: "HLOOKUP(key, table, row, [approx])", desc: "Looks for a value in the top row of a table and returns a value in the same column.", args: ["lookup_value", "table_array", "row_index_num", "range_lookup"] },
  XLOOKUP: { cat: "Lookup", sig: "XLOOKUP(key, lookup, return, [if_na])", desc: "Searches a range or array and returns the item corresponding to the first match it finds.", args: ["lookup_value", "lookup_array", "return_array", "if_not_found"] },
  INDEX: { cat: "Lookup", sig: "INDEX(range, row, [col])", desc: "Returns a value or the reference to a value from within a table or range.", args: ["array", "row_num", "column_num"] },
  MATCH: { cat: "Lookup", sig: "MATCH(key, range, [0|1|-1])", desc: "Returns the relative position of an item in an array that matches a specified value.", args: ["lookup_value", "lookup_array", "match_type"] },
  LOOKUP: { cat: "Lookup", sig: "LOOKUP(key, vector, [result])", desc: "Looks in a one-row or one-column range and returns a value from the same position in a second range.", args: ["lookup_value", "lookup_vector", "result_vector"] },
  OFFSET: { cat: "Lookup", sig: "OFFSET(ref, rows, cols, [h], [w])", desc: "Returns a reference to a range that is a given number of rows and columns from a given reference.", args: ["reference", "rows", "cols", "height", "width"] },
  INDIRECT: { cat: "Lookup", sig: "INDIRECT(\"A1\" | \"Sheet!A1\")", desc: "Returns the reference specified by a text string.", args: ["ref_text"] },
  SUMIF: { cat: "Math", sig: "SUMIF(range, criteria, [sum_range])", desc: "Adds the cells specified by a given criteria.", args: ["range", "criteria", "sum_range"] },
  SUMIFS: { cat: "Math", sig: "SUMIFS(sum_range, crit_range1, crit1, …)", desc: "Adds the cells in a range that meet multiple criteria.", args: ["sum_range", "criteria_range1", "criteria1"] },
  AVERAGEIF: { cat: "Math", sig: "AVERAGEIF(range, criteria, [avg_range])", desc: "Returns the average of all cells that meet a criterion.", args: ["range", "criteria", "average_range"] },
  ROUND: { cat: "Math", sig: "ROUND(n, digits)", desc: "Rounds a number to a specified number of digits.", args: ["number", "num_digits"] },
  ROUNDUP: { cat: "Math", sig: "ROUNDUP(n, digits)", desc: "Rounds a number up, away from zero.", args: ["number", "num_digits"] },
  ROUNDDOWN: { cat: "Math", sig: "ROUNDDOWN(n, digits)", desc: "Rounds a number down, toward zero.", args: ["number", "num_digits"] },
  ABS: { cat: "Math", sig: "ABS(n)", desc: "Returns the absolute value of a number.", args: ["number"] },
  MOD: { cat: "Math", sig: "MOD(n, d)", desc: "Returns the remainder from division.", args: ["number", "divisor"] },
  POWER: { cat: "Math", sig: "POWER(n, p)", desc: "Returns the result of a number raised to a power.", args: ["number", "power"] },
  SQRT: { cat: "Math", sig: "SQRT(n)", desc: "Returns a positive square root.", args: ["number"] },
  RAND: { cat: "Math", sig: "RAND()", desc: "Returns a random number between 0 and 1.", args: [] },
  RANDBETWEEN: { cat: "Math", sig: "RANDBETWEEN(low, high)", desc: "Returns a random number between the numbers you specify.", args: ["bottom", "top"] },
  SEQUENCE: { cat: "Math", sig: "SEQUENCE(rows, [cols], [start], [step])", desc: "Generates a list of sequential numbers in an array.", args: ["rows", "columns", "start", "step"] },
  SUBTOTAL: { cat: "Math", sig: "SUBTOTAL(fn_num, ref1, …)", desc: "Returns a subtotal in a list or database (9=SUM, 1=AVERAGE, 2=COUNT, …).", args: ["function_num", "ref1"] },
  LEFT: { cat: "Text", sig: "LEFT(text, [n])", desc: "Returns the first character(s) in a text string.", args: ["text", "num_chars"] },
  RIGHT: { cat: "Text", sig: "RIGHT(text, [n])", desc: "Returns the last character(s) in a text string.", args: ["text", "num_chars"] },
  MID: { cat: "Text", sig: "MID(text, start, n)", desc: "Returns characters from the middle of a text string.", args: ["text", "start_num", "num_chars"] },
  LEN: { cat: "Text", sig: "LEN(text)", desc: "Returns the number of characters in a text string.", args: ["text"] },
  TRIM: { cat: "Text", sig: "TRIM(text)", desc: "Removes spaces from text.", args: ["text"] },
  UPPER: { cat: "Text", sig: "UPPER(text)", desc: "Converts text to uppercase.", args: ["text"] },
  LOWER: { cat: "Text", sig: "LOWER(text)", desc: "Converts text to lowercase.", args: ["text"] },
  CONCAT: { cat: "Text", sig: "CONCAT(t1, [t2], …)", desc: "Combines the text from multiple ranges and/or strings.", args: ["text1", "text2"] },
  TEXTJOIN: { cat: "Text", sig: "TEXTJOIN(delim, ignore_empty, t1, …)", desc: "Combines text from multiple ranges with a delimiter.", args: ["delimiter", "ignore_empty", "text1"] },
  SUBSTITUTE: { cat: "Text", sig: "SUBSTITUTE(text, old, new, [occ])", desc: "Substitutes new text for old text in a text string.", args: ["text", "old_text", "new_text", "instance_num"] },
  TEXT: { cat: "Text", sig: "TEXT(value, format)", desc: "Formats a number and converts it to text.", args: ["value", "format_text"] },
  VALUE: { cat: "Text", sig: "VALUE(text)", desc: "Converts a text argument to a number.", args: ["text"] },
  FIND: { cat: "Text", sig: "FIND(find, within, [start])", desc: "Finds one text value within another (case-sensitive).", args: ["find_text", "within_text", "start_num"] },
  REPLACE: { cat: "Text", sig: "REPLACE(old, start, n, new)", desc: "Replaces characters within text.", args: ["old_text", "start_num", "num_chars", "new_text"] },
  DATE: { cat: "Date", sig: "DATE(year, month, day)", desc: "Returns the serial number of a particular date.", args: ["year", "month", "day"] },
  TODAY: { cat: "Date", sig: "TODAY()", desc: "Returns the serial number of today's date.", args: [] },
  NOW: { cat: "Date", sig: "NOW()", desc: "Returns the serial number of the current date and time.", args: [] },
  YEAR: { cat: "Date", sig: "YEAR(date)", desc: "Converts a serial number to a year.", args: ["serial_number"] },
  MONTH: { cat: "Date", sig: "MONTH(date)", desc: "Converts a serial number to a month.", args: ["serial_number"] },
  DAY: { cat: "Date", sig: "DAY(date)", desc: "Converts a serial number to a day of the month.", args: ["serial_number"] },
  EOMONTH: { cat: "Date", sig: "EOMONTH(start, months)", desc: "Returns the serial number of the last day of the month before or after a specified number of months.", args: ["start_date", "months"] },
  EDATE: { cat: "Date", sig: "EDATE(start, months)", desc: "Returns the serial number of the date that is the indicated number of months before or after the start date.", args: ["start_date", "months"] },
  DATEDIF: { cat: "Date", sig: "DATEDIF(start, end, \"y\"|\"m\"|\"d\")", desc: "Calculates the number of days, months, or years between two dates.", args: ["start_date", "end_date", "unit"] },
  PMT: { cat: "Financial", sig: "PMT(rate, nper, pv, [fv], [type])", desc: "Calculates the payment for a loan based on constant payments and a constant interest rate.", args: ["rate", "nper", "pv", "fv", "type"] },
  NPV: { cat: "Financial", sig: "NPV(rate, v1, …)", desc: "Calculates net present value of an investment based on a discount rate and a series of future payments and income.", args: ["rate", "value1"] },
  IRR: { cat: "Financial", sig: "IRR(values, [guess])", desc: "Returns the internal rate of return for a series of cash flows.", args: ["values", "guess"] },
  HYPERLINK: { cat: "Lookup", sig: "HYPERLINK(url, [friendly_name])", desc: "Creates a shortcut that opens a document stored on a server, intranet or the web.", args: ["link_location", "friendly_name"] },
  LET: { cat: "Logical", sig: "LET(name1, val1, …, calc)", desc: "Assigns names to calculation results to allow storing intermediate values inside a formula.", args: ["name1", "name_value1", "calculation"] },
  LAMBDA: { cat: "Logical", sig: "LAMBDA(param, …, calc)", desc: "Creates a reusable custom function that can be called with friendly names.", args: ["parameter", "calculation"] },
};
const EXTRA_FNS = ["VLOOKUP","HLOOKUP","INDEX","MATCH","OFFSET","INDIRECT","LOOKUP","XLOOKUP","IFS","TEXTJOIN","CONCAT","DATEDIF","SEQUENCE","RANDARRAY","IFERROR","IFNA","NA"];
const MOST_FNS = ["SUM", "AVERAGE", "IF", "VLOOKUP", "COUNT", "COUNTIF", "SUMIF", "MAX", "MIN", "TODAY"];

export function FunctionWizard({ wb: _wb, initial, onInsert, onClose }: {
  wb: Workbook;
  /** formula text already in the cell (without "="), if any */
  initial?: string;
  onInsert: (formula: string) => void;
  onClose: () => void;
}) {
  const all = useMemo(() => {
    const set = new Set([...SUPPORTED_FORMULAS.map((f) => f.toUpperCase()), ...EXTRA_FNS, "HYPERLINK"]);
    return [...set].filter((f) => !f.startsWith("KX")).sort();
  }, []);
  const cats = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const f of all) {
      const cat = FN_META[f]?.cat ?? "More";
      if (!m.has(cat)) m.set(cat, []);
      m.get(cat)!.push(f);
    }
    return ["Most used", ...[...m.keys()].sort(), "All"] as const;
  }, [all]);
  const [cat, setCat] = useState<string>("Most used");
  const [fn, setFn] = useState<string>(() => initial?.match(/^\s*([A-Za-z_][\w.]*)\s*\(/)?.[1]?.toUpperCase() ?? "SUM");
  const [q, setQ] = useState("");
  const [argVals, setArgVals] = useState<string[]>([]);
  const list = useMemo(() => {
    let l = cat === "All" ? all : cat === "Most used" ? MOST_FNS.filter((f) => all.includes(f)) : all.filter((f) => FN_META[f]?.cat === cat);
    if (q.trim()) l = all.filter((f) => f.startsWith(q.trim().toUpperCase()));
    return l;
  }, [cat, all, q]);
  const meta = FN_META[fn];
  const sigArgs = meta?.args ?? [];
  // args joined positionally; trailing empties trimmed
  const argText = sigArgs.map((_, i) => argVals[i] ?? "").join(",").replace(/(, *)+$/, "");
  const formula = `${fn}(${argText})`;
  return (
    <Back onClose={onClose} width={520}>
      <h3>Insert function</h3>
      <input style={inp} placeholder="Search for a function…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
        <div style={{ width: 130, maxHeight: 220, overflowY: "auto", border: "1px solid var(--line,#E0DCD8)", borderRadius: 6 }}>
          {cats.map((c) => (
            <div key={c} className={`fx-wiz-cat ${cat === c ? "on" : ""}`} onClick={() => { setCat(c); setQ(""); }}>{c}</div>
          ))}
        </div>
        <div style={{ flex: 1, maxHeight: 220, overflowY: "auto", border: "1px solid var(--line,#E0DCD8)", borderRadius: 6 }}>
          {list.map((f) => (
            <div key={f} className={`fx-wiz-fn ${fn === f ? "on" : ""}`}
              onClick={() => setFn(f)} onDoubleClick={() => setFn(f)}>{f}</div>
          ))}
          {!list.length && <div style={{ padding: 10, fontSize: 12, color: "var(--muted)" }}>No matching functions</div>}
        </div>
      </div>
      <div style={{ margin: "12px 0 6px", fontSize: 12 }}>
        <b>{meta?.sig ?? `${fn}(…)`}</b>
        {meta && <div style={{ color: "var(--muted)", marginTop: 2 }}>{meta.desc}</div>}
      </div>
      {sigArgs.map((a, i) => (
        <div key={a + i} className="frow" style={{ marginTop: 6 }}>
          <span style={{ width: 150, fontSize: 12, color: "var(--ink)" }}>{a}</span>
          <input style={inp} value={argVals[i] ?? ""} placeholder="value or range"
            onChange={(e) => setArgVals((v) => { const n = [...v]; n[i] = e.target.value; return n; })} />
        </div>
      ))}
      <div style={{ marginTop: 10, fontSize: 12, fontFamily: "monospace", background: "#F8F6F4", padding: "6px 8px", borderRadius: 6 }}>
        ={formula}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
        <button className="btn-primary btn-sm" onClick={() => { onInsert(`=${formula}`); onClose(); }}>Insert</button>
      </div>
    </Back>
  );
}

// ---------- S19.3 Floating picture ----------

export function PictureDialog({ onInsert, onClose }: { onInsert: (obj: Omit<SheetObject, "id">) => void; onClose: () => void }) {
  const [src, setSrc] = useState("");
  const [alt, setAlt] = useState("");
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pickFile = (f: File) => {
    const rd = new FileReader();
    rd.onload = () => setSrc(String(rd.result));
    rd.readAsDataURL(f);
  };
  const size = nat ? Math.min(1, 320 / Math.max(nat.w, nat.h)) : 1;
  return (
    <Back onClose={onClose} width={380}>
      <h3>Insert picture</h3>
      <div className="frow" style={{ gap: 8 }}>
        <button className="btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>From file…</button>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
          onChange={(e) => e.target.files?.[0] && pickFile(e.target.files[0])} />
        <input style={{ ...inp, flex: 1 }} value={src.startsWith("data:") ? "" : src}
          placeholder="…or paste an image URL" onChange={(e) => setSrc(e.target.value)} />
      </div>
      {src && (
        <img src={src} alt="" style={{ maxWidth: "100%", maxHeight: 160, marginTop: 10, borderRadius: 6, border: "1px solid var(--line,#E0DCD8)" }}
          onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
      )}
      <input style={{ ...inp, marginTop: 10 }} value={alt} onChange={(e) => setAlt(e.target.value)} placeholder="Alt text (optional)" />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
        <button className="btn-primary btn-sm" disabled={!src} onClick={() => {
          onInsert({ kind: "image", src, alt: alt || undefined, x: 60, y: 60, w: nat ? nat.w * size : 200, h: nat ? nat.h * size : 120 });
          onClose();
        }}>Insert</button>
      </div>
    </Back>
  );
}

// ---------- S19.6 Scenario Manager ----------

export function ScenarioDialog({ sheet, selection, onAdd, onShow, onDelete, onClose }: {
  sheet: SheetData;
  /** selected refs captured when adding */
  selection: string;
  onAdd: (name: string) => void;
  onShow: (sc: Scenario) => void;
  onDelete: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const scenarios = sheet.scenarios ?? [];
  return (
    <Back onClose={onClose} width={420}>
      <h3>Scenario Manager</h3>
      {scenarios.length === 0 && <p style={{ fontSize: 12, color: "var(--muted)" }}>No scenarios yet. Select the input cells you want to vary, then add a scenario.</p>}
      {scenarios.map((sc) => (
        <div key={sc.name} className="frow" style={{ justifyContent: "space-between", borderBottom: "1px solid var(--line,#EEE)", padding: "6px 0" }}>
          <span style={{ fontSize: 12 }}>
            <b>{sc.name}</b>
            <span style={{ color: "var(--muted)", marginLeft: 8 }}>{Object.keys(sc.cells).join(", ")}</span>
          </span>
          <span style={{ display: "flex", gap: 4 }}>
            <button className="btn-ghost btn-sm" onClick={() => onShow(sc)}>Show</button>
            <button className="btn-ghost btn-sm" onClick={() => onDelete(sc.name)}>✕</button>
          </span>
        </div>
      ))}
      <div style={{ borderTop: "1px solid var(--line,#EEE)", marginTop: 10, paddingTop: 10 }}>
        <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 6px" }}>New scenario over {selection}</p>
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ ...inp, flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Scenario name (e.g. Best case)" />
          <button className="btn-primary btn-sm" disabled={!name.trim()} onClick={() => { onAdd(name.trim()); setName(""); }}>Add</button>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
        <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
      </div>
    </Back>
  );
}

// ---------- S19.6 Data Table ----------

export function DataTableDialog({ wb, sheetName, onApply, onClose }: {
  wb: Workbook; sheetName: string;
  onApply: (anchor: string, matrix: (number | string | null)[][]) => void;
  onClose: () => void;
}) {
  const sheet = wb.sheets.find((s) => s.name === sheetName);
  const formulaCells = useMemo(() => Object.keys(sheet?.cells ?? {}).filter((r) => sheet!.cells[r].f), [sheet]);
  const [fref, setFref] = useState(formulaCells[0] ?? "");
  const [in1, setIn1] = useState("");
  const [vals1, setVals1] = useState("");
  const [in2, setIn2] = useState("");
  const [vals2, setVals2] = useState("");
  const [anchor, setAnchor] = useState("");
  const [err, setErr] = useState("");
  const run = () => {
    const list = (s: string) => s.split(/[,\s;]+/).map((x) => x.trim()).filter(Boolean).map((x) => {
      // expand ranges like "1:5"? no — treat each token as a literal value/num
      const n = Number(x); return isNaN(n) ? x : n;
    });
    const res = runDataTable(wb, sheetName, {
      formulaRef: fref.trim().toUpperCase(),
      input1: in1.trim().toUpperCase(),
      values1: list(vals1),
      input2: in2.trim() ? in2.trim().toUpperCase() : undefined,
      values2: in2.trim() ? list(vals2) : undefined,
    });
    if (res.error) { setErr(res.error); return; }
    if (!parseA1(anchor.trim().toUpperCase())) { setErr("Enter a valid output cell (e.g. E2)"); return; }
    onApply(anchor.trim().toUpperCase(), res.matrix);
    onClose();
  };
  return (
    <Back onClose={onClose} width={440}>
      <h3>Data Table</h3>
      <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 10px" }}>
        Re-evaluates a formula while substituting input values — the what-if
        sensitivity grid. Two-var tables also emit a header row/column.
      </p>
      <label className="frow" style={{ display: "block", fontSize: 12 }}>
        Formula cell
        <input style={inp} list="kx-dt-f" value={fref} onChange={(e) => setFref(e.target.value)} placeholder="e.g. B8" />
        <datalist id="kx-dt-f">{formulaCells.map((r) => <option key={r} value={r} />)}</datalist>
      </label>
      <div className="frow" style={{ gap: 8, marginTop: 8 }}>
        <label style={{ flex: 1, fontSize: 12 }}>Input cell 1
          <input style={inp} value={in1} onChange={(e) => setIn1(e.target.value)} placeholder="e.g. B2" /></label>
        <label style={{ flex: 1.4, fontSize: 12 }}>Values (comma-sep)
          <input style={inp} value={vals1} onChange={(e) => setVals1(e.target.value)} placeholder="e.g. 2,4,6,8" /></label>
      </div>
      <div className="frow" style={{ gap: 8, marginTop: 8 }}>
        <label style={{ flex: 1, fontSize: 12 }}>Input cell 2 <span style={{ color: "var(--muted)" }}>(optional)</span>
          <input style={inp} value={in2} onChange={(e) => setIn2(e.target.value)} placeholder="e.g. B3" /></label>
        <label style={{ flex: 1.4, fontSize: 12 }}>Values (comma-sep)
          <input style={inp} value={vals2} onChange={(e) => setVals2(e.target.value)} placeholder="e.g. 10,20,30" /></label>
      </div>
      <label className="frow" style={{ display: "block", fontSize: 12, marginTop: 8 }}>
        Output anchor cell
        <input style={inp} value={anchor} onChange={(e) => setAnchor(e.target.value)} placeholder="e.g. E2" />
      </label>
      {err && <p style={{ color: "#C0392B", fontSize: 12 }}>{err}</p>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
        <button className="btn-primary btn-sm" disabled={!fref.trim() || !in1.trim() || !vals1.trim()} onClick={run}>Create table</button>
      </div>
    </Back>
  );
}

// ---------- S19.6 Solver ----------

export function SolverDialog({ wb, sheetName, anchorRef, onApply, onClose }: {
  wb: Workbook; sheetName: string; anchorRef: string;
  onApply: (values: Record<string, number>) => void;
  onClose: () => void;
}) {
  const [target, setTarget] = useState(anchorRef);
  const [sense, setSense] = useState<"max" | "min" | "value">("max");
  const [tval, setTval] = useState("0");
  const [changing, setChanging] = useState("");
  const [ints, setInts] = useState("");
  const [nonNeg, setNonNeg] = useState(true);
  const [cons, setCons] = useState<SolverConstraint[]>([]);
  const [nlhs, setNlhs] = useState(""); const [nop, setNop] = useState<SolverConstraint["op"]>("<="); const [nrhs, setNrhs] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const solve = () => {
    const res = runSolver(wb, sheetName, {
      targetRef: target.trim().toUpperCase(), sense,
      targetValue: sense === "value" ? Number(tval) : undefined,
      changing: refsInRangeText(changing),
      constraints: cons,
      integers: refsInRangeText(ints),
      nonNeg,
    });
    setResult(res);
    if (res.ok && res.values) onApply(res.values);
  };
  return (
    <Back onClose={onClose} width={480}>
      <h3>Solver</h3>
      <label className="frow" style={{ display: "block", fontSize: 12 }}>
        Set objective
        <input style={inp} value={target} onChange={(e) => setTarget(e.target.value)} />
      </label>
      <div className="frow" style={{ gap: 14, margin: "8px 0" }}>
        {([["max", "Max"], ["min", "Min"], ["value", "Value of"]] as const).map(([v, l]) => (
          <label key={v} style={{ fontSize: 12 }}>
            <input type="radio" checked={sense === v} onChange={() => setSense(v)} /> {l}
          </label>
        ))}
        {sense === "value" && <input style={{ ...inp, width: 80 }} type="number" value={tval} onChange={(e) => setTval(e.target.value)} />}
      </div>
      <label className="frow" style={{ display: "block", fontSize: 12 }}>
        By changing variable cells <span style={{ color: "var(--muted)" }}>(refs or ranges, comma-sep)</span>
        <input style={inp} value={changing} onChange={(e) => setChanging(e.target.value)} placeholder="e.g. B4:D4" />
      </label>
      <div style={{ margin: "8px 0 4px", fontSize: 12 }}>Subject to constraints:</div>
      {cons.map((c, i) => (
        <div key={i} className="frow" style={{ justifyContent: "space-between", fontSize: 12 }}>
          <span><b style={{ fontFamily: "monospace" }}>{c.lhs}</b> {c.op} {c.rhs}</span>
          <button className="btn-ghost btn-sm" onClick={() => setCons(cons.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <div className="frow" style={{ gap: 6, marginTop: 6 }}>
        <input style={{ ...inp, flex: 1.4 }} value={nlhs} onChange={(e) => setNlhs(e.target.value)} placeholder="cell ref, e.g. E5" />
        <select style={sel} value={nop} onChange={(e) => setNop(e.target.value as SolverConstraint["op"])}>
          <option>{"<="}</option><option>{">="}</option><option>{"="}</option>
        </select>
        <input style={{ ...inp, flex: 1 }} value={nrhs} onChange={(e) => setNrhs(e.target.value)} placeholder="value" type="number" />
        <button className="btn-ghost btn-sm" disabled={!nlhs.trim() || nrhs === ""}
          onClick={() => { setCons([...cons, { lhs: nlhs.trim().toUpperCase(), op: nop, rhs: Number(nrhs) }]); setNlhs(""); setNrhs(""); }}>Add</button>
      </div>
      <label className="frow" style={{ display: "block", fontSize: 12, marginTop: 8 }}>
        Integer cells <span style={{ color: "var(--muted)" }}>(subset of changing cells)</span>
        <input style={inp} value={ints} onChange={(e) => setInts(e.target.value)} placeholder="e.g. B4:D4" />
      </label>
      <label className="frow" style={{ fontSize: 12, marginTop: 8 }}>
        <input type="checkbox" checked={nonNeg} onChange={(e) => setNonNeg(e.target.checked)} /> Make unconstrained variables non-negative
      </label>
      {result && <p style={{ fontSize: 12, color: result.ok ? "#1E7B3C" : "#C0392B" }}>{result.message}</p>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
        <button className="btn-primary btn-sm" disabled={!changing.trim()} onClick={solve}>Solve</button>
      </div>
    </Back>
  );
}

// ---------- S19.4 Spell check panel ----------

export function SpellPanel({ sheet, onFix, onJump, onClose }: {
  sheet: SheetData;
  /** replace a whole-cell misspelling (cell-level fix) */
  onFix: (ref: string, from: number, to: number, word: string) => void;
  onJump: (ref: string) => void;
  onClose: () => void;
}) {
  const [sel, setSel] = useState(0);
  const misses = useMemo(() => {
    const out: { ref: string; word: string; from: number; to: number; text: string }[] = [];
    for (const [ref, cell] of Object.entries(sheet.cells)) {
      if (cell.f || typeof cell.v !== "string" || cell.v.startsWith("=")) continue;
      for (const m of spellcheckText(cell.v, 0)) {
        if (checkWord(m.word) || getCustomDict().has(m.word.toLowerCase())) continue;
        out.push({ ref, word: cell.v.slice(m.from, m.to), from: m.from, to: m.to, text: cell.v });
      }
    }
    return out;
  }, [sheet.cells]);
  const cur = misses[Math.min(sel, misses.length - 1)];
  return (
    <Back onClose={onClose} width={400}>
      <h3>Spelling</h3>
      {!misses.length && <p style={{ fontSize: 12, color: "var(--muted)" }}>Spell check complete — no issues found.</p>}
      {cur && (
        <>
          <p style={{ fontSize: 13 }}>
            <b style={{ color: "#C0392B", textDecoration: "underline wavy" }}>{cur.word}</b>
            <span style={{ color: "var(--muted)", marginLeft: 8 }}>in {cur.ref} · {sel + 1} of {misses.length}</span>
          </p>
          <div style={{ maxHeight: 160, overflowY: "auto", border: "1px solid var(--line,#EEE)", borderRadius: 6 }}>
            {suggest(cur.word, docVocabulary(cur.text), 6).map((s) => (
              <div key={s} className="fx-wiz-fn" onClick={() => onFix(cur.ref, cur.from, cur.to, s)}>
                {s}
              </div>
            ))}
            {!suggest(cur.word, docVocabulary(cur.text), 6).length && <div style={{ padding: 10, fontSize: 12, color: "var(--muted)" }}>No suggestions</div>}
          </div>
          <div className="frow" style={{ gap: 8, marginTop: 10 }}>
            <button className="btn-ghost btn-sm" onClick={() => setSel(sel + 1)}>Ignore</button>
            <button className="btn-ghost btn-sm" onClick={() => { addToDict(cur.word); setSel(sel); }}>Add to dictionary</button>
            <button className="btn-ghost btn-sm" onClick={() => onJump(cur.ref)}>Go to cell</button>
          </div>
        </>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
        <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
      </div>
    </Back>
  );
}
