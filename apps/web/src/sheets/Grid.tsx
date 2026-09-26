import { useMemo, useRef, useState, useEffect, type KeyboardEvent, type ClipboardEvent, type MouseEvent } from "react";
import type { SheetData, Range, Ref } from "./model";
import { colLabel, toA1, ROW_H, COL_W, HEADER_W, parseA1, rangeRefs, parseRange } from "./model";
import type { EvalResult } from "./engine";
import { formatValue } from "./format";
import { rangeToTSV } from "./io";

const HEADER_H = 26;

interface GridProps {
  sheet: SheetData;
  evals: Map<string, EvalResult>;
  canEdit: boolean;
  selection: Range;
  setSelection: (r: Range) => void;
  onCommit: (ref: string, raw: string) => void;
  onClear: (refs: string[]) => void;
  onPaste: (anchor: Ref, tsv: string) => void;
  onFillHandle: (src: Range, dst: Range) => void;
}

export function Grid({ sheet, evals, canEdit, selection, setSelection, onCommit, onClear, onPaste, onFillHandle }: GridProps) {
  const [editing, setEditing] = useState<{ ref: Ref; value: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const cols = useMemo(() => {
    const used = Object.keys(sheet.cells).map((r) => parseA1(r)!.col);
    return Math.max(16, Math.max(0, ...used) + 8, 26);
  }, [sheet.cells]);
  const rows = useMemo(() => {
    const used = Object.keys(sheet.cells).map((r) => parseA1(r)!.row);
    return Math.max(50, Math.max(0, ...used) + 25);
  }, [sheet.cells]);

  const colW = (c: number) => sheet.colWidths?.[c] ?? COL_W;
  const colX = useMemo(() => {
    const xs: number[] = [];
    let x = 0;
    for (let c = 0; c < cols; c++) { xs.push(x); x += colW(c); }
    return xs;
  }, [cols, sheet.colWidths]);

  const fz = sheet.freeze ?? { rows: 0, cols: 0 };
  const inSel = (c: number, r: number) => c >= selection.c1 && c <= selection.c2 && r >= selection.r1 && r <= selection.r2;

  const cfBg = useMemo(() => {
    const map = new Map<string, string>();
    for (const rule of sheet.cf ?? []) {
      const range = parseRange(rule.range);
      if (!range) continue;
      for (const ref of rangeRefs(range)) {
        const res = evals.get(ref);
        const cell = sheet.cells[ref];
        const v = Number(cell?.f ? res?.value : cell?.v);
        if (isNaN(v)) continue;
        const ok = rule.op === ">" ? v > rule.value : rule.op === "<" ? v < rule.value
          : rule.op === ">=" ? v >= rule.value : rule.op === "<=" ? v <= rule.value
          : rule.op === "=" ? v === rule.value : v !== rule.value;
        if (ok) map.set(ref, rule.bg);
      }
    }
    return map;
  }, [sheet.cf, sheet.cells, evals]);

  const startEdit = (ref: Ref, initial?: string) => {
    if (!canEdit) return;
    const cell = sheet.cells[toA1(ref.col, ref.row)];
    setEditing({ ref, value: initial ?? (cell?.f ? `=${cell.f}` : cell?.v === undefined || cell.v === null ? "" : String(cell.v)) });
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const commitEdit = (move?: { dc: number; dr: number }) => {
    if (!editing) return;
    if (editing.value.trim() !== "" || sheet.cells[toA1(editing.ref.col, editing.ref.row)]) {
      onCommit(toA1(editing.ref.col, editing.ref.row), editing.value);
    }
    setEditing(null);
    if (move) moveSel(editing.ref.col + move.dc, editing.ref.row + move.dr, false);
    containerRef.current?.focus();
  };

  const moveSel = (c: number, r: number, extend: boolean) => {
    const nc = Math.max(0, Math.min(cols - 1, c));
    const nr = Math.max(0, Math.min(rows - 1, r));
    setSelection(extend
      ? { c1: Math.min(selection.c1, nc), r1: Math.min(selection.r1, nr), c2: Math.max(selection.c2, nc), r2: Math.max(selection.r2, nr) }
      : { c1: nc, r1: nr, c2: nc, r2: nr });
  };

  const onKey = (e: KeyboardEvent) => {
    if (editing) return;
    const anchor = { col: selection.c1, row: selection.r1 };
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const d = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key]!;
      moveSel(anchor.col + d[0], anchor.row + d[1], e.shiftKey);
    } else if (e.key === "Enter") { e.preventDefault(); moveSel(anchor.col, anchor.row + (e.shiftKey ? -1 : 1), false); }
    else if (e.key === "Tab") { e.preventDefault(); moveSel(anchor.col + (e.shiftKey ? -1 : 1), anchor.row, false); }
    else if (e.key === "F2") { e.preventDefault(); startEdit(anchor); }
    else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (canEdit) onClear([...rangeRefs(selection)]);
    } else if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setSelection({ c1: 0, r1: 0, c2: cols - 1, r2: rows - 1 });
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && canEdit) {
      startEdit(anchor, e.key);
    }
  };

  const onCopy = (e: ClipboardEvent) => {
    if (editing) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", rangeToTSV(sheet, selection));
  };
  const onCut = (e: ClipboardEvent) => {
    if (editing) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", rangeToTSV(sheet, selection));
    if (canEdit) onClear([...rangeRefs(selection)]);
  };
  const onPasteCb = (e: ClipboardEvent) => {
    if (!canEdit || editing) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    onPaste({ col: selection.c1, row: selection.r1 }, text);
  };

  const cellMouse = (c: number, r: number, e: MouseEvent) => {
    if (e.type === "mousedown") {
      if (e.shiftKey) {
        setSelection({ c1: Math.min(selection.c1, c), r1: Math.min(selection.r1, r), c2: Math.max(selection.c2, c), r2: Math.max(selection.r2, r) });
      } else {
        setSelection({ c1: c, r1: r, c2: c, r2: r });
        setDragging(true);
      }
      containerRef.current?.focus();
    } else if (e.type === "mouseenter" && dragging) {
      setSelection({ c1: Math.min(selection.c1, c), r1: Math.min(selection.r1, r), c2: Math.max(selection.c2, c), r2: Math.max(selection.r2, r) });
    } else if (e.type === "dblclick") {
      startEdit({ col: c, row: r });
    }
  };
  useEffect(() => {
    const up = () => setDragging(false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const selRef = useRef(selection);
  selRef.current = selection;

  const selX = HEADER_W + colX[selection.c1];
  const selY = HEADER_H + selection.r1 * ROW_H;
  const selW = colX[selection.c2] + colW(selection.c2) - colX[selection.c1];
  const selH = (selection.r2 - selection.r1 + 1) * ROW_H;

  const frozenLeft = HEADER_W + (fz.cols ? colX[fz.cols - 1] + colW(fz.cols - 1) : 0);

  return (
    <div ref={containerRef} className="sheet-grid" tabIndex={0} onKeyDown={onKey}
      onCopy={onCopy} onCut={onCut} onPaste={onPasteCb}
      style={{ outline: "none" }}>
      <div className="grid-inner" style={{ position: "relative", width: HEADER_W + colX[cols - 1] + colW(cols - 1), height: HEADER_H + rows * ROW_H }}>
        <table className="grid-table" cellSpacing={0}>
          <thead>
            <tr>
              <th className="corner" style={{ position: "sticky", left: 0, top: 0, zIndex: 30 }}
                onMouseDown={() => setSelection({ c1: 0, r1: 0, c2: cols - 1, r2: rows - 1 })} />
              {Array.from({ length: cols }).map((_, c) => (
                <th key={c} className={`col-h ${c >= selection.c1 && c <= selection.c2 ? "sel" : ""}`}
                  style={{ position: "sticky", top: 0, zIndex: 20, width: colW(c), minWidth: colW(c) }}
                  onMouseDown={() => setSelection({ c1: c, r1: 0, c2: c, r2: rows - 1 })}>
                  {colLabel(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }).map((_, r) => (
              <tr key={r} style={{ height: ROW_H }}>
                <td className={`row-h ${r >= selection.r1 && r <= selection.r2 ? "sel" : ""}`}
                  style={{ position: "sticky", left: 0, zIndex: 15, ...(r < fz.rows ? { top: HEADER_H + r * ROW_H } : {}) }}
                  onMouseDown={() => setSelection({ c1: 0, r1: r, c2: cols - 1, r2: r })}>
                  {r + 1}
                </td>
                {Array.from({ length: cols }).map((__, c) => {
                  const ref = toA1(c, r);
                  const cell = sheet.cells[ref];
                  const res = evals.get(ref);
                  const s = cell?.s ?? {};
                  const sticky: React.CSSProperties = {};
                  let z = 1;
                  if (r < fz.rows) { sticky.position = "sticky"; sticky.top = HEADER_H + r * ROW_H; z = 10; }
                  if (c < fz.cols) { sticky.position = "sticky"; sticky.left = HEADER_W + colX[c]; z = Math.max(z, 10); }
                  if (r < fz.rows && c < fz.cols) z = 11;
                  return (
                    <td key={c}
                      className={`cell ${inSel(c, r) ? "in-sel" : ""} ${res?.error ? "err" : ""}`}
                      style={{
                        ...sticky, zIndex: z,
                        fontWeight: s.b ? 700 : 400, fontStyle: s.i ? "italic" : "normal",
                        textDecoration: s.u ? "underline" : "none",
                        color: s.color ?? "#26221F",
                        background: cfBg.get(ref) ?? s.bg ?? "#fff",
                        textAlign: s.align ?? (typeof (cell?.f ? res?.value : cell?.v) === "number" ? "right" : "left"),
                      }}
                      onMouseDown={(e) => cellMouse(c, r, e)}
                      onMouseEnter={(e) => cellMouse(c, r, e)}
                      onDoubleClick={(e) => cellMouse(c, r, e)}>
                      {editing?.ref.col === c && editing.ref.row === r ? null
                        : res?.error ?? formatValue(cell?.f ? res?.value : cell?.v, s.fmt)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        {/* selection frame */}
        <div className="sel-frame" style={{ left: selX, top: selY, width: selW, height: selH }}>
          {canEdit && <div className="fill-handle"
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              const src = { ...selection };
              const move = (ev: MouseEvent | globalThis.MouseEvent) => {
                const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("td.cell");
                if (el) {
                  const tr = el.parentElement!;
                  const rr = (tr as HTMLTableRowElement).rowIndex - 1;
                  const cc = (el as HTMLTableCellElement).cellIndex - 1;
                  setSelection({ c1: Math.min(src.c1, cc), r1: Math.min(src.r1, rr), c2: Math.max(src.c2, cc), r2: Math.max(src.r2, rr) });
                }
              };
              const up = () => {
                window.removeEventListener("mousemove", move as never);
                window.removeEventListener("mouseup", up);
                const dst = selRef.current;
                if (dst.c2 - dst.c1 !== src.c2 - src.c1 || dst.r2 - dst.r1 !== src.r2 - src.r1) onFillHandle(src, dst);
              };
              window.addEventListener("mousemove", move as never);
              window.addEventListener("mouseup", up);
            }} />}
        </div>

        {/* cell editor */}
        {editing && (
          <input ref={inputRef} className="cell-editor"
            style={{ left: HEADER_W + colX[editing.ref.col], top: HEADER_H + editing.ref.row * ROW_H, width: colW(editing.ref.col) + 60 }}
            value={editing.value}
            onChange={(e) => setEditing({ ...editing, value: e.target.value })}
            onBlur={() => commitEdit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitEdit({ dc: 0, dr: 1 }); }
              else if (e.key === "Tab") { e.preventDefault(); commitEdit({ dc: 1, dr: 0 }); }
              else if (e.key === "Escape") { setEditing(null); containerRef.current?.focus(); }
            }} />
        )}
        {/* freeze split indicators */}
        {fz.cols > 0 && <div className="freeze-v" style={{ left: frozenLeft }} />}
        {fz.rows > 0 && <div className="freeze-h" style={{ top: HEADER_H + fz.rows * ROW_H }} />}
      </div>
    </div>
  );
}
