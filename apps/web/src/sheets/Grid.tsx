import { useMemo, useRef, useState, useEffect, useCallback, Fragment, type KeyboardEvent, type ClipboardEvent, type MouseEvent, type CSSProperties } from "react";
import type { SheetData, Range, Ref } from "./model";
import { colLabel, toA1, ROW_H, COL_W, HEADER_W, parseA1, rangeRefs, parseRange } from "./model";
import type { EvalResult } from "./engine";
import { formatValue } from "./format";
import { rangeToTSV } from "./io";

const HEADER_H = 26;
const OVERSCAN_ROWS = 6;
const OVERSCAN_COLS = 3;

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

interface Run { start: number; end: number; gapBefore: number }

export function Grid({ sheet, evals, canEdit, selection, setSelection, onCommit, onClear, onPaste, onFillHandle }: GridProps) {
  const [editing, setEditing] = useState<{ ref: Ref; value: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [view, setView] = useState({ r0: 0, r1: 80, c0: 0, c1: 26 });
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // total dimensions: used range + comfortable margin
  const { cols, rows } = useMemo(() => {
    let mc = 0, mr = 0;
    for (const ref of Object.keys(sheet.cells)) {
      const p = parseA1(ref)!;
      mc = Math.max(mc, p.col); mr = Math.max(mr, p.row);
    }
    for (const m of sheet.merges ?? []) { mc = Math.max(mc, m.c2); mr = Math.max(mr, m.r2); }
    return { cols: Math.max(26, mc + 10), rows: Math.max(100, mr + 60) };
  }, [sheet.cells, sheet.merges]);

  const colW = useCallback((c: number) => sheet.colWidths?.[c] ?? COL_W, [sheet.colWidths]);
  const colX = useMemo(() => {
    const xs: number[] = [];
    let x = 0;
    for (let c = 0; c < cols; c++) { xs.push(x); x += colW(c); }
    return xs;
  }, [cols, colW]);
  const totalW = colX[cols - 1] + colW(cols - 1);
  const totalH = rows * ROW_H;

  const colAtX = useCallback((x: number) => {
    let lo = 0, hi = cols - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (colX[mid] + colW(mid) > x) hi = mid; else lo = mid + 1;
    }
    return lo;
  }, [cols, colX, colW]);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const r0 = Math.max(0, Math.floor(el.scrollTop / ROW_H) - OVERSCAN_ROWS);
    const r1 = Math.min(rows, Math.ceil((el.scrollTop + el.clientHeight) / ROW_H) + OVERSCAN_ROWS);
    const x = Math.max(0, el.scrollLeft - HEADER_W);
    const c0 = Math.max(0, colAtX(x) - OVERSCAN_COLS);
    const c1 = Math.min(cols, colAtX(x + el.clientWidth) + OVERSCAN_COLS);
    setView((v) => (v.r0 === r0 && v.r1 === r1 && v.c0 === c0 && v.c1 === c1) ? v : { r0, r1, c0, c1 });
  }, [rows, cols, colAtX]);

  useEffect(() => { onScroll(); }, [onScroll]);

  const fz = sheet.freeze ?? { rows: 0, cols: 0 };

  // rendered runs: frozen strips + window, expanded to fully cover any
  // intersecting merge (a merged td never spans a virtualized spacer)
  const { colRuns, rowRuns } = useMemo(() => {
    const colSet = new Set<number>();
    const rowSet = new Set<number>();
    for (let c = 0; c < Math.min(fz.cols, cols); c++) colSet.add(c);
    for (let r = 0; r < Math.min(fz.rows, rows); r++) rowSet.add(r);
    for (let c = Math.max(fz.cols, view.c0); c < Math.min(cols, view.c1); c++) colSet.add(c);
    for (let r = Math.max(fz.rows, view.r0); r < Math.min(rows, view.r1); r++) rowSet.add(r);
    for (let pass = 0; pass < 3; pass++) {
      let grew = false;
      for (const m of sheet.merges ?? []) {
        if ([...colSet].some((c) => c >= m.c1 && c <= m.c2) && [...rowSet].some((r) => r >= m.r1 && r <= m.r2)) {
          for (let c = m.c1; c <= m.c2; c++) if (!colSet.has(c)) { colSet.add(c); grew = true; }
          for (let r = m.r1; r <= m.r2; r++) if (!rowSet.has(r)) { rowSet.add(r); grew = true; }
        }
      }
      if (!grew) break;
    }
    const runs = (set: Set<number>): Run[] => {
      const out: Run[] = [];
      let prev = -1;
      for (const n of [...set].sort((a, b) => a - b)) {
        if (n !== prev + 1) out.push({ start: n, end: n, gapBefore: n - (prev + 1) });
        else out[out.length - 1].end = n;
        prev = n;
      }
      return out;
    };
    return { colRuns: runs(colSet), rowRuns: runs(rowSet) };
  }, [sheet.merges, fz.rows, fz.cols, view, rows, cols]);

  const mergeMaps = useMemo(() => {
    const covered = new Map<string, Range>();
    const heads = new Map<string, Range>();
    for (const m of sheet.merges ?? []) {
      heads.set(toA1(m.c1, m.r1), m);
      for (const ref of rangeRefs(m)) if (ref !== toA1(m.c1, m.r1)) covered.set(ref, m);
    }
    return { covered, heads };
  }, [sheet.merges]);

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
    const m = mergeMaps.covered.get(toA1(ref.col, ref.row));
    const target = m ? { col: m.c1, row: m.r1 } : ref;
    const cell = sheet.cells[toA1(target.col, target.row)];
    setEditing({ ref: target, value: initial ?? (cell?.f ? `=${cell.f}` : cell?.v === undefined || cell.v === null ? "" : String(cell.v)) });
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

  const ensureVisible = (c: number, r: number) => {
    const el = containerRef.current;
    if (!el) return;
    const top = HEADER_H + r * ROW_H, left = HEADER_W + colX[c];
    if (top < el.scrollTop + HEADER_H) el.scrollTop = top - HEADER_H;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    if (left < el.scrollLeft + HEADER_W) el.scrollLeft = left - HEADER_W;
    else if (left + colW(c) > el.scrollLeft + el.clientWidth) el.scrollLeft = left + colW(c) - el.clientWidth;
  };

  const inSel = (c: number, r: number) => c >= selection.c1 && c <= selection.c2 && r >= selection.r1 && r <= selection.r2;

  const moveSel = (c: number, r: number, extend: boolean) => {
    const nc = Math.max(0, Math.min(cols - 1, c));
    const nr = Math.max(0, Math.min(rows - 1, r));
    const m = mergeMaps.covered.get(toA1(nc, nr));
    const target: Range = m ? { c1: m.c1, r1: m.r1, c2: m.c2, r2: m.r2 }
      : { c1: nc, r1: nr, c2: nc, r2: nr };
    setSelection(extend
      ? { c1: Math.min(selection.c1, target.c1), r1: Math.min(selection.r1, target.r1), c2: Math.max(selection.c2, target.c2), r2: Math.max(selection.r2, target.r2) }
      : target);
    ensureVisible(nc, nr);
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
    const merge = mergeMaps.covered.get(toA1(c, r)) ?? mergeMaps.heads.get(toA1(c, r));
    const box: Range = merge ?? { c1: c, r1: r, c2: c, r2: r };
    if (e.type === "mousedown") {
      if (e.shiftKey) {
        setSelection({ c1: Math.min(selection.c1, box.c1), r1: Math.min(selection.r1, box.r1), c2: Math.max(selection.c2, box.c2), r2: Math.max(selection.r2, box.r2) });
      } else {
        setSelection(box);
        setDragging(true);
      }
      containerRef.current?.focus();
    } else if (e.type === "mouseenter" && dragging) {
      setSelection({ c1: Math.min(selection.c1, box.c1), r1: Math.min(selection.r1, box.r1), c2: Math.max(selection.c2, box.c2), r2: Math.max(selection.r2, box.r2) });
    } else if (e.type === "dblclick") {
      startEdit({ col: box.c1, row: box.r1 });
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

  const renderCell = (c: number, r: number) => {
    const ref = toA1(c, r);
    if (mergeMaps.covered.has(ref)) return null;
    const head = mergeMaps.heads.get(ref);
    const cell = sheet.cells[ref];
    const res = evals.get(ref);
    const s = cell?.s ?? {};
    const sticky: CSSProperties = {};
    let z = 1;
    if (r < fz.rows) { sticky.position = "sticky"; sticky.top = HEADER_H + r * ROW_H; z = 10; }
    if (c < fz.cols) { sticky.position = "sticky"; sticky.left = HEADER_W + colX[c]; z = Math.max(z, 10); }
    if (r < fz.rows && c < fz.cols) z = 11;
    const sel = head
      ? head.c1 >= selection.c1 && head.c2 <= selection.c2 && head.r1 >= selection.r1 && head.r2 <= selection.r2
      : inSel(c, r);
    return (
      <td key={c} data-c={c} data-r={r}
        colSpan={head ? head.c2 - head.c1 + 1 : 1}
        rowSpan={head ? head.r2 - head.r1 + 1 : 1}
        className={`cell ${sel ? "in-sel" : ""} ${res?.error ? "err" : ""}`}
        style={{
          ...sticky, zIndex: z,
          fontWeight: s.b ? 700 : 400, fontStyle: s.i ? "italic" : "normal",
          textDecoration: s.u ? "underline" : "none",
          color: s.color ?? "#26221F",
          background: cfBg.get(ref) ?? s.bg ?? "#fff",
          textAlign: s.align ?? (typeof (cell?.f ? res?.value : cell?.v) === "number" ? "right" : "left"),
          verticalAlign: head ? "middle" : undefined,
        }}
        onMouseDown={(e) => cellMouse(c, r, e)}
        onMouseEnter={(e) => cellMouse(c, r, e)}
        onDoubleClick={(e) => cellMouse(c, r, e)}>
        {editing?.ref.col === c && editing.ref.row === r ? null
          : res?.error ?? formatValue(cell?.f ? res?.value : cell?.v, s.fmt)}
      </td>
    );
  };

  return (
    <div ref={containerRef} className="sheet-grid" tabIndex={0} onKeyDown={onKey} onScroll={onScroll}
      onCopy={onCopy} onCut={onCut} onPaste={onPasteCb}
      style={{ outline: "none" }}>
      <div className="grid-inner" style={{ position: "relative", width: HEADER_W + totalW, height: HEADER_H + totalH }}>
        <table className="grid-table" cellSpacing={0}>
          <thead>
            <tr>
              <th className="corner" style={{ position: "sticky", left: 0, top: 0, zIndex: 30 }}
                onMouseDown={() => setSelection({ c1: 0, r1: 0, c2: cols - 1, r2: rows - 1 })} />
              {colRuns.map((run) => (
                <Fragment key={run.start}>
                  {run.gapBefore > 0 && (
                    <th className="col-h" style={{ position: "sticky", top: 0, zIndex: 20, width: colX[run.start] - colX[run.start - run.gapBefore], minWidth: colX[run.start] - colX[run.start - run.gapBefore] }} />
                  )}
                  {Array.from({ length: run.end - run.start + 1 }).map((_, i) => {
                    const c = run.start + i;
                    return (
                      <th key={c} className={`col-h ${c >= selection.c1 && c <= selection.c2 ? "sel" : ""}`}
                        style={{ position: "sticky", top: 0, zIndex: 20, width: colW(c), minWidth: colW(c) }}
                        onMouseDown={() => setSelection({ c1: c, r1: 0, c2: c, r2: rows - 1 })}>
                        {colLabel(c)}
                      </th>
                    );
                  })}
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowRuns.map((run) => (
              <Fragment key={run.start}>
                {run.gapBefore > 0 && (
                  <tr style={{ height: run.gapBefore * ROW_H }}>
                    <td className="row-h" style={{ position: "sticky", left: 0, zIndex: 15 }} />
                    <td colSpan={cols} style={{ background: "#fff", border: 0 }} />
                  </tr>
                )}
                {Array.from({ length: run.end - run.start + 1 }).map((_, i) => {
                  const r = run.start + i;
                  return (
                    <tr key={r} style={{ height: ROW_H }}>
                      <td className={`row-h ${r >= selection.r1 && r <= selection.r2 ? "sel" : ""}`}
                        style={{ position: "sticky", left: 0, zIndex: 15, ...(r < fz.rows ? { top: HEADER_H + r * ROW_H } : {}) }}
                        onMouseDown={() => setSelection({ c1: 0, r1: r, c2: cols - 1, r2: r })}>
                        {r + 1}
                      </td>
                      {colRuns.map((cr) => (
                        <Fragment key={cr.start}>
                          {cr.gapBefore > 0 && (
                            <td style={{ width: colX[cr.start] - colX[cr.start - cr.gapBefore], border: 0, background: "#fff" }} />
                          )}
                          {Array.from({ length: cr.end - cr.start + 1 }).map((__, ci) => renderCell(cr.start + ci, r))}
                        </Fragment>
                      ))}
                    </tr>
                  );
                })}
              </Fragment>
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
              const move = (ev: globalThis.MouseEvent) => {
                const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("td.cell") as HTMLElement | null;
                if (el?.dataset.c !== undefined && el.dataset.r !== undefined) {
                  const cc = Number(el.dataset.c), rr = Number(el.dataset.r);
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
