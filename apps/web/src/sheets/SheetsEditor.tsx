import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import type { Comment, DriveItem } from "@kreatix/shared";
import { api } from "../lib/api";
import { saveContent } from "../lib/drafts";
import { useCollabSession, useMapSync, type MapSync } from "../collab/useCollab";
import { useAuth } from "../lib/auth";
import { PresenceBar } from "../collab/PresenceBar";
import { AiPanel, type AiOp } from "../ai/AiPanel";
import { ShareDialog } from "../components/ShareDialog";
import { AppIcon } from "../components/AppIcon";
import { RibbonTabs } from "../components/RibbonTabs";
import { VersionsPanel } from "../components/VersionsPanel";
import { CommentsPanel } from "../components/CommentsPanel";
import { useToast } from "../pages/Home";
import { clampToViewport } from "../lib/mobile";
import type { Workbook, SheetData, Range, Ref, CellStyle, ChartSpec, CellData, CondFormat, PivotSpec, QuerySpec, SheetObject, Scenario, RichRun } from "./model";
import { toA1, colLabel, rangeToA1, rangeRefs, parseInput, cellEditText, parseA1, parseRange, shiftForFill, adjustForRowsCols, translateFormula, renameSheetRefs, validRangeName, validNameRef, validationsAt, validateValue, detectSeries, seriesValue, cellLocked, shiftCells, toggleOutline, richRunsMatch, type Validation, type FilterCrit, type TableSpec, type AllowRange } from "./model";
import { evaluateSheetIn, createSheetEvaluator, refsInFormula, displayValue, explainFormula, type EvalResult } from "./engine";
import { formatValue, NUM_FORMATS } from "./format";
import { sheetToCSV, csvToSheet, workbookToXLSX, workbookToODS, xlsxToWorkbook, tsvToCells, usedRangeA1, getCopyBuffer, pasteCells, type PasteMode, type PasteOp, findInWorkbook, replaceInCell, type FindHit, listItems, filterValues, computeFilteredRows, printSheet, type PrintOpts, buildPivotCells, pivotDrillRows, solveGoalSeek, errorCheck, flashFillTemplate, goToSpecial, applySubtotals, slicerHiddenRows, slicerValues, htmlToCells, scanExternRefs } from "./io";
import { runScript } from "./script";
import { runQuery, queryToSheet, type QueryResult } from "./query";
import { Grid } from "./Grid";
import { ChartCard } from "./Chart";
import { FxInput } from "./FxInput";
import { LinkDialog, SymbolDialog, FunctionWizard, PictureDialog, ScenarioDialog, DataTableDialog, SolverDialog, SpellPanel, CommentDialog, RichTextDialog } from "./SheetsDialogs";
import { captureScenario } from "./whatif";
import { spellcheckText } from "../writer/proofing";

type SaveState = "saved" | "saving" | "unsaved" | "error";

const CF_COLORS = ["#D4F5E2", "#FFE1DA", "#FFF3C4", "#DCE9FF"];
const FONTS = ["Inter", "Arial", "Calibri", "Cambria", "Consolas", "Courier New", "Georgia", "Roboto", "Segoe UI", "Times New Roman", "Verdana"];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36];
const CELL_STYLES: [string, string, CellStyle][] = [
  ["normal", "Normal", {}],
  ["good", "Good", { bg: "#D4F5E2", color: "#14532D" }],
  ["bad", "Bad", { bg: "#FFE1DA", color: "#7F1D1D" }],
  ["neutral", "Neutral", { bg: "#FFF3C4", color: "#713F12" }],
  ["warning", "Warning", { bg: "#FCE4D6", color: "#9C3D0F" }],
  ["input", "Input", { bg: "#DCE9FF", color: "#1E3A8A" }],
  ["heading1", "Heading 1", { b: true, size: 16, borders: { bottom: { w: 2, style: "solid", color: "var(--ink)" } } }],
  ["accent", "Accent", { bg: "#F2782E", color: "#FFFFFF", b: true }],
];
const fmtStat = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");

