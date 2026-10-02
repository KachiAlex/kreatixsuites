import { useMemo, useRef, useState, useEffect, useCallback, Fragment, type KeyboardEvent, type ClipboardEvent, type CSSProperties } from "react";
import type { SheetData, Range, Ref, Workbook, SheetObject, RichRun, CellStyle } from "./model";
import { colLabel, toA1, ROW_H, COL_W, HEADER_W, parseA1, rangeRefs, parseRange, outlineHiddenFields, richStyleRuns, richRunsMatch, richRunsForEdit } from "./model";
import type { EvalResult } from "./engine";
import { formatValue } from "./format";
import { rangeToTSV, rangeToCells, setCopyBuffer, cfEffects, columnSuggestions } from "./io";
import { FxInput } from "./FxInput";
import { SparklineView } from "./Chart";
import { clampToViewport } from "../lib/mobile";

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
  onCommit: (ref: string, raw: string, rt?: RichRun[]) => void;
  onClear: (refs: string[]) => void;
  onPaste: (anchor: Ref, tsv: string, html?: string) => void;
  onPasteImage?: (anchor: Ref, dataUrl: string) => void;
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
  /** cell with a comment thread → marker (S19.16) */
  commented?: Set<string>;
  /** right-click a body cell → context menu (notes etc.) */
  onCellMenu?: (ref: string, x: number, y: number) => void;
  /** click a filter ▾ on the header row (S5.1) */
  onFilterClick?: (col: number, x: number, y: number) => void;
  /** evaluate an ad-hoc formula in this sheet's context (CF formula rules) */
  evalFormula?: (f: string) => EvalResult;
  /** highlight cells carrying a change stamp (S9.2) */
  showChanges?: boolean;
  /** toggle an outline group's collapsed state (S12.3) — `end` = last member index */
  onOutlineToggle?: (axis: "row" | "col", end: number) => void;
  /** S16.1 split panes — restrict this pane to rows [r0, r1]; others collapse */
  paneRows?: [number, number];
  /** S16.1 — overlay dashed page-break lines (page ~7.5×10in content) */
  pageBreaks?: boolean;
  /** S16.3 — Ctrl+D / Ctrl+R directional fill */
  onFillDir?: (dir: "down" | "right") => void;
  /** S19.2 — render formulas instead of values (Ctrl+`) */
  showFormulas?: boolean;
  /** S19.1 — open a cell link / HYPERLINK() target */
  onOpenLink?: (url: string) => void;
  /** S19.3 — floating-object mutations (drag/resize/delete) */
  onObjects?: (next: SheetObject[]) => void;
  /** S19.4 — refs containing a misspelling (red wavy underline) */
  spellMisses?: Set<string>;
  /** S19.12 — Quick Analysis popover trigger on the selection corner */
  onQuickAction?: (kind: string, range: Range) => void;
}

interface Run { start: number; end: number; gapBefore: number }

