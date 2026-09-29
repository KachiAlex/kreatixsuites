import { useMemo, useRef, useState, useEffect, useCallback, Fragment, type KeyboardEvent, type ClipboardEvent, type MouseEvent, type CSSProperties } from "react";
import type { SheetData, Range, Ref, Workbook } from "./model";
import { colLabel, toA1, ROW_H, COL_W, HEADER_W, parseA1, rangeRefs, parseRange } from "./model";
import type { EvalResult } from "./engine";
import { formatValue } from "./format";
import { rangeToTSV, rangeToCells, setCopyBuffer } from "./io";
import { FxInput } from "./FxInput";

const HEADER_H = 26;
const OVERSCAN_ROWS = 6;
const OVERSCAN_COLS = 3;

interface GridProps {
  sheet: SheetData;
  evals: Map<string, EvalResult>;
  canEdit: boolean;
  wb?: Workbook;
  audit?: { refs: Set<string>; kind: "pre" | "dep" };
  /** all selected ranges — last = active */
  selections?: Range[];
  selection: Range;
  setSelection: (r: Range) => void;
  /** Ctrl+click — append a new range */
  addSelection?: (r: Range) => void;
  /** drag-extend the most recently added range */
  extendSelection?: (r: Range) => void;
  onCommit: (ref: string, raw: string) => void;
  onClear: (refs: string[]) => void;
  onPaste: (anchor: Ref, tsv: string) => void;
  onFillHandle: (src: Range, dst: Range) => void;
  /** set column width / row height (px) */
  onGeom?: (axis: "col" | "row", index: number, size: number) => void;
  /** insert/delete/hide/unhide from the header context menu */
  onHeader?: (action: "ins" | "del" | "hide" | "unhide", axis: "col" | "row", index: number) => void;
  /** refs violating a validation rule → red triangle marker */
  invalid?: Set<string>;
  /** list-validation dropdown for the anchor cell */
  listDrop?: { ref: string; items: string[] };
  /** cell with a note → marker (S3.5) */
  noted?: Set<string>;
  /** right-click a body cell → context menu (notes etc.) */
  onCellMenu?: (ref: string, x: number, y: number) => void;
}

interface Run { start: number; end: number; gapBefore: number }