/** S15.1 — SHA-256 hex for the workbook open-password gate. */
async function sha256hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function SheetsEditor({ item, initialDoc, sourceFile, permission }: {
  item: DriveItem;
  initialDoc: unknown;
  /** Native binary upload (xlsx/ods) — auto-imported on mount. */
  sourceFile?: File | null;
  permission: string;
}) {
  const navigate = useNavigate();
  const canEdit = permission === "owner" || permission === "editor";
  const { msg, toast } = useToast();
  const [title, setTitle] = useState(item.name);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [panel, setPanel] = useState<"none" | "comments" | "versions" | "ai">("none");
  const [sharing, setSharing] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState(false);
  const [cfOpen, setCfOpen] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const [nameMgr, setNameMgr] = useState(false);
  const [pasteSpec, setPasteSpec] = useState(false);
  const [findDlg, setFindDlg] = useState<null | { replace: boolean }>(null);
  const [valDlg, setValDlg] = useState(false);
  const [cellMenu, setCellMenu] = useState<{ ref: string; x: number; y: number } | null>(null);
  const [noteEdit, setNoteEdit] = useState<{ ref: string; text: string } | null>(null);
  const [filterMenu, setFilterMenu] = useState<{ col: number; x: number; y: number } | null>(null);
  const [sortDlg, setSortDlg] = useState(false);
  const [dedupeDlg, setDedupeDlg] = useState(false);
  const [t2cDlg, setT2cDlg] = useState(false);
  const [tableDlg, setTableDlg] = useState(false);
  const [chartEdit, setChartEdit] = useState<ChartSpec | null>(null);
  const [sparkDlg, setSparkDlg] = useState(false);
  const [pivotDlg, setPivotDlg] = useState(false);
  const [calcDlg, setCalcDlg] = useState(false);
  const [inspDlg, setInspDlg] = useState(false);
  const [cellShiftDlg, setCellShiftDlg] = useState(false);
  const [gtsDlg, setGtsDlg] = useState(false);
  const [subtotalDlg, setSubtotalDlg] = useState(false);
  const [slicerDlg, setSlicerDlg] = useState(false);
  const [seekDlg, setSeekDlg] = useState(false);
  // ---- S19 Excel-parity batch ----
  const [showFormulas, setShowFormulas] = useState(false);          // S19.2 Ctrl+`
  const [linkDlg, setLinkDlg] = useState(false);                    // S19.1 insert/edit link
  const [symbolDlg, setSymbolDlg] = useState(false);                // S19.5 insert symbol
  const [fnWiz, setFnWiz] = useState(false);                        // S19.8 function wizard
  const [picDlg, setPicDlg] = useState(false);                      // S19.3 floating picture
  const [scenDlg, setScenDlg] = useState(false);                    // S19.6 scenario manager
  const [dtDlg, setDtDlg] = useState(false);                        // S19.6 data table
  const [solverDlg, setSolverDlg] = useState(false);                // S19.6 solver
  const [spellDlg, setSpellDlg] = useState(false);                  // S19.4 spelling panel
  const [spellOn, setSpellOn] = useState(false);                    // S19.4 underline toggle
  const [commentDlg, setCommentDlg] = useState<string | null>(null); // S19.16 comment thread
  const [rtDlg, setRtDlg] = useState<string | null>(null);            // S19.10 in-cell rich text
  const [printDlg, setPrintDlg] = useState(false);
  const [propsDlg, setPropsDlg] = useState(false);
  const [protectDlg, setProtectDlg] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
  const [audit, setAudit] = useState<"pre" | "dep" | null>(null);
  const [zoom, setZoom] = useState(1);
  const [borderMenu, setBorderMenu] = useState(false);
  const [borderStyle, setBorderStyle] = useState<{ w: 1 | 2 | 3; style: "solid" | "dashed" | "dotted" | "double"; color: string }>({ w: 1, style: "solid", color: "var(--ink)" });
  const [painter, setPainter] = useState<{ s: CellStyle } | null>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  const xlsxRef = useRef<HTMLInputElement>(null);
  const nameBoxRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const pendingJson = useRef<unknown>(null);

  const wbRef = useRef<Workbook | undefined>(undefined);
  const [wb, setWb] = useState<Workbook>(() => {
    const d = initialDoc as { workbook?: Workbook } | null;
    return d?.workbook?.sheets?.length ? d.workbook : { sheets: [{ name: "Sheet1", cells: {} }] };
  });
  // S15.1 — open-password gate (S8.4 workbook-level lock)
  const [pwLocked, setPwLocked] = useState(() => !!wb.passwordHash);
  const [pwTry, setPwTry] = useState("");
  const [pwErr, setPwErr] = useState(false);
  const [reviewDlg, setReviewDlg] = useState(false);
  const [pbPreview, setPbPreview] = useState(false);        // S16.1 page-break preview
  const [paneRatio, setPaneRatio] = useState(0.5);        // S16.1 split divider position
  const [viewsDlg, setViewsDlg] = useState(false);        // S16.1 custom views
  const [scriptDlg, setScriptDlg] = useState(false);      // S18.2 automation
  const [queryDlg, setQueryDlg] = useState(false);        // S18.3 get & transform
  const [active, setActive] = useState(0);
  // multi-range: last entry is the active range (Ctrl+click/drag adds more)
  const [selections, setSelections] = useState<Range[]>([{ c1: 0, r1: 0, c2: 0, r2: 0 }]);
  const selection = selections[selections.length - 1];
  const setSelection = useCallback((r: Range) => setSelections([r]), []);
  const addSelection = useCallback((r: Range) => setSelections((p) => [...p, r]), []);
  const extendSelection = useCallback((r: Range) => setSelections((p) => [...p.slice(0, -1), r]), []);
  // format painter hooks into every selection path (mousedown + drag-extend);
  // refs bridge the TDZ gap since mutateSheet is declared below
  const mutateRef = useRef<(fn: (s: SheetData) => void) => void>(() => {});
  const painterRef = useRef(painter);
  painterRef.current = painter;
  const selWithPaint = useCallback((r: Range) => {
    const p = painterRef.current;
    if (p) {
      mutateRef.current((s) => Array.from(rangeRefs(r)).forEach((ref) => {
        s.cells[ref] = { ...s.cells[ref], s: { ...p.s } };
      }));
    }
    setSelections([r]);
  }, []);
  const extWithPaint = useCallback((r: Range) => {
    const p = painterRef.current;
    if (p) {
      mutateRef.current((s) => Array.from(rangeRefs(r)).forEach((ref) => {
        s.cells[ref] = { ...s.cells[ref], s: { ...p.s } };
      }));
      setSelections((prev) => [...prev.slice(0, -1), r]);
    } else extendSelection(r);
  }, [extendSelection]);
  const [renamingTab, setRenamingTab] = useState<number | null>(null);
  const [tabMenu, setTabMenu] = useState<{ i: number; x: number; y: number } | null>(null);
  const dragTab = useRef<number | null>(null);
  // long-press on a tab → context menu on touch devices
  const tabLp = useRef<number>(0);
  useEffect(() => {
    const cancel = () => window.clearTimeout(tabLp.current);
    window.addEventListener("pointerup", cancel);
    window.addEventListener("pointercancel", cancel);
    return () => { window.removeEventListener("pointerup", cancel); window.removeEventListener("pointercancel", cancel); };
  }, []);
  const undoStack = useRef<Workbook[]>([]);
  const redoStack = useRef<Workbook[]>([]);
  const [, forceUi] = useState(0);

  const sheet = wb.sheets[Math.min(active, wb.sheets.length - 1)];
  wbRef.current = wb;
  // S11.5 calc modes — manual freezes the evaluated snapshot until F9/Calc Now
  const manualCalc = wb.calc?.mode === "manual";
  const [calcWb, setCalcWb] = useState(wb);
  useEffect(() => { if (!manualCalc) setCalcWb(wb); }, [wb, manualCalc]);
  const recalc = useCallback(() => setCalcWb(wb), [wb]);
  const evaluator = useMemo(
    () => createSheetEvaluator(manualCalc ? calcWb : wb, sheet.name),
    [wb, calcWb, manualCalc, sheet.name]);
  // S13.1 refresh-on-open — rebuild flagged pivots once per mount
  const refreshed = useRef(false);
  useEffect(() => {
    if (refreshed.current) return;
    const flagged = wb.sheets.filter((s) => s.pivots?.some((p) => p.refreshOnOpen));
    if (!flagged.length) { refreshed.current = true; return; }
    refreshed.current = true;
    setWb((prev) => {
      const next = structuredClone(prev);
      for (const s of next.sheets)
        s.pivots?.forEach((p, i) => {
          if (!p.refreshOnOpen) return;
          const built = buildPivotCells(next, s, s.pivots![i]);
          if (built) applyPivot(s, built, s.pivots![i]);
        });
      return next;
    });
  }, [wb]);
  const evals = evaluator.values;
  const selRefs = useMemo(() => selections.flatMap((r) => [...rangeRefs(r)]), [selections]);
  const anchorRef = toA1(selection.c1, selection.r1);

  // ---- collab: sheet meta + per-cell keys in shared Y.Maps (S9.1) ----
  // "sheets" map: sheet meta (everything except cells) + $order.
  // "cells" map: "Sheet\x01A1" → JSON CellData — two editors in one sheet
  // merge at cell granularity instead of last-writer-wins per sheet.
  const session = useCollabSession(item.id);
  const pushSnap = useRef<Workbook | null>(null);
  const cellsSyncRef = useRef<MapSync | null>(null);
  const applyRemoteRef = useRef<(changed: Map<string, string | null>) => void>(() => {});
  applyRemoteRef.current = (changed) => {
    setWb((prev) => {
      const next = structuredClone(prev);
      for (const [k, v] of changed) {
        if (k === "$order") {
          if (v) {
            const order = JSON.parse(v) as string[];
            next.sheets.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
          }
        } else if (v == null) {
          const i = next.sheets.findIndex((s) => s.name === k);
          if (i >= 0 && next.sheets.length > 1) next.sheets.splice(i, 1);
        } else {
          const sh = JSON.parse(v) as SheetData;
          const i = next.sheets.findIndex((s) => s.name === k);
          // keep local cells — cell data lives in the "cells" map
          if (i >= 0) next.sheets[i] = { ...sh, cells: next.sheets[i].cells };
          else {
            // hydrate cells that may have arrived in the cells map before this sheet's meta
            const cells: SheetData["cells"] = {};
            const m = cellsSyncRef.current?.map;
            if (m) for (const [ck, cv] of m) {
              const sep = ck.indexOf("\x01");
              if (ck.slice(0, sep) === sh.name) cells[ck.slice(sep + 1)] = JSON.parse(cv);
            }
            next.sheets.push({ ...sh, cells });
          }
        }
      }
      pushSnap.current = next;
      return next;
    });
  };
  const mapSync = useMapSync(session, "sheets", applyRemoteRef);
  const applyCellsRef = useRef<(changed: Map<string, string | null>) => void>(() => {});
  applyCellsRef.current = (changed) => {
    setWb((prev) => {
      const next = structuredClone(prev);
      for (const [key, v] of changed) {
        const sep = key.indexOf("\x01");
        const sh = next.sheets.find((s) => s.name === key.slice(0, sep));
        if (!sh) continue;
        if (v === null) delete sh.cells[key.slice(sep + 1)];
        else sh.cells[key.slice(sep + 1)] = JSON.parse(v);
      }
      pushSnap.current = next;
      return next;
    });
  };
  const cellsSync = useMapSync(session, "cells", applyCellsRef);
  cellsSyncRef.current = cellsSync;

  // seed existing cells into the cells map once — otherwise deletions of
  // pre-existing cells produce no remote event (key never existed in the map)
  const cellsSeeded = useRef(false);
  useEffect(() => {
    if (!cellsSync || cellsSeeded.current) return;
    cellsSeeded.current = true;
    const patch = new Map<string, string>();
    for (const s of pushSnap.current?.sheets ?? wb.sheets)
      for (const [ref, cell] of Object.entries(s.cells)) {
        const k = `${s.name}\x01${ref}`;
        if (!cellsSync.map.has(k)) patch.set(k, JSON.stringify(cell));
      }
    if (patch.size) cellsSync.patch(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellsSync]);

  // presence: which cell we're on
  useEffect(() => {
    session?.setLocal({ where: { label: `${sheet.name}!${anchorRef}` } });
  }, [session, sheet.name, anchorRef]);
  const anchorCell = sheet.cells[anchorRef];
  const anchorRes = evals.get(anchorRef);
  const anchorStyle = anchorCell?.s ?? {};

  // formula bar — controlled value; fxAnchor pins the cell being edited so a
  // blur caused by selecting another cell still commits to the right target
  const [fxValue, setFxValue] = useState("");
  const fxAnchor = useRef(anchorRef);
  useEffect(() => { fxAnchor.current = anchorRef; setFxValue(cellEditText(anchorCell)); }, [anchorRef, anchorCell]);

  // formula auditing — precedents of the anchor cell / dependents of it
  const auditRefs = useMemo(() => {
    if (!audit) return null;
    const set = new Set<string>();
    if (audit === "pre") {
      const f = sheet.cells[anchorRef]?.f;
      if (f) for (const r of refsInFormula(f)) {
        if (!r.sheet || r.sheet.toLowerCase() === sheet.name.toLowerCase())
          for (const ref of rangeRefs(r.range)) set.add(ref);
      }
    } else {
      const ar = parseA1(anchorRef);
      if (ar) for (const s2 of wb.sheets) for (const [ref, c] of Object.entries(s2.cells)) {
        if (!c.f) continue;
        for (const rr of refsInFormula(c.f)) {
          const on = (rr.sheet ?? s2.name).toLowerCase() === sheet.name.toLowerCase();
          if (on && ar.col >= rr.range.c1 && ar.col <= rr.range.c2 && ar.row >= rr.range.r1 && ar.row <= rr.range.r2)
            if (s2.name === sheet.name) set.add(ref);
        }
      }
    }
    return set;
  }, [audit, anchorRef, sheet, wb]);

  // status-bar quick stats over the whole multi-range selection
  const selStats = useMemo(() => {
    const vals: number[] = [];
    let count = 0;
    for (const ref of selRefs) {
      const cell = sheet.cells[ref];
      if (!cell || (cell.v === undefined && !cell.f)) continue;
      count++;
      const v = cell.f ? evals.get(ref)?.value : cell.v;
      if (typeof v === "number" && !isNaN(v)) vals.push(v);
    }
    if (!count) return null;
    const sum = vals.reduce((a, b) => a + b, 0);
    return {
      count, nums: vals.length, sum,
      avg: vals.length ? sum / vals.length : null,
      min: vals.length ? Math.min(...vals) : null,
      max: vals.length ? Math.max(...vals) : null,
    };
  }, [selRefs, sheet.cells, evals]);

  // data validation — invalid markers + list dropdown for the anchor cell
  const invalidCells = useMemo(() => {
    const out = new Set<string>();
    for (const v of sheet.validations ?? []) {
      const range = parseRange(v.range);
      if (!range) continue;
      const refs = Array.from(rangeRefs(range));
      if (refs.length > 5000) continue;
      const list = v.type === "list" ? listItems(v, wb, sheet.name) : null;
      for (const ref of refs) {
        const cell = sheet.cells[ref];
        const val = cell?.f ? evals.get(ref)?.value : cell?.v;
        if (!validateValue(val as CellData["v"], v, list)) out.add(ref);
      }
    }
    return out;
  }, [sheet, wb, evals]);

  const anchorVals = useMemo(() => validationsAt(sheet, anchorRef), [sheet, anchorRef]);
  const activeList = useMemo(() => {
    const lv = anchorVals.find((v) => v.type === "list");
    return lv ? listItems(lv, wb, sheet.name) : null;
  }, [anchorVals, wb, sheet.name]);
  const anchorInputMsg = anchorVals.find((v) => v.inputMsg)?.inputMsg;

  // cell notes (S3.5)
  const notedCells = useMemo(() => new Set(Object.keys(sheet.notes ?? {})), [sheet.notes]);
  const commentedCells = useMemo(() => new Set(Object.keys(sheet.comments ?? {})), [sheet.comments]);

  // ---- mutation helpers ----
  const mutate = useCallback((fn: (wb: Workbook) => void, save = true) => {
    setWb((prev) => {
      const next = structuredClone(prev);
      fn(next);
      undoStack.current.push(prev);
      if (undoStack.current.length > 60) undoStack.current.shift();
      redoStack.current = [];
      return next;
    });
    forceUi((n) => n + 1);
    if (save) {
      setSaveState("unsaved");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flushSave, 1200);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mutateSheet = useCallback((fn: (s: SheetData) => void) => {
    mutate((w) => {
      const s = w.sheets[active];
      if (!s.trackChanges) { fn(s); return; }
      // S15.3 — record the cell-level delta for accept/reject review
      const before = { ...s.cells };
      fn(s);
      const log = (s.changeLog ??= []);
      for (const ref of new Set([...Object.keys(before), ...Object.keys(s.cells)])) {
        const prev = before[ref], next = s.cells[ref];
        if (JSON.stringify(prev ?? null) !== JSON.stringify(next ?? null))
          log.push({ ref, prev, next, by: userRef.current?.displayName, at: Date.now() });
      }
      if (log.length > 500) s.changeLog = log.slice(-500);
    }, true);
  }, [mutate, active]);
  mutateRef.current = mutateSheet;
  /** Same as mutateSheet but never writes change-log entries — used by
   *  review accept/reject so rejections don't re-log as new changes (S15.3). */
  const mutateSheetRaw = useCallback((fn: (s: SheetData) => void) => {
    mutate((w) => fn(w.sheets[active]), true);
  }, [mutate, active]);

  // ---- AI ops (tool-constrained; routed through mutate → undo/autosave/collab) ----
  const aiSerialize = useCallback(() => wb.sheets.map((s) => {
    const lines = [`# ${s.name}`];
    let max = -1;
    for (const r of Object.keys(s.cells)) { const p = parseA1(r); if (p && p.row > max) max = p.row; }
    for (let row = 0; row <= Math.min(max, 80); row++) {
      const cols: string[] = [];
      for (let c = 0; c <= 13; c++) {
        const cell = s.cells[toA1(c, row)];
        cols.push(cell ? (cell.f ? `=${cell.f}` : String(cell.v ?? "")) : "");
      }
      if (cols.some((x) => x !== "")) lines.push(cols.join(","));
    }
    return lines.join("\n");
  }).join("\n\n").slice(0, 30000), [wb]);

  const aiApplyOps = useCallback((ops: AiOp[]) => {
    mutate((w) => {
      for (const o of ops) {
        if (o.op === "set_cells" || o.op === "set_format") {
          const s = w.sheets.find((x) => x.name === o.sheet);
          if (!s) continue;
          if (o.op === "set_cells") {
            for (const [ref, val] of Object.entries((o.cells as Record<string, string>) ?? {})) {
              s.cells[ref] = { s: s.cells[ref]?.s, ...parseInput(val) };
            }
          } else {
            for (const ref of (o.refs as string[]) ?? []) {
              s.cells[ref] = { ...s.cells[ref], s: { ...s.cells[ref]?.s, ...(o.style as CellStyle) } };
            }
          }
        } else if (o.op === "add_sheet" && !w.sheets.some((x) => x.name === o.name)) {
          w.sheets.push({ name: String(o.name), cells: {} });
        }
      }
    });
  }, [mutate]);

  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; pushSnap.current = wb; return; }
    pendingJson.current = { kind: "sheets", workbook: wb };
    const prev = pushSnap.current;
    if (prev === wb) return; // remote-applied state — nothing to echo back
    pushSnap.current = wb;
    // sheet meta (cells stripped — they sync through the cells map)
    if (mapSync) {
      const m = new Map<string, string>();
      for (const s of wb.sheets) {
        const { cells: _cells, ...meta } = s;
        m.set(s.name, JSON.stringify({ ...meta, cells: {} }));
      }
      m.set("$order", JSON.stringify(wb.sheets.map((s) => s.name)));
      mapSync.push(m);
    }
    // per-cell patch: only keys that differ from the last pushed snapshot
    if (cellsSync && prev) {
      const patch = new Map<string, string | null>();
      const prevSheets = new Map(prev.sheets.map((s) => [s.name, s]));
      for (const s of wb.sheets) {
        const ps = prevSheets.get(s.name);
        for (const [ref, cell] of Object.entries(s.cells)) {
          const js = JSON.stringify(cell);
          if (JSON.stringify(ps?.cells[ref]) !== js) patch.set(`${s.name}\x01${ref}`, js);
        }
        for (const ref of Object.keys(ps?.cells ?? {}))
          if (!(ref in s.cells)) patch.set(`${s.name}\x01${ref}`, null);
      }
      for (const [name, ps] of prevSheets)
        if (!wb.sheets.some((s) => s.name === name))
          for (const ref of Object.keys(ps.cells)) patch.set(`${name}\x01${ref}`, null);
      if (patch.size) cellsSync.patch(patch);
    }
  }, [wb, mapSync, cellsSync]);

  const flushSave = useCallback(async () => {
    if (!pendingJson.current) return;
    const payload = pendingJson.current;
    pendingJson.current = null;
    setSaveState("saving");
    const ok = await saveContent(item.id, payload, !!session);
    if (ok) setSaveState("saved");
    else {
      pendingJson.current = payload;
      setSaveState("error");
      toast(navigator.onLine
        ? "Could not save — will retry on next edit"
        : "Offline — changes saved locally, syncing on reconnect");
    }
  }, [item.id, session, toast]);

  // replay pending saves when connectivity returns
  useEffect(() => {
    const on = () => { void flushSave(); };
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, [flushSave]);

  useEffect(() => {
    const flush = () => { if (saveTimer.current) { clearTimeout(saveTimer.current); flushSave(); } };
    window.addEventListener("beforeunload", flush);
    return () => { window.removeEventListener("beforeunload", flush); flush(); };
  }, [flushSave]);

  // ---- cell ops ----
  const { user } = useAuth();
  const userRef = useRef(user);
  userRef.current = user;
  const stamp = useCallback(() => ({ by: user?.displayName ?? "you", at: Date.now() }), [user]);

  /** S9.2/S15.2 — true if any of `refs` is locked by sheet protection for this user. */
  const anyLocked = useCallback((refs: string[]) => {
    const bad = sheet.protected ? refs.find((r) => cellLocked(sheet, r, user)) : undefined;
    if (bad) toast(`${bad} is locked — this sheet is protected`);
    return !!bad;
  }, [sheet, toast]);

  /** Structural ops (insert/delete/sort/merge/dedupe) are blocked entirely
   *  on protected sheets — they'd break allowed-range boundaries. */
  const structuralLocked = useCallback(() => {
    if (sheet.protected) toast("Blocked — this sheet is protected");
    return !!sheet.protected;
  }, [sheet, toast]);

  const commitCell = useCallback((ref: string, raw: string, rt?: RichRun[]) => {
    if (anyLocked([ref])) return;
    // data validation — direct entry only (paste bypasses, like Excel)
    if (raw.trim() !== "" && !raw.trimStart().startsWith("=")) {
      for (const v of validationsAt(sheet, ref)) {
        if (v.type === "any") continue;
        const parsed = parseInput(raw);
        const ok = validateValue(parsed.v, v, v.type === "list" ? listItems(v, wb, sheet.name) : null);
        if (!ok) {
          toast(v.errorMsg || `"${raw}" doesn't match the validation for ${ref}`);
          if (v.errorStyle !== "warn") return;
        }
      }
    }
    mutateSheet((s) => {
      if (raw.trim() === "") {
        const style = s.cells[ref]?.s;
        if (style) s.cells[ref] = { s: style }; else delete s.cells[ref];
        return;
      }
      const parsed = parseInput(raw);
      // S19.10 — rich runs persist only for plain string values that match
      const keepRt = rt && !parsed.f && typeof parsed.v === "string" && richRunsMatch(rt, parsed.v) ? rt : undefined;
      s.cells[ref] = { s: s.cells[ref]?.s, ...parsed, rt: keepRt, link: s.cells[ref]?.link, h: stamp() };
    });
  }, [mutateSheet, sheet, wb, toast, anyLocked, stamp]);

  const clearCells = useCallback((refs: string[]) => {
    if (anyLocked(refs)) return;
    mutateSheet((s) => refs.forEach((r) => { if (s.cells[r]) s.cells[r] = { s: s.cells[r].s, h: stamp() }; }));
  }, [mutateSheet, anyLocked, stamp]);

  const pasteTsv = useCallback((anchor: Ref, tsv: string, html?: string) => {
    // web paste (S17.2) — HTML tables carry spans/styles TSV can't express
    const cells = html ? htmlToCells(html, anchor) : tsvToCells(tsv, anchor);
    if (!cells) return;
    if (anyLocked(Object.keys(cells))) return;
    const h = stamp();
    mutateSheet((s) => Object.entries(cells).forEach(([r, c]) => { s.cells[r] = { ...c, h }; }));
    const dc = Math.max(...Object.keys(cells).map((r) => parseA1(r)!.col)) - anchor.col;
    const dr = Math.max(...Object.keys(cells).map((r) => parseA1(r)!.row)) - anchor.row;
    setSelection({ c1: anchor.col, r1: anchor.row, c2: anchor.col + dc, r2: anchor.row + dr });
  }, [mutateSheet, anyLocked, stamp]);

  const pasteImage = useCallback((anchor: Ref, dataUrl: string) => {
    const ref = toA1(anchor.col, anchor.row);
    if (anyLocked([ref])) return;
    const h = stamp();
    mutateSheet((s) => { s.cells[ref] = { ...s.cells[ref], img: dataUrl, h }; });
  }, [mutateSheet, anyLocked, stamp]);

  // S18.1 — rich data type: an entity cell whose fields formulas read as A1.Prop
  const insertEntity = () => {
    const kind = prompt("Entity kind (Stock, Geography, Product…):")?.trim();
    if (!kind) return;
    const name = prompt("Entity name:")?.trim();
    if (!name) return;
    let props: Record<string, unknown> = {};
    const raw = prompt('Fields as JSON, e.g. {"Price":420,"Change":1.2}:');
    if (raw?.trim()) { try { props = JSON.parse(raw); } catch { toast("Invalid JSON"); return; } }
    if (anyLocked(selRefs)) return;
    const h = stamp();
    mutateSheet((s) => selRefs.forEach((r) => { s.cells[r] = { ent: { kind, name, props }, h }; }));
  };

  const setStyle = useCallback((patch: CellStyle) => {
    if (anyLocked(selRefs)) return;
    mutateSheet((s) => selRefs.forEach((r) => {
      s.cells[r] = { ...s.cells[r], s: { ...s.cells[r]?.s, ...patch } };
    }));
  }, [mutateSheet, selRefs, anyLocked]);

  const toggleStyle = useCallback((key: "b" | "i" | "u" | "st") => {
    setStyle({ [key]: !anchorStyle[key] });
  }, [setStyle, anchorStyle]);

  // borders — presets apply to selection edges (S4.3)
  const applyBorder = useCallback((preset: "all" | "outside" | "top" | "bottom" | "left" | "right" | "none") => {
    const e = { ...borderStyle };
    mutateSheet((s) => {
      const edge = (ref: string, side: "top" | "right" | "bottom" | "left", on: boolean) => {
        const cell = s.cells[ref] ?? {};
        const borders = { ...(cell.s?.borders ?? {}) } as Record<string, unknown>;
        if (on) borders[side] = { ...e }; else delete borders[side];
        s.cells[ref] = { ...cell, s: { ...(cell.s ?? {}), borders: Object.keys(borders).length ? borders as CellStyle["borders"] : undefined } };
      };
      for (let r = selection.r1; r <= selection.r2; r++) for (let c = selection.c1; c <= selection.c2; c++) {
        const ref = toA1(c, r);
        if (preset === "none") { (["top", "right", "bottom", "left"] as const).forEach((sd) => edge(ref, sd, false)); continue; }
        if (preset === "all") { (["top", "right", "bottom", "left"] as const).forEach((sd) => edge(ref, sd, true)); continue; }
        if ((preset === "outside" || preset === "top") && r === selection.r1) edge(ref, "top", true);
        if ((preset === "outside" || preset === "bottom") && r === selection.r2) edge(ref, "bottom", true);
        if ((preset === "outside" || preset === "left") && c === selection.c1) edge(ref, "left", true);
        if ((preset === "outside" || preset === "right") && c === selection.c2) edge(ref, "right", true);
      }
    });
    setBorderMenu(false);
  }, [mutateSheet, selection, borderStyle]);

  // format painter — next click/drag paints captured style, mouseup disarms (S4.4)
  useEffect(() => {
    if (!painter) return;
    const up = () => setPainter(null);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [painter]);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(wb);
    setWb(prev);
    setSaveState("unsaved");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, 1200);
  }, [wb, flushSave]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(wb);
    setWb(next);
    setSaveState("unsaved");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, 1200);
  }, [wb, flushSave]);

  // fill handle: repeat source block across extended region
  const fillHandle = useCallback((src: Range, dst: Range) => {
    if (anyLocked([...rangeRefs(dst)])) return;
    mutateSheet((s) => {
      const sw = src.c2 - src.c1 + 1, sh = src.r2 - src.r1 + 1;
      const ev = evaluateSheetIn(wb, s.name);
      const vertical = dst.r2 > src.r2 || dst.r1 < src.r1;
      const horiz = dst.c2 > src.c2 || dst.c1 < src.c1;
      // seed lines for series detection (one per column for vertical fills, per row for horizontal)
      const seriesOf = (axis: "row" | "col", line: number) => {
        const refs = axis === "row"
          ? Array.from({ length: sh }, (_, i) => toA1(line, src.r1 + i))
          : Array.from({ length: sw }, (_, i) => toA1(src.c1 + i, line));
        if (refs.some((r) => s.cells[r]?.f)) return null; // formulas fill by shifting, not by series
        return detectSeries(refs.map((r) => {
          const c = s.cells[r];
          return c ? (ev.get(r)?.value ?? c.v) : null;
        }));
      };
      for (const ref of rangeRefs(dst)) {
        const p = parseA1(ref)!;
        if (p.col >= src.c1 && p.col <= src.c2 && p.row >= src.r1 && p.row <= src.r2) continue;
        const sr = toA1(src.c1 + ((p.col - src.c1) % sw + sw) % sw, src.r1 + ((p.row - src.r1) % sh + sh) % sh);
        const srcCell = s.cells[sr];
        // series: vertical fill → per-column seeds; horizontal → per-row
        if (vertical && !horiz) {
          const ser = seriesOf("row", p.col);
          if (ser) {
            s.cells[ref] = { v: seriesValue(ser, p.row - src.r1), s: srcCell?.s };
            continue;
          }
        } else if (horiz && !vertical) {
          const ser = seriesOf("col", p.row);
          if (ser) {
            s.cells[ref] = { v: seriesValue(ser, p.col - src.c1), s: srcCell?.s };
            continue;
          }
        }
        if (srcCell) {
          const copy = structuredClone(srcCell);
          if (copy.f) copy.f = shiftForFill(copy.f, p.col - (parseA1(sr)!.col), p.row - (parseA1(sr)!.row));
          s.cells[ref] = copy;
        }
      }
    });
  }, [mutateSheet, wb, anyLocked]);

  // S16.3 — Ctrl+D fills down from the top row, Ctrl+R right from the left col
  const fillDir = useCallback((dir: "down" | "right") => {
    if (dir === "down" && selection.r2 > selection.r1)
      fillHandle({ c1: selection.c1, r1: selection.r1, c2: selection.c2, r2: selection.r1 },
        { c1: selection.c1, r1: selection.r1 + 1, c2: selection.c2, r2: selection.r2 });
    if (dir === "right" && selection.c2 > selection.c1)
      fillHandle({ c1: selection.c1, r1: selection.r1, c2: selection.c1, r2: selection.r2 },
        { c1: selection.c1 + 1, r1: selection.r1, c2: selection.c2, r2: selection.r2 });
  }, [fillHandle, selection]);

  // sort selected rows by one or more key columns; formula refs pointing
  // into the sorted block are remapped to the rows' new positions.
  // `range` defaults to selection; the filter menu sorts data rows only.
  // sort keys: value sort by default; `order` = custom list (unlisted sort
  // last, stable); `color` = rows whose key cell fill matches sort first.
  const sortBy = useCallback((keys: { col: number; asc: boolean; order?: string[]; color?: string }[], range?: Range) => {
    if (structuralLocked()) return;
    const rng = range ?? selection;
    mutateSheet((s) => {
      const ev = evaluateSheetIn(wb, s.name);
      const rows: number[] = [];
      for (let r = rng.r1; r <= rng.r2; r++) rows.push(r);
      const val = (r: number, c: number) => {
        const ref = toA1(c, r);
        const cell = s.cells[ref];
        const res = ev.get(ref);
        return cell?.f ? res?.value : cell?.v;
      };
      rows.sort((a, b) => {
        for (const k of keys) {
          if (k.color) {
            const ha = s.cells[toA1(k.col, a)]?.s?.bg === k.color ? 0 : 1;
            const hb = s.cells[toA1(k.col, b)]?.s?.bg === k.color ? 0 : 1;
            if (ha !== hb) return k.asc ? ha - hb : hb - ha;
            continue;
          }
          const va = val(a, k.col), vb = val(b, k.col);
          if (k.order?.length) {
            const ia = k.order.findIndex((x) => x.toLowerCase() === String(va ?? "").toLowerCase());
            const ib = k.order.findIndex((x) => x.toLowerCase() === String(vb ?? "").toLowerCase());
            if (ia !== ib) return (ia < 0 ? k.order.length : ia) - (ib < 0 ? k.order.length : ib);
            if (ia >= 0) continue;
          }
          const na = Number(va), nb = Number(vb);
          const cmp = !isNaN(na) && !isNaN(nb) ? na - nb : String(va ?? "").localeCompare(String(vb ?? ""));
          if (cmp) return k.asc ? cmp : -cmp;
        }
        return a - b; // stable
      });
      const rowMap = new Map<number, number>();
      rows.forEach((srcRow, i) => rowMap.set(srcRow, rng.r1 + i));
      const next: Record<string, (typeof s.cells)[string] | undefined> = {};
      rows.forEach((srcRow, i) => {
        for (let c = rng.c1; c <= rng.c2; c++) {
          next[toA1(c, rng.r1 + i)] = s.cells[toA1(c, srcRow)];
        }
      });
      for (let r = rng.r1; r <= rng.r2; r++)
        for (let c = rng.c1; c <= rng.c2; c++) {
          const ref = toA1(c, r);
          if (next[ref]) s.cells[ref] = next[ref]!; else delete s.cells[ref];
        }
      for (const cell of Object.values(s.cells)) {
        if (cell.f) cell.f = translateFormula(cell.f, (r) =>
          r.col >= rng.c1 && r.col <= rng.c2 && rowMap.has(r.row)
            ? { col: r.col, row: rowMap.get(r.row)! }
            : { col: r.col, row: r.row });
      }
    });
  }, [mutateSheet, selection, wb, structuralLocked]);

  const sortSel = useCallback((asc: boolean) => sortBy([{ col: selection.c1, asc }]), [sortBy, selection.c1]);

  // S12.3 outline grouping — bump the outline level of selected rows
  const groupSel = useCallback((delta: 1 | -1) => {
    if (structuralLocked()) return;
    mutateSheet((s) => {
      const lv = { ...(s.outlineRows ?? {}) };
      for (let r = selection.r1; r <= selection.r2; r++) {
        const next = (lv[r] ?? 0) + delta;
        if (next <= 0) delete lv[r]; else lv[r] = Math.min(next, 8);
      }
      s.outlineRows = Object.keys(lv).length ? lv : undefined;
    });
  }, [mutateSheet, selection, structuralLocked]);

  // S19.7 — column outline grouping (mirrors rows)
  const groupCols = useCallback((delta: 1 | -1) => {
    if (structuralLocked()) return;
    mutateSheet((s) => {
      const lv = { ...(s.outlineCols ?? {}) };
      for (let c = selection.c1; c <= selection.c2; c++) {
        const next = (lv[c] ?? 0) + delta;
        if (next <= 0) delete lv[c]; else lv[c] = Math.min(next, 8);
      }
      s.outlineCols = Object.keys(lv).length ? lv : undefined;
    });
  }, [mutateSheet, selection, structuralLocked]);

  // ---- S19 Excel-parity handlers ----

  // S19.1 — open a cell link: "#Sheet!A1" jumps internally, else new tab
  const openLink = useCallback((url: string) => {
    if (url.startsWith("#")) {
      const t = url.slice(1);
      const q = t.match(/^(?:'([^']+)'|([A-Za-z_][\w.]*))!(.+)$/);
      const ref = (q ? q[3] : t).replace(/\$/g, "");
      const range = parseRange(ref);
      if (!range) { toast(`"${t}" isn't a valid destination`); return; }
      const sn = q ? (q[1] ?? q[2]) : sheet.name;
      const si = wb.sheets.findIndex((s) => s.name.toLowerCase() === sn.toLowerCase());
      if (si < 0) { toast(`No sheet named ${sn}`); return; }
      setActive(si);
      setSelection(range);
      return;
    }
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    window.open(href, "_blank", "noopener,noreferrer");
  }, [wb, sheet.name, setSelection, toast]);

  // S19.1 — write a hyperlink into the anchor cell
  const insertLink = useCallback((text: string, link: string) => {
    if (anyLocked([anchorRef])) return;
    mutateSheet((s) => {
      const cur = s.cells[anchorRef] ?? {};
      s.cells[anchorRef] = { ...cur, v: text, link, s: { ...cur.s, color: "#1155CC", u: true } };
    });
    toast("Link inserted");
  }, [anchorRef, mutateSheet, anyLocked, toast]);

  // S19.5 — append a symbol to the anchor cell's text
  const insertSymbol = useCallback((ch: string) => {
    if (anyLocked([anchorRef])) return;
    mutateSheet((s) => {
      const cur = s.cells[anchorRef] ?? {};
      // inserting into a literal cell appends; a formula cell is replaced
      s.cells[anchorRef] = cur.f
        ? { s: cur.s, v: ch }
        : { ...cur, v: `${cur.v ?? ""}${ch}` };
    });
  }, [anchorRef, mutateSheet, anyLocked]);

  // S19.3 — floating objects mutate through the normal sheet path (syncs via Yjs)
  const setObjects = useCallback((next: SheetObject[]) => {
    mutateSheet((s) => { s.objects = next.length ? next : undefined; });
  }, [mutateSheet]);

  // S19.6 — scenario add/show/delete
  const scenarioAdd = useCallback((name: string) => {
    const refs = [...rangeRefs(selection)];
    const sc = captureScenario(wbRef.current ?? wb, sheet.name, name, refs);
    mutateSheet((s) => { s.scenarios = [...(s.scenarios ?? []).filter((x) => x.name !== name), sc]; });
    toast(`Scenario "${name}" saved (${refs.length} cell${refs.length > 1 ? "s" : ""})`);
  }, [wb, sheet.name, selection, mutateSheet, toast]);
  const scenarioShow = useCallback((sc: Scenario) => {
    const refs = Object.keys(sc.cells);
    if (anyLocked(refs)) return;
    mutateSheet((s) => {
      for (const [ref, v] of Object.entries(sc.cells))
        s.cells[ref] = { ...(s.cells[ref] ?? {}), v, f: undefined };
    });
    toast(`Showing "${sc.name}"`);
  }, [mutateSheet, anyLocked, toast]);
  const scenarioDelete = useCallback((name: string) => {
    mutateSheet((s) => { s.scenarios = (s.scenarios ?? []).filter((x) => x.name !== name); });
  }, [mutateSheet]);

  // S19.6 — write a computed data-table matrix below the anchor
  const dataTableApply = useCallback((anchor: string, matrix: (number | string | null)[][]) => {
    const a = parseA1(anchor);
    if (!a) return;
    const refs: string[] = [];
    matrix.forEach((row, r) => row.forEach((_, c) => refs.push(toA1(a.col + c, a.row + r))));
    if (anyLocked(refs)) return;
    mutateSheet((s) => {
      matrix.forEach((row, r) => row.forEach((v, c) => {
        if (v === null || v === undefined) return;
        const ref = toA1(a.col + c, a.row + r);
        s.cells[ref] = { ...(s.cells[ref] ?? {}), v: v as CellData["v"] };
      }));
    });
    toast("Data table created");
  }, [mutateSheet, anyLocked, toast]);

  // S19.6 — write solver results into the changing cells
  const solverApply = useCallback((values: Record<string, number>) => {
    const refs = Object.keys(values);
    if (anyLocked(refs)) return;
    mutateSheet((s) => {
      for (const [ref, v] of Object.entries(values))
        s.cells[ref] = { ...(s.cells[ref] ?? {}), v, f: undefined };
    });
  }, [mutateSheet, anyLocked]);

  // S19.4 — misspelled refs for the wavy underline (only while enabled)
  const spellMisses = useMemo(() => {
    if (!spellOn) return undefined;
    const out = new Set<string>();
    for (const [ref, cell] of Object.entries(sheet.cells)) {
      if (cell.f || typeof cell.v !== "string") continue;
      if (spellcheckText(cell.v, 0).length) out.add(ref);
    }
    return out;
  }, [spellOn, sheet.cells]);
  const spellFix = useCallback((ref: string, from: number, to: number, word: string) => {
    mutateSheet((s) => {
      const cur = s.cells[ref];
      if (!cur || typeof cur.v !== "string") return;
      s.cells[ref] = { ...cur, v: cur.v.slice(0, from) + word + cur.v.slice(to) };
    });
  }, [mutateSheet]);

  // S19.12 — Quick Analysis actions on the active selection
  const quickAction = useCallback((kind: string, r: Range) => {
    if (anyLocked([...rangeRefs(r)]) && kind !== "chart") return;
    mutateSheet((s) => {
      switch (kind) {
        case "sum": {
          // totals row under the selection: =SUM(col-range) per column
          for (let c = r.c1; c <= r.c2; c++) {
            const ref = toA1(c, r.r2 + 1);
            s.cells[ref] = { f: `SUM(${toA1(c, r.r1)}:${toA1(c, r.r2)})`, s: { b: true } };
          }
          break;
        }
        case "chart": {
          const id = `ch${Date.now().toString(36)}`;
          const rng = rangeToA1(r);
          // S19.13 — pick a sensible type: single row/col → pie, else column
          const type: ChartSpec["type"] = (r.c2 - r.c1) <= 1 && (r.r2 - r.r1) <= 6 && (r.c2 - r.c1 + 1) * (r.r2 - r.r1 + 1) <= 8 ? "pie" : "bar";
          s.charts = [...(s.charts ?? []), { id, type, range: rng, title: rng, x: 40, y: 40 }];
          break;
        }
        case "colorscale":
          s.cf = [...(s.cf ?? []), { range: rangeToA1(r), type: "colorscale", minColor: "#F8696B", maxColor: "#63BE7B" }];
          break;
        case "databar":
          s.cf = [...(s.cf ?? []), { range: rangeToA1(r), type: "databar", bar: "#3574E0" }];
          break;
        case "table":
          s.tables = [...(s.tables ?? []), { name: `Table${(s.tables ?? []).length + 1}`, range: rangeToA1(r), style: "banded" }];
          break;
        case "sparkline":
          for (let row = r.r1; row <= r.r2; row++) {
            s.sparklines = { ...(s.sparklines ?? {}), [toA1(r.c2 + 1, row)]: { range: `${toA1(r.c1, row)}:${toA1(r.c2, row)}`, type: "line" } };
          }
          break;
      }
    });
    if (kind === "chart") toast("Chart inserted — drag to position");
  }, [mutateSheet, anyLocked, toast]);

  // S19.15 — Copy as picture: render the selection to a canvas, then to the
  // clipboard (or a downloaded PNG when ClipboardItem is unavailable)
  const copyAsPicture = useCallback(async () => {
    const r = selection;
    const cw = (c: number) => sheet.colWidths?.[c] ?? 100;
    const rh = (row: number) => sheet.rowHeights?.[row] ?? 26;
    const W = Array.from({ length: r.c2 - r.c1 + 1 }, (_, i) => cw(r.c1 + i)).reduce((a, b) => a + b, 0);
    const H = Array.from({ length: r.r2 - r.r1 + 1 }, (_, i) => rh(r.r1 + i)).reduce((a, b) => a + b, 0);
    const cv = document.createElement("canvas");
    cv.width = W + 2; cv.height = H + 2;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = "#D9D4CF"; ctx.font = "11px Inter, sans-serif";
    let y = 1;
    for (let row = r.r1; row <= r.r2; row++) {
      let x = 1;
      for (let c = r.c1; c <= r.c2; c++) {
        const w = cw(c), h = rh(row);
        const ref = toA1(c, row);
        const cell = sheet.cells[ref];
        const s = cell?.s ?? {};
        const res = evals.get(ref);
        const v = cell?.f ? res?.value : cell?.v;
        const txt = res?.error ?? formatValue(Array.isArray(v) ? "" : v, s.fmt);
        if (s.bg) { ctx.fillStyle = s.bg; ctx.fillRect(x, y, w, h); }
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = s.color ?? "#26221F";
        ctx.font = `${s.i ? "italic " : ""}${s.b ? "600 " : ""}${s.size ?? 11}px ${s.font ?? "Inter"}, sans-serif`;
        ctx.textBaseline = "middle";
        const align = s.align ?? (typeof v === "number" ? "right" : "left");
        const tx = align === "right" ? x + w - 5 : align === "center" ? x + w / 2 : x + 5;
        ctx.textAlign = align === "right" ? "right" : align === "center" ? "center" : "left";
        ctx.fillText(String(txt ?? ""), tx, y + h / 2, w - 8);
        x += w;
      }
      y += rh(row);
    }
    try {
      const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, "image/png"));
      if (blob && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        toast("Copied range as picture");
      } else throw new Error("no-clipboard");
    } catch {
      const a = document.createElement("a");
      a.href = cv.toDataURL("image/png");
      a.download = "range.png"; a.click();
      toast("Downloaded range.png (clipboard images not permitted)");
    }
  }, [selection, sheet, evals, toast]);

  // S12.6 Flash Fill — anchor cell holds a worked example; infer the
  // transform from the other values on its row and fill the column down
  // across the contiguous data region.
  const flashFill = useCallback(() => {
    const ap = parseA1(anchorRef);
    const ex = String(sheet.cells[anchorRef]?.v ?? "").trim();
    if (!ap || !ex) { toast("Type a worked example in the anchor cell first"); return; }
    const ur = parseRange(usedRangeA1(sheet.cells));
    if (!ur) return;
    const rowVals = (r: number) => {
      const vals: string[] = [];
      for (let c = ur.c1; c <= ur.c2; c++)
        if (c !== ap.col) vals.push(String(sheet.cells[toA1(c, r)]?.v ?? ""));
      return vals;
    };
    const fn = flashFillTemplate(rowVals(ap.row), ex);
    if (!fn) { toast("Couldn't infer a pattern from the example"); return; }
    const targets: string[] = [];
    for (let r = ur.r1; r <= ur.r2; r++) {
      if (r === ap.row) continue;
      if (rowVals(r).every((v) => v === "")) continue; // empty row
      targets.push(toA1(ap.col, r));
    }
    if (anyLocked(targets)) return;
    mutateSheet((s) => {
      for (let r = ur.r1; r <= ur.r2; r++) {
        if (r === ap.row) continue;
        const vals = rowVals(r);
        if (vals.every((v) => v === "")) continue;
        const out = fn(vals);
        if (out !== null) s.cells[toA1(ap.col, r)] = { s: s.cells[toA1(ap.col, r)]?.s, v: out, h: stamp() };
      }
    });
    toast(`Flash fill applied to ${targets.length} cells`);
  }, [anchorRef, sheet, mutateSheet, anyLocked, toast, stamp]);

  // ---- S5: filter / dedupe / text-to-columns / tables ----
  const dispSheet = useMemo<SheetData>(() => {
    const f = sheet.filter ? computeFilteredRows(sheet, wb) : [];
    const sl = slicerHiddenRows(sheet, wb);
    return f.length || sl.length ? { ...sheet, filteredRows: [...f, ...sl] } : sheet;
  },
  [sheet, wb]);

  const toggleFilter = useCallback(() => {
    if (sheet.filter) { mutateSheet((s) => { s.filter = undefined; }); return; }
    // single-cell selection → auto-range from used range rows, selection cols
    let rng = { ...selection };
    if (rng.r1 === rng.r2 && rng.c1 === rng.c2) {
      const m = /^([A-Z]+\d+):([A-Z]+\d+)$/.exec(usedRangeA1(sheet.cells));
      if (m) { const a = parseA1(m[1])!, b = parseA1(m[2])!; rng = { c1: a.col, r1: a.row, c2: b.col, r2: b.row }; }
    }
    mutateSheet((s) => { s.filter = { range: rangeToA1(rng), cols: {} }; });
  }, [mutateSheet, sheet, selection]);

  const setFilterCol = useCallback((col: number, crit: FilterCrit | null) => {
    mutateSheet((s) => {
      if (!s.filter) return;
      const cols = { ...s.filter.cols };
      if (crit) cols[col] = crit; else delete cols[col];
      s.filter = { ...s.filter, cols };
    });
  }, [mutateSheet]);

  const sortFilterCol = useCallback((col: number, asc: boolean) => {
    const r = sheet.filter ? parseRange(sheet.filter.range) : null;
    if (!r) return;
    sortBy([{ col, asc }], { ...r, r1: r.r1 + 1 }); // skip header row
  }, [sheet.filter, sortBy]);

  const dedupe = useCallback((cols: number[]) => {
    if (structuralLocked()) return;
    mutateSheet((s) => {
      const ev = evaluateSheetIn(wb, s.name);
      const seen = new Set<string>();
      const keep: number[] = [];
      for (let r = selection.r1; r <= selection.r2; r++) {
        const key = cols.map((c) => {
          const ref = toA1(c, r);
          const cell = s.cells[ref];
          return String(cell?.f ? ev.get(ref)?.value : cell?.v ?? "");
        }).join("\x01");
        if (!seen.has(key)) { seen.add(key); keep.push(r); }
      }
      const rowMap = new Map<number, number>();
      keep.forEach((srcRow, i) => rowMap.set(srcRow, selection.r1 + i));
      const next: Record<string, (typeof s.cells)[string] | undefined> = {};
      keep.forEach((srcRow, i) => {
        for (let c = selection.c1; c <= selection.c2; c++)
          next[toA1(c, selection.r1 + i)] = s.cells[toA1(c, srcRow)];
      });
      for (let r = selection.r1; r <= selection.r2; r++)
        for (let c = selection.c1; c <= selection.c2; c++) {
          const ref = toA1(c, r);
          if (next[ref]) s.cells[ref] = next[ref]!; else delete s.cells[ref];
        }
      for (const cell of Object.values(s.cells)) {
        if (cell.f) cell.f = translateFormula(cell.f, (r) =>
          r.col >= selection.c1 && r.col <= selection.c2 && rowMap.has(r.row)
            ? { col: r.col, row: rowMap.get(r.row)! }
            : { col: r.col, row: r.row });
      }
      toast(`${selection.r2 - selection.r1 + 1 - keep.length} duplicate row(s) removed`);
    });
  }, [mutateSheet, wb, selection, structuralLocked]);

  const textToCols = useCallback((delim: string) => {
    if (anyLocked([...rangeRefs(selection)])) return;
    mutateSheet((s) => {
      for (let r = selection.r1; r <= selection.r2; r++)
        for (let c = selection.c1; c <= selection.c2; c++) {
          const cell = s.cells[toA1(c, r)];
          if (!cell || cell.f) continue;
          const parts = String(cell.v ?? "").split(delim);
          parts.forEach((p, i) => { s.cells[toA1(c + i, r)] = { ...cell, ...parseInput(p.trim()) }; });
        }
    });
  }, [mutateSheet, selection, anyLocked]);

  const createTable = useCallback((name: string, style: TableSpec["style"], totals: NonNullable<TableSpec["totals"]>) => {
    mutateSheet((s) => {
      s.tables = [...(s.tables ?? []), { name: name || `Table${(s.tables?.length ?? 0) + 1}`, range: rangeToA1(selection), style, totals }];
    });
  }, [mutateSheet, selection]);

  const removeTable = useCallback((name: string) => {
    mutateSheet((s) => { s.tables = s.tables?.filter((t) => t.name !== name); });
  }, [mutateSheet]);

  // insert / delete rows & cols (formulas incl. cross-sheet refs, merges,
  // cf, charts all shift)
  const insRows = useCallback(() => {
    if (structuralLocked()) return;
    mutate((w) => adjustForRowsCols(w.sheets[active], "row", selection.r1, Math.max(1, selection.r2 - selection.r1 + 1), w));
  }, [mutate, active, selection, structuralLocked]);
  const delRows = useCallback(() => {
    if (structuralLocked()) return;
    mutate((w) => adjustForRowsCols(w.sheets[active], "row", selection.r1, -(selection.r2 - selection.r1 + 1), w));
  }, [mutate, active, selection, structuralLocked]);
  const insCols = useCallback(() => {
    if (structuralLocked()) return;
    mutate((w) => adjustForRowsCols(w.sheets[active], "col", selection.c1, Math.max(1, selection.c2 - selection.c1 + 1), w));
  }, [mutate, active, selection, structuralLocked]);
  const delCols = useCallback(() => {
    if (structuralLocked()) return;
    mutate((w) => adjustForRowsCols(w.sheets[active], "col", selection.c1, -(selection.c2 - selection.c1 + 1), w));
  }, [mutate, active, selection, structuralLocked]);

  // ---- geometry: col widths / row heights / hide / header ops ----
  const onGeom = useCallback((axis: "col" | "row", i: number, size: number) => {
    mutateSheet((s) => {
      const key = axis === "col" ? "colWidths" : "rowHeights";
      s[key] = { ...s[key], [i]: Math.round(size) };
    });
  }, [mutateSheet]);

  const onHeader = useCallback((action: "ins" | "del" | "hide" | "unhide", axis: "col" | "row", index: number) => {
    const lo = axis === "row" ? selection.r1 : selection.c1;
    const hi = axis === "row" ? selection.r2 : selection.c2;
    const inSel = index >= lo && index <= hi;
    const at = inSel ? lo : index;
    const count = inSel ? hi - lo + 1 : 1;
    if (action === "ins" || action === "del") {
      if (structuralLocked()) return;
      mutate((w) => adjustForRowsCols(w.sheets[active], axis, at, action === "ins" ? count : -count, w));
    } else {
      mutateSheet((s) => {
        const key = axis === "row" ? "hiddenRows" : "hiddenCols";
        const cur = new Set(s[key] ?? []);
        if (action === "hide") { for (let i = at; i < at + count; i++) cur.add(i); }
        else { for (let i = lo; i <= hi; i++) cur.delete(i); cur.delete(index); }
        s[key] = cur.size ? [...cur].sort((a, b) => a - b) : undefined;
      });
    }
  }, [mutate, mutateSheet, selection, active, structuralLocked]);

  // merge / unmerge
  const mergeSel = useCallback(() => {
    if (anyLocked([...rangeRefs(selection)])) return;
    if (selection.c1 === selection.c2 && selection.r1 === selection.r2) return toast("Select a range to merge");
    mutateSheet((s) => {
      s.merges = (s.merges ?? []).filter((m) =>
        !(m.c1 <= selection.c2 && m.c2 >= selection.c1 && m.r1 <= selection.r2 && m.r2 >= selection.r1));
      for (const ref of rangeRefs(selection)) {
        if (ref !== toA1(selection.c1, selection.r1)) delete s.cells[ref];
      }
      s.merges.push({ ...selection });
      // merge & center (Excel's Merge & Center button semantics)
      const head = toA1(selection.c1, selection.r1);
      s.cells[head] = { ...s.cells[head], s: { ...(s.cells[head]?.s ?? {}), align: "center", valign: "middle" } };
    });
    return undefined;
  }, [mutateSheet, selection, toast, anyLocked]);
  const unmergeSel = useCallback(() => {
    if (anyLocked([...rangeRefs(selection)])) return;
    mutateSheet((s) => {
      s.merges = (s.merges ?? []).filter((m) =>
        !(m.c1 <= selection.c2 && m.c2 >= selection.c1 && m.r1 <= selection.r2 && m.r2 >= selection.r1));
    });
  }, [mutateSheet, selection, anyLocked]);

  // ---- sheets tabs ----
  /** S15.1 — workbook structure lock blocks sheet add/remove/rename/reorder/hide. */
  const wbLocked = () => {
    if (wb.protectStructure) toast("Workbook structure is protected");
    return !!wb.protectStructure;
  };
  const addSheet = () => {
    if (wbLocked()) return;
    mutate((w) => {
      let n = w.sheets.length + 1;
      while (w.sheets.some((s) => s.name === `Sheet${n}`)) n++;
      w.sheets.push({ name: `Sheet${n}`, cells: {} });
    });
    setActive(wb.sheets.length);
  };
  const delSheet = (i: number) => {
    if (wbLocked()) return;
    if (wb.sheets.length <= 1) return toast("Workbook needs at least one sheet");
    mutate((w) => { w.sheets.splice(i, 1); });
    setActive((a) => Math.min(a, wb.sheets.length - 2));
  };
  const dupSheet = (i: number) => {
    if (wbLocked()) return;
    mutate((w) => {
      const copy = structuredClone(w.sheets[i]);
      copy.name = `${copy.name} copy`;
      w.sheets.splice(i + 1, 0, copy);
    });
    setActive(i + 1);
  };
  const hideSheet = (i: number) => {
    if (wbLocked()) return;
    if (wb.sheets.filter((s) => !s.hidden).length <= 1) return toast("Cannot hide the only visible sheet");
    mutate((w) => { w.sheets[i].hidden = true; });
    if (i === active) {
      const next = wb.sheets.findIndex((s, j) => j !== i && !s.hidden);
      if (next >= 0) setActive(next);
    }
  };
  useEffect(() => {
    if (!tabMenu) return;
    const close = () => setTabMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [tabMenu]);

  // ---- conditional formatting (S6: rule manager + rule types) ----
  const addCF = (rule: Omit<CondFormat, "range">) => {
    mutateSheet((s) => {
      s.cf = [...(s.cf ?? []), { ...rule, range: rangeToA1(selection) }];
    });
    toast(`Rule added to ${rangeToA1(selection)}`);
  };
  const moveCF = (i: number, dir: -1 | 1) => {
    mutateSheet((s) => {
      const cf = [...(s.cf ?? [])];
      const j = i + dir;
      if (j < 0 || j >= cf.length) return;
      [cf[i], cf[j]] = [cf[j], cf[i]];
      s.cf = cf;
    });
  };
  const delCF = (i: number) => mutateSheet((s) => { s.cf = s.cf?.filter((_, j) => j !== i); });
  const clearCF = () => mutateSheet((s) => { s.cf = undefined; });

  // ---- charts ----
  const addChart = (type: ChartSpec["type"]) => {
    mutateSheet((s) => {
      s.charts = [...(s.charts ?? []), {
        id: crypto.randomUUID(), type, range: rangeToA1(selection),
        title: `${rangeToA1(selection)}`, x: 200, y: 80,
      }];
    });
    setChartOpen(false);
  };

  // ---- import/export ----
  const exportCSV = () => {
    const blob = new Blob([sheetToCSV(sheet, wb)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${title}-${sheet.name}.csv`;
    a.click();
  };
  const onCsvImport = async (f: File) => {
    const imported = csvToSheet(f.name.replace(/\.[^.]+$/, ""), await f.text());
    mutate((w) => w.sheets.push(imported));
    setActive(wb.sheets.length);
    toast(`Imported ${f.name}`);
  };
  const onXlsxImport = async (f: File) => {
    try {
      const imported = await xlsxToWorkbook(f);
      mutate((w) => { for (const k of Object.keys(w)) delete (w as unknown as Record<string, unknown>)[k]; Object.assign(w, imported); });
      setActive(0);
      toast(`Imported ${imported.sheets.length} sheet(s) from ${f.name}`);
    } catch {
      toast("Could not read that workbook");
    }
  };
  // Native-binary item opened from Drive/desktop — run the import once so the
  // docx/xlsx a user double-clicks opens as a real workbook, not a blank grid.
  const autoImported = useRef(false);
  useEffect(() => {
    if (!sourceFile || autoImported.current) return;
    autoImported.current = true;
    void onXlsxImport(sourceFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceFile]);
  // S17.3 — external workbook links: a file becomes a cached snapshot under
  // wb.externs so formulas like [Book.xlsx]Sheet!A1 resolve locally
  const linkRef = useRef<HTMLInputElement>(null);
  const onLinkImport = async (f: File) => {
    try {
      const imported = await xlsxToWorkbook(f);
      mutate((w) => { (w.externs ??= {})[f.name] = imported; });
      toast(`Linked ${f.name} — [${f.name}]Sheet!A1 refs now resolve`);
    } catch {
      toast("Could not read that workbook");
    }
  };
  const missingLinks = useMemo(() => scanExternRefs(wb).filter((b) => !wb.externs?.[b]), [wb]);

  // ---- comments (anchor = sheet!cell) ----
  const loadComments = useCallback(async () => {
    const r = await api.get<{ comments: Comment[] }>(`/api/files/${item.id}/comments`);
    setComments(r.comments);
  }, [item.id]);
  useEffect(() => { loadComments().catch(() => {}); }, [loadComments]);

  const submitComment = async (body: string) => {
    await api.post(`/api/files/${item.id}/comments`, { body, anchor: `${sheet.name}!${anchorRef}` });
    setNewComment(false);
    loadComments();
  };
  const focusAnchor = (anchor: string) => {
    const [name, ref] = anchor.split("!");
    const i = wb.sheets.findIndex((s) => s.name === name);
    if (i >= 0) setActive(i);
    const p = parseA1(ref ?? "");
    if (p) setSelection({ c1: p.col, r1: p.row, c2: p.col, r2: p.row });
  };

  // ---- Go To / name-box navigation: B5, A1:C9, Sheet2!A1, or a defined name ----
  const goTo = useCallback((raw: string) => {
    const t = raw.trim();
    if (!t) return;
    // defined name → its refers-to
    const named = Object.entries(wb.names ?? {}).find(([k]) => k.toLowerCase() === t.toLowerCase());
    let target = named ? named[1] : t;
    // optional sheet qualifier
    const q = target.match(/^(?:'([^']+)'|([A-Za-z_][\w.]*))!(.+)$/);
    const ref = (q ? q[3] : target).replace(/\$/g, "");
    const range = parseRange(ref);
    if (!range) { toast(`"${t}" isn't a cell, range, or defined name`); return; }
    const sheetName = q ? (q[1] ?? q[2]) : sheet.name;
    const si = wb.sheets.findIndex((s) => s.name.toLowerCase() === sheetName.toLowerCase());
    if (si < 0) { toast(`No sheet named ${sheetName}`); return; }
    setActive(si);
    setSelection(range);
  }, [wb, sheet.name, setSelection, toast]);

  const pasteSpecial = useCallback((mode: PasteMode, op: PasteOp) => {
    if (anyLocked([...rangeRefs(selection)])) return;
    const buf = getCopyBuffer();
    if (!buf) return toast("Nothing copied yet — copy a range first");
    mutateSheet((s) => {
      pasteCells(s.cells, { col: selection.c1, row: selection.r1 }, buf, mode, op, evals);
    });
    setPasteSpec(false);
    toast("Pasted");
  }, [mutateSheet, selection, evals, toast, anyLocked]);

  // Ctrl+G → Go To (focus the name box); Ctrl+Alt+V / Ctrl+Shift+V → Paste Special
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "F9") { e.preventDefault(); if (wbRef.current) setCalcWb(wbRef.current); return; }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "g") {
        e.preventDefault();
        nameBoxRef.current?.focus();
      } else if (k === "v" && (e.altKey || e.shiftKey) && canEdit) {
        e.preventDefault();
        if (getCopyBuffer()) setPasteSpec(true);
        else toast("Nothing copied yet — copy a range first");
      } else if (k === "f") {
        e.preventDefault();
        setFindDlg({ replace: false });
      } else if (k === "h" && canEdit) {
        e.preventDefault();
        setFindDlg({ replace: true });
      } else if (k === "k" && canEdit) {
        e.preventDefault();
        setLinkDlg(true);
      }
      // S19.2 — Ctrl+` toggles show-formulas view (Excel parity)
      if (e.key === "`" || e.key === "~") {
        e.preventDefault();
        setShowFormulas((v) => !v);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [canEdit, toast]);

  const rename = useCallback(async (name: string) => {
    await api.patch(`/api/drive/${item.id}`, { name });
  }, [item.id]);

  const saveLabel: Record<SaveState, string> = {
    saved: "All changes saved", saving: "Saving…", unsaved: "Unsaved changes", error: "Save failed",
  };

  // S15.1 — open-password gate blocks the whole editor until unlocked
  if (pwLocked) {
    return (
      <div className="editor-shell sheets-shell" style={{ alignItems: "center", justifyContent: "center", display: "flex" }}>
        <div className="dlg" style={{ width: 320 }}>
          <h3>🔒 {item.name}</h3>
          <p style={{ fontSize: 12, color: "var(--muted)" }}>This workbook is password protected.</p>
          <input className="inp" type="password" placeholder="Password" autoFocus value={pwTry}
            style={{ width: "100%", marginTop: 8 }}
            onChange={(e) => { setPwTry(e.target.value); setPwErr(false); }}
            onKeyDown={async (e) => {
              if (e.key !== "Enter") return;
              if (await sha256hex(pwTry) === wb.passwordHash) setPwLocked(false);
              else setPwErr(true);
            }} />
          {pwErr && <p style={{ fontSize: 11, color: "#D84B57", marginTop: 6 }}>Incorrect password</p>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
            <button className="btn-ghost btn-sm" onClick={() => navigate(-1)}>Back</button>
            <button className="btn-primary btn-sm" onClick={async () => {
              if (await sha256hex(pwTry) === wb.passwordHash) setPwLocked(false);
              else setPwErr(true);
            }}>Open</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-shell sheets-shell">
      <div className="editor-top">
        <button className="back" onClick={() => navigate(-1)} title="Back">←</button>
        <AppIcon kind="sheets" size={34} />
        <input className="doc-title" value={title} disabled={!canEdit}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== item.name && rename(title.trim())}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        <span className={`save-state ${saveState === "saving" || saveState === "unsaved" ? "saving" : ""}`}>
          {saveLabel[saveState]}
        </span>
        {permission !== "owner" && <span className="perm-badge">{permission}</span>}
        <PresenceBar session={session} />
        <div className="spacer" />
        <button className="btn-ghost btn-sm" onClick={() => setSharing(true)}>Share</button>
        <button className="btn-primary btn-sm" onClick={() => void workbookToXLSX(wb, title)}>Export .xlsx</button>
      </div>

      {canEdit && (<>
        <RibbonTabs persistKey="sheets"
          end={<>
            {missingLinks.length > 0 && (
              <span className="rb warn" title={`Uncached external refs: ${missingLinks.join(", ")} — link the file to resolve`}
                style={{ color: "#B3560E" }}>⚠ {missingLinks.length} link{missingLinks.length > 1 ? "s" : ""}</span>
            )}
            <button className={`rb ${panel === "comments" ? "on" : ""}`} title="Comments"
              onClick={() => setPanel(panel === "comments" ? "none" : "comments")}>💬</button>
            <button className={`rb ${panel === "ai" ? "on" : ""}`} title="Kreatix AI"
              onClick={() => setPanel(panel === "ai" ? "none" : "ai")}>✨</button>
            <span style={{ fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap" }}>{usedRangeA1(sheet.cells)}</span>
          </>}
          tabs={[
            { id: "file", label: "File", icon: "📁", menu: [
              { label: "Import CSV…", onClick: () => csvRef.current?.click() },
              { label: "Import XLSX / ODS…", onClick: () => xlsxRef.current?.click() },
              { label: "Link external workbook…", onClick: () => linkRef.current?.click() },
              { divider: true },
              { label: "Export CSV", onClick: exportCSV },
              { label: "Export .ods", onClick: () => void workbookToODS(wb, title) },
              { label: "Export .xlsx", onClick: () => void workbookToXLSX(wb, title) },
              { divider: true },
              { label: "Print / save as PDF…", onClick: () => setPrintDlg(true) },
              { label: "Version history", onClick: () => setPanel("versions") },
              { label: "Workbook properties…", onClick: () => setPropsDlg(true) },
            ]},
            { id: "home", label: "Home", icon: "🏠", groups: [
              { id: "clip", label: "Clipboard", node: <>
                <button className="rb" title="Undo" disabled={!undoStack.current.length} onClick={undo}>↶</button>
                <button className="rb" title="Redo" disabled={!redoStack.current.length} onClick={redo}>↷</button>
                <button className="rb" title="Paste Special — values/formats/formulas/transpose/operations (Ctrl+Alt+V)"
                  onClick={() => getCopyBuffer() ? setPasteSpec(true) : toast("Nothing copied yet")}>⧉</button>
                <button className="rb" title="Copy selection as picture" onClick={copyAsPicture}>📷</button>
                <button className={`rb ${painter ? "on" : ""}`} title="Format Painter — click to copy this cell's format, then drag over targets"
                  onClick={() => setPainter(painter ? null : { s: { ...anchorStyle } })}>🖌</button>
              </>},
              { id: "font", label: "Font", node: <>
                <select className="rb-sel" value={anchorStyle.font ?? "Inter"} title="Font family" style={{ width: 96 }}
                  onChange={(e) => setStyle({ font: e.target.value === "Inter" ? undefined : e.target.value })}>
                  {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
                <select className="rb-sel" value={String(anchorStyle.size ?? 12)} title="Font size" style={{ width: 52 }}
                  onChange={(e) => setStyle({ size: Number(e.target.value) === 12 ? undefined : Number(e.target.value) })}>
                  {SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <button className={`rb ${anchorStyle.b ? "on" : ""}`} title="Bold (Ctrl+B)" onClick={() => toggleStyle("b")}><b>B</b></button>
                <button className={`rb ${anchorStyle.i ? "on" : ""}`} title="Italic (Ctrl+I)" onClick={() => toggleStyle("i")}><i>I</i></button>
                <button className={`rb ${anchorStyle.u ? "on" : ""}`} title="Underline (Ctrl+U)" onClick={() => toggleStyle("u")}><u>U</u></button>
                <button className={`rb ${anchorStyle.st ? "on" : ""}`} title="Strikethrough" onClick={() => toggleStyle("st")}><s>S</s></button>
                <label className="rb" title="Text color" style={{ padding: 4, cursor: "pointer" }}>
                  A<input type="color" value={anchorStyle.color ?? "#171717"} style={{ position: "absolute", opacity: 0, width: 0 }}
                    onChange={(e) => setStyle({ color: e.target.value })} />
                </label>
                <label className="rb" title="Fill color" style={{ padding: 4, cursor: "pointer" }}>
                  ▨<input type="color" value={anchorStyle.bg ?? "#ffffff"} style={{ position: "absolute", opacity: 0, width: 0 }}
                    onChange={(e) => setStyle({ bg: e.target.value })} />
                </label>
                <div style={{ position: "relative" }}>
                  <button className={`rb ${borderMenu ? "on" : ""}`} title="Borders" onClick={() => setBorderMenu((v) => !v)}>▩</button>
                  {borderMenu && (
                    <div className="border-menu" onMouseLeave={() => setBorderMenu(false)}>
                      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                        <select className="rb-sel" style={{ flex: 1 }} value={borderStyle.style}
                          onChange={(e) => setBorderStyle({ ...borderStyle, style: e.target.value as typeof borderStyle.style })}>
                          <option value="solid">Solid</option><option value="dashed">Dashed</option>
                          <option value="dotted">Dotted</option><option value="double">Double</option>
                        </select>
                        <select className="rb-sel" value={borderStyle.w}
                          onChange={(e) => setBorderStyle({ ...borderStyle, w: Number(e.target.value) as 1 | 2 | 3 })}>
                          <option value={1}>Thin</option><option value={2}>Medium</option><option value={3}>Thick</option>
                        </select>
                        <input type="color" value={borderStyle.color} style={{ width: 28, height: 28, padding: 0, border: "none", background: "none" }}
                          onChange={(e) => setBorderStyle({ ...borderStyle, color: e.target.value })} />
                      </div>
                      <div className="border-grid">
                        {([["all", "▦ All"], ["outside", "◻ Outside"], ["top", "⬒ Top"], ["bottom", "⬓ Bottom"], ["left", "◨ Left"], ["right", "◧ Right"], ["none", "✕ None"]] as const).map(([p, label]) => (
                          <button key={p} className="border-opt" onClick={() => applyBorder(p)}>{label}</button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </>},
              { id: "align", label: "Alignment", node: <>
                {(["left", "center", "right"] as const).map((a) => (
                  <button key={a} className={`rb ${anchorStyle.align === a ? "on" : ""}`} title={`Align ${a}`}
                    onClick={() => setStyle({ align: a })}>
                    {a === "left" ? "⇤" : a === "center" ? "≡" : "⇥"}
                  </button>
                ))}
                {/* S19.11 — extended horizontal alignments */}
                <select className="rb" title="More alignments — justify / distributed / fill / center-across"
                  style={{ padding: "0 4px", fontSize: 11 }}
                  value={anchorStyle.align && !["left", "center", "right"].includes(anchorStyle.align) ? anchorStyle.align : ""}
                  onChange={(e) => setStyle({ align: (e.target.value || undefined) as CellStyle["align"] })}>
                  <option value="">⇅</option>
                  <option value="justify">Justify</option>
                  <option value="distributed">Distributed</option>
                  <option value="fill">Fill</option>
                  <option value="centerAcross">Center across</option>
                </select>
                {(["top", "middle", "bottom"] as const).map((v) => (
                  <button key={v} className={`rb ${anchorStyle.valign === v ? "on" : ""}`} title={`Align ${v}`}
                    onClick={() => setStyle({ valign: anchorStyle.valign === v ? undefined : v })}>
                    {v === "top" ? "⤒" : v === "middle" ? "⬍" : "⤓"}
                  </button>
                ))}
                <button className={`rb ${anchorStyle.wrap ? "on" : ""}`} title="Wrap text"
                  onClick={() => setStyle({ wrap: !anchorStyle.wrap || undefined })}>↩</button>
                <button className={`rb ${anchorStyle.shrink ? "on" : ""}`} title="Shrink to fit"
                  onClick={() => setStyle({ shrink: !anchorStyle.shrink || undefined })}>⇲</button>
                <button className="rb" title="Decrease indent"
                  onClick={() => setStyle({ indent: Math.max(0, (anchorStyle.indent ?? 0) - 1) || undefined })}>◁</button>
                <button className="rb" title="Increase indent"
                  onClick={() => setStyle({ indent: Math.min(15, (anchorStyle.indent ?? 0) + 1) })}>▷</button>
                <select className="rb-sel" value={String(anchorStyle.rotate ?? 0)} title="Text orientation" style={{ width: 56 }}
                  onChange={(e) => setStyle({ rotate: Number(e.target.value) || undefined })}>
                  {[0, 45, 90, -45, -90].map((d) => <option key={d} value={d}>{d === 0 ? "0°" : `${d > 0 ? "+" : ""}${d}°`}</option>)}
                </select>
                <button className="rb" title="Merge selection" onClick={mergeSel}>▦</button>
                <button className="rb" title="Unmerge" onClick={unmergeSel}>▢</button>
              </>},
              { id: "num", label: "Number", node: <>
                <select className="rb-sel" value={!anchorStyle.fmt ? "auto" : NUM_FORMATS.some((f) => f.id === anchorStyle.fmt) ? anchorStyle.fmt : "custom"} title="Number format"
                  onChange={(e) => {
                    if (e.target.value === "auto") return setStyle({ fmt: undefined });
                    if (e.target.value === "custom") {
                      const code = prompt("Custom format code (e.g. #,##0.00;[Red]-#,##0.00):", anchorStyle.fmt && !NUM_FORMATS.some((f) => f.id === anchorStyle.fmt) ? anchorStyle.fmt : "");
                      if (code) setStyle({ fmt: code });
                      return;
                    }
                    setStyle({ fmt: e.target.value });
                  }}>
                  {NUM_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                  <option value="custom">Custom code…</option>
                </select>
              </>},
              { id: "styles", label: "Styles", node: <>
                <select className="rb-sel" value="" title="Cell style preset (replaces formatting)" style={{ width: 84 }}
                  onChange={(e) => {
                    const p = CELL_STYLES.find(([id]) => id === e.target.value);
                    if (!p) return;
                    const st = p[2];
                    mutateSheet((s) => selRefs.forEach((r) => {
                      s.cells[r] = { ...s.cells[r], s: p[0] === "normal" ? undefined : { ...st } };
                    }));
                  }}>
                  <option value="" disabled>Style…</option>
                  {CELL_STYLES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
                <button className="rb" title="Conditional formatting" onClick={() => setCfOpen(true)}>◐</button>
              </>},
              { id: "cells", label: "Cells", node: <>
                <button className="rb" title="Insert/delete cells — shift remaining cells"
                  onClick={() => setCellShiftDlg(true)}>⌗</button>
                <button className="rb" title="Insert rows above" onClick={insRows}>R+</button>
                <button className="rb" title="Delete rows" onClick={delRows}>R−</button>
                <button className="rb" title="Insert columns left" onClick={insCols}>C+</button>
                <button className="rb" title="Delete columns" onClick={delCols}>C−</button>
              </>},
            ]},
            { id: "insert", label: "Insert", icon: "➕", groups: [
              { id: "ill", label: "Illustrations", node: <>
                <button className="rb" title="Insert picture — floating over the grid"
                  onClick={() => setPicDlg(true)}>🖼</button>
                <button className="rb" title="Insert chart from selection" onClick={() => setChartOpen(true)}>📊</button>
                <button className="rb" title="Sparkline — in-cell mini chart (anchor cell gets it)" onClick={() => setSparkDlg(true)}>∿</button>
                <button className="rb" title="Format as Table — banded rows + totals" onClick={() => setTableDlg(true)}>▤</button>
                <button className="rb" title="Insert slicer — filter column values with a visual picker"
                  onClick={() => setSlicerDlg(true)}>⊟</button>
                <button className="rb" title="Insert data-type entity — fields usable as A1.Prop in formulas"
                  onClick={insertEntity}>▣</button>
              </>},
              { id: "lnk", label: "Links & Text", node: <>
                <button className="rb" title="Insert link (Ctrl+K) — URL or place in this workbook"
                  onClick={() => setLinkDlg(true)}>🔗</button>
                <button className="rb" title="Insert symbol" onClick={() => setSymbolDlg(true)}>Ω</button>
              </>},
            ]},
            { id: "formulas", label: "Formulas", icon: "𝑓x", groups: [
              { id: "names", label: "Named & Insert", node: <>
                <button className="rb" title="Name Manager — define named ranges" onClick={() => setNameMgr(true)}>📛</button>
                <button className="rb" title="Insert function — guided wizard" onClick={() => setFnWiz(true)}>ƒx</button>
              </>},
              { id: "audit", label: "Auditing", node: <>
                <button className={`rb ${showFormulas ? "on" : ""}`} title="Show formulas (Ctrl+`)"
                  onClick={() => setShowFormulas(!showFormulas)}>fx↔</button>
                <button className={`rb ${audit === "pre" ? "on" : ""}`} title="Trace precedents" style={{ width: "auto", padding: "0 8px", fontSize: 11 }}
                  onClick={() => setAudit(audit === "pre" ? null : "pre")}>⇠Pre</button>
                <button className={`rb ${audit === "dep" ? "on" : ""}`} title="Trace dependents" style={{ width: "auto", padding: "0 8px", fontSize: 11 }}
                  onClick={() => setAudit(audit === "dep" ? null : "dep")}>Dep⇢</button>
                <button className="rb" title="Formula inspector — step through evaluation / error check"
                  onClick={() => setInspDlg(true)}>🔍</button>
              </>},
              { id: "calc", label: "Calculation", node: <>
                <button className={`rb ${manualCalc ? "on" : ""}`} title="Calculation options — manual/auto, iterative calc"
                  onClick={() => setCalcDlg(true)}>∑</button>
                {manualCalc && <button className="rb" title="Calculate now (F9)" onClick={recalc}>⟳</button>}
              </>},
            ]},
            { id: "data", label: "Data", icon: "🗃", groups: [
              { id: "sort", label: "Sort & Filter", node: <>
                <button className="rb" title="Sort A→Z" onClick={() => sortSel(true)}>A↓</button>
                <button className="rb" title="Sort Z→A" onClick={() => sortSel(false)}>Z↑</button>
                <button className="rb" title="Sort — multiple columns/levels" onClick={() => setSortDlg(true)}>⇅…</button>
                <button className={`rb ${sheet.filter ? "on" : ""}`} title="AutoFilter — dropdown filters on selection/range"
                  onClick={toggleFilter}>⧩</button>
              </>},
              { id: "tools", label: "Data Tools", node: <>
                <button className="rb" title="Remove duplicates in selection" onClick={() => setDedupeDlg(true)}>⊟</button>
                <button className="rb" title="Text to Columns — split selection by delimiter" onClick={() => setT2cDlg(true)}>⇶</button>
                <button className="rb" title="Flash Fill — infer pattern from example cell, fill column"
                  onClick={flashFill}>⚡</button>
                <button className="rb" title="Data validation — lists, ranges, rules" onClick={() => setValDlg(true)}>✓⃞</button>
                <button className="rb" title="Subtotal — insert SUBTOTAL rows at group boundaries"
                  onClick={() => setSubtotalDlg(true)}>Σ↓</button>
                <button className="rb" title="Go To Special — select blanks/formulas/constants/errors/notes"
                  onClick={() => setGtsDlg(true)}>◎</button>
              </>},
              { id: "outline", label: "Outline", node: <>
                <button className="rb" title="Group selected rows (outline)" onClick={() => groupSel(1)}>⧉</button>
                <button className="rb" title="Ungroup selected rows" onClick={() => groupSel(-1)}>⧈</button>
                <button className="rb" title="Group selected columns (outline)" onClick={() => groupCols(1)}>⧉→</button>
                <button className="rb" title="Ungroup selected columns" onClick={() => groupCols(-1)}>⧈→</button>
              </>},
              { id: "whatif", label: "What-If", node: <>
                <button className="rb" title="Scenario Manager — named what-if snapshots"
                  onClick={() => setScenDlg(true)}>🎬</button>
                <button className="rb" title="Goal Seek — find input that makes a formula hit a target"
                  onClick={() => setSeekDlg(true)}>🎯</button>
                <button className="rb" title="Data Table — 1/2-variable sensitivity grid"
                  onClick={() => setDtDlg(true)}>∑▦</button>
                <button className="rb" title="Solver — optimize an objective under constraints"
                  onClick={() => setSolverDlg(true)}>∂</button>
              </>},
              { id: "auto", label: "Automation", node: <>
                <button className="rb" title="PivotTable — summarize selection by row/column fields"
                  onClick={() => setPivotDlg(true)}>⊞</button>
                <button className="rb" title="Get & Transform — load external data through a query pipeline"
                  onClick={() => setQueryDlg(true)}>⚡</button>
                <button className="rb" title="Scripts — JS automation against the workbook (Office Scripts-style)"
                  onClick={() => setScriptDlg(true)}>📜</button>
              </>},
            ]},
            { id: "review", label: "Review", icon: "✓", groups: [
              { id: "proof", label: "Proofing", node: <>
                <button className={`rb ${spellOn ? "on" : ""}`} title="Spelling — toggle underlines; click again to review"
                  onClick={() => spellOn ? setSpellDlg(true) : setSpellOn(true)}>✓abc</button>
              </>},
              { id: "comm", label: "Comments", node: <>
                <button className="rb" title="Add comment on cell" onClick={() => { setNewComment(true); setPanel("comments"); }}>💬</button>
              </>},
              { id: "chg", label: "Changes", node: <>
                <button className={`rb ${showChanges ? "on" : ""}`} title="Show change marks — who last edited each cell"
                  onClick={() => setShowChanges(!showChanges)}>✎</button>
                <button className={`rb ${sheet.trackChanges ? "on" : ""}`} title={`Review tracked changes${sheet.changeLog?.length ? ` — ${sheet.changeLog.length} pending` : ""}`}
                  onClick={() => setReviewDlg(true)}>☑{sheet.changeLog?.length ? ` ${sheet.changeLog.length}` : ""}</button>
              </>},
              { id: "prot", label: "Protection", node: <>
                <button className={`rb ${sheet.protected ? "on" : ""}`} title="Protect sheet — lock cells except allowed ranges"
                  onClick={() => setProtectDlg(true)}>🔒</button>
              </>},
            ]},
            { id: "view", label: "View", icon: "👁", groups: [
              { id: "views", label: "Views", node: <>
                <button className="rb" title="Freeze rows above" style={{ width: "auto", padding: "0 8px", fontSize: 11 }}
                  onClick={() => mutateSheet((s) => { s.freeze = { rows: selection.r1, cols: s.freeze?.cols ?? 0 }; })}>
                  ❄ {selection.r1 || "No"} rows
                </button>
                <button className="rb" title="Freeze columns left" style={{ width: "auto", padding: "0 8px", fontSize: 11 }}
                  onClick={() => mutateSheet((s) => { s.freeze = { rows: s.freeze?.rows ?? 0, cols: selection.c1 }; })}>
                  ❄ {selection.c1 || "No"} cols
                </button>
                <button className={`rb ${sheet.splitRow ? "on" : ""}`} title="Split at selection row — two scrollable panes (dbl-click divider to unsplit)"
                  onClick={() => mutateSheet((s) => { s.splitRow = s.splitRow ? undefined : Math.max(1, selection.r1); })}>⇹</button>
                <button className={`rb ${pbPreview ? "on" : ""}`} title="Page-break preview — dashed page boundaries"
                  onClick={() => setPbPreview(!pbPreview)}>▦⃞</button>
                <button className="rb" title="Custom views — save/apply named view states" onClick={() => setViewsDlg(true)}>👁</button>
              </>},
            ]},
          ]} />
        <input ref={csvRef} type="file" accept=".csv" hidden onChange={(e) => e.target.files?.[0] && onCsvImport(e.target.files[0])} />
        <input ref={xlsxRef} type="file" accept=".xlsx,.xls,.xlsm,.xlsb,.ods,.xml" hidden onChange={(e) => e.target.files?.[0] && onXlsxImport(e.target.files[0])} />
        <input ref={linkRef} type="file" accept=".xlsx,.xls,.xlsm,.xlsb,.ods" hidden onChange={(e) => e.target.files?.[0] && onLinkImport(e.target.files[0])} />
      </>)}

      {/* formula bar */}
      <div className="formula-bar">
        <input ref={nameBoxRef} className="name-box" key={`${anchorRef}-${selections.length}`}
          defaultValue={anchorRef + (selection.c2 - selection.c1 || selection.r2 - selection.r1 ? ` : ${rangeToA1(selection)}` : "")}
          title="Name box — type a ref (B5), range (A1:C9), Sheet!ref, or defined name, then Enter"
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") { goTo((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur(); }
            else if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
          onBlur={(e) => { e.target.value = anchorRef; }} />
        <span className="fx">fx</span>
        <FxInput wb={wb} className="fx-input" wrapStyle={{ flex: 1 }}
          disabled={!canEdit}
          value={fxValue}
          onValue={setFxValue}
          placeholder={canEdit ? "Value or =formula" : ""}
          onKeyDown={(e) => {
            if (e.key === "Enter") { commitCell(fxAnchor.current, fxValue); (e.target as HTMLInputElement).blur(); }
            else if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
          onBlur={() => fxValue !== cellEditText(anchorCell) && commitCell(fxAnchor.current, fxValue)} />
        <span className="fx-val">{anchorCell?.f ? `= ${anchorRes?.error ?? formatValue(anchorRes?.value, anchorStyle.fmt)}` : ""}</span>
        {anchorInputMsg && <span className="fx-val" style={{ color: "#7A6A5C", fontStyle: "italic" }} title="Input message">{anchorInputMsg}</span>}
      </div>

      <div className="sheet-workspace" style={{ marginRight: panel !== "none" ? 330 : 0, zoom }}>
        {(() => {
          const gridProps = {
            sheet: dispSheet, evals, canEdit, wb,
            evalFormula: evaluator.evalFormula,
            audit: auditRefs ? { refs: auditRefs, kind: audit! } : undefined,
            selections, selection, setSelection: selWithPaint,
            addSelection, extendSelection: extWithPaint,
            invalid: invalidCells,
            noted: notedCells,
            commented: commentedCells,
            showChanges,
            pageBreaks: pbPreview,
            onCellMenu: (ref: string, x: number, y: number) => setCellMenu({ ref, ...clampToViewport(x, y, 240, 400) }),
            onFilterClick: (col: number, x: number, y: number) => setFilterMenu({ col, ...clampToViewport(x, y, 240, 360) }),
            onOutlineToggle: (axis: "row" | "col", end: number) => mutateSheet((s) => toggleOutline(s, axis, end)),
            listDrop: canEdit && activeList ? { ref: anchorRef, items: activeList } : undefined,
            onCommit: commitCell, onClear: clearCells, onPaste: pasteTsv, onPasteImage: pasteImage, onFillHandle: fillHandle,
            onFillDir: fillDir,
            onGeom, onHeader,
            showFormulas,
            onOpenLink: openLink,
            onObjects: canEdit ? setObjects : undefined,
            spellMisses,
            onQuickAction: canEdit ? quickAction : undefined,
          };
          // S16.1 split panes — two independently-scrolled windows at splitRow
          if (sheet.splitRow != null && sheet.splitRow > 0) {
            return (
              <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
                <div style={{ flex: `0 0 ${paneRatio * 100}%`, minHeight: 60, overflow: "hidden" }}>
                  <Grid {...gridProps} paneRows={[0, sheet.splitRow - 1]} />
                </div>
                <div className="split-divider" title="Drag to resize panes — double-click to unsplit"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    const wrap = (e.currentTarget.parentElement as HTMLElement);
                    const move = (ev: globalThis.MouseEvent) => {
                      const r = wrap.getBoundingClientRect();
                      setPaneRatio(Math.min(0.85, Math.max(0.15, (ev.clientY - r.top) / r.height)));
                    };
                    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
                    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
                  }}
                  onDoubleClick={() => mutateSheet((s) => { s.splitRow = undefined; })} />
                <div style={{ flex: 1, minHeight: 60, overflow: "hidden" }}>
                  <Grid {...gridProps} paneRows={[sheet.splitRow, 1e9]} />
                </div>
              </div>
            );
          }
          return <Grid {...gridProps} />;
        })()}
        {(sheet.slicers ?? []).map((sl, si) => (
          <SlicerPanel key={si} sheet={sheet} wb={wb} slicer={sl} index={si}
            onChange={(sel) => mutateSheet((s) => { if (s.slicers) s.slicers[si].sel = sel; })}
            onRemove={canEdit ? () => mutateSheet((s) => { s.slicers = s.slicers?.filter((_, j) => j !== si); }) : undefined} />
        ))}
        {(sheet.charts ?? []).map((c) => (
          <ChartCard key={c.id} spec={c} sheet={sheet} wb={wb}
            onMove={canEdit ? (id, x, y) => mutateSheet((s) => { const ch = s.charts?.find((k) => k.id === id); if (ch) { ch.x = x; ch.y = y; } }) : undefined}
            onRemove={canEdit ? (id) => mutateSheet((s) => { s.charts = s.charts?.filter((k) => k.id !== id); }) : undefined}
            onEdit={canEdit ? (spec) => setChartEdit(spec) : undefined} />
        ))}
      </div>

      {/* sheet tabs */}
      <div className="sheet-tabs" style={{ marginRight: panel !== "none" ? 330 : 0 }}>
        {canEdit && <button className="tab-add" title="Add sheet" onClick={addSheet}>＋</button>}
        {wb.sheets.map((s, i) => ({ s, i })).filter(({ s }) => !s.hidden).map(({ s, i }) => (
          <div key={i} className={`sheet-tab ${i === active ? "active" : ""}`}
            draggable={canEdit}
            style={s.tabColor ? { boxShadow: `inset 0 -3px 0 ${s.tabColor}` } : undefined}
            onDragStart={() => { dragTab.current = i; }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              const from = dragTab.current;
              dragTab.current = null;
              if (wb.protectStructure) return;
              if (from === null || from === i) return;
              mutate((w) => { const [moved] = w.sheets.splice(from, 1); w.sheets.splice(i, 0, moved); });
              setActive(i);
            }}
            onClick={() => setActive(i)}
            onDoubleClick={() => canEdit && setRenamingTab(i)}
            onPointerDown={(e) => {
              if (e.pointerType === "mouse" || !canEdit) return;
              const x = e.clientX, y = e.clientY;
              window.clearTimeout(tabLp.current);
              tabLp.current = window.setTimeout(() => setTabMenu({ i, ...clampToViewport(x, y, 240, 380) }), 520);
            }}
            onContextMenu={(e) => { e.preventDefault(); if (canEdit) setTabMenu({ i, ...clampToViewport(e.clientX, e.clientY, 240, 380) }); }}>
            {renamingTab === i ? (
              <input autoFocus defaultValue={s.name}
                onBlur={(e) => {
                  const nn = (e.target.value || s.name).trim();
                  if (nn !== s.name && !wb.protectStructure) mutate((w) => { renameSheetRefs(w, s.name, nn); w.sheets[i].name = nn; });
                  setRenamingTab(null);
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                style={{ width: 70 }} />
            ) : s.name}
            {i === active && wb.sheets.length > 1 && canEdit && (
              <span className="tab-menu">
                <button title="Duplicate" onClick={(e) => { e.stopPropagation(); dupSheet(i); }}>⧉</button>
                <button title="Delete" onClick={(e) => { e.stopPropagation(); delSheet(i); }}>✕</button>
              </span>
            )}
          </div>
        ))}
        {wb.sheets.some((s) => s.hidden) && (
          <button className="tab-add" title="Unhide sheets"
            onClick={(e) => setTabMenu({ i: -1, ...clampToViewport(e.clientX, e.clientY, 240, 380) })}>👁</button>
        )}
      </div>

      {/* status bar — quick stats + zoom (Excel-style) */}
      <div className="sheet-status" style={{ marginRight: panel !== "none" ? 330 : 0 }}>
        {selStats && (
          <span className="ss-stats">
            {selStats.nums > 0 && <>Avg {fmtStat(selStats.avg!)} · Sum {fmtStat(selStats.sum)} · Min {fmtStat(selStats.min!)} · Max {fmtStat(selStats.max!)} · </>}
            Count {selStats.count}
          </span>
        )}
        <div className="spacer" />
        <button className="ss-zoom" onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))}>−</button>
        <input type="range" min={50} max={200} step={10} value={zoom * 100}
          onChange={(e) => setZoom(Number(e.target.value) / 100)} style={{ width: 90 }} />
        <button className="ss-zoom" onClick={() => setZoom((z) => Math.min(2, Math.round((z + 0.1) * 10) / 10))}>＋</button>
        <span className="ss-pct">{Math.round(zoom * 100)}%</span>
      </div>

      {/* sheet-tab context menu */}
      {tabMenu && (
        <div className="hmenu" style={{ left: tabMenu.x, top: tabMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
          {tabMenu.i >= 0 ? (
            <>
              <div className="hmenu-item" onMouseDown={() => { setRenamingTab(tabMenu.i); setTabMenu(null); }}>Rename</div>
              <div className="hmenu-item" onMouseDown={() => { dupSheet(tabMenu.i); setTabMenu(null); }}>Duplicate</div>
              <div className="hmenu-item" onMouseDown={() => { hideSheet(tabMenu.i); setTabMenu(null); }}>Hide sheet</div>
              {wb.sheets.length > 1 && (
                <div className="hmenu-item" style={{ color: "#D84B57" }}
                  onMouseDown={() => { delSheet(tabMenu.i); setTabMenu(null); }}>Delete</div>
              )}
              <div style={{ padding: "6px 10px 2px", fontSize: 10, color: "var(--muted)" }}>Tab color</div>
              <div style={{ display: "flex", gap: 6, padding: "0 10px 8px" }}>
                {["#F2782E", "#3578E5", "#1F9D66", "#D84B57", "#8E6BC8", "#E9B44C"].map((c) => (
                  <button key={c} onMouseDown={() => { mutate((w) => { w.sheets[tabMenu.i].tabColor = c; }); setTabMenu(null); }}
                    style={{ width: 16, height: 16, borderRadius: 4, background: c, border: "none", cursor: "pointer" }} />
                ))}
                <button title="No color" onMouseDown={() => { mutate((w) => { w.sheets[tabMenu.i].tabColor = undefined; }); setTabMenu(null); }}
                  style={{ width: 16, height: 16, border: "1px solid var(--line)", borderRadius: 4, background: "var(--surface)", fontSize: 9 }}>✕</button>
              </div>
            </>
          ) : (
            <>
              <div style={{ padding: "6px 10px 2px", fontSize: 10, color: "var(--muted)" }}>Hidden sheets</div>
              {wb.sheets.map((s, i) => s.hidden && (
                <div key={i} className="hmenu-item"
                  onMouseDown={() => { mutate((w) => { w.sheets[i].hidden = undefined; }); setActive(i); setTabMenu(null); }}>
                  ▤ {s.name}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* conditional format dialog */}
      {cfOpen && <CfManager sheet={sheet} selection={rangeToA1(selection)}
        onAdd={addCF} onMove={moveCF} onDelete={delCF} onClear={clearCF}
        onClose={() => setCfOpen(false)} />}
      {pasteSpec && <PasteSpecialDialog onPick={pasteSpecial} onClose={() => setPasteSpec(false)} />}
      {cellMenu && (
        <div className="ctx-back" onPointerDown={() => setCellMenu(null)} onContextMenu={(e) => e.preventDefault()}>
          <div className="hmenu" style={{ left: cellMenu.x, top: cellMenu.y, position: "fixed" }}
            onMouseDown={(e) => e.stopPropagation()}>
            {/* S19.1 — link actions surface when the cell carries a link */}
            {sheet.cells[cellMenu.ref]?.link && (<>
              <div className="hmenu-item" onMouseDown={() => { setLinkDlg(true); setCellMenu(null); }}>Edit link</div>
              <div className="hmenu-item" onMouseDown={() => {
                mutateSheet((s) => {
                  const cur = s.cells[cellMenu.ref];
                  if (cur) s.cells[cellMenu.ref] = { ...cur, link: undefined, s: { ...cur.s, color: undefined, u: undefined } };
                });
                setCellMenu(null);
              }}>Remove link</div>
              <div className="hmenu-item" onMouseDown={() => { openLink(sheet.cells[cellMenu.ref]!.link!); setCellMenu(null); }}>Open link</div>
            </>)}
            <div className="hmenu-item" onMouseDown={() => { setLinkDlg(true); setCellMenu(null); }}>Insert link…</div>
            {!sheet.cells[cellMenu.ref]?.f && (
              <div className="hmenu-item" onMouseDown={() => { setRtDlg(cellMenu.ref); setCellMenu(null); }}>Format text…</div>
            )}
            <div className="hmenu-item" onMouseDown={() => { setCommentDlg(cellMenu.ref); setCellMenu(null); }}>
              {sheet.comments?.[cellMenu.ref] ? `Comments (${sheet.comments[cellMenu.ref].replies.length})` : "New comment"}
            </div>
            <div className="hmenu-item" onMouseDown={() => { copyAsPicture(); setCellMenu(null); }}>Copy as picture</div>
            <div className="hmenu-item" onMouseDown={() => {
              setNoteEdit({ ref: cellMenu.ref, text: sheet.notes?.[cellMenu.ref] ?? "" });
              setCellMenu(null);
            }}>{sheet.notes?.[cellMenu.ref] ? "Edit note" : "Add note"}</div>
            {sheet.notes?.[cellMenu.ref] && (
              <div className="hmenu-item" onMouseDown={() => {
                mutateSheet((s) => { delete s.notes?.[cellMenu.ref]; });
                setCellMenu(null);
              }}>Delete note</div>
            )}
          </div>
        </div>
      )}
      {noteEdit && (
        <div className="dlg-back" onClick={() => setNoteEdit(null)}>
          <div className="dlg" onClick={(e) => e.stopPropagation()}>
            <h3>Note — {noteEdit.ref}</h3>
            <textarea autoFocus className="inp" style={{ minHeight: 90, marginTop: 12, resize: "vertical", fontFamily: "inherit" }}
              value={noteEdit.text} placeholder="Note text…"
              onChange={(e) => setNoteEdit({ ...noteEdit, text: e.target.value })} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button className="btn-ghost btn-sm" onClick={() => setNoteEdit(null)}>Cancel</button>
              <button className="btn-primary btn-sm" onClick={() => {
                mutateSheet((s) => {
                  s.notes = { ...(s.notes ?? {}) };
                  if (noteEdit.text.trim()) s.notes[noteEdit.ref] = noteEdit.text.trim();
                  else delete s.notes[noteEdit.ref];
                });
                setNoteEdit(null);
              }}>Save</button>
            </div>
          </div>
        </div>
      )}
      {valDlg && (
        <ValidationDialog sheet={sheet} selection={rangeToA1(selection)}
          onMutate={mutateSheet} onClose={() => setValDlg(false)} />
      )}
      {findDlg && (
        <FindDialog wb={wb} replace={findDlg.replace} canEdit={canEdit} user={user}
          onMutate={mutate} onJump={(hit) => {
            const si = wb.sheets.findIndex((s) => s.name === hit.sheet);
            if (si >= 0) { setActive(si); setSelection({ c1: parseA1(hit.ref)!.col, r1: parseA1(hit.ref)!.row, c2: parseA1(hit.ref)!.col, r2: parseA1(hit.ref)!.row }); }
          }}
          toast={toast} onClose={() => setFindDlg(null)} />
      )}
      {nameMgr && (
        <NameManager wb={wb} sheetName={sheet.name} selection={rangeToA1(selection)}
          onMutate={mutate} onClose={() => setNameMgr(false)} toast={toast} />
      )}
      {filterMenu && sheet.filter && (
        <div className="ctx-back" onPointerDown={() => setFilterMenu(null)} onContextMenu={(e) => e.preventDefault()}>
          <FilterMenu wb={wb} sheet={sheet} col={filterMenu.col} x={filterMenu.x} y={filterMenu.y}
            onSet={setFilterCol} onSort={sortFilterCol} onClose={() => setFilterMenu(null)} />
        </div>
      )}
      {sortDlg && (
        <SortDialog range={selection} onSort={(keys) => { sortBy(keys); setSortDlg(false); }}
          onClose={() => setSortDlg(false)} />
      )}
      {dedupeDlg && (
        <DedupeDialog range={selection} onApply={(cols) => { dedupe(cols); setDedupeDlg(false); }}
          onClose={() => setDedupeDlg(false)} />
      )}
      {t2cDlg && (
        <T2CDialog onApply={(d) => { textToCols(d); setT2cDlg(false); }} onClose={() => setT2cDlg(false)} />
      )}
      {tableDlg && (
        <TableDialog range={selection} onApply={createTable} onClose={() => setTableDlg(false)} />
      )}
      {chartEdit && (
        <ChartEditDialog spec={chartEdit} onClose={() => setChartEdit(null)}
          onSave={(spec) => {
            mutateSheet((s) => { s.charts = s.charts?.map((c) => c.id === spec.id ? spec : c); });
            setChartEdit(null);
          }} />
      )}
      {printDlg && (
        <PrintDialog sheet={sheet} wb={wb} defaultArea={usedRangeA1(sheet.cells)}
          onPrint={(opts) => { mutate((w) => { w.print = opts; }); printSheet(dispSheet, wb, { ...opts, title }); setPrintDlg(false); }}
          onClose={() => setPrintDlg(false)} />
      )}
      {propsDlg && (
        <PropsDialog wb={wb} onSave={(p) => { mutate((w) => { w.props = p; }); setPropsDlg(false); }}
          onClose={() => setPropsDlg(false)} />
      )}
      {protectDlg && (
        <ProtectDialog sheet={sheet} wb={wb}
          onSave={(o) => {
            mutateSheet((s) => {
              s.protected = o.prot || undefined;
              s.allowRanges = o.ranges.length ? o.ranges : undefined;
              s.trackChanges = o.track || undefined;
              if (!o.track) s.changeLog = undefined;
            });
            if (o.structure !== !!wb.protectStructure || o.passwordHash !== wb.passwordHash)
              mutate((w) => {
                w.protectStructure = o.structure || undefined;
                w.passwordHash = o.passwordHash ?? undefined;
              });
            setProtectDlg(false);
          }}
          onClose={() => setProtectDlg(false)} />
      )}
      {viewsDlg && (
        <ViewsDialog wb={wb} sheet={sheet}
          onSaveView={(name) => mutate((w) => {
            w.views = (w.views ?? []).filter((v) => v.name !== name);
            w.views.push({
              name, sheet: sheet.name,
              state: {
                hiddenRows: sheet.hiddenRows, hiddenCols: sheet.hiddenCols,
                freeze: sheet.freeze, splitRow: sheet.splitRow, zoom,
              },
            });
          })}
          onApply={(v) => {
            mutate((w) => {
              const s = w.sheets.find((x) => x.name === v.sheet);
              if (!s) return;
              s.hiddenRows = v.state.hiddenRows; s.hiddenCols = v.state.hiddenCols;
              s.freeze = v.state.freeze; s.splitRow = v.state.splitRow;
            });
            const idx = wb.sheets.findIndex((x) => x.name === v.sheet);
            if (idx >= 0) setActive(idx);
            if (v.state.zoom) setZoom(v.state.zoom);
            setViewsDlg(false);
          }}
          onDelete={(name) => mutate((w) => { w.views = w.views?.filter((v) => v.name !== name); })}
          onClose={() => setViewsDlg(false)} />
      )}
      {reviewDlg && (
        <ReviewDialog sheet={sheet}
          onReject={(i) => mutateSheetRaw((s) => {
            const e = s.changeLog?.[i];
            if (!e) return;
            if (e.prev) s.cells[e.ref] = e.prev; else delete s.cells[e.ref];
            s.changeLog!.splice(i, 1);
          })}
          onRejectAll={() => mutateSheetRaw((s) => {
            (s.changeLog ?? []).slice().reverse().forEach((e) => {
              if (e.prev) s.cells[e.ref] = e.prev; else delete s.cells[e.ref];
            });
            s.changeLog = [];
          })}
          onAcceptAll={() => mutateSheetRaw((s) => { s.changeLog = []; })}
          onClose={() => setReviewDlg(false)} />
      )}
      {sparkDlg && (
        <SparklineDialog anchor={anchorRef} sheet={sheet}
          onApply={(ref, spec) => {
            mutateSheet((s) => {
              s.sparklines = { ...(s.sparklines ?? {}) };
              if (spec) s.sparklines[ref] = spec; else delete s.sparklines[ref];
            });
            setSparkDlg(false);
          }}
          onClose={() => setSparkDlg(false)} />
      )}
      {pivotDlg && (
        <PivotDialog sheet={sheet} wb={wb} selection={selection}
          onApply={(spec) => {
            const built = buildPivotCells(wb, sheet, spec);
            if (!built) { toast("Invalid pivot — check source range and fields"); return; }
            if (anyLocked(Object.keys(built.cells))) return;
            mutateSheet((s) => applyPivot(s, built, spec));
            setPivotDlg(false);
          }}
          onClose={() => setPivotDlg(false)} />
      )}
      {seekDlg && (
        <GoalSeekDialog sheet={sheet} wb={wb} anchor={anchorRef}
          onApply={(ref, v) => {
            if (anyLocked([ref])) return;
            mutateSheet((s) => { s.cells[ref] = { s: s.cells[ref]?.s, v, h: stamp() }; });
            setSeekDlg(false);
          }}
          onClose={() => setSeekDlg(false)} />
      )}
      {calcDlg && (
        <CalcDialog wb={wb}
          onApply={(calc) => { setWb({ ...wb, calc }); setCalcWb(wb); setCalcDlg(false); }}
          onClose={() => setCalcDlg(false)} />
      )}
      {inspDlg && (
        <InspectDialog sheet={sheet} wb={wb} evals={evals}
          onJump={(ref) => { const p = parseA1(ref); if (p) { setSelection({ c1: p.col, r1: p.row, c2: p.col, r2: p.row }); setInspDlg(false); } }}
          onClose={() => setInspDlg(false)} />
      )}
      {/* ---- S19 Excel-parity dialogs ---- */}
      {linkDlg && (
        <LinkDialog wb={wb} sheetName={sheet.name}
          initialText={typeof anchorCell?.v === "string" ? anchorCell.v : anchorCell?.v != null ? String(anchorCell.v) : ""}
          initialLink={anchorCell?.link}
          onInsert={insertLink}
          onRemove={anchorCell?.link ? () => mutateSheet((s) => {
            const cur = s.cells[anchorRef];
            if (cur) s.cells[anchorRef] = { ...cur, link: undefined, s: { ...cur.s, color: undefined, u: undefined } };
          }) : undefined}
          onClose={() => setLinkDlg(false)} />
      )}
      {symbolDlg && <SymbolDialog onPick={insertSymbol} onClose={() => setSymbolDlg(false)} />}
      {fnWiz && (
        <FunctionWizard wb={wb}
          initial={anchorCell?.f}
          onInsert={(f) => { commitCell(fxAnchor.current, f); }}
          onClose={() => setFnWiz(false)} />
      )}
      {picDlg && (
        <PictureDialog
          onInsert={(obj) => setObjects([...(sheet.objects ?? []), { ...obj, id: `obj${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` }])}
          onClose={() => setPicDlg(false)} />
      )}
      {scenDlg && (
        <ScenarioDialog sheet={sheet} selection={rangeToA1(selection)}
          onAdd={scenarioAdd} onShow={scenarioShow} onDelete={scenarioDelete}
          onClose={() => setScenDlg(false)} />
      )}
      {dtDlg && (
        <DataTableDialog wb={wb} sheetName={sheet.name}
          onApply={dataTableApply} onClose={() => setDtDlg(false)} />
      )}
      {solverDlg && (
        <SolverDialog wb={wb} sheetName={sheet.name} anchorRef={anchorRef}
          onApply={solverApply} onClose={() => setSolverDlg(false)} />
      )}
      {spellDlg && (
        <SpellPanel sheet={sheet}
          onFix={(ref, from, to, w) => { spellFix(ref, from, to, w); }}
          onJump={(ref) => { const p = parseA1(ref); if (p) setSelection({ c1: p.col, r1: p.row, c2: p.col, r2: p.row }); }}
          onClose={() => setSpellDlg(false)} />
      )}
      {commentDlg && (
        <CommentDialog cellRef={commentDlg} thread={sheet.comments?.[commentDlg]}
          me={user?.displayName ?? user?.email ?? "You"} canEdit={canEdit}
          onReply={(text) => mutateSheet((s) => {
            const cur = s.comments?.[commentDlg] ?? { at: Date.now(), replies: [] };
            const who = user?.displayName ?? user?.email ?? "You";
            s.comments = { ...(s.comments ?? {}), [commentDlg]: { ...cur, by: cur.by ?? who, replies: [...cur.replies, { by: who, at: Date.now(), text }] } };
          })}
          onResolve={sheet.comments?.[commentDlg] ? (res) => mutateSheet((s) => {
            const cur = s.comments![commentDlg];
            s.comments![commentDlg] = { ...cur, resolved: res };
          }) : undefined}
          onDelete={sheet.comments?.[commentDlg] ? () => mutateSheet((s) => {
            const next = { ...(s.comments ?? {}) };
            delete next[commentDlg];
            s.comments = Object.keys(next).length ? next : undefined;
          }) : undefined}
          onClose={() => setCommentDlg(null)} />
      )}
      {rtDlg && (
        <RichTextDialog cell={sheet.cells[rtDlg]}
          onSave={(text, rt) => commitCell(rtDlg, text, rt)}
          onClose={() => setRtDlg(null)} />
      )}
      {cellShiftDlg && (
        <CellShiftDialog
          onApply={(_ins, dir) => {
            if (anyLocked([...rangeRefs(selection)])) return;
            mutateSheet((s) => shiftCells(s, selection, dir));
            setCellShiftDlg(false);
          }}
          onClose={() => setCellShiftDlg(false)} />
      )}
      {slicerDlg && (
        <SlicerDialog sheet={sheet} range={selection}
          onApply={(col, title) => {
            mutateSheet((s) => { s.slicers = [...(s.slicers ?? []), { col, title, sel: [] }]; });
            setSlicerDlg(false);
          }}
          onClose={() => setSlicerDlg(false)} />
      )}
      {subtotalDlg && (
        <SubtotalDialog sheet={sheet} range={selection}
          onApply={(keyCol, code, cols) => {
            if (anyLocked([...rangeRefs(selection)])) return;
            mutate((w) => applySubtotals(w.sheets[active], w, selection, keyCol, code, cols));
            setSubtotalDlg(false);
          }}
          onClose={() => setSubtotalDlg(false)} />
      )}
      {gtsDlg && (
        <GoToSpecialDialog
          onApply={(kind) => {
            const refs = goToSpecial(sheet, evals, selection, kind);
            if (!refs.length) { toast("No matching cells in selection"); return; }
            setSelections(refs.map((r) => { const p = parseA1(r)!; return { c1: p.col, r1: p.row, c2: p.col, r2: p.row }; }));
            setGtsDlg(false);
          }}
          onClose={() => setGtsDlg(false)} />
      )}
      {scriptDlg && (
        <ScriptDialog wb={wb}
          onRun={(code) => {
            let out: string[] = [];
            mutate((w) => { out = runScript(w, code, sheet.name); });
            return out;
          }}
          onSave={(name, code) => mutate((w) => {
            const list = (w.scripts ??= []);
            const i = list.findIndex((s) => s.name === name);
            if (i >= 0) list[i].code = code; else list.push({ name, code });
          })}
          onDelete={(name) => mutate((w) => { w.scripts = (w.scripts ?? []).filter((s) => s.name !== name); })}
          onClose={() => setScriptDlg(false)} />
      )}
      {queryDlg && (
        <QueryDialog wb={wb}
          onPreview={(spec) => runQuery(spec)}
          onLoad={(spec, res) => {
            mutate((w) => {
              const name = spec.destSheet || spec.name;
              const fresh = queryToSheet(name, res);
              const i = w.sheets.findIndex((s) => s.name === name);
              if (i >= 0) w.sheets[i] = fresh; else w.sheets.push(fresh);
            });
            toast(`Loaded ${res.rows.length} rows → ${spec.destSheet || spec.name}`);
          }}
          onSave={(spec) => mutate((w) => {
            const list = (w.queries ??= []);
            const i = list.findIndex((q) => q.name === spec.name);
            if (i >= 0) list[i] = spec; else list.push(spec);
          })}
          onDelete={(name) => mutate((w) => { w.queries = (w.queries ?? []).filter((q) => q.name !== name); })}
          onClose={() => setQueryDlg(false)} />
      )}
      {sheet.pivots?.length ? (
        <div className="sheet-tables-bar">
          {sheet.pivots.map((p, i) => (
            <span key={i} className="sheet-table-chip" title={`${p.src} → ${p.at}`}>
              Pivot {p.at}
              {canEdit && <>
                <button className="chip-x" title="Insert PivotChart" onClick={() => {
                  mutateSheet((s) => {
                    s.charts = [...(s.charts ?? []), {
                      id: crypto.randomUUID(), type: "bar", range: "",
                      pivot: i, title: `Pivot ${p.at}`, x: 200, y: 80,
                    }];
                  });
                }}>📊</button>
                <button className="chip-x" title="Drill into selected pivot row" onClick={() => {
                  const spec = sheet.pivots![i];
                  const at = parseA1(spec.at);
                  if (!at || !spec.span) return;
                  const r = selection.r1;
                  if (r <= at.row || r >= at.row + spec.span.r - 1) { toast("Select a pivot data row first"); return; }
                  // expand the row's key parts — blanks repeat the outer value
                  const nHdr = Math.max(spec.rows.length, 1);
                  const parts: string[] = [];
                  for (let c = 0; c < nHdr && c < spec.rows.length; c++) {
                    let rr = r, v = "";
                    while (rr > at.row && !(v = String(sheet.cells[toA1(at.col + c, rr)]?.v ?? ""))) rr--;
                    parts.push(v);
                  }
                  const drill = pivotDrillRows(wb, sheet, spec, parts);
                  if (!drill) { toast("No source rows behind this group"); return; }
                  const name = `Drill ${parts.join("-")}`.slice(0, 28);
                  setWb((prev) => {
                    const next = structuredClone(prev);
                    next.sheets.push({ name: wb.sheets.some((s) => s.name === name) ? `${name} ${next.sheets.length}` : name, cells: drill });
                    return next;
                  });
                  setActive(wb.sheets.length);
                }}>⤵</button>
                <button className="chip-x" title="Refresh" onClick={() => {
                  const built = buildPivotCells(wb, sheet, sheet.pivots![i]);
                  if (!built) { toast("Pivot source invalid"); return; }
                  if (anyLocked(Object.keys(built.cells))) return;
                  mutateSheet((s) => applyPivot(s, built, s.pivots![i]));
                }}>⟳</button>
                <button className="chip-x" title="Remove" onClick={() => mutateSheet((s) => removePivot(s, i))}>×</button>
              </>}
            </span>
          ))}
        </div>
      ) : null}
      {sheet.tables?.length ? (
        <div className="sheet-tables-bar">
          {sheet.tables.map((t) => (
            <span key={t.name} className="sheet-table-chip" title={t.range}>
              {t.name}
              {canEdit && <button className="chip-x" title="Convert back to range" onClick={() => removeTable(t.name)}>×</button>}
            </span>
          ))}
        </div>
      ) : null}
      {chartOpen && (
        <div className="dlg-back" onClick={() => setChartOpen(false)}>
          <div className="dlg" onClick={(e) => e.stopPropagation()}>
            <h3>Chart from {rangeToA1(selection)}</h3>
            <p style={{ fontSize: 12, color: "var(--muted)" }}>First column = labels (or X for scatter), other columns = series. Combo = bars + last series as line.</p>
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              {CHART_TYPES.map(([t, l]) => (
                <button key={t} className="btn-ghost btn-sm"
                  onClick={() => addChart(t)}>{l}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {panel === "comments" && (
        <CommentsPanel fileId={item.id} comments={comments}
          canComment={canEdit || permission === "commenter" || permission === "reviewer"}
          onReload={loadComments} onAnchorClick={focusAnchor}
          onNewComment={submitComment} newCommentOpen={newComment}
          onCancelNew={() => { setNewComment(false); setPanel("none"); }}
          toast={toast} />
      )}
      {panel === "versions" && (
        <VersionsPanel item={item} onClose={() => setPanel("none")}
          onRestore={async () => {
            const r = await api.get<{ content: { workbook: Workbook } }>(`/api/files/${item.id}/content`);
            if (r.content?.workbook) setWb(r.content.workbook);
          }} toast={toast} />
      )}
      {panel === "ai" && (
        <AiPanel fileId={item.id} kind="sheets" canEdit={canEdit}
          serialize={aiSerialize}
          selection={() => `${sheet.name}!${rangeToA1(selection)}`}
          applyOps={aiApplyOps} onClose={() => setPanel("none")} toast={toast} />
      )}
      {sharing && <ShareDialog item={item} onClose={() => setSharing(false)} toast={toast} />}
      {msg && <div className="toast">{msg}</div>}
    </div>
  );
}

// ---------- fill series detection (S3.3) — helpers live in model.ts ----------

type CFType = NonNullable<CondFormat["type"]>;
const CF_TYPES: [CFType, string][] = [
  ["value", "Cell value"], ["text", "Text"], ["topn", "Top/bottom N"],
  ["formula", "Formula"], ["databar", "Data bars"], ["colorscale", "Color scale"], ["iconset", "Icon set"],
];

function cfRuleSummary(r: CondFormat): string {
  switch (r.type ?? "value") {
    case "value": return `cell ${r.op} ${r.value} → ${r.bg}`;
    case "text": return `text ${r.textOp ?? "contains"} "${r.text}" → ${r.bg}`;
    case "topn": return `${r.bottom ? "bottom" : "top"} ${r.n ?? 10} → ${r.bg}`;
    case "formula": return `=${r.f} → ${r.bg}`;
    case "databar": return `data bars (${r.bar ?? "#3574E0"})`;
    case "colorscale": return `scale ${r.minColor ?? "#F8696B"}→${r.maxColor ?? "#63BE7B"}`;
    case "iconset": return `icons (${r.icons ?? "arrows"})`;
  }
}

/** Conditional-formatting rule manager (S6.1+S6.2): list, reorder, delete,
 *  clear-all, and add any of the seven rule types. */
function CfManager({ sheet, selection, onAdd, onMove, onDelete, onClear, onClose }: {
  sheet: SheetData;
  selection: string;
  onAdd: (rule: Omit<CondFormat, "range">) => void;
  onMove: (i: number, dir: -1 | 1) => void;
  onDelete: (i: number) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const rules = sheet.cf ?? [];
  const [adding, setAdding] = useState(rules.length === 0);
  const [type, setType] = useState<CFType>("value");
  const [op, setOp] = useState<NonNullable<CondFormat["op"]>>(">");
  const [value, setValue] = useState("0");
  const [bg, setBg] = useState(CF_COLORS[0]);
  const [textOp, setTextOp] = useState<NonNullable<CondFormat["textOp"]>>("contains");
  const [text, setText] = useState("");
  const [n, setN] = useState("10");
  const [bottom, setBottom] = useState(false);
  const [f, setF] = useState("");
  const [bar, setBar] = useState("#3574E0");
  const [minColor, setMinColor] = useState("#F8696B");
  const [midColor, setMidColor] = useState("");
  const [maxColor, setMaxColor] = useState("#63BE7B");
  const [icons, setIcons] = useState<NonNullable<CondFormat["icons"]>>("arrows");

  const sel: CSSProperties = { height: 30, border: "1px solid var(--line)", borderRadius: 8, padding: "0 8px", fontSize: 12, fontFamily: "inherit" };
  const inp: CSSProperties = { ...sel, flex: 1, minWidth: 0 };
  const swatch = (val: string, set: (v: string) => void, colors: string[]) => (
    <div style={{ display: "flex", gap: 6 }}>
      {colors.map((c) => (
        <button key={c} onClick={() => set(c)}
          style={{ width: 24, height: 24, borderRadius: 6, background: c, border: val === c ? "2px solid #171717" : "1px solid var(--line)" }} />
      ))}
      <input type="color" value={val} onChange={(e) => set(e.target.value)} style={{ width: 26, height: 24, padding: 0, border: "none", background: "none" }} />
    </div>
  );

  const build = (): Omit<CondFormat, "range"> => {
    switch (type) {
      case "value": return { type, op, value: Number(value) || 0, bg };
      case "text": return { type, textOp, text, bg };
      case "topn": return { type, n: Math.max(1, Number(n) || 1), bottom, bg };
      case "formula": return { type, f: f.replace(/^=/, ""), bg };
      case "databar": return { type, bar };
      case "colorscale": return { type, minColor, midColor: midColor || undefined, maxColor };
      case "iconset": return { type, icons };
    }
  };

  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
        <h3>Conditional formatting</h3>
        {rules.length > 0 && (
          <div style={{ maxHeight: 180, overflowY: "auto", marginTop: 10 }}>
            {rules.map((r, i) => (
              <div key={i} className="frow" style={{ justifyContent: "space-between" }}>
                <span style={{ fontSize: 12 }}>
                  <b style={{ fontFamily: "monospace", marginRight: 6 }}>{r.range}</b>
                  {cfRuleSummary(r)}
                </span>
                <span style={{ display: "flex", gap: 2 }}>
                  <button className="btn-ghost btn-sm" disabled={i === 0} onClick={() => onMove(i, -1)}>↑</button>
                  <button className="btn-ghost btn-sm" disabled={i === rules.length - 1} onClick={() => onMove(i, 1)}>↓</button>
                  <button className="btn-ghost btn-sm" onClick={() => onDelete(i)}>✕</button>
                </span>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="btn-ghost btn-sm" onClick={() => setAdding(!adding)}>{adding ? "Hide" : "＋ New rule"}</button>
          {rules.length > 0 && <button className="btn-ghost btn-sm" onClick={onClear}>Clear all rules</button>}
        </div>
        {adding && (
          <div style={{ marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
            <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 8px" }}>New rule on {selection}</p>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select style={sel} value={type} onChange={(e) => setType(e.target.value as CFType)}>
                {CF_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              {type === "value" && <>
                <select style={sel} value={op} onChange={(e) => setOp(e.target.value as NonNullable<CondFormat["op"]>)}>
                  {[">", "<", ">=", "<=", "=", "!="].map((o) => <option key={o}>{o}</option>)}
                </select>
                <input style={{ ...inp, width: 80 }} value={value} onChange={(e) => setValue(e.target.value)} type="number" />
              </>}
              {type === "text" && <>
                <select style={sel} value={textOp} onChange={(e) => setTextOp(e.target.value as NonNullable<CondFormat["textOp"]>)}>
                  {[["contains", "contains"], ["notcontains", "doesn't contain"], ["starts", "begins with"], ["ends", "ends with"], ["=", "equals"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <input style={{ ...inp, width: 90 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="text" />
              </>}
              {type === "topn" && <>
                <select style={sel} value={bottom ? "b" : "t"} onChange={(e) => setBottom(e.target.value === "b")}>
                  <option value="t">Top</option><option value="b">Bottom</option>
                </select>
                <input style={{ ...inp, width: 60 }} value={n} onChange={(e) => setN(e.target.value)} type="number" />
              </>}
              {type === "formula" &&
                <input style={inp} value={f} onChange={(e) => setF(e.target.value)} placeholder="=A1>100 (relative to top-left)" />}
              {type === "iconset" &&
                <select style={sel} value={icons} onChange={(e) => setIcons(e.target.value as NonNullable<CondFormat["icons"]>)}>
                  <option value="arrows">Arrows</option><option value="traffic">Traffic lights</option><option value="stars">Stars</option>
                </select>}
            </div>
            {(type === "value" || type === "text" || type === "topn" || type === "formula") && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>Fill</span>{swatch(bg, setBg, CF_COLORS)}
              </div>
            )}
            {type === "databar" && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>Bar</span>
                {swatch(bar, setBar, ["#3574E0", "#63BE7B", "#F2782E", "#9334E0"])}
              </div>
            )}
            {type === "colorscale" && (
              <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 10, fontSize: 11, color: "var(--muted)" }}>
                Min {swatch(minColor, setMinColor, ["#F8696B", "#FFF", "#DCE9FF"])}
                Mid {swatch(midColor || "#FFFFFF", setMidColor, ["#FFDD71", "#FFF3C4"])}
                Max {swatch(maxColor, setMaxColor, ["#63BE7B", "#171717", "#F2782E"])}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button className="btn-primary btn-sm" onClick={() => { onAdd(build()); setAdding(false); }}>Add rule</button>
            </div>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Paste Special (S3.1) ----------

function PasteSpecialDialog({ onPick, onClose }: {
  onPick: (mode: PasteMode, op: PasteOp) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<PasteMode>("all");
  const [op, setOp] = useState<PasteOp>("none");
  const MODES: [PasteMode, string][] = [
    ["all", "All"], ["values", "Values"], ["formats", "Formats"], ["formulas", "Formulas"], ["transpose", "Transpose"],
  ];
  const OPS: [PasteOp, string][] = [
    ["none", "None"], ["add", "Add"], ["sub", "Subtract"], ["mul", "Multiply"], ["div", "Divide"],
  ];
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()}>
        <h3>Paste Special</h3>
        <p style={{ fontSize: 12, color: "var(--muted)", margin: "6px 0 0" }}>Paste</p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          {MODES.map(([m, label]) => (
            <label key={m} className={`ps-opt ${mode === m ? "on" : ""}`}>
              <input type="radio" name="ps-mode" checked={mode === m} onChange={() => setMode(m)} hidden />
              {label}
            </label>
          ))}
        </div>
        <p style={{ fontSize: 12, color: "var(--muted)", margin: "14px 0 0" }}>Operation</p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          {OPS.map(([o, label]) => (
            <label key={o} className={`ps-opt ${op === o ? "on" : ""}`}>
              <input type="radio" name="ps-op" checked={op === o} onChange={() => setOp(o)} hidden />
              {label}
            </label>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={() => onPick(mode, op)}>Paste</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Find & Replace (S3.2) ----------

function FindDialog({ wb, replace, canEdit, user, onMutate, onJump, toast, onClose }: {
  wb: Workbook;
  replace: boolean;
  canEdit: boolean;
  user?: { id?: string; email?: string; role?: string } | null;
  onMutate: (fn: (wb: Workbook) => void) => void;
  onJump: (hit: FindHit) => void;
  toast: (m: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [rep, setRep] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [inFormulas, setInFormulas] = useState(false);
  const [hits, setHits] = useState<FindHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [cursor, setCursor] = useState(0);

  const run = () => {
    const h = findInWorkbook(wb, q, { matchCase, inFormulas });
    setHits(h);
    setSearched(true);
    setCursor(0);
    if (h[0]) onJump(h[0]);
  };
  const next = (dir: 1 | -1) => {
    if (!hits.length) return;
    const i = (cursor + dir + hits.length) % hits.length;
    setCursor(i);
    onJump(hits[i]);
  };
  const doReplace = (all: boolean) => {
    if (!q) return;
    let n = 0;
    const targets = all ? hits : hits.slice(cursor, cursor + 1);
    const bySheet = new Map<string, Set<string>>();
    for (const h of targets) {
      if (!bySheet.has(h.sheet)) bySheet.set(h.sheet, new Set());
      bySheet.get(h.sheet)!.add(h.ref);
    }
    let blocked = 0;
    onMutate((w) => {
      for (const s of w.sheets) {
        const refs = bySheet.get(s.name);
        if (!refs) continue;
        for (const ref of refs) {
          if (cellLocked(s, ref, user)) { blocked++; continue; }
          const cell = s.cells[ref];
          if (cell && replaceInCell(cell, q, rep, matchCase)) n++;
        }
      }
    });
    toast(n ? `Replaced ${n} cell${n > 1 ? "s" : ""}${blocked ? ` (${blocked} locked)` : ""}`
            : blocked ? `${blocked} hit${blocked > 1 ? "s" : ""} locked — sheet protected` : "Nothing replaced");
    setHits([]);
    setSearched(false);
  };

  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()} style={{ minWidth: 380 }}>
        <h3>{replace ? "Find and Replace" : "Find"}</h3>
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          <input autoFocus value={q} placeholder="Find what…" className="inp"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (hits.length ? next(1) : run())} />
          {replace && (
            <input value={rep} placeholder="Replace with…" className="inp"
              onChange={(e) => setRep(e.target.value)} />
          )}
          <div style={{ display: "flex", gap: 14, fontSize: 12 }}>
            <label><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case</label>
            <label><input type="checkbox" checked={inFormulas} onChange={(e) => setInFormulas(e.target.checked)} /> Look in formulas</label>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
          <button className="btn-ghost btn-sm" onClick={() => next(-1)} disabled={!hits.length}>↑ Prev</button>
          <button className="btn-ghost btn-sm" onClick={() => next(1)} disabled={!hits.length}>Next ↓</button>
          <button className="btn-primary btn-sm" onClick={run}>Find all</button>
          {replace && canEdit && (
            <>
              <button className="btn-ghost btn-sm" onClick={() => doReplace(false)} disabled={!hits.length}>Replace</button>
              <button className="btn-ghost btn-sm" onClick={() => doReplace(true)} disabled={!searched}>Replace all</button>
            </>
          )}
        </div>
        {searched && (
          <div style={{ marginTop: 10, maxHeight: 200, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8 }}>
            {hits.length === 0 && <div style={{ padding: 12, fontSize: 12, color: "var(--muted)" }}>No matches</div>}
            {hits.map((h, i) => (
              <button key={`${h.sheet}!${h.ref}`} className={`find-row ${i === cursor ? "on" : ""}`}
                onClick={() => { setCursor(i); onJump(h); }}>
                <b>{h.sheet}!{h.ref}</b>
                <span>{h.text.length > 60 ? h.text.slice(0, 60) + "…" : h.text}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Data validation (S3.4) ----------

function ValidationDialog({ sheet, selection, onMutate, onClose }: {
  sheet: SheetData;
  selection: string;
  onMutate: (fn: (s: SheetData) => void) => void;
  onClose: () => void;
}) {
  const [range, setRange] = useState(selection);
  const [type, setType] = useState<Validation["type"]>("list");
  const [list, setList] = useState("");
  const [op, setOp] = useState<NonNullable<Validation["op"]>>("between");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [inputMsg, setInputMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [errorStyle, setErrorStyle] = useState<"stop" | "warn">("stop");
  const rules = sheet.validations ?? [];

  const add = () => {
    const v: Validation = { range: range.trim() || selection, type, inputMsg: inputMsg || undefined, errorMsg: errorMsg || undefined, errorStyle };
    if (type === "list") v.list = list;
    else { v.op = op; v.min = min; v.max = max; }
    onMutate((s) => { s.validations = [...(s.validations ?? []), v]; });
  };

  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()} style={{ minWidth: 420 }}>
        <h3>Data validation</h3>
        {rules.length > 0 && (
          <div style={{ marginTop: 10, border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
            {rules.map((r, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: i < rules.length - 1 ? "1px solid var(--line)" : "none", fontSize: 12 }}>
                <b>{r.range}</b>
                <span style={{ color: "var(--muted)" }}>
                  {r.type === "list" ? `list: ${r.list}` : `${r.type} ${r.op ?? ""} ${r.min ?? ""}${r.max ? `–${r.max}` : ""}`}
                  {r.errorStyle === "warn" ? " (warn)" : ""}
                </span>
                <button className="btn-ghost btn-sm" style={{ marginLeft: "auto" }}
                  onClick={() => onMutate((s) => { s.validations = (s.validations ?? []).filter((_, j) => j !== i); })}>✕</button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="inp" value={range} onChange={(e) => setRange(e.target.value)} placeholder="Range (A1:C9)" style={{ flex: 1 }} />
            <select className="rb-sel" value={type} onChange={(e) => setType(e.target.value as Validation["type"])}>
              <option value="list">List</option>
              <option value="number">Number</option>
              <option value="date">Date</option>
              <option value="text_len">Text length</option>
            </select>
          </div>
          {type === "list" ? (
            <input className="inp" value={list} onChange={(e) => setList(e.target.value)}
              placeholder="Items — Red,Green,Blue or a range =Sheet1!A1:A5 or a name" />
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <select className="rb-sel" value={op} onChange={(e) => setOp(e.target.value as typeof op)}>
                {["between", "notbetween", ">", "<", ">=", "<=", "=", "!="].map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <input className="inp" value={min} onChange={(e) => setMin(e.target.value)} placeholder="Min / value" style={{ flex: 1 }} />
              {(op === "between" || op === "notbetween") && (
                <input className="inp" value={max} onChange={(e) => setMax(e.target.value)} placeholder="Max" style={{ flex: 1 }} />
              )}
            </div>
          )}
          <input className="inp" value={inputMsg} onChange={(e) => setInputMsg(e.target.value)} placeholder="Input message (shown when the cell is selected)" />
          <input className="inp" value={errorMsg} onChange={(e) => setErrorMsg(e.target.value)} placeholder="Error message (shown on invalid entry)" />
          <label style={{ fontSize: 12 }}>
            <input type="checkbox" checked={errorStyle === "warn"} onChange={(e) => setErrorStyle(e.target.checked ? "warn" : "stop")} />
            {" "}Warn only (allow invalid values, flag them)
          </label>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Done</button>
          <button className="btn-primary btn-sm" onClick={add}>Add rule</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Name Manager ----------

function NameManager({ wb, sheetName, selection, onMutate, onClose, toast }: {
  wb: Workbook;
  sheetName: string;
  selection: string;
  onMutate: (fn: (w: Workbook) => void) => void;
  onClose: () => void;
  toast: (m: string) => void;
}) {
  const names = wb.names ?? {};
  const qSheet = /[\s]/.test(sheetName) || /^\d/.test(sheetName) ? `'${sheetName}'` : sheetName;
  const [newName, setNewName] = useState("");
  const [newRef, setNewRef] = useState(`${qSheet}!${selection}`);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editRef, setEditRef] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const addName = () => {
    const nm = newName.trim();
    const bad = validRangeName(nm) ?? validNameRef(newRef, wb);
    if (bad) return setErr(bad);
    if (Object.keys(names).some((k) => k.toLowerCase() === nm.toLowerCase()))
      return setErr(`"${nm}" is already defined`);
    onMutate((w) => { w.names = { ...w.names, [nm]: newRef.trim() }; });
    setNewName(""); setErr(null);
    toast(`Defined ${nm}`);
  };

  const saveEdit = (key: string) => {
    const bad = validNameRef(editRef, wb);
    if (bad) return setErr(bad);
    onMutate((w) => { w.names = { ...w.names, [key]: editRef.trim() }; });
    setEditKey(null); setErr(null);
  };

  const row: CSSProperties = { display: "flex", gap: 8, alignItems: "center", padding: "5px 0", borderBottom: "1px solid var(--line)" };
  const inp: CSSProperties = { height: 28, border: "1px solid var(--line)", borderRadius: 7, padding: "0 8px", fontSize: 12, fontFamily: "inherit" };

  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <h3>Name Manager</h3>
        <div style={{ maxHeight: 240, overflowY: "auto", marginTop: 8 }}>
          {Object.entries(names).length === 0 && (
            <p style={{ fontSize: 12, color: "var(--muted)" }}>No named ranges yet. Names work in any formula — e.g. <code>=SUM(Sales)</code>.</p>
          )}
          {Object.entries(names).map(([nm, ref]) => (
            <div key={nm} style={row}>
              <b style={{ width: 110, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>{nm}</b>
              {editKey === nm ? (
                <>
                  <input style={{ ...inp, flex: 1 }} value={editRef} autoFocus
                    onChange={(e) => setEditRef(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveEdit(nm); if (e.key === "Escape") setEditKey(null); }} />
                  <button className="btn-primary btn-sm" onClick={() => saveEdit(nm)}>Save</button>
                </>
              ) : (
                <>
                  <span style={{ flex: 1, fontSize: 12, fontFamily: "monospace", color: "var(--muted)" }}>{ref}</span>
                  <button className="btn-ghost btn-sm" onClick={() => { setEditKey(nm); setEditRef(ref); setErr(null); }}>Edit</button>
                  <button className="btn-ghost btn-sm" onClick={() => onMutate((w) => { const n = { ...w.names }; delete n[nm]; w.names = n; })}>✕</button>
                </>
              )}
            </div>
          ))}
        </div>
        <div style={{ ...row, borderBottom: "none", marginTop: 8 }}>
          <input style={{ ...inp, width: 110 }} placeholder="Name" value={newName}
            onChange={(e) => setNewName(e.target.value)} />
          <input style={{ ...inp, flex: 1 }} placeholder="Refers to" value={newRef}
            onChange={(e) => setNewRef(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addName()} />
          <button className="btn-primary btn-sm" onClick={addName}>Add</button>
        </div>
        {err && <p style={{ fontSize: 12, color: "#D84B57", marginTop: 4 }}>{err}</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ---------- S5 data tools ----------

const COND_OPS: [string, string][] = [
  ["=", "equals"], ["!=", "does not equal"], [">", "greater than"], [">=", "≥"],
  ["<", "less than"], ["<=", "≤"], ["contains", "contains"], ["notcontains", "doesn't contain"],
  ["starts", "begins with"], ["ends", "ends with"], ["blank", "is blank"], ["notblank", "is not blank"],
];

/** AutoFilter dropdown menu for one column (S5.1). */
function FilterMenu({ wb, sheet, col, x, y, onSet, onSort, onClose }: {
  wb: Workbook; sheet: SheetData; col: number;
  x: number; y: number;
  onSet: (col: number, crit: FilterCrit | null) => void;
  onSort: (col: number, asc: boolean) => void;
  onClose: () => void;
}) {
  const range = parseRange(sheet.filter!.range)!;
  const crit = sheet.filter!.cols[col];
  const all = useMemo(() => filterValues(sheet, wb, range, col), [sheet, wb, range, col]);
  const [tab, setTab] = useState<"values" | "cond">(crit?.type === "cond" ? "cond" : "values");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(() =>
    new Set(crit?.type === "values" && crit.values ? crit.values : all));
  const [op1, setOp1] = useState(crit?.op1 ?? "=");
  const [v1, setV1] = useState(crit?.v1 ?? "");
  const [op2, setOp2] = useState(crit?.op2 ?? "");
  const [v2, setV2] = useState(crit?.v2 ?? "");
  const [and, setAnd] = useState(crit?.and ?? true);

  const shown = q ? all.filter((v) => v.toLowerCase().includes(q.toLowerCase())) : all;
  const applyValues = () => { onSet(col, { type: "values", values: [...sel] }); onClose(); };
  const applyCond = () => {
    onSet(col, { type: "cond", op1, v1, op2: op2 || undefined, v2, and });
    onClose();
  };

  return (
    <div className="hmenu filter-menu" style={{ left: Math.min(x, window.innerWidth - 280), top: y, position: "fixed" }}
      onMouseDown={(e) => e.stopPropagation()}>
      <div className="hmenu-item" onClick={() => { onSort(col, true); onClose(); }}>Sort A → Z</div>
      <div className="hmenu-item" onClick={() => { onSort(col, false); onClose(); }}>Sort Z → A</div>
      {crit && <div className="hmenu-item" onClick={() => { onSet(col, null); onClose(); }}>Clear filter from {colLabel(col)}</div>}
      <div className="hmenu-sep" />
      <div className="ftabs">
        <button className={tab === "values" ? "on" : ""} onClick={() => setTab("values")}>Values</button>
        <button className={tab === "cond" ? "on" : ""} onClick={() => setTab("cond")}>Conditions</button>
      </div>
      {tab === "values" ? (
        <>
          <input className="fsearch" placeholder="Search…" value={q} autoFocus
            onChange={(e) => setQ(e.target.value)} />
          <label className="frow">
            <input type="checkbox" checked={sel.size === all.length}
              onChange={(e) => setSel(e.target.checked ? new Set(all) : new Set())} />
            <i>(Select all)</i>
          </label>
          <div className="flist">
            {shown.map((v) => (
              <label key={v} className="frow">
                <input type="checkbox" checked={sel.has(v)}
                  onChange={(e) => {
                    const n = new Set(sel);
                    e.target.checked ? n.add(v) : n.delete(v);
                    setSel(n);
                  }} />
                {v === "" ? <i>(Blanks)</i> : v}
              </label>
            ))}
            {!shown.length && <div className="frow"><i>No matches</i></div>}
          </div>
          <div className="factions">
            <button className="btn-primary btn-sm" onClick={applyValues}>OK</button>
            <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <div className="fcond">
            <select value={op1} onChange={(e) => setOp1(e.target.value)}>
              {COND_OPS.map(([o, l]) => <option key={o} value={o}>{l}</option>)}
            </select>
            <input value={v1} onChange={(e) => setV1(e.target.value)} placeholder="value" />
            <select value={op2} onChange={(e) => setOp2(e.target.value)}>
              <option value="">— and/or —</option>
              {COND_OPS.map(([o, l]) => <option key={o} value={o}>{l}</option>)}
            </select>
            {op2 && <input value={v2} onChange={(e) => setV2(e.target.value)} placeholder="value" />}
            {op2 && (
              <div className="frow" style={{ gap: 12 }}>
                <label><input type="radio" checked={and} onChange={() => setAnd(true)} /> And</label>
                <label><input type="radio" checked={!and} onChange={() => setAnd(false)} /> Or</label>
              </div>
            )}
          </div>
          <div className="factions">
            <button className="btn-primary btn-sm" onClick={applyCond}>OK</button>
            <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

/** Multi-key sort dialog (S5.2). */
function SortDialog({ range, onSort, onClose }: {
  range: Range;
  onSort: (keys: { col: number; asc: boolean; order?: string[]; color?: string }[]) => void;
  onClose: () => void;
}) {
  type Key = { col: number; asc: boolean; on: "v" | "list" | "color"; order: string; color: string };
  const [keys, setKeys] = useState<Key[]>([{ col: range.c1, asc: true, on: "v", order: "", color: "#ffff00" }]);
  const upd = (i: number, patch: Partial<Key>) => setKeys(keys.map((k, j) => j === i ? { ...k, ...patch } : k));
  const colSel = (i: number) => (
    <select value={keys[i].col} onChange={(e) => upd(i, { col: Number(e.target.value) })}>
      {Array.from({ length: range.c2 - range.c1 + 1 }, (_, k) => range.c1 + k)
        .map((c) => <option key={c} value={c}>{colLabel(c)}</option>)}
    </select>
  );
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()}>
        <h3>Sort {rangeToA1(range)}</h3>
        {keys.map((k, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, width: 60 }}>{i === 0 ? "Sort by" : "Then by"}</span>
            {colSel(i)}
            <select value={k.on} onChange={(e) => upd(i, { on: e.target.value as Key["on"] })}>
              <option value="v">Values</option>
              <option value="list">Custom list</option>
              <option value="color">Cell color</option>
            </select>
            {k.on === "v" && (
              <select value={k.asc ? "a" : "d"} onChange={(e) => upd(i, { asc: e.target.value === "a" })}>
                <option value="a">A → Z</option>
                <option value="d">Z → A</option>
              </select>
            )}
            {k.on === "list" && (
              <input className="inp" style={{ width: 160 }} placeholder="e.g. High, Medium, Low"
                value={k.order} onChange={(e) => upd(i, { order: e.target.value })} />
            )}
            {k.on === "color" && (
              <input type="color" value={k.color} onChange={(e) => upd(i, { color: e.target.value })}
                title="Rows with this fill color sort first" />
            )}
            {keys.length > 1 && (
              <button className="btn-ghost btn-sm" onClick={() => setKeys(keys.filter((_, j) => j !== i))}>✕</button>
            )}
          </div>
        ))}
        <button className="btn-ghost btn-sm" style={{ marginTop: 10 }}
          onClick={() => setKeys([...keys, { col: range.c1, asc: true, on: "v", order: "", color: "#ffff00" }])}>＋ Add level</button>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={() => onSort(keys.map((k) => ({
            col: k.col, asc: k.asc,
            order: k.on === "list" ? k.order.split(",").map((x) => x.trim()).filter(Boolean) : undefined,
            color: k.on === "color" ? k.color : undefined,
          })))}>Sort</button>
        </div>
      </div>
    </div>
  );
}

/** Remove duplicates — pick key columns (S5.3a). */
function DedupeDialog({ range, onApply, onClose }: {
  range: Range;
  onApply: (cols: number[]) => void;
  onClose: () => void;
}) {
  const allCols = Array.from({ length: range.c2 - range.c1 + 1 }, (_, i) => range.c1 + i);
  const [cols, setCols] = useState<Set<number>>(new Set(allCols));
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()}>
        <h3>Remove duplicates — {rangeToA1(range)}</h3>
        <p style={{ fontSize: 12, color: "var(--muted)" }}>Rows are compared on the checked columns; later duplicates are removed.</p>
        <div style={{ marginTop: 8 }}>
          {allCols.map((c) => (
            <label key={c} className="frow">
              <input type="checkbox" checked={cols.has(c)}
                onChange={(e) => { const n = new Set(cols); e.target.checked ? n.add(c) : n.delete(c); setCols(n); }} />
              Column {colLabel(c)}
            </label>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" disabled={!cols.size}
            onClick={() => onApply([...cols].sort((a, b) => a - b))}>Remove</button>
        </div>
      </div>
    </div>
  );
}

/** Text to Columns (S5.3b). */
function T2CDialog({ onApply, onClose }: { onApply: (delim: string) => void; onClose: () => void }) {
  const [d, setD] = useState(",");
  const [custom, setCustom] = useState("");
  const opts: [string, string][] = [[",", "Comma"], ["\t", "Tab"], [";", "Semicolon"], [" ", "Space"], ["|", "Pipe"]];
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()}>
        <h3>Text to Columns</h3>
        <p style={{ fontSize: 12, color: "var(--muted)" }}>Split each selected cell into columns at the delimiter.</p>
        <div style={{ marginTop: 8 }}>
          {opts.map(([v, l]) => (
            <label key={l} className="frow">
              <input type="radio" checked={d === v} onChange={() => setD(v)} /> {l}
            </label>
          ))}
          <label className="frow">
            <input type="radio" checked={d === ""} onChange={() => setD("")} /> Other:
            <input style={{ width: 50, height: 24, border: "1px solid var(--line)", borderRadius: 6, padding: "0 6px" }}
              value={custom} onChange={(e) => { setCustom(e.target.value); setD(""); }} />
          </label>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm"
            onClick={() => onApply(d === "" ? (custom || ",") : d)}>Split</button>
        </div>
      </div>
    </div>
  );
}

/** Format-as-Table dialog (S5.4). */
function TableDialog({ range, onApply, onClose }: {
  range: Range;
  onApply: (name: string, style: TableSpec["style"], totals: NonNullable<TableSpec["totals"]>) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [style, setStyle] = useState<NonNullable<TableSpec["style"]>>("banded");
  const [totals, setTotals] = useState<Record<number, string>>({});
  const cols = Array.from({ length: range.c2 - range.c1 + 1 }, (_, i) => range.c1 + i);
  const AGGS: [string, string][] = [["none", "—"], ["sum", "Sum"], ["avg", "Average"], ["count", "Count"], ["min", "Min"], ["max", "Max"]];
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
        <h3>Create table — {rangeToA1(range)}</h3>
        <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
          <span style={{ fontSize: 12 }}>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Table1"
            style={{ height: 30, flex: 1, border: "1px solid var(--line)", borderRadius: 8, padding: "0 8px" }} />
          <select value={style} onChange={(e) => setStyle(e.target.value as NonNullable<TableSpec["style"]>)}
            style={{ height: 30, border: "1px solid var(--line)", borderRadius: 8 }}>
            <option value="banded">Banded</option>
            <option value="accent">Accent</option>
            <option value="dark">Dark</option>
            <option value="plain">Plain</option>
          </select>
        </div>
        <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 12 }}>Totals row — pick an aggregation per column (optional):</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginTop: 6 }}>
          {cols.map((c) => (
            <label key={c} style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
              {colLabel(c)}:
              <select value={totals[c] ?? "none"}
                onChange={(e) => setTotals({ ...totals, [c]: e.target.value })}
                style={{ height: 26, border: "1px solid var(--line)", borderRadius: 6, flex: 1 }}>
                {AGGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm"
            onClick={() => onApply(name, style, Object.fromEntries(
              Object.entries(totals).filter(([, v]) => v !== "none").map(([k, v]) => [Number(k), v])
            ) as NonNullable<TableSpec["totals"]>)}>Create</button>
        </div>
      </div>
    </div>
  );
}


// ---------- S7: chart editor + sparklines ----------

const CHART_TYPES: [ChartSpec["type"], string][] = [
  ["bar", "Bar"], ["line", "Line"], ["area", "Area"], ["pie", "Pie"],
  ["doughnut", "Doughnut"], ["scatter", "Scatter"], ["stacked", "Stacked"], ["combo", "Combo"],
  ["waterfall", "Waterfall"], ["funnel", "Funnel"], ["histogram", "Histogram"],
  ["treemap", "Treemap"], ["radar", "Radar"], ["stock", "Stock (OHLC)"], ["boxwhisker", "Box & Whisker"],
];

/** Chart settings dialog (S7.2): type, titles, legend, data labels, range. */
function ChartEditDialog({ spec, onSave, onClose }: {
  spec: ChartSpec;
  onSave: (s: ChartSpec) => void;
  onClose: () => void;
}) {
  const [s, setS] = useState<ChartSpec>({ ...spec, legend: spec.legend ?? "bottom" });
  const inp: CSSProperties = { height: 30, border: "1px solid var(--line)", borderRadius: 8, padding: "0 8px", fontSize: 12, fontFamily: "inherit", flex: 1, minWidth: 0 };
  const sel: CSSProperties = { ...inp, flex: "none" };
  const row: CSSProperties = { display: "flex", gap: 8, alignItems: "center", marginTop: 10, fontSize: 12 };
  // series count for the secondary-axis picker (columns minus the label col)
  const seriesN = (() => { const r = parseRange(s.range); return r ? Math.max(0, r.c2 - r.c1) : 0; })();
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
        <h3>Chart settings</h3>
        <div style={{ ...row, flexWrap: "wrap", gap: 6 }}>
          {CHART_TYPES.map(([v, l]) => (
            <button key={v} className={`ps-opt ${s.type === v ? "on" : ""}`} onClick={() => setS({ ...s, type: v })}>{l}</button>
          ))}
        </div>
        <div style={row}><span style={{ width: 70 }}>Title</span>
          <input style={inp} value={s.title ?? ""} onChange={(e) => setS({ ...s, title: e.target.value })} /></div>
        <div style={row}><span style={{ width: 70 }}>Data range</span>
          <input style={inp} value={s.range} onChange={(e) => setS({ ...s, range: e.target.value })} /></div>
        <div style={row}><span style={{ width: 70 }}>X axis</span>
          <input style={inp} value={s.xTitle ?? ""} onChange={(e) => setS({ ...s, xTitle: e.target.value })} /></div>
        <div style={row}><span style={{ width: 70 }}>Y axis</span>
          <input style={inp} value={s.yTitle ?? ""} onChange={(e) => setS({ ...s, yTitle: e.target.value })} /></div>
        <div style={row}>
          <span style={{ width: 70 }}>Legend</span>
          <select style={sel} value={s.legend} onChange={(e) => setS({ ...s, legend: e.target.value as ChartSpec["legend"] })}>
            <option value="bottom">Bottom</option><option value="right">Right</option><option value="none">None</option>
          </select>
          <label style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: 10 }}>
            <input type="checkbox" checked={!!s.dataLabels} onChange={(e) => setS({ ...s, dataLabels: e.target.checked })} />
            Data labels
          </label>
        </div>
        <div style={row}>
          <span style={{ width: 70 }}>Trendline</span>
          <select style={sel} value={s.trendline ?? ""}
            onChange={(e) => setS({ ...s, trendline: (e.target.value || null) as ChartSpec["trendline"] })}>
            <option value="">None</option><option value="linear">Linear</option><option value="exponential">Exponential</option>
          </select>
          <span>Error ±</span>
          <input style={{ ...inp, width: 70 }} value={s.errorBars === "stddev" ? "stddev" : s.errorBars ?? ""}
            placeholder="off" onChange={(e) => {
              const v = e.target.value.trim();
              setS({ ...s, errorBars: v === "stddev" ? "stddev" : v === "" ? undefined : Number(v) || undefined });
            }} />
        </div>
        <div style={row}>
          <span style={{ width: 70 }}>Axis min/max</span>
          <input style={{ ...inp, width: 60 }} placeholder="auto" value={s.yMin ?? ""}
            onChange={(e) => setS({ ...s, yMin: e.target.value === "" ? undefined : Number(e.target.value) })} />
          <input style={{ ...inp, width: 60 }} placeholder="auto" value={s.yMax ?? ""}
            onChange={(e) => setS({ ...s, yMax: e.target.value === "" ? undefined : Number(e.target.value) })} />
          <span>2nd axis</span>
          <select style={sel} value={s.axis2 ?? ""}
            onChange={(e) => setS({ ...s, axis2: e.target.value === "" ? undefined : Number(e.target.value) })}>
            <option value="">off</option>
            {Array.from({ length: seriesN }, (_, i) => (
              <option key={i} value={i}>series {i + 1}</option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={() => onSave(s)}>Save</button>
        </div>
      </div>
    </div>
  );
}

/** Insert a sparkline into the anchor cell (S7.3). Pass null spec to remove. */
function SparklineDialog({ anchor, sheet, onApply, onClose }: {
  anchor: string; sheet: SheetData;
  onApply: (ref: string, spec: { range: string; type: "line" | "bar" | "winloss"; color?: string } | null) => void;
  onClose: () => void;
}) {
  const existing = sheet.sparklines?.[anchor];
  const [range, setRange] = useState(existing?.range ?? "");
  const [type, setType] = useState<"line" | "bar" | "winloss">(existing?.type ?? "line");
  const [color, setColor] = useState(existing?.color ?? "#3574E0");
  const inp: CSSProperties = { height: 30, border: "1px solid var(--line)", borderRadius: 8, padding: "0 8px", fontSize: 12, fontFamily: "inherit", flex: 1 };
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()}>
        <h3>Sparkline in {anchor}</h3>
        <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
          <input style={inp} value={range} onChange={(e) => setRange(e.target.value)}
            placeholder="Source range e.g. B2:F2" autoFocus
            onKeyDown={(e) => e.key === "Enter" && onApply(anchor, { range, type, color })} />
          <select value={type} onChange={(e) => setType(e.target.value as "line" | "bar" | "winloss")}
            style={{ ...inp, flex: "none", width: 90 }}>
            <option value="line">Line</option><option value="bar">Bar</option><option value="winloss">Win/Loss</option>
          </select>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
            style={{ width: 32, height: 30, padding: 0, border: "none", background: "none" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          {existing && (
            <button className="btn-ghost btn-sm" style={{ marginRight: "auto" }}
              onClick={() => onApply(anchor, null)}>Remove</button>
          )}
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" disabled={!parseRange(range)}
            onClick={() => onApply(anchor, { range, type, color })}>Insert</button>
        </div>
      </div>
    </div>
  );
}

// ---------- S8: print/page setup + workbook properties ----------

/** Print / PDF export dialog (S8.3). */
function PrintDialog({ sheet, wb, defaultArea, onPrint, onClose }: {
  sheet: SheetData; wb: Workbook; defaultArea: string;
  onPrint: (opts: PrintOpts) => void; onClose: () => void;
}) {
  const saved = wb.print ?? {};
  const [orientation, setOrientation] = useState<"portrait" | "landscape">(saved.orientation ?? "portrait");
  const [area, setArea] = useState(saved.area ?? defaultArea);
  const [gridlines, setGridlines] = useState(saved.gridlines ?? false);
  const [fitWidth, setFitWidth] = useState(saved.fitWidth ?? true);
  const [titleRows, setTitleRows] = useState(saved.titleRows ?? "");
  const [titleCols, setTitleCols] = useState(saved.titleCols ?? "");
  const [header, setHeader] = useState(saved.header ?? "");
  const [footer, setFooter] = useState(saved.footer ?? "");
  const [scale, setScale] = useState(saved.scale ? String(saved.scale) : "");
  const inp: CSSProperties = { height: 30, border: "1px solid var(--line)", borderRadius: 8, padding: "0 8px", fontSize: 12, fontFamily: "inherit", flex: 1 };
  const lab: CSSProperties = { fontSize: 12, width: 80 };
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()}>
        <h3>Print — {sheet.name}</h3>
        <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
          <span style={{ fontSize: 12, width: 80 }}>Orientation</span>
          {(["portrait", "landscape"] as const).map((o) => (
            <button key={o} className={`ps-opt ${orientation === o ? "on" : ""}`}
              style={{ textTransform: "capitalize" }} onClick={() => setOrientation(o)}>{o}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
          <span style={{ fontSize: 12, width: 80 }}>Print area</span>
          <input style={inp} value={area} onChange={(e) => setArea(e.target.value)} placeholder={defaultArea} />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
          <span style={lab}>Title rows</span>
          <input style={inp} value={titleRows} onChange={(e) => setTitleRows(e.target.value)} placeholder="e.g. 1:2 — repeat per page" />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <span style={lab}>Title cols</span>
          <input style={inp} value={titleCols} onChange={(e) => setTitleCols(e.target.value)} placeholder="e.g. A:A" />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <span style={lab}>Header</span>
          <input style={inp} value={header} onChange={(e) => setHeader(e.target.value)} placeholder="&T — &D   (&P/&N = page/of)" />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <span style={lab}>Footer</span>
          <input style={inp} value={footer} onChange={(e) => setFooter(e.target.value)} placeholder="Page &P of &N" />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <span style={lab}>Scale %</span>
          <input style={{ ...inp, width: 70, flex: "none" }} value={scale} onChange={(e) => setScale(e.target.value)} placeholder="100" />
        </div>
        <label className="frow" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={gridlines} onChange={(e) => setGridlines(e.target.checked)} /> Print gridlines
        </label>
        <label className="frow">
          <input type="checkbox" checked={fitWidth} disabled={!!scale} onChange={(e) => setFitWidth(e.target.checked)} /> Fit to page width
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" disabled={!!area && !parseRange(area)}
            onClick={() => onPrint({
              orientation, area: area || undefined, gridlines, fitWidth,
              titleRows: titleRows || undefined, titleCols: titleCols || undefined,
              header: header || undefined, footer: footer || undefined,
              scale: scale ? Math.min(400, Math.max(10, Number(scale) || 100)) : undefined,
            })}>Print / PDF</button>
        </div>
      </div>
    </div>
  );
}

/** Workbook properties (S8.4). */
function PropsDialog({ wb, onSave, onClose }: {
  wb: Workbook; onSave: (p: NonNullable<Workbook["props"]>) => void; onClose: () => void;
}) {
  const [p, setP] = useState<NonNullable<Workbook["props"]>>({ ...(wb.props ?? {}) });
  const inp: CSSProperties = { height: 30, border: "1px solid var(--line)", borderRadius: 8, padding: "0 8px", fontSize: 12, fontFamily: "inherit", flex: 1 };
  const fld = (k: keyof NonNullable<Workbook["props"]>, label: string) => (
    <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
      <span style={{ fontSize: 12, width: 80 }}>{label}</span>
      <input style={inp} value={p[k] ?? ""} onChange={(e) => setP({ ...p, [k]: e.target.value })} />
    </div>
  );
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()}>
        <h3>Workbook properties</h3>
        {fld("title", "Title")}
        {fld("subject", "Subject")}
        {fld("author", "Author")}
        {fld("company", "Company")}
        {fld("keywords", "Keywords")}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={() => onSave(p)}>Save</button>
        </div>
      </div>
    </div>
  );
}

/** Sheet + workbook protection dialog (S9.2/S15): lock cells with optional
 *  per-user/per-role allowed ranges, track-changes toggle, structure lock,
 *  and an open password. */
function ProtectDialog({ sheet, wb, onSave, onClose }: {
  sheet: SheetData; wb: Workbook;
  onSave: (o: {
    prot: boolean; ranges: (string | AllowRange)[]; track: boolean;
    structure: boolean; passwordHash?: string | null;
  }) => void;
  onClose: () => void;
}) {
  const rangeText = (sheet.allowRanges ?? []).map((e) =>
    typeof e === "string" ? e : `${e.range}${e.users?.length ? ` | ${e.users.join(";")}` : ""}${e.roles?.length ? ` | role:${e.roles.join(";")}` : ""}`
  ).join(", ");
  const [prot, setProt] = useState(!!sheet.protected);
  const [ranges, setRanges] = useState(rangeText);
  const [track, setTrack] = useState(!!sheet.trackChanges);
  const [structure, setStructure] = useState(!!wb.protectStructure);
  const [pw, setPw] = useState("");
  const [pwOn, setPwOn] = useState(!!wb.passwordHash);
  const parsed = ranges.split(",").map((r) => r.trim()).filter(Boolean).map((entry) => {
    const [rng, ...scopes] = entry.split("|").map((x) => x.trim());
    if (!parseRange(rng)) return { bad: rng };
    const ar: AllowRange = { range: rng };
    for (const sc of scopes) {
      if (sc.startsWith("role:")) ar.roles = sc.slice(5).split(";").map((x) => x.trim()).filter(Boolean);
      else ar.users = sc.split(";").map((x) => x.trim()).filter(Boolean);
    }
    return (ar.users || ar.roles) ? ar : rng;
  });
  const bad = parsed.filter((e): e is { bad: string } => typeof e === "object" && "bad" in e);
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()} style={{ minWidth: 440 }}>
        <h3>Protect — {sheet.name}</h3>
        <label className="frow" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={prot} onChange={(e) => setProt(e.target.checked)} />
          Lock all cells (editing, formatting, structural changes)
        </label>
        <div style={{ marginTop: 8 }}>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            Editable ranges — comma-separated; scope to users or roles with <code>|</code>, e.g.{" "}
            <code>B2:D10 | ana@x.com</code>, <code>F2 | role:admin</code>
          </span>
          <input className="inp" style={{ width: "100%", marginTop: 6 }} value={ranges}
            onChange={(e) => setRanges(e.target.value)} placeholder="none — everything locked"
            disabled={!prot} />
          {!!bad.length && <p style={{ fontSize: 11, color: "#D84B57", marginTop: 4 }}>Invalid: {bad.map((b) => b.bad).join(", ")}</p>}
        </div>
        <label className="frow" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={track} onChange={(e) => setTrack(e.target.checked)} />
          Track changes on this sheet (records edits for accept/reject review)
        </label>
        <h4 style={{ margin: "16px 0 6px", fontSize: 12, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Workbook</h4>
        <label className="frow">
          <input type="checkbox" checked={structure} onChange={(e) => setStructure(e.target.checked)} />
          Protect structure (no sheet add / delete / rename / reorder / hide)
        </label>
        <label className="frow" style={{ marginTop: 6 }}>
          <input type="checkbox" checked={pwOn} onChange={(e) => setPwOn(e.target.checked)} />
          Require a password to open this workbook
        </label>
        {pwOn && (
          <input className="inp" type="password" style={{ width: "100%", marginTop: 6 }} value={pw}
            placeholder={wb.passwordHash ? "Leave blank to keep current password" : "New open password"}
            onChange={(e) => setPw(e.target.value)} />
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" disabled={!!bad.length}
            onClick={async () => {
              const passwordHash = !pwOn ? null : pw ? await sha256hex(pw) : wb.passwordHash;
              onSave({ prot, ranges: parsed.filter((e): e is string | AllowRange => typeof e === "string" || !("bad" in e)), track, structure, passwordHash });
            }}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/** Custom views (S16.1) — named snapshots of view state (hidden rows/cols,
 *  freeze, split, zoom) applied on demand. */
function ViewsDialog({ wb, sheet, onSaveView, onApply, onDelete, onClose }: {
  wb: Workbook; sheet: SheetData;
  onSaveView: (name: string) => void;
  onApply: (v: NonNullable<Workbook["views"]>[number]) => void;
  onDelete: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const views = wb.views ?? [];
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()}>
        <h3>Custom views</h3>
        <p style={{ fontSize: 12, color: "var(--muted)" }}>Captures hidden rows/cols, freeze, split and zoom for <b>{sheet.name}</b>.</p>
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input className="inp" style={{ flex: 1 }} placeholder="View name" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn-ghost btn-sm" disabled={!name.trim()} onClick={() => { onSaveView(name.trim()); setName(""); }}>Save current</button>
        </div>
        <div style={{ marginTop: 10 }}>
          {views.map((v) => (
            <div key={v.name} style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0", borderBottom: "1px solid #F0ECE8" }}>
              <span style={{ flex: 1, fontSize: 12 }}>{v.name} <span style={{ color: "var(--muted)" }}>({v.sheet})</span></span>
              <button className="btn-ghost btn-sm" onClick={() => onApply(v)}>Apply</button>
              <button className="chip-x" onClick={() => onDelete(v.name)}>×</button>
            </div>
          ))}
          {!views.length && <p style={{ fontSize: 12, color: "#B8B2AA" }}>No saved views.</p>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
          <button className="btn-primary btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/** Tracked-changes review (S15.3): per-entry reject, accept/reject-all. */
function ReviewDialog({ sheet, onReject, onRejectAll, onAcceptAll, onClose }: {
  sheet: SheetData;
  onReject: (i: number) => void;
  onRejectAll: () => void;
  onAcceptAll: () => void;
  onClose: () => void;
}) {
  const log = sheet.changeLog ?? [];
  const cellText = (c?: CellData) => c == null ? "(empty)" : c.f ? `=${c.f}` : String(c.v ?? "(style)");
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()} style={{ minWidth: 480 }}>
        <h3>Track changes — {sheet.name}</h3>
        {!sheet.trackChanges && <p style={{ fontSize: 12, color: "var(--muted)" }}>Tracking is off — enable it in 🔒 Protect.</p>}
        {sheet.trackChanges && !log.length && <p style={{ fontSize: 12, color: "var(--muted)" }}>No pending changes.</p>}
        <div style={{ maxHeight: 300, overflowY: "auto", marginTop: 8 }}>
          {log.map((e, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0", borderBottom: "1px solid #F0ECE8", fontSize: 12 }}>
              <code style={{ minWidth: 42, fontWeight: 600 }}>{e.ref}</code>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <s style={{ color: "#B0574A" }}>{cellText(e.prev)}</s> → <b>{cellText(e.next)}</b>
              </span>
              <span style={{ color: "var(--muted)", fontSize: 10, whiteSpace: "nowrap" }}>
                {e.by ?? ""} {new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
              <button className="chip-x" title="Reject — restore previous value" onClick={() => onReject(i)}>↩</button>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          {!!log.length && <>
            <button className="btn-ghost btn-sm" onClick={onRejectAll}>Reject all</button>
            <button className="btn-ghost btn-sm" onClick={onAcceptAll}>Accept all</button>
          </>}
          <button className="btn-primary btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ---------- S10.1 pivot helpers ----------

/** Materialize a built pivot into the sheet: clear the previous output span,
 *  write the new cells, record the spec. */
function applyPivot(s: SheetData, built: { cells: Record<string, CellData>; rows: number; cols: number }, spec: PivotSpec) {
  if (spec.span) {
    const at = parseA1(spec.at)!;
    for (let r = 0; r < spec.span.r; r++)
      for (let c = 0; c < spec.span.c; c++)
        delete s.cells[toA1(at.col + c, at.row + r)];
  }
  Object.assign(s.cells, built.cells);
  spec.span = { r: built.rows, c: built.cols };
  s.pivots = s.pivots ?? [];
  const i = s.pivots.indexOf(spec);
  if (i < 0) s.pivots.push(spec);
}

function removePivot(s: SheetData, i: number) {
  const spec = s.pivots?.[i];
  if (spec?.span) {
    const at = parseA1(spec.at)!;
    for (let r = 0; r < spec.span.r; r++)
      for (let c = 0; c < spec.span.c; c++)
        delete s.cells[toA1(at.col + c, at.row + r)];
  }
  s.pivots?.splice(i, 1);
  if (!s.pivots?.length) delete s.pivots;
}

// ---------- S10 dialogs ----------

function PivotDialog({ sheet, wb, selection, onApply, onClose }: {
  sheet: SheetData; wb: Workbook; selection: Range;
  onApply: (spec: PivotSpec) => void; onClose: () => void;
}) {
  const [src, setSrc] = useState(rangeToA1(selection));
  const [at, setAt] = useState(() => {
    // default anchor: two cols right of the source block, same top row
    const p = parseRange(rangeToA1(selection));
    return p ? toA1(p.c2 + 2, p.r1) : "A1";
  });
  const [rows, setRows] = useState<string[]>([]);
  const [cols, setCols] = useState<string[]>([]);
  const [vals, setVals] = useState<PivotSpec["vals"]>([]);
  const [filters, setFilters] = useState<{ field: string; sel: string[] }[]>([]);
  const [groups, setGroups] = useState<Record<string, { kind: "month" | "quarter" | "year" | "num"; size?: number }>>({});
  const [calcFields, setCalcFields] = useState<{ name: string; formula: string }[]>([]);
  const [calcName, setCalcName] = useState("");
  const [calcF, setCalcF] = useState("");
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [editFilter, setEditFilter] = useState<string | null>(null);

  // resolve header fields from the src range (qualified or same-sheet)
  const fields = useMemo(() => {
    let r = src, sh = sheet;
    const bang = r.indexOf("!");
    if (bang >= 0) {
      const nm = r.slice(0, bang).replace(/^'|'$/g, "").replace(/''/g, "'");
      sh = wb.sheets.find((s) => s.name === nm) ?? sheet;
      r = r.slice(bang + 1);
    }
    const range = parseRange(r);
    if (!range) return [];
    const evals = evaluateSheetIn(wb, sh.name);
    const out: string[] = [];
    for (let c = range.c1; c <= range.c2; c++) {
      const ref = toA1(c, range.r1);
      const cell = sh.cells[ref];
      out.push((cell?.f ? displayValue(evals.get(ref), cell) : cell?.v == null ? "" : String(cell.v)) || `Col ${c - range.c1 + 1}`);
    }
    return out;
  }, [src, sheet, wb]);

  // source-sheet + range for filter value lists and drill-downs
  const srcCtx = useMemo(() => {
    let r = src, sh = sheet;
    const bang = r.indexOf("!");
    if (bang >= 0) {
      const nm = r.slice(0, bang).replace(/^'|'$/g, "").replace(/''/g, "'");
      sh = wb.sheets.find((s) => s.name === nm) ?? sheet;
      r = r.slice(bang + 1);
    }
    const range = parseRange(r);
    return range ? { sh, range } : null;
  }, [src, sheet, wb]);
  const distinctVals = (field: string): string[] => {
    if (!srcCtx) return [];
    const i = fields.indexOf(field);
    if (i < 0) return [];
    const evals = evaluateSheetIn(wb, srcCtx.sh.name);
    const seen = new Set<string>();
    for (let r = srcCtx.range.r1 + 1; r <= srcCtx.range.r2; r++) {
      const ref = toA1(srcCtx.range.c1 + i, r);
      const cell = srcCtx.sh.cells[ref];
      seen.add((cell?.f ? displayValue(evals.get(ref), cell) : cell?.v == null ? "" : String(cell.v)));
    }
    return [...seen];
  };

  const unassign = (f: string) => {
    setRows((rs) => rs.filter((x) => x !== f));
    setCols((cs) => cs.filter((x) => x !== f));
    setVals((vs) => vs.filter((x) => x.field !== f));
    setFilters((fs) => fs.filter((x) => x.field !== f));
  };
  const move = (f: string, area: "rows" | "cols" | "vals" | "filters") => {
    unassign(f);
    if (area === "rows") setRows((rs) => [...rs.filter((x) => x !== f), f]);
    if (area === "cols") setCols((cs) => [...cs.filter((x) => x !== f), f]);
    if (area === "vals") setVals((vs) => [...vs.filter((x) => x.field !== f), { field: f, agg: "sum" }]);
    if (area === "filters") setFilters((fs) => [...fs.filter((x) => x.field !== f), { field: f, sel: distinctVals(f) }]);
  };
  const unassigned = fields.filter((f) => !rows.includes(f) && !cols.includes(f)
    && !vals.some((v) => v.field === f) && !filters.some((x) => x.field === f) && !calcFields.some((c) => c.name === f));
  const ok = vals.length > 0 && (rows.length > 0 || cols.length > 0) && fields.length > 0 && !!parseA1(at);

  const Area = ({ title, items, area }: { title: string; items: string[]; area: "rows" | "cols" | "vals" }) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", marginBottom: 4 }}>{title}</div>
      <div style={{ minHeight: 56, border: "1px dashed #D9D4CC", borderRadius: 6, padding: 4, display: "flex", flexDirection: "column", gap: 3 }}>
        {items.map((f) => (
          <span key={f} className="pv-chip">
            {f}
            {(area === "rows" || area === "cols") && (
              <select value={groups[f]?.kind ?? ""} title="Group"
                onChange={(e) => {
                  const k = e.target.value;
                  setGroups((g) => {
                    const n = { ...g };
                    if (!k) delete n[f];
                    else n[f] = k === "num" ? { kind: "num", size: 10 } : { kind: k as "month" | "quarter" | "year" };
                    return n;
                  });
                }}>
                <option value="">ungrouped</option>
                <option value="month">by month</option><option value="quarter">by quarter</option>
                <option value="year">by year</option><option value="num">by 10s</option>
              </select>
            )}
            {area === "vals" && (
              <>
                <select value={vals.find((v) => v.field === f)?.agg}
                  onChange={(e) => setVals((vs) => vs.map((v) => v.field === f ? { ...v, agg: e.target.value as PivotSpec["vals"][number]["agg"] } : v))}>
                  <option value="sum">Sum</option><option value="count">Count</option><option value="avg">Avg</option>
                  <option value="min">Min</option><option value="max">Max</option>
                </select>
                <select value={vals.find((v) => v.field === f)?.showAs ?? "value"} title="Show as"
                  onChange={(e) => setVals((vs) => vs.map((v) => v.field === f ? { ...v, showAs: e.target.value as NonNullable<typeof v.showAs> } : v))}>
                  <option value="value">value</option><option value="%total">% total</option>
                  <option value="%col">% col</option><option value="%row">% row</option>
                  <option value="running">running</option><option value="diff">diff prev</option>
                </select>
              </>
            )}
            <button className="chip-x" title="Remove" onClick={() => unassign(f)}>×</button>
          </span>
        ))}
        {!items.length && <span style={{ fontSize: 11, color: "#B8B2AA", padding: 4 }}>drop fields here</span>}
      </div>
    </div>
  );

  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()} style={{ minWidth: 520 }}>
        <h3>PivotTable</h3>
        <div className="frow" style={{ marginTop: 10 }}>
          <label style={{ flex: 1 }}>Source range
            <input className="inp" value={src} onChange={(e) => setSrc(e.target.value)} />
          </label>
          <label style={{ width: 110 }}>Output at
            <input className="inp" value={at} onChange={(e) => setAt(e.target.value)} />
          </label>
        </div>
        {!!unassigned.length && (
          <div style={{ margin: "10px 0 4px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", marginBottom: 4 }}>Fields — click to assign:</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {unassigned.map((f) => (
                <span key={f} className="pv-chip pv-un">
                  {f}
                  <button onClick={() => move(f, "rows")} title="Row field">R</button>
                  <button onClick={() => move(f, "cols")} title="Column field">C</button>
                  <button onClick={() => move(f, "vals")} title="Value field">Σ</button>
                  <button onClick={() => move(f, "filters")} title="Report filter">F</button>
                </span>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
          <Area title="Rows" items={rows} area="rows" />
          <Area title="Columns" items={cols} area="cols" />
          <Area title="Values" items={vals.map((v) => v.field)} area="vals" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", marginBottom: 4 }}>Filters</div>
            <div style={{ minHeight: 56, border: "1px dashed #D9D4CC", borderRadius: 6, padding: 4, display: "flex", flexDirection: "column", gap: 3 }}>
              {filters.map((ft) => (
                <span key={ft.field} className="pv-chip" onClick={() => setEditFilter(editFilter === ft.field ? null : ft.field)} style={{ cursor: "pointer" }}>
                  {ft.field} ({ft.sel.length})
                  <button className="chip-x" title="Remove" onClick={(e) => { e.stopPropagation(); unassign(ft.field); }}>×</button>
                </span>
              ))}
              {!filters.length && <span style={{ fontSize: 11, color: "#B8B2AA", padding: 4 }}>drop fields here</span>}
            </div>
            {editFilter && (
              <div style={{ marginTop: 4, border: "1px solid #D9D4CC", borderRadius: 6, padding: 4, maxHeight: 110, overflowY: "auto" }}>
                {distinctVals(editFilter).map((v) => {
                  const ft = filters.find((x) => x.field === editFilter)!;
                  const on = ft.sel.includes(v);
                  return (
                    <label key={v} style={{ display: "flex", gap: 6, fontSize: 12, padding: "1px 4px" }}>
                      <input type="checkbox" checked={on}
                        onChange={() => setFilters((fs) => fs.map((x) => x.field === editFilter
                          ? { ...x, sel: on ? x.sel.filter((s) => s !== v) : [...x.sel, v] } : x))} />
                      {v === "" ? "(blank)" : v}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", marginBottom: 4 }}>Calculated fields</div>
          {calcFields.map((cf, i) => (
            <span key={cf.name} className="pv-chip" style={{ marginRight: 4 }}>
              {cf.name} = {cf.formula}
              <button className="chip-x" onClick={() => setCalcFields((cs) => cs.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <input className="inp" style={{ width: 110 }} placeholder="Field name" value={calcName} onChange={(e) => setCalcName(e.target.value)} />
            <input className="inp" style={{ flex: 1 }} placeholder="=Price*Qty (field names)" value={calcF} onChange={(e) => setCalcF(e.target.value)} />
            <button className="btn-ghost btn-sm" disabled={!calcName.trim() || !calcF.trim() || fields.includes(calcName.trim())}
              onClick={() => { setCalcFields((cs) => [...cs, { name: calcName.trim(), formula: calcF.trim() }]); setCalcName(""); setCalcF(""); }}>Add</button>
          </div>
        </div>
        <label className="frow" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={refreshOpen} onChange={(e) => setRefreshOpen(e.target.checked)} />
          Refresh when the sheet is opened
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" disabled={!ok}
            onClick={() => onApply({
              src, at, rows, cols,
              vals: [...vals, ...calcFields.map((c) => ({ field: c.name, agg: "sum" as const, formula: c.formula }))],
              filters: filters.length ? filters : undefined,
              groups: Object.keys(groups).length ? Object.entries(groups).map(([field, g]) => ({ field, ...g })) : undefined,
              refreshOnOpen: refreshOpen || undefined,
            })}>Create</button>
        </div>
      </div>
    </div>
  );
}

function GoalSeekDialog({ sheet, wb, anchor, onApply, onClose }: {
  sheet: SheetData; wb: Workbook; anchor: string;
  onApply: (ref: string, v: number) => void; onClose: () => void;
}) {
  const [target, setTarget] = useState(anchor);
  const [goal, setGoal] = useState("");
  const [input, setInput] = useState("");
  const [err, setErr] = useState("");
  const ok = !!parseA1(target) && !!parseA1(input) && goal.trim() !== "" && Number.isFinite(Number(goal));

  const run = () => {
    setErr("");
    const g = Number(goal);
    const cur = sheet.cells[input];
    const guess = typeof cur?.v === "number" ? cur.v : Number(cur?.v) || 0;
    const x = solveGoalSeek((xv) => {
      const wb2 = structuredClone(wb);
      const sh = wb2.sheets.find((s) => s.name === sheet.name)!;
      sh.cells[input] = { s: sh.cells[input]?.s, v: xv };
      const evals = evaluateSheetIn(wb2, sh.name);
      const res = evals.get(target);
      const v = res?.value;
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
      return Number.isFinite(n) ? n : null;
    }, g, guess);
    if (x === null) { setErr("No solution found — target may not depend on the input cell"); return; }
    onApply(input, x);
  };

  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()} style={{ minWidth: 360 }}>
        <h3>Goal Seek</h3>
        <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
          <label>Set cell <input className="inp" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="B10" /></label>
          <label>To value <input className="inp" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="100000" /></label>
          <label>By changing cell <input className="inp" value={input} onChange={(e) => setInput(e.target.value)} placeholder="B3" /></label>
          {err && <p style={{ fontSize: 12, color: "#D84B57", margin: 0 }}>{err}</p>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" disabled={!ok} onClick={run}>Solve</button>
        </div>
      </div>
    </div>
  );
}

// ---------- S11.5/S11.6: calc options + formula inspector ----------

function CalcDialog({ wb, onApply, onClose }: {
  wb: Workbook;
  onApply: (calc: NonNullable<Workbook["calc"]>) => void;
  onClose: () => void;
}) {
  const c = wb.calc ?? {};
  const [mode, setMode] = useState<string>(c.mode ?? "auto");
  const [iter, setIter] = useState(!!c.iterative);
  const [maxIter, setMaxIter] = useState(String(c.maxIterations ?? 100));
  const [maxChange, setMaxChange] = useState(String(c.maxChange ?? 0.001));
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()} style={{ minWidth: 340 }}>
        <h3>Calculation options</h3>
        <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
          <label>Workbook calculation
            <select className="inp" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="auto">Automatic</option>
              <option value="autoNoTables">Automatic except tables</option>
              <option value="manual">Manual — recalc with F9</option>
            </select>
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={iter} onChange={(e) => setIter(e.target.checked)} />
            Enable iterative calculation (allow circular references)
          </label>
          {iter && <>
            <label>Max iterations <input className="inp" type="number" value={maxIter} onChange={(e) => setMaxIter(e.target.value)} /></label>
            <label>Max change <input className="inp" type="number" step="0.0001" value={maxChange} onChange={(e) => setMaxChange(e.target.value)} /></label>
          </>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={() => onApply({
            mode: mode as "auto" | "manual" | "autoNoTables",
            iterative: iter,
            maxIterations: Number(maxIter) || 100,
            maxChange: Number(maxChange) || 0.001,
          })}>Apply</button>
        </div>
      </div>
    </div>
  );
}

function InspectDialog({ sheet, wb, evals, onJump, onClose }: {
  sheet: SheetData; wb: Workbook;
  evals: Map<string, EvalResult>;
  onJump: (ref: string) => void;
  onClose: () => void;
}) {
  const [ref, setRef] = useState("");
  const [cell, setCell] = useState<CellData | null>(null);
  const findings = useMemo(() => errorCheck(sheet, evals, !!sheet.protected), [sheet, evals]);
  const explain = useMemo(() => {
    const c = cell?.f ? cell.f : null;
    if (!c || !ref) return null;
    return explainFormula(wb, sheet.name, c);
  }, [cell, ref, wb, sheet.name]);
  const pick = (r: string) => { setRef(r); setCell(sheet.cells[r] ?? null); };
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()} style={{ minWidth: 480 }}>
        <h3>Formula inspector</h3>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <input className="inp" placeholder="Cell ref (e.g. B5)" value={ref}
            onChange={(e) => pick(e.target.value.toUpperCase())} style={{ width: 120 }} />
          {cell?.f && <code style={{ fontSize: 12, alignSelf: "center" }}>={cell.f}</code>}
        </div>
        {explain && (
          <div style={{ marginTop: 12, maxHeight: 220, overflow: "auto" }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>
              Result: {explain.final.error ?? JSON.stringify(explain.final.value)}
            </div>
            {explain.parts.map((pt, i) => (
              <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
                <code style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{pt.expr}</code>
                <span style={{ color: pt.result.error ? "#D84B57" : "var(--mut)" }}>
                  {pt.result.error ?? JSON.stringify(pt.result.value)}
                </span>
              </div>
            ))}
          </div>
        )}
        <h4 style={{ margin: "14px 0 6px" }}>Error checking ({findings.length})</h4>
        <div style={{ maxHeight: 200, overflow: "auto" }}>
          {findings.length === 0 && <p style={{ fontSize: 12, color: "var(--mut)" }}>No issues found on this sheet.</p>}
          {findings.map((f, i) => (
            <div key={i} className="errcheck-row" onClick={() => onJump(f.ref)}
              style={{ display: "flex", gap: 10, fontSize: 12, padding: "5px 4px", cursor: "pointer", borderBottom: "1px solid var(--line)" }}>
              <b style={{ width: 40 }}>{f.ref}</b>
              <span style={{ flex: 1 }}>{f.msg}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ---------- S12.4: insert/delete cells with shift ----------

function CellShiftDialog({ onApply, onClose }: {
  onApply: (insert: boolean, dir: "down" | "right" | "up" | "left") => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"ins" | "del">("ins");
  const [dir, setDir] = useState<"down" | "right">("down");
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()} style={{ minWidth: 320 }}>
        <h3>Insert / delete cells</h3>
        <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
          <label>Action
            <select className="inp" value={mode} onChange={(e) => setMode(e.target.value as "ins" | "del")}>
              <option value="ins">Insert cells</option>
              <option value="del">Delete cells</option>
            </select>
          </label>
          <label>{mode === "ins" ? "Shift cells" : "Shift remaining cells"}
            <select className="inp" value={dir} onChange={(e) => setDir(e.target.value as "down" | "right")}>
              <option value="down">{mode === "ins" ? "Down" : "Up"}</option>
              <option value="right">{mode === "ins" ? "Right" : "Left"}</option>
            </select>
          </label>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm"
            onClick={() => onApply(mode === "ins", mode === "ins" ? dir : (dir === "down" ? "up" : "left"))}>
            {mode === "ins" ? "Insert" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- S12.6: Go To Special ----------

function GoToSpecialDialog({ onApply, onClose }: {
  onApply: (kind: "blanks" | "formulas" | "constants" | "errors" | "notes") => void;
  onClose: () => void;
}) {
  const opts = [
    ["blanks", "Blank cells"], ["formulas", "Formulas"], ["constants", "Constants (non-formula values)"],
    ["errors", "Errors"], ["notes", "Cells with notes"],
  ] as const;
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()} style={{ minWidth: 300 }}>
        <h3>Go To Special — selection</h3>
        <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
          {opts.map(([k, label]) => (
            <button key={k} className="btn-ghost btn-sm" style={{ textAlign: "left" }}
              onClick={() => onApply(k)}>{label}</button>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ---------- S12.3: subtotal dialog ----------

function SubtotalDialog({ sheet, range, onApply, onClose }: {
  sheet: SheetData;
  range: Range;
  onApply: (keyCol: number, fnCode: number, aggCols: number[]) => void;
  onClose: () => void;
}) {
  const cols = Array.from({ length: range.c2 - range.c1 + 1 }, (_, i) => range.c1 + i);
  const [keyCol, setKeyCol] = useState(range.c1);
  const [fnCode, setFnCode] = useState("9");
  const [agg, setAgg] = useState<Set<number>>(new Set(cols.filter((c) => c !== range.c1)));
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()} style={{ minWidth: 340 }}>
        <h3>Subtotal {rangeToA1(range)}</h3>
        <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
          <label>Group by
            <select className="inp" value={keyCol} onChange={(e) => setKeyCol(Number(e.target.value))}>
              {cols.map((c) => <option key={c} value={c}>{colLabel(c)} — {String(sheet.cells[toA1(c, range.r1)]?.v ?? "")}</option>)}
            </select>
          </label>
          <label>Function
            <select className="inp" value={fnCode} onChange={(e) => setFnCode(e.target.value)}>
              <option value="9">Sum</option><option value="1">Average</option>
              <option value="2">Count</option><option value="4">Max</option><option value="5">Min</option>
            </select>
          </label>
          <div>
            <div style={{ fontSize: 12, marginBottom: 4 }}>Add subtotal to:</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {cols.map((c) => (
                <label key={c} style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }}>
                  <input type="checkbox" checked={agg.has(c)}
                    onChange={(e) => setAgg((s) => { const n = new Set(s); e.target.checked ? n.add(c) : n.delete(c); return n; })} />
                  {colLabel(c)}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" disabled={!agg.size}
            onClick={() => onApply(keyCol, Number(fnCode), [...agg])}>Insert subtotals</button>
        </div>
      </div>
    </div>
  );
}

// ---------- S12.2: slicer dialog + panel ----------

function SlicerDialog({ sheet, range, onApply, onClose }: {
  sheet: SheetData; range: Range;
  onApply: (col: number, title: string) => void;
  onClose: () => void;
}) {
  const cols = Array.from({ length: range.c2 - range.c1 + 1 }, (_, i) => range.c1 + i);
  const [col, setCol] = useState(range.c1);
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()} style={{ minWidth: 300 }}>
        <h3>Insert slicer</h3>
        <p style={{ fontSize: 12, color: "var(--mut)" }}>Pick the column to filter on (uses the selection's column span).</p>
        <select className="inp" value={col} onChange={(e) => setCol(Number(e.target.value))}>
          {cols.map((c) => <option key={c} value={c}>{colLabel(c)} — {String(sheet.cells[toA1(c, range.r1)]?.v ?? "")}</option>)}
        </select>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm"
            onClick={() => onApply(col, String(sheet.cells[toA1(col, range.r1)]?.v ?? colLabel(col)))}>Insert</button>
        </div>
      </div>
    </div>
  );
}

function SlicerPanel({ sheet, wb, slicer, index, onChange, onRemove }: {
  sheet: SheetData; wb: Workbook;
  slicer: { col: number; title: string; sel: string[] };
  index: number;
  onChange: (sel: string[]) => void;
  onRemove?: () => void;
}) {
  const vals = useMemo(() => slicerValues(sheet, wb, slicer.col), [sheet, wb, slicer.col]);
  const sel = new Set(slicer.sel);
  const toggle = (v: string) => {
    const n = new Set(sel);
    if (n.has(v)) n.delete(v); else n.add(v);
    onChange([...n]);
  };
  return (
    <div className="slicer-panel" style={{ top: 40 + index * 180 }}>
      <div className="slicer-head">
        <b>{slicer.title}</b>
        <span>
          {slicer.sel.length > 0 && (
            <button className="btn-ghost btn-sm" title="Clear filter" onClick={() => onChange([])}>✕ filter</button>
          )}
          {onRemove && <button className="btn-ghost btn-sm" title="Remove slicer" onClick={onRemove}>✕</button>}
        </span>
      </div>
      <div className="slicer-body">
        {vals.map((v) => (
          <button key={v} className={`slicer-item ${sel.has(v) ? "on" : ""} ${slicer.sel.length && !sel.has(v) ? "dim" : ""}`}
            onClick={() => toggle(v as string)}>{v === "" ? "(blank)" : v}</button>
        ))}
      </div>
    </div>
  );
}

// ---------- S18.2: automation — script editor/runner ----------

function ScriptDialog({ wb, onRun, onSave, onDelete, onClose }: {
  wb: Workbook;
  onRun: (code: string) => string[];
  onSave: (name: string, code: string) => void;
  onDelete: (name: string) => void;
  onClose: () => void;
}) {
  const [sel, setSel] = useState(wb.scripts?.[0]?.name ?? "");
  const [name, setName] = useState(wb.scripts?.[0]?.name ?? "script1");
  const [code, setCode] = useState(wb.scripts?.[0]?.code ??
`// Office Scripts-style API — mutates the workbook directly
const sheet = workbook.getActiveSheet();
const rng = sheet.getUsedRange();
if (rng) console.log(rng.getAddress(), rng.getRowCount(), "rows");
`);
  const [out, setOut] = useState<string[] | null>(null);
  const [err, setErr] = useState("");
  const pick = (n: string) => {
    setSel(n);
    const s = wb.scripts?.find((x) => x.name === n);
    if (s) { setName(s.name); setCode(s.code); }
  };
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" style={{ minWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <h3>Scripts</h3>
        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
          <div style={{ width: 140, display: "flex", flexDirection: "column", gap: 4 }}>
            {(wb.scripts ?? []).map((s) => (
              <button key={s.name} className={`btn-ghost btn-sm ${sel === s.name ? "on" : ""}`}
                style={{ textAlign: "left" }} onClick={() => pick(s.name)}>📜 {s.name}</button>
            ))}
            <button className="btn-ghost btn-sm" onClick={() => { setSel(""); setName(`script${(wb.scripts?.length ?? 0) + 1}`); setCode("// new script\n"); }}>
              + New
            </button>
          </div>
          <div style={{ flex: 1, display: "grid", gap: 8 }}>
            <input className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="Script name" />
            <textarea className="inp" value={code} onChange={(e) => setCode(e.target.value)}
              spellCheck={false}
              style={{ fontFamily: "monospace", fontSize: 12, minHeight: 200, resize: "vertical" }} />
            {err && <div style={{ color: "#D64545", fontSize: 12 }}>{err}</div>}
            {out !== null && (
              <pre style={{ background: "var(--subtle)", padding: 8, borderRadius: 6, fontSize: 11, maxHeight: 120, overflow: "auto", margin: 0 }}>
                {out.length ? out.join("\n") : "(no output)"}
              </pre>
            )}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 14 }}>
          <div>
            {sel && <button className="btn-ghost btn-sm" onClick={() => { onDelete(sel); setSel(""); }}>Delete</button>}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
            <button className="btn-ghost btn-sm" disabled={!name.trim()}
              onClick={() => { onSave(name.trim(), code); setSel(name.trim()); }}>Save</button>
            <button className="btn-primary btn-sm" onClick={() => {
              setErr(""); setOut(null);
              try { onSave(name.trim(), code); setOut(onRun(code)); }
              catch (e) { setErr((e as Error).message); }
            }}>▶ Run</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- S18.3: Get & Transform — query builder ----------

const STEP_HELP = `Steps JSON, e.g.:
[
  {"op":"filter","col":1,"cmp":">","value":"100"},
  {"op":"sort","col":0,"dir":1},
  {"op":"groupBy","col":0,"agg":"sum","valCol":2}
]
ops: filter keepCols dropCols rename sort skip take distinct groupBy cast`;

function QueryDialog({ wb, onPreview, onLoad, onSave, onDelete, onClose }: {
  wb: Workbook;
  onPreview: (spec: QuerySpec) => Promise<QueryResult>;
  onLoad: (spec: QuerySpec, res: QueryResult) => void;
  onSave: (spec: QuerySpec) => void;
  onDelete: (name: string) => void;
  onClose: () => void;
}) {
  const [sel, setSel] = useState(wb.queries?.[0]?.name ?? "");
  const cur = wb.queries?.find((q) => q.name === sel);
  const [name, setName] = useState(cur?.name ?? "query1");
  const [kind, setKind] = useState<QuerySpec["source"]["kind"]>(cur?.source.kind ?? "csv");
  const [url, setUrl] = useState(cur?.source.url ?? "");
  const [text, setText] = useState(cur?.source.text ?? "");
  const [jsonPath, setJsonPath] = useState(cur?.source.jsonPath ?? "");
  const [steps, setSteps] = useState(JSON.stringify(cur?.steps ?? [], null, 2));
  const [dest, setDest] = useState(cur?.destSheet ?? "");
  const [preview, setPreview] = useState<QueryResult | null>(null);
  const [err, setErr] = useState("");
  const spec = (): QuerySpec => ({
    name: name.trim() || "query1",
    source: { kind, url: url || undefined, text: text || undefined, jsonPath: jsonPath || undefined },
    steps: JSON.parse(steps || "[]"),
    destSheet: dest.trim() || undefined,
  });
  const pick = (n: string) => {
    setSel(n);
    const q = wb.queries?.find((x) => x.name === n);
    if (!q) return;
    setName(q.name); setKind(q.source.kind); setUrl(q.source.url ?? "");
    setText(q.source.text ?? ""); setJsonPath(q.source.jsonPath ?? "");
    setSteps(JSON.stringify(q.steps, null, 2)); setDest(q.destSheet ?? "");
  };
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" style={{ minWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <h3>Get &amp; Transform</h3>
        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
          <div style={{ width: 130, display: "flex", flexDirection: "column", gap: 4 }}>
            {(wb.queries ?? []).map((q) => (
              <button key={q.name} className={`btn-ghost btn-sm ${sel === q.name ? "on" : ""}`}
                style={{ textAlign: "left" }} onClick={() => pick(q.name)}>⚡ {q.name}</button>
            ))}
            <button className="btn-ghost btn-sm" onClick={() => { setSel(""); setName(`query${(wb.queries?.length ?? 0) + 1}`); setSteps("[]"); }}>
              + New
            </button>
          </div>
          <div style={{ flex: 1, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="inp" style={{ width: 120 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Query name" />
              <select className="inp" style={{ width: 90 }} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="csv">CSV</option><option value="tsv">TSV</option><option value="json">JSON</option>
              </select>
              <input className="inp" style={{ flex: 1 }} value={dest} onChange={(e) => setDest(e.target.value)} placeholder="Load into sheet (default: query name)" />
            </div>
            <input className="inp" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Source URL (or paste data below)" />
            {kind === "json" && <input className="inp" value={jsonPath} onChange={(e) => setJsonPath(e.target.value)} placeholder="JSON path to array, e.g. data.items" />}
            {!url && <textarea className="inp" value={text} onChange={(e) => setText(e.target.value)}
              placeholder={`Paste ${kind.toUpperCase()} data here…`} style={{ minHeight: 70, fontFamily: "monospace", fontSize: 11 }} />}
            <textarea className="inp" value={steps} onChange={(e) => setSteps(e.target.value)} spellCheck={false}
              placeholder={STEP_HELP} title={STEP_HELP}
              style={{ fontFamily: "monospace", fontSize: 11, minHeight: 90, resize: "vertical" }} />
            {err && <div style={{ color: "#D64545", fontSize: 12 }}>{err}</div>}
            {preview && (
              <div style={{ maxHeight: 140, overflow: "auto", border: "1px solid var(--line)", borderRadius: 6 }}>
                <table style={{ fontSize: 11, borderCollapse: "collapse", width: "100%" }}>
                  <thead><tr>{preview.headers.map((h, i) => <th key={i} style={{ padding: "3px 8px", borderBottom: "1px solid var(--line)", textAlign: "left" }}>{h}</th>)}</tr></thead>
                  <tbody>
                    {preview.rows.slice(0, 12).map((r, i) => (
                      <tr key={i}>{r.map((v, j) => <td key={j} style={{ padding: "2px 8px" }}>{String(v ?? "")}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
                {preview.rows.length > 12 && <div style={{ fontSize: 10, color: "var(--muted)", padding: 4 }}>…{preview.rows.length - 12} more rows</div>}
              </div>
            )}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 14 }}>
          <div>{sel && <button className="btn-ghost btn-sm" onClick={() => { onDelete(sel); setSel(""); }}>Delete</button>}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
            <button className="btn-ghost btn-sm" onClick={async () => {
              setErr(""); setPreview(null);
              try { const s = spec(); onSave(s); setPreview(await onPreview(s)); }
              catch (e) { setErr((e as Error).message); }
            }}>Preview</button>
            <button className="btn-primary btn-sm" disabled={!preview} onClick={() => {
              try { const s = spec(); onSave(s); onLoad(s, preview!); onClose(); }
              catch (e) { setErr((e as Error).message); }
            }}>Load to sheet</button>
          </div>
        </div>
      </div>
    </div>
  );
}