export function Grid({ sheet, evals, canEdit, wb, audit, selections, selection, setSelection, addSelection, extendSelection, onCommit, onClear, onPaste, onPasteImage, onFillHandle, onGeom, onHeader, invalid, listDrop, noted, commented, onCellMenu, onFilterClick, evalFormula, showChanges, onOutlineToggle, paneRows, pageBreaks, onFillDir, showFormulas, onOpenLink, onObjects, spellMisses, onQuickAction }: GridProps) {
  const [selObj, setSelObj] = useState<string | null>(null);
  const [objDrag, setObjDrag] = useState<{ id: string; dx: number; dy: number; x: number; y: number; w: number; h: number; mode: "move" | "size" } | null>(null);
  const [qaOpen, setQaOpen] = useState(false);
  const allSels = selections ?? [selection];
  const [editing, setEditing] = useState<{ ref: Ref; value: string; rt?: RichRun[] } | null>(null);
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
  // hidden = 0 size (manual hidden + autofilter-hidden rows)
  const hiddenR = useMemo(() => {
    const s = new Set([...(sheet.hiddenRows ?? []), ...(sheet.filteredRows ?? []), ...outlineHiddenFields(sheet.outlineRows, sheet.collapsedRows)]);
    if (paneRows) for (let r = 0; r < rows; r++) if (r < paneRows[0] || r > paneRows[1]) s.add(r);
    return s;
  }, [sheet.hiddenRows, sheet.filteredRows, sheet.outlineRows, sheet.collapsedRows, paneRows, rows]);

  // autofilter chrome — ▾ on header-row cells, active columns highlighted
  const fRange = useMemo(() => (sheet.filter ? parseRange(sheet.filter.range) : null), [sheet.filter]);
  const fActive = useMemo(() => new Set(Object.keys(sheet.filter?.cols ?? {}).map(Number)), [sheet.filter]);

  // table banding + totals rows (S5.4)
  const tableInfo = useMemo(() => {
    const bands = new Map<string, { bg: string; header: boolean; light: boolean }>();
    const totals = new Map<number, { spec: NonNullable<SheetData["tables"]>[number]; range: { c1: number; r1: number; c2: number; r2: number } }>();
    for (const t of sheet.tables ?? []) {
      const r = parseRange(t.range);
      if (!r) continue;
      for (let row = r.r1; row <= r.r2; row++) for (let c = r.c1; c <= r.c2; c++) {
        const i = row - r.r1;
        let bg: string | undefined;
        if (t.style === "banded") bg = i === 0 ? "#F3E2D3" : i % 2 ? "#FBF4EE" : undefined;
        else if (t.style === "accent") bg = i === 0 ? "#F2782E" : i % 2 ? "#FBE3D5" : "#FDF3EC";
        else if (t.style === "dark") bg = i === 0 ? "#26221F" : i % 2 ? "#F4F1EE" : "#FFFFFF";
        if (bg) bands.set(toA1(c, row), { bg, header: i === 0, light: i === 0 && (t.style === "accent" || t.style === "dark") });
      }
      if (t.totals) totals.set(r.r2 + 1, { spec: t, range: r });
    }
    return { bands, totals };
  }, [sheet.tables]);
  const hiddenC = useMemo(() => new Set([...(sheet.hiddenCols ?? []), ...outlineHiddenFields(sheet.outlineCols, sheet.collapsedCols)]), [sheet.hiddenCols, sheet.outlineCols, sheet.collapsedCols]);
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
        if (!out.length || n !== prev + 1) out.push({ start: n, end: n, gapBefore: n - (prev + 1) });
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

  // conditional formats (S6): pure computation lives in io.ts → cfEffects
  const cfFx = useMemo(() => cfEffects(sheet, evals, evalFormula), [sheet, evals, evalFormula]);

  const startEdit = (ref: Ref, initial?: string) => {
    if (!canEdit) return;
    const m = mergeMaps.covered.get(toA1(ref.col, ref.row));
    const target = m ? { col: m.c1, row: m.r1 } : ref;
    const cell = sheet.cells[toA1(target.col, target.row)];
    const seedV = initial ?? (cell?.f ? `=${cell.f}` : cell?.v === undefined || cell.v === null ? "" : String(cell.v));
    // S19.10 — carry the existing runs into the edit session so Ctrl+B/I/U
    // can extend them; typing a fresh value drops them (richRunsMatch guard)
    setEditing({ ref: target, value: seedV, rt: !cell?.f && richRunsMatch(cell?.rt, cell?.v) ? cell!.rt!.map((r) => ({ ...r })) : undefined });
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const commitEdit = (move?: { dc: number; dr: number }) => {
    if (!editing) return;
    if (editing.value.trim() !== "" || sheet.cells[toA1(editing.ref.col, editing.ref.row)]) {
      // S19.10 — rich runs persist only when they still match the text
      const rt = richRunsMatch(editing.rt, editing.value) ? editing.rt : undefined;
      onCommit(toA1(editing.ref.col, editing.ref.row), editing.value, rt);
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

  // S16.3 — data-edge jump for Ctrl+Arrows / Ctrl+End
  const lastUsed = useMemo(() => {
    let mc = 0, mr = 0;
    for (const ref of Object.keys(sheet.cells)) {
      const p = parseA1(ref)!;
      if (p.col > mc) mc = p.col;
      if (p.row > mr) mr = p.row;
    }
    return { c: mc, r: mr };
  }, [sheet.cells]);
  const edgeOf = (c: number, r: number, dc: number, dr: number): [number, number] => {
    // walk until the next cell is empty (or hit bounds); if starting on empty,
    // walk until the next cell is non-empty — Excel's Ctrl+Arrow semantics
    const filled = (cc: number, rr: number) => !!sheet.cells[toA1(cc, rr)];
    let nc = c, nr = r;
    const onData = filled(c, r);
    while (true) {
      const tc = nc + dc, tr = nr + dr;
      if (tc < 0 || tr < 0 || tc >= cols || tr >= rows) break;
      if (onData ? !filled(tc, tr) : filled(tc, tr)) break;
      nc = tc; nr = tr;
    }
    // on data: stop at last filled before the gap
    if (onData) return [nc, nr];
    return [nc, nr];
  };

  const onKey = (e: KeyboardEvent) => {
    if (editing) return;
    const anchor = { col: selection.c1, row: selection.r1 };
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const d = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key]!;
      if (ctrl) {
        const [ec, er] = edgeOf(anchor.col, anchor.row, d[0], d[1]);
        if (e.shiftKey) setSelection({ c1: Math.min(selection.c1, ec), r1: Math.min(selection.r1, er), c2: Math.max(selection.c2, ec), r2: Math.max(selection.r2, er) });
        else moveSel(ec, er, false);
      } else moveSel(anchor.col + d[0], anchor.row + d[1], e.shiftKey);
    } else if (e.key === "Home") {
      e.preventDefault();
      moveSel(ctrl ? 0 : selection.c1, ctrl ? 0 : anchor.row, e.shiftKey);
    } else if (e.key === "End" && ctrl) {
      e.preventDefault();
      moveSel(lastUsed.c, lastUsed.r, e.shiftKey);
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      const h = containerRef.current?.clientHeight ?? 600;
      const step = Math.max(1, Math.floor(h / ROW_H) - 1) * (e.key === "PageDown" ? 1 : -1);
      moveSel(anchor.col, anchor.row + step, e.shiftKey);
    } else if (e.key === " " && ctrl) {
      e.preventDefault(); // Ctrl+Space — whole column
      setSelection({ c1: selection.c1, r1: 0, c2: selection.c2, r2: rows - 1 });
    } else if (e.key === " " && e.shiftKey) {
      e.preventDefault(); // Shift+Space — whole row
      setSelection({ c1: 0, r1: selection.r1, c2: cols - 1, r2: selection.r2 });
    } else if ((e.key === "d" || e.key === "r") && ctrl && canEdit) {
      e.preventDefault();
      onFillDir?.(e.key === "d" ? "down" : "right");
    } else if (e.key === "Enter") { e.preventDefault(); moveSel(anchor.col, anchor.row + (e.shiftKey ? -1 : 1), false); }
    else if (e.key === "Tab") { e.preventDefault(); moveSel(anchor.col + (e.shiftKey ? -1 : 1), anchor.row, false); }
    else if (e.key === "F2") { e.preventDefault(); startEdit(anchor); }
    else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      // S19.3 — a selected floating object takes precedence over cell clear
      if (selObj && canEdit && onObjects) {
        onObjects((sheet.objects ?? []).filter((o) => o.id !== selObj));
        setSelObj(null);
      } else if (canEdit) onClear([...rangeRefs(selection)]);
    } else if (e.key === "a" && ctrl) {
      e.preventDefault();
      setSelection({ c1: 0, r1: 0, c2: cols - 1, r2: rows - 1 });
    } else if (e.key.length === 1 && !ctrl && canEdit) {
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
    // image paste — prefer binary items; become in-cell image metadata
    const imgItem = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
    if (imgItem && onPasteImage) {
      const file = imgItem.getAsFile();
      if (file) {
        e.preventDefault();
        const rd = new FileReader();
        rd.onload = () => onPasteImage({ col: selection.c1, row: selection.r1 }, String(rd.result));
        rd.readAsDataURL(file);
        return;
      }
    }
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    if (!text && !html) return;
    e.preventDefault();
    onPaste({ col: selection.c1, row: selection.r1 }, text, html.includes("<table") ? html : undefined);
  };

  // touch long-press → context menu (iOS doesn't reliably fire contextmenu)
  const lp = useRef<{ t: number; x: number; y: number } | null>(null);
  const cancelLp = () => {
    if (lp.current) { window.clearTimeout(lp.current.t); lp.current = null; }
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (lp.current && Math.hypot(e.clientX - lp.current.x, e.clientY - lp.current.y) > 10) cancelLp();
    };
    const end = () => cancelLp();
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);

  const cellMouse = (c: number, r: number, e: React.MouseEvent | React.PointerEvent) => {
    const merge = mergeMaps.covered.get(toA1(c, r)) ?? mergeMaps.heads.get(toA1(c, r));
    const box: Range = merge ?? { c1: c, r1: r, c2: c, r2: r };
    const ref = toA1(c, r);
    if (e.type === "pointerdown") {
      const pe = e as React.PointerEvent;
      const touch = pe.pointerType === "touch";
      if (touch) {
        // long-press → cell context menu; drag stays native pan-scroll
        if (onCellMenu) {
          cancelLp();
          lp.current = { t: window.setTimeout(() => { onCellMenu(ref, pe.clientX, pe.clientY); }, 520), x: pe.clientX, y: pe.clientY };
        }
        if (selObj) setSelObj(null);
        setSelection(box);
        containerRef.current?.focus();
        return;
      }
      if (selObj) setSelObj(null);
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
    } else if (e.type === "pointerenter" && dragging) {
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
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("mouseup", up); window.removeEventListener("pointerup", up); };
  }, []);

  /** Touch range-extend: drag a selection-handle to grow/shrink the range. */
  const startTouchExtend = (corner: "tl" | "br", e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const src = { ...selRef.current };
    const move = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("td.cell") as HTMLElement | null;
      if (!el || el.dataset.c === undefined || el.dataset.r === undefined) return;
      const cc = Number(el.dataset.c), rr = Number(el.dataset.r);
      const next = corner === "br"
        ? { ...src, c2: Math.max(src.c1, cc), r2: Math.max(src.r1, rr) }
        : { ...src, c1: Math.min(src.c2, cc), r1: Math.min(src.r2, rr) };
      setSelection(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  useEffect(() => {
    if (!hMenu) return;
    const close = () => setHMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("blur", close); };
  }, [hMenu]);

  const selRef = useRef(selection);
  useEffect(() => { selRef.current = selection; }, [selection]);

  const frozenLeft = HEADER_W + (fz.cols ? colX[fz.cols - 1] + colW(fz.cols - 1) : 0);
  const frozenTop = HEADER_H + (fz.rows ? rowY[fz.rows - 1] + rowH(fz.rows - 1) : 0);

  // ---- resize grips ----
  const startResize = (axis: "col" | "row", i: number, e: React.PointerEvent) => {
    if (!onGeom) return;
    e.preventDefault();
    e.stopPropagation();
    const start = axis === "col" ? e.clientX : e.clientY;
    const size0 = axis === "col" ? colW(i) : rowH(i);
    const move = (ev: globalThis.PointerEvent) => {
      const delta = (axis === "col" ? ev.clientX : ev.clientY) - start;
      setResizePrev({ axis, i, size: Math.max(axis === "col" ? 24 : 12, size0 + delta) });
    };
    const up = (ev: globalThis.PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      const delta = (axis === "col" ? ev.clientX : ev.clientY) - start;
      onGeom(axis, i, Math.max(axis === "col" ? 24 : 12, size0 + delta));
      setResizePrev(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
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
    const deco = [s.u ? "underline" : "", s.st ? "line-through" : ""].filter(Boolean).join(" ");
    const borderCss = (e?: { w?: number; style?: string; color?: string }) =>
      e ? `${e.w ?? 1}px ${e.style ?? "solid"} ${e.color ?? "var(--ink)"}` : undefined;
    // table banding (falls back under direct bg/cf) + totals row (S5.4)
    const band = tableInfo.bands.get(ref);
    const tot = tableInfo.totals.get(r);
    const cfx = cfFx.get(ref);
    const spark = sheet.sparklines?.[ref];
    // spill targets have no cell entry — their value comes from evals;
    // the anchor keeps the whole matrix so flatten to its top-left
    const rawV = cell?.f || (!cell && res) ? res?.value : cell?.v;
    let content: string | number | null = editing?.ref.col === c && editing.ref.row === r ? null
      : res?.error ?? formatValue(Array.isArray(rawV) ? (rawV[0] as unknown[])?.[0] ?? null : rawV, s.fmt);
    // S19.2 — show formulas renders the expression, not the result (Ctrl+`)
    if (showFormulas && cell?.f) content = `=${cell.f}`;
    // S19.11 — "fill" alignment repeats the text to fill the cell width
    if (s.align === "fill" && content !== null && content !== undefined && content !== "") {
      const rep = Math.ceil((colW(c) - 6) / 7);
      content = String(content).repeat(Math.max(1, rep)).slice(0, Math.max(1, rep * String(content).length));
    }
    // S19.1 — link styling + navigation (cell.link or HYPERLINK() result)
    const link = cell?.link ?? res?.link ?? null;
    // S19.10 — in-cell rich text: styled runs replace the flat content
    const runs = !cell?.f && richRunsMatch(cell?.rt, cell?.v) ? cell!.rt! : null;
    const runCss = (rs?: Partial<CellStyle>): CSSProperties => rs ? {
      fontWeight: rs.b ? 700 : undefined,
      fontStyle: rs.i ? "italic" : undefined,
      textDecoration: [rs.u ? "underline" : "", rs.st ? "line-through" : ""].filter(Boolean).join(" ") || undefined,
      color: rs.color, background: rs.bg, fontFamily: rs.font,
      fontSize: rs.size ? `${rs.size}px` : undefined,
    } : {};
    // IMAGE() renders its result URL as an in-cell image (S18.1)
    const isImgFn = /^IMAGE\s*\(/i.test(cell?.f ?? "");
    if (spark || cell?.img || cell?.ent || (isImgFn && typeof res?.value === "string")) content = null;
    const richContent = runs && content !== null
      ? <>{runs.map((rr, i) => <span key={i} style={runCss(rr.s)}>{rr.t}</span>)}</>
      : content;
    if (tot && c >= tot.range.c1 && c <= tot.range.c2) {
      if (c === tot.range.c1) content = "Totals";
      else {
        const fn = tot.spec.totals?.[c] ?? "none";
        if (fn !== "none") {
          const nums: number[] = [];
          let cnt = 0;
          for (let rr = tot.range.r1 + 1; rr <= tot.range.r2; rr++) {
            const v = evals.get(toA1(c, rr))?.value;
            if (v !== null && v !== undefined && v !== "") cnt++;
            const nn = typeof v === "number" ? v : Number(v);
            if (!isNaN(nn)) nums.push(nn);
          }
          content = fn === "count" ? cnt
            : fn === "sum" ? nums.reduce((a, b) => a + b, 0)
            : fn === "avg" ? (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : "")
            : fn === "min" ? (nums.length ? Math.min(...nums) : "")
            : fn === "max" ? (nums.length ? Math.max(...nums) : "") : "";
          if (typeof content === "number") content = formatValue(content, s.fmt);
        }
      }
    }
    return (
      <td key={c} data-c={c} data-r={r}
        colSpan={head ? head.c2 - head.c1 + 1 : 1}
        rowSpan={head ? head.r2 - head.r1 + 1 : 1}
        className={`cell ${sel ? "in-sel" : ""} ${res?.error ? "err" : ""} ${audit?.refs.has(ref) ? `audit-${audit.kind}` : ""} ${s.wrap ? "wrap" : ""} ${link ? "has-link" : ""} ${spellMisses?.has(ref) ? "spell-miss" : ""}`}
        style={{
          ...sticky, zIndex: z,
          fontWeight: band?.header || tot ? 600 : s.b ? 700 : 400, fontStyle: s.i ? "italic" : "normal",
          fontFamily: s.font, fontSize: s.size ? `${s.size}px` : undefined,
          textDecoration: deco || "none",
          color: s.color ?? (band?.light ? "#fff" : "var(--ink)"),
          background: cfx?.bg ?? s.bg ?? band?.bg ?? (tot ? "var(--subtle)" : "var(--surface)"),
          textAlign: s.align === "justify" || s.align === "distributed" ? "justify" as const
            : s.align === "centerAcross" || s.align === "fill" ? "left" as const
            : s.align ?? (typeof (cell?.f ? res?.value : cell?.v) === "number" ? "right" : "left"),
          textAlignLast: s.align === "distributed" ? "justify" : undefined,
          overflow: s.align === "centerAcross" ? "visible" : undefined,
          verticalAlign: s.valign ?? (head ? "middle" : undefined),
          paddingLeft: s.indent ? 5 + s.indent * 8 : undefined,
          borderTop: borderCss(s.borders?.top), borderRight: borderCss(s.borders?.right),
          borderBottom: borderCss(s.borders?.bottom), borderLeft: borderCss(s.borders?.left),
        }}
        role="gridcell" aria-selected={sel || undefined} aria-colindex={c + 1}
        onPointerDown={(e) => cellMouse(c, r, e)}
        onPointerEnter={(e) => cellMouse(c, r, e)}
        onDoubleClick={(e) => cellMouse(c, r, e)}
        title={[
          sheet.notes?.[ref] ?? "",
          showChanges && cell?.h ? `Edited by ${cell.h.by} · ${new Date(cell.h.at).toLocaleString()}` : "",
        ].filter(Boolean).join("\n") || undefined}
        onContextMenu={(e) => { if (onCellMenu) { e.preventDefault(); if (!inSel(c, r)) setSelection({ c1: c, r1: r, c2: c, r2: r }); onCellMenu(ref, e.clientX, e.clientY); } }}>
        {cfx?.bar && (
          <span className="cf-bar" style={{ width: `${cfx.bar.pct}%`, background: cfx.bar.color }} />
        )}
        {cfx?.icon && <span className="cf-icon" style={{ color: cfx.icon.split("|")[0] }}>{cfx.icon.split("|")[1]}</span>}
        {spark && <SparklineView spec={spark} sheet={sheet} wb={wb} w={colW(c) - 4} h={rowH(r) - 3} />}
        {cell?.img && (
          <img className="cell-img" src={cell.img} alt=""
            style={{ maxWidth: colW(c) - 4, maxHeight: rowH(r) - 4 }} />
        )}
        {isImgFn && typeof res?.value === "string" && !res.error && (
          <img className="cell-img" src={res.value} alt=""
            style={{ maxWidth: colW(c) - 4, maxHeight: rowH(r) - 4 }} />
        )}
        {cell?.ent && (
          <span className="cell-ent" title={`${cell.ent.kind} — fields: ${Object.keys(cell.ent.props).join(", ")}`}>
            <span className="ent-ico">▣</span>{cell.ent.name}
          </span>
        )}
        {link ? (
          <span className="cell-link" title={link}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onOpenLink?.(link); }}>
            {s.rotate ? <span className="cell-rot" style={{ transform: `rotate(${s.rotate}deg)` }}>{richContent}</span> : richContent}
          </span>
        ) : s.align === "centerAcross" ? (() => {
          // S19.11 — center the text across the contiguous run of
          // centerAcross-aligned cells (Excel's center-across-selection)
          let e2 = c;
          while (sheet.cells[toA1(e2 + 1, r)]?.s?.align === "centerAcross") e2++;
          const wRun = colX[e2] + colW(e2) - colX[c] - 8;
          return <span className="cell-ca" style={{ width: wRun }}>{richContent}</span>;
        })() : s.rotate ? (
          <span className="cell-rot" style={{ transform: `rotate(${s.rotate}deg)` }}>{richContent}</span>
        ) : s.shrink ? (
          <span className="cell-shrink">{richContent}</span>
        ) : richContent}
        {invalid?.has(ref) && <span className="cell-flag inv" title="Fails data validation" />}
        {noted?.has(ref) && <span className="cell-flag note" />}
        {commented?.has(ref) && <span className="cell-flag cmt" title="Has comment thread" />}
        {showChanges && cell?.h && <span className="cell-flag chg" />}
        {fRange && r === fRange.r1 && c >= fRange.c1 && c <= fRange.c2 && canEdit && (
          <span className={`fbtn ${fActive.has(c) ? "on" : ""}`}
            onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); onFilterClick?.(c, e.clientX, e.clientY); }}>▾</span>
        )}
      </td>
    );
  };

  return (
    <div ref={containerRef} className="sheet-grid" tabIndex={0} onKeyDown={onKey} onScroll={onScroll}
      onCopy={onCopy} onCut={onCut} onPaste={onPasteCb}
      role="grid" aria-label={sheet.name} aria-rowcount={rows} aria-colcount={cols}
      style={{ outline: "none" }}>
      <div className="grid-inner" style={{ position: "relative", width: HEADER_W + totalW, height: HEADER_H + totalH }}>
        <table className="grid-table" cellSpacing={0}>
          <thead>
            <tr role="row">
              <th className="corner" style={{ position: "sticky", left: 0, top: 0, zIndex: 30 }}
                aria-label="Select all"
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
                        onPointerDown={(e) => { if (!(e.target as HTMLElement).classList.contains("grip-c")) setSelection({ c1: c, r1: 0, c2: c, r2: rows - 1 }); }}
                        onContextMenu={(e) => { e.preventDefault(); if (onHeader) setHMenu({ ...clampToViewport(e.clientX, e.clientY, 230, 300), axis: "col", index: c }); }}>
                        {w > 0 ? colLabel(c) : ""}
                        {canEdit && onGeom && w > 0 && (
                          <span className="grip-c" title="Drag to resize — double-click to autofit"
                            onPointerDown={(e) => startResize("col", c, e)}
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
                    <td colSpan={cols} style={{ background: "var(--surface)", border: 0 }} />
                  </tr>
                )}
                {Array.from({ length: run.end - run.start + 1 }).map((_, i) => {
                  const r = run.start + i;
                  const h = rowH(r);
                  return (
                    <tr key={r} style={{ height: h }}>
                      <td className={`row-h ${allSels.some((s) => r >= s.r1 && r <= s.r2) ? "sel" : ""} ${h === 0 ? "hid" : ""}`}
                        style={{ position: "sticky", left: 0, zIndex: 15, padding: 0, ...(r < fz.rows ? { top: HEADER_H + rowY[r] } : {}) }}
                        onPointerDown={(e) => { if (!(e.target as HTMLElement).classList.contains("grip-r")) setSelection({ c1: 0, r1: r, c2: cols - 1, r2: r }); }}
                        onContextMenu={(e) => { e.preventDefault(); if (onHeader) setHMenu({ ...clampToViewport(e.clientX, e.clientY, 230, 300), axis: "row", index: r }); }}>
                        {h > 0 ? r + 1 : ""}
                        {canEdit && onGeom && h > 0 && (
                          <span className="grip-r" title="Drag to resize — double-click to reset"
                            onPointerDown={(e) => startResize("row", r, e)}
                            onDoubleClick={(e) => { e.stopPropagation(); autofitRow(r); }} />
                        )}
                      </td>
                      {colRuns.map((cr) => (
                        <Fragment key={cr.start}>
                          {cr.gapBefore > 0 && (
                            <td style={{ width: colX[cr.start] - colX[cr.start - cr.gapBefore], border: 0, background: "var(--surface)" }} />
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
            {si === allSels.length - 1 && onQuickAction && (sr.c2 > sr.c1 || sr.r2 > sr.r1) && (
              <span className="qa-btn" title="Quick analysis"
                onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); setQaOpen((v) => !v); }}>
                ⚡
                {qaOpen && (
                  <span className="qa-pop" onMouseDown={(e) => e.stopPropagation()}>
                    {[
                      ["sum", "Σ Totals"], ["chart", "📊 Chart"], ["colorscale", "🎨 Color scale"],
                      ["databar", "▰ Data bars"], ["table", "▦ Table"], ["sparkline", "〽 Sparklines"],
                    ].map(([k, l]) => (
                      <button key={k} onClick={() => { setQaOpen(false); onQuickAction(k, sr); }}>{l}</button>
                    ))}
                  </span>
                )}
              </span>
            )}
            {/* touch range handles — corner dots that drag-extend on coarse pointers */}
            {si === allSels.length - 1 && canEdit && (
              <>
                <div className="sel-th sel-th-tl" onPointerDown={(e) => startTouchExtend("tl", e)} />
                <div className="sel-th sel-th-br" onPointerDown={(e) => startTouchExtend("br", e)} />
              </>
            )}
            {si === allSels.length - 1 && canEdit && <div className="fill-handle"
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              const src = { ...selection };
              const move = (ev: globalThis.PointerEvent) => {
                const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("td.cell") as HTMLElement | null;
                if (el?.dataset.c !== undefined && el.dataset.r !== undefined) {
                  const cc = Number(el.dataset.c), rr = Number(el.dataset.r);
                  setSelection({ c1: Math.min(src.c1, cc), r1: Math.min(src.r1, rr), c2: Math.max(src.c2, cc), r2: Math.max(src.r2, rr) });
                }
              };
              const up = () => {
                window.removeEventListener("pointermove", move as never);
                window.removeEventListener("pointerup", up);
                window.removeEventListener("pointercancel", up);
                const dst = selRef.current;
                if (dst.c2 - dst.c1 !== src.c2 - src.c1 || dst.r2 - dst.r1 !== src.r2 - src.r1) onFillHandle(src, dst);
              };
              window.addEventListener("pointermove", move as never);
              window.addEventListener("pointerup", up);
              window.addEventListener("pointercancel", up);
            }} />}
          </div>
        ))}

        {/* cell editor — formula-aware (autocomplete, hints, F4) */}
        {editing && (
          <FxInput wb={wb} inputRef={inputRef} className="cell-editor"
            wrapStyle={{ position: "absolute", left: HEADER_W + colX[editing.ref.col], top: HEADER_H + rowY[editing.ref.row], width: colW(editing.ref.col) + 60, zIndex: 40 }}
            inputStyle={{ position: "relative" }}
            value={editing.value}
            onValue={(v) => setEditing({ ...editing, value: v, rt: v.startsWith("=") ? undefined : richRunsForEdit(editing.value, editing.rt, v) })}
            onBlur={() => commitEdit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitEdit({ dc: 0, dr: 1 }); }
              else if (e.key === "Tab") { e.preventDefault(); commitEdit({ dc: 1, dr: 0 }); }
              else if (e.key === "Escape") { setEditing(null); containerRef.current?.focus(); }
              // S19.10 — rich-text shortcuts on the input's selection
              else if ((e.ctrlKey || e.metaKey) && ["b", "i", "u"].includes(e.key.toLowerCase())
                && !editing.value.startsWith("=")) {
                const el = inputRef.current;
                const from = el?.selectionStart ?? 0, to = el?.selectionEnd ?? 0;
                if (el && to > from) {
                  e.preventDefault();
                  const key = { b: "b", i: "i", u: "u" }[e.key.toLowerCase()] as "b" | "i" | "u";
                  // toggle: off if the whole range already carries the style
                  const probe = (editing.rt ?? [{ t: editing.value }]);
                  let pos = 0, already = true;
                  for (const r of probe) {
                    if (pos < to && pos + r.t.length > from && !r.s?.[key]) already = false;
                    pos += r.t.length;
                  }
                  const rt = richStyleRuns(editing.value, editing.rt, from, to, { [key]: !already });
                  setEditing({ ...editing, rt });
                }
              }
            }} />
        )}
        {/* column autocomplete — non-formula text suggests prior column values (S12.6) */}
        {editing && !editing.value.startsWith("=") && editing.value.trim() !== "" && (() => {
          const sug = columnSuggestions(sheet, editing.ref.col)
            .filter((s) => s.toLowerCase().startsWith(editing.value.toLowerCase()) && s !== editing.value);
          if (!sug.length) return null;
          const p = editing.ref;
          return (
            <div className="list-drop col-auto"
              style={{ left: HEADER_W + colX[p.col], top: HEADER_H + rowY[p.row] + rowH(p.row), minWidth: Math.max(120, colW(p.col)) }}>
              {sug.map((s) => (
                <button key={s} onMouseDown={(e) => {
                  e.preventDefault(); e.stopPropagation();
                  onCommit(toA1(p.col, p.row), s); setEditing(null);
                }}>{s}</button>
              ))}
            </div>
          );
        })()}
        {/* outline collapse toggles (S12.3) — −/+ sits on the summary row
            just past each group's last member */}
        {sheet.outlineRows && (() => {
          const lv = sheet.outlineRows;
          const collapsed = new Set(sheet.collapsedRows ?? []);
          const ends: number[] = [];
          const max = Math.max(0, ...Object.keys(lv).map(Number));
          for (let i = 0; i <= max; i++)
            if ((lv[i] ?? 0) >= 1 && (lv[i + 1] ?? 0) < (lv[i] ?? 0)) ends.push(i);
          return ends.map((e) => {
            const sum = e + 1;
            const y = HEADER_H + (rowY[sum] ?? 0);
            if (hiddenR.has(sum)) return null;
            return (
              <button key={e} className="outline-tgl"
                style={{ left: 2, top: y + Math.max(0, ((rowH(sum) ?? ROW_H) - 14) / 2) }}
                title={collapsed.has(e) ? "Expand group" : "Collapse group"}
                onMouseDown={(ev) => ev.stopPropagation()}
                onClick={() => onOutlineToggle?.("row", e)}>
                {collapsed.has(e) ? "+" : "−"}
              </button>
            );
          });
        })()}
        {/* S19.7 — column outline toggles, same shape as row groups:
            −/+ sits on the summary column just past each group's last member */}
        {sheet.outlineCols && (() => {
          const lv = sheet.outlineCols;
          const collapsed = new Set(sheet.collapsedCols ?? []);
          const ends: number[] = [];
          const max = Math.max(0, ...Object.keys(lv).map(Number));
          for (let i = 0; i <= max; i++)
            if ((lv[i] ?? 0) >= 1 && (lv[i + 1] ?? 0) < (lv[i] ?? 0)) ends.push(i);
          return ends.map((e) => {
            const sum = e + 1;
            const x = HEADER_W + (colX[sum] ?? 0);
            if (hiddenC.has(sum)) return null;
            return (
              <button key={e} className="outline-tgl"
                style={{ top: 2, left: x + Math.max(0, ((colW(sum) ?? COL_W) - 14) / 2) }}
                title={collapsed.has(e) ? "Expand group" : "Collapse group"}
                onMouseDown={(ev) => ev.stopPropagation()}
                onClick={() => onOutlineToggle?.("col", e)}>
                {collapsed.has(e) ? "+" : "−"}
              </button>
            );
          });
        })()}
        {/* S19.3 — floating objects layer (images); drag to move, corner to
            resize, Delete removes the selected object */}
        {(sheet.objects ?? []).map((o) => {
          const d = objDrag?.id === o.id ? objDrag : null;
          const pos = { x: d?.x ?? o.x, y: d?.y ?? o.y, w: d?.w ?? o.w, h: d?.h ?? o.h };
          const startDrag = (e: React.PointerEvent, mode: "move" | "size") => {
            if (!canEdit || !onObjects) return;
            e.stopPropagation(); e.preventDefault();
            setSelObj(o.id);
            const sx = e.clientX, sy = e.clientY;
            const move = (ev: globalThis.PointerEvent) => {
              setObjDrag({
                id: o.id, mode, dx: 0, dy: 0,
                x: mode === "move" ? Math.max(0, o.x + ev.clientX - sx) : o.x,
                y: mode === "move" ? Math.max(0, o.y + ev.clientY - sy) : o.y,
                w: mode === "size" ? Math.max(24, o.w + ev.clientX - sx) : o.w,
                h: mode === "size" ? Math.max(24, o.h + ev.clientY - sy) : o.h,
              });
            };
            const up = (ev: globalThis.PointerEvent) => {
              window.removeEventListener("pointermove", move as never);
              window.removeEventListener("pointerup", up);
              window.removeEventListener("pointercancel", up);
              setObjDrag((cur) => {
                if (cur) {
                  const next = (sheet.objects ?? []).map((ob) =>
                    ob.id === o.id ? { ...ob, x: cur.x, y: cur.y, w: cur.w, h: cur.h } : ob);
                  onObjects(next);
                }
                return null;
              });
              void ev;
            };
            window.addEventListener("pointermove", move as never);
            window.addEventListener("pointerup", up);
            window.addEventListener("pointercancel", up);
          };
          return (
            <div key={o.id} className={`sheet-obj ${selObj === o.id ? "sel" : ""}`}
              style={{ left: HEADER_W + pos.x, top: HEADER_H + pos.y, width: pos.w, height: pos.h }}
              onPointerDown={(e) => startDrag(e, "move")}
              onContextMenu={(e) => { e.preventDefault(); setSelObj(o.id); }}>
              <img src={o.src} alt={o.alt ?? ""} draggable={false} />
              {canEdit && selObj === o.id && (
                <>
                  <span className="obj-grip" title="Drag to resize" onPointerDown={(e) => startDrag(e, "size")} />
                  <button className="obj-del" title="Delete object"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => { onObjects?.((sheet.objects ?? []).filter((ob) => ob.id !== o.id)); setSelObj(null); }}>✕</button>
                </>
              )}
            </div>
          );
        })}
        {/* freeze split indicators */}
        {fz.cols > 0 && <div className="freeze-v" style={{ left: frozenLeft }} />}
        {fz.rows > 0 && <div className="freeze-h" style={{ top: frozenTop }} />}

        {/* S16.1 page-break preview — dashed lines at each page boundary
            (portrait ≈ 7.5×10in / landscape ≈ 10×7.5in content at 96dpi) */}
        {pageBreaks && (() => {
          const land = wb?.print?.orientation === "landscape";
          const pw = land ? 960 : 720, ph = land ? 720 : 960;
          const vlines: number[] = [], hlines: number[] = [];
          let acc = 0;
          for (let c = 0; c < cols; c++) {
            acc += colW(c);
            if (acc > pw) { vlines.push(HEADER_W + acc - colW(c)); acc = colW(c); }
          }
          acc = 0;
          for (let r = 0; r < rows; r++) {
            acc += rowH(r);
            if (acc > ph) { hlines.push(HEADER_H + acc - rowH(r)); acc = rowH(r); }
          }
          return (
            <>
              {vlines.map((x, i) => (
                <div key={`pv${i}`} className="page-break-v" style={{ left: x }} />
              ))}
              {hlines.map((y, i) => (
                <div key={`ph${i}`} className="page-break-h" style={{ top: y }} />
              ))}
            </>
          );
        })()}

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
                  {!listDrop.items.length && <span style={{ padding: 8, fontSize: 12, color: "var(--muted)" }}>Empty list</span>}
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