export function Grid({ sheet, evals, canEdit, wb, audit, selections, selection, setSelection, addSelection, extendSelection, onCommit, onClear, onPaste, onFillHandle, onGeom, onHeader, invalid, listDrop, noted, onCellMenu }: GridProps) {
  const allSels = selections ?? [selection];
  const [editing, setEditing] = useState<{ ref: Ref; value: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [view, setView] = useState({ r0: 0, r1: 80, c0: 0, c1: 26 });
  const [resizePrev, setResizePrev] = useState<{ axis: "col" | "row"; i: number; size: number } | null>(null);
  const [hMenu, setHMenu] = useState<{ x: number; y: number; axis: "col" | "row"; index: number } | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const listRef = useRef(listDrop?.ref);
  if (listRef.current !== listDrop?.ref) { listRef.current = listDrop?.ref; setListOpen(false); }
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

  // geometry — variable col widths + row heights, live resize preview,
  // hidden = 0 size
  const hiddenR = useMemo(() => new Set(sheet.hiddenRows ?? []), [sheet.hiddenRows]);
  const hiddenC = useMemo(() => new Set(sheet.hiddenCols ?? []), [sheet.hiddenCols]);
  const colW = useCallback((c: number) =>
    resizePrev?.axis === "col" && resizePrev.i === c ? resizePrev.size
    : hiddenC.has(c) ? 0 : (sheet.colWidths?.[c] ?? COL_W), [sheet.colWidths, hiddenC, resizePrev]);
  const rowH = useCallback((r: number) =>
    resizePrev?.axis === "row" && resizePrev.i === r ? resizePrev.size
    : hiddenR.has(r) ? 0 : (sheet.rowHeights?.[r] ?? ROW_H), [sheet.rowHeights, hiddenR, resizePrev]);
  const colX = useMemo(() => {
    const xs: number[] = [];
    let x = 0;
    for (let c = 0; c < cols; c++) { xs.push(x); x += colW(c); }
    return xs;
  }, [cols, colW]);
  const rowY = useMemo(() => {
    const ys: number[] = [];
    let y = 0;
    for (let r = 0; r < rows; r++) { ys.push(y); y += rowH(r); }
    return ys;
  }, [rows, rowH]);
  const totalW = colX[cols - 1] + colW(cols - 1);
  const totalH = rowY[rows - 1] + rowH(rows - 1);

  const colAtX = useCallback((x: number) => {
    let lo = 0, hi = cols - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (colX[mid] + colW(mid) > x) hi = mid; else lo = mid + 1;
    }
    return lo;
  }, [cols, colX, colW]);
  const rowAtY = useCallback((y: number) => {
    let lo = 0, hi = rows - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rowY[mid] + rowH(mid) > y) hi = mid; else lo = mid + 1;
    }
    return lo;
  }, [rows, rowY, rowH]);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const r0 = Math.max(0, rowAtY(Math.max(0, el.scrollTop - HEADER_H)) - OVERSCAN_ROWS);
    const r1 = Math.min(rows, rowAtY(el.scrollTop - HEADER_H + el.clientHeight) + OVERSCAN_ROWS);
    const x = Math.max(0, el.scrollLeft - HEADER_W);
    const c0 = Math.max(0, colAtX(x) - OVERSCAN_COLS);
    const c1 = Math.min(cols, colAtX(x + el.clientWidth) + OVERSCAN_COLS);
    setView((v) => (v.r0 === r0 && v.r1 === r1 && v.c0 === c0 && v.c1 === c1) ? v : { r0, r1, c0, c1 });
  }, [rows, cols, colAtX, rowAtY]);

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
    const top = HEADER_H + rowY[r], left = HEADER_W + colX[c];
    const h = Math.max(rowH(r), 1), w = Math.max(colW(c), 1);
    if (top < el.scrollTop + HEADER_H) el.scrollTop = top - HEADER_H;
    else if (top + h > el.scrollTop + el.clientHeight) el.scrollTop = top + h - el.clientHeight;
    if (left < el.scrollLeft + HEADER_W) el.scrollLeft = left - HEADER_W;
    else if (left + w > el.scrollLeft + el.clientWidth) el.scrollLeft = left + w - el.clientWidth;
  };

  const inSel = (c: number, r: number) => allSels.some((s) => c >= s.c1 && c <= s.c2 && r >= s.r1 && r <= s.r2);

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
    e.clipboardData.setData("text/plain", rangeToTSV(sheet, selection, wb));
    setCopyBuffer({ cells: rangeToCells(sheet, selection, wb), w: selection.c2 - selection.c1 + 1, h: selection.r2 - selection.r1 + 1,
      origin: { col: selection.c1, row: selection.r1 } });
  };
  const onCut = (e: ClipboardEvent) => {
    if (editing) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", rangeToTSV(sheet, selection, wb));
    setCopyBuffer({ cells: rangeToCells(sheet, selection, wb), w: selection.c2 - selection.c1 + 1, h: selection.r2 - selection.r1 + 1,
      origin: { col: selection.c1, row: selection.r1 } });
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
        extendSelection?.({ c1: Math.min(selection.c1, box.c1), r1: Math.min(selection.r1, box.r1), c2: Math.max(selection.c2, box.c2), r2: Math.max(selection.r2, box.r2) });
        if (!extendSelection) setSelection({ c1: Math.min(selection.c1, box.c1), r1: Math.min(selection.r1, box.r1), c2: Math.max(selection.c2, box.c2), r2: Math.max(selection.r2, box.r2) });
      } else if ((e.ctrlKey || e.metaKey) && addSelection) {
        addSelection(box);
        setDragging(true);
      } else {
        setSelection(box);
        setDragging(true);
      }
      containerRef.current?.focus();
    } else if (e.type === "mouseenter" && dragging) {
      const next = { c1: Math.min(selection.c1, box.c1), r1: Math.min(selection.r1, box.r1), c2: Math.max(selection.c2, box.c2), r2: Math.max(selection.r2, box.r2) };
      if (extendSelection && allSels.length > 1) extendSelection(next);
      else setSelection(next);
    } else if (e.type === "dblclick") {
      startEdit({ col: box.c1, row: box.r1 });
    }
  };
  useEffect(() => {
    const up = () => setDragging(false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);
  useEffect(() => {
    if (!hMenu) return;
    const close = () => setHMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("blur", close); };
  }, [hMenu]);

  const selRef = useRef(selection);
  selRef.current = selection;

  const frozenLeft = HEADER_W + (fz.cols ? colX[fz.cols - 1] + colW(fz.cols - 1) : 0);
  const frozenTop = HEADER_H + (fz.rows ? rowY[fz.rows - 1] + rowH(fz.rows - 1) : 0);

  // ---- resize grips ----
  const startResize = (axis: "col" | "row", i: number, e: MouseEvent) => {
    if (!onGeom) return;
    e.preventDefault();
    e.stopPropagation();
    const start = axis === "col" ? e.clientX : e.clientY;
    const size0 = axis === "col" ? colW(i) : rowH(i);
    const move = (ev: globalThis.MouseEvent) => {
      const delta = (axis === "col" ? ev.clientX : ev.clientY) - start;
      setResizePrev({ axis, i, size: Math.max(axis === "col" ? 24 : 12, size0 + delta) });
    };
    const up = (ev: globalThis.MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const delta = (axis === "col" ? ev.clientX : ev.clientY) - start;
      onGeom(axis, i, Math.max(axis === "col" ? 24 : 12, size0 + delta));
      setResizePrev(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /** Double-click grip → autofit: widest rendered text in the column. */
  const autofitCol = (c: number) => {
    if (!onGeom) return;
    let w = 50;
    for (const ref of Object.keys(sheet.cells)) {
      const p = parseA1(ref)!;
      if (p.col !== c) continue;
      const cell = sheet.cells[ref];
      const res = evals.get(ref);
      const text = String(cell?.f ? res?.value ?? "" : cell?.v ?? "");
      w = Math.max(w, Math.min(400, text.length * 7.2 + 16));
    }
    onGeom("col", c, Math.round(w));
  };
  const autofitRow = (r: number) => {
    if (onGeom) onGeom("row", r, ROW_H);
  };

  const renderCell = (c: number, r: number) => {
    const ref = toA1(c, r);
    if (mergeMaps.covered.has(ref)) return null;
    const head = mergeMaps.heads.get(ref);
    const cell = sheet.cells[ref];
    const res = evals.get(ref);
    const s = cell?.s ?? {};
    const sticky: CSSProperties = {};
    let z = 1;
    if (r < fz.rows) { sticky.position = "sticky"; sticky.top = HEADER_H + rowY[r]; z = 10; }
    if (c < fz.cols) { sticky.position = "sticky"; sticky.left = HEADER_W + colX[c]; z = Math.max(z, 10); }
    if (r < fz.rows && c < fz.cols) z = 11;
    const sel = head
      ? head.c1 >= selection.c1 && head.c2 <= selection.c2 && head.r1 >= selection.r1 && head.r2 <= selection.r2
      : inSel(c, r);
    return (
      <td key={c} data-c={c} data-r={r}
        colSpan={head ? head.c2 - head.c1 + 1 : 1}
        rowSpan={head ? head.r2 - head.r1 + 1 : 1}
        className={`cell ${sel ? "in-sel" : ""} ${res?.error ? "err" : ""} ${audit?.refs.has(ref) ? `audit-${audit.kind}` : ""}`}
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
        onDoubleClick={(e) => cellMouse(c, r, e)}
        title={sheet.notes?.[ref] ? `${sheet.notes[ref]}` : undefined}
        onContextMenu={(e) => { if (onCellMenu) { e.preventDefault(); if (!inSel(c, r)) setSelection({ c1: c, r1: r, c2: c, r2: r }); onCellMenu(ref, e.clientX, e.clientY); } }}>
        {editing?.ref.col === c && editing.ref.row === r ? null
          : res?.error ?? formatValue(cell?.f ? res?.value : cell?.v, s.fmt)}
        {invalid?.has(ref) && <span className="cell-flag inv" title="Fails data validation" />}
        {noted?.has(ref) && <span className="cell-flag note" />}
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
                    const w = colW(c);
                    return (
                      <th key={c} className={`col-h ${allSels.some((s) => c >= s.c1 && c <= s.c2) ? "sel" : ""} ${w === 0 ? "hid" : ""}`}
                        style={{ position: "sticky", top: 0, zIndex: 20, width: w, minWidth: w, padding: 0 }}
                        onMouseDown={(e) => { if (!(e.target as HTMLElement).classList.contains("grip-c")) setSelection({ c1: c, r1: 0, c2: c, r2: rows - 1 }); }}
                        onContextMenu={(e) => { e.preventDefault(); onHeader && setHMenu({ x: e.clientX, y: e.clientY, axis: "col", index: c }); }}>
                        {w > 0 ? colLabel(c) : ""}
                        {canEdit && onGeom && w > 0 && (
                          <span className="grip-c" title="Drag to resize — double-click to autofit"
                            onMouseDown={(e) => startResize("col", c, e)}
                            onDoubleClick={(e) => { e.stopPropagation(); autofitCol(c); }} />
                        )}
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
                  <tr style={{ height: rowY[run.start] - rowY[run.start - run.gapBefore] }}>
                    <td className="row-h" style={{ position: "sticky", left: 0, zIndex: 15 }} />
                    <td colSpan={cols} style={{ background: "#fff", border: 0 }} />
                  </tr>
                )}
                {Array.from({ length: run.end - run.start + 1 }).map((_, i) => {
                  const r = run.start + i;
                  const h = rowH(r);
                  return (
                    <tr key={r} style={{ height: h }}>
                      <td className={`row-h ${allSels.some((s) => r >= s.r1 && r <= s.r2) ? "sel" : ""} ${h === 0 ? "hid" : ""}`}
                        style={{ position: "sticky", left: 0, zIndex: 15, padding: 0, ...(r < fz.rows ? { top: HEADER_H + rowY[r] } : {}) }}
                        onMouseDown={(e) => { if (!(e.target as HTMLElement).classList.contains("grip-r")) setSelection({ c1: 0, r1: r, c2: cols - 1, r2: r }); }}
                        onContextMenu={(e) => { e.preventDefault(); onHeader && setHMenu({ x: e.clientX, y: e.clientY, axis: "row", index: r }); }}>
                        {h > 0 ? r + 1 : ""}
                        {canEdit && onGeom && h > 0 && (
                          <span className="grip-r" title="Drag to resize — double-click to reset"
                            onMouseDown={(e) => startResize("row", r, e)}
                            onDoubleClick={(e) => { e.stopPropagation(); autofitRow(r); }} />
                        )}
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

        {/* selection frames — one per range; fill handle on the active (last) */}
        {allSels.map((sr, si) => (
          <div key={si} className={`sel-frame ${si === allSels.length - 1 ? "" : "aux"}`}
            style={{
              left: HEADER_W + colX[sr.c1], top: HEADER_H + rowY[sr.r1],
              width: colX[sr.c2] + colW(sr.c2) - colX[sr.c1],
              height: rowY[sr.r2] + rowH(sr.r2) - rowY[sr.r1],
            }}>
            {si === allSels.length - 1 && canEdit && <div className="fill-handle"
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
        ))}

        {/* cell editor — formula-aware (autocomplete, hints, F4) */}
        {editing && (
          <FxInput wb={wb} inputRef={inputRef} className="cell-editor"
            wrapStyle={{ position: "absolute", left: HEADER_W + colX[editing.ref.col], top: HEADER_H + rowY[editing.ref.row], width: colW(editing.ref.col) + 60, zIndex: 40 }}
            inputStyle={{ position: "relative" }}
            value={editing.value}
            onValue={(v) => setEditing({ ...editing, value: v })}
            onBlur={() => commitEdit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitEdit({ dc: 0, dr: 1 }); }
              else if (e.key === "Tab") { e.preventDefault(); commitEdit({ dc: 1, dr: 0 }); }
              else if (e.key === "Escape") { setEditing(null); containerRef.current?.focus(); }
            }} />
        )}
        {/* freeze split indicators */}
        {fz.cols > 0 && <div className="freeze-v" style={{ left: frozenLeft }} />}
        {fz.rows > 0 && <div className="freeze-h" style={{ top: frozenTop }} />}

        {/* list-validation dropdown on the anchor cell */}
        {listDrop && canEdit && !editing && (() => {
          const p = parseA1(listDrop.ref);
          if (!p || colW(p.col) === 0 || rowH(p.row) === 0) return null;
          const x = HEADER_W + colX[p.col], y = HEADER_H + rowY[p.row];
          return (
            <>
              <button className="list-drop-btn"
                style={{ left: x + colW(p.col) - 19, top: y + Math.max(0, (rowH(p.row) - 18) / 2) }}
                title="List"
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setListOpen((v) => !v); }}>▾</button>
              {listOpen && (
                <div className="list-drop" style={{ left: x, top: y + rowH(p.row), minWidth: Math.max(120, colW(p.col)) }}>
                  {listDrop.items.map((it) => (
                    <button key={it} onMouseDown={(e) => { e.preventDefault(); onCommit(listDrop.ref, it); setListOpen(false); }}>{it}</button>
                  ))}
                  {!listDrop.items.length && <span style={{ padding: 8, fontSize: 12, color: "#8B8480" }}>Empty list</span>}
                </div>
              )}
            </>
          );
        })()}

        {/* header context menu — insert/delete/hide/unhide */}
        {hMenu && (
          <div className="hmenu" style={{ left: hMenu.x, top: hMenu.y }}>
            {([
              ["ins", hMenu.axis === "row" ? `Insert row above ${hMenu.index + 1}` : `Insert column left of ${colLabel(hMenu.index)}`],
              ["del", hMenu.axis === "row" ? "Delete row(s)" : "Delete column(s)"],
              ["hide", hMenu.axis === "row" ? "Hide row(s)" : "Hide column(s)"],
              ["unhide", hMenu.axis === "row" ? "Unhide rows in selection" : "Unhide cols in selection"],
            ] as const).map(([act, label]) => (
              <div key={act} className="hmenu-item"
                onMouseDown={(e) => { e.preventDefault(); onHeader?.(act, hMenu.axis, hMenu.index); setHMenu(null); }}>
                {label}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
