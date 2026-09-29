import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import type { Comment, DriveItem } from "@kreatix/shared";
import { api } from "../lib/api";
import { saveContent } from "../lib/drafts";
import { useCollabSession, useMapSync } from "../collab/useCollab";
import { PresenceBar } from "../collab/PresenceBar";
import { AiPanel, type AiOp } from "../ai/AiPanel";
import { ShareDialog } from "../components/ShareDialog";
import { VersionsPanel } from "../components/VersionsPanel";
import { CommentsPanel } from "../components/CommentsPanel";
import { useToast } from "../pages/Home";
import type { Workbook, SheetData, Range, Ref, CellStyle, ChartSpec, CellData } from "./model";
import { toA1, rangeToA1, rangeRefs, parseInput, cellEditText, parseA1, parseRange, shiftForFill, adjustForRowsCols, translateFormula, renameSheetRefs, validRangeName, validNameRef, validationsAt, validateValue, detectSeries, seriesValue, type Validation } from "./model";
import { evaluateSheetIn, refsInFormula } from "./engine";
import { formatValue, NUM_FORMATS } from "./format";
import { sheetToCSV, csvToSheet, workbookToXLSX, xlsxToWorkbook, tsvToCells, usedRangeA1, getCopyBuffer, pasteCells, type PasteMode, type PasteOp, findInWorkbook, replaceInCell, type FindHit, listItems } from "./io";
import { Grid } from "./Grid";
import { ChartCard } from "./Chart";
import { FxInput } from "./FxInput";

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
  ["heading1", "Heading 1", { b: true, size: 16, borders: { bottom: { w: 2, style: "solid", color: "#26221F" } } }],
  ["accent", "Accent", { bg: "#F2782E", color: "#FFFFFF", b: true }],
];
const fmtStat = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");

export function SheetsEditor({ item, initialDoc, permission }: {
  item: DriveItem;
  initialDoc: unknown;
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
  const [audit, setAudit] = useState<"pre" | "dep" | null>(null);
  const [zoom, setZoom] = useState(1);
  const [borderMenu, setBorderMenu] = useState(false);
  const [borderStyle, setBorderStyle] = useState<{ w: 1 | 2 | 3; style: "solid" | "dashed" | "dotted" | "double"; color: string }>({ w: 1, style: "solid", color: "#26221F" });
  const [painter, setPainter] = useState<{ s: CellStyle } | null>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  const xlsxRef = useRef<HTMLInputElement>(null);
  const nameBoxRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const pendingJson = useRef<unknown>(null);

  const [wb, setWb] = useState<Workbook>(() => {
    const d = initialDoc as { workbook?: Workbook } | null;
    return d?.workbook?.sheets?.length ? d.workbook : { sheets: [{ name: "Sheet1", cells: {} }] };
  });
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
  const undoStack = useRef<Workbook[]>([]);
  const redoStack = useRef<Workbook[]>([]);
  const [, forceUi] = useState(0);

  const sheet = wb.sheets[Math.min(active, wb.sheets.length - 1)];
  const evals = useMemo(() => evaluateSheetIn(wb, sheet.name), [wb, sheet.name]);
  const selRefs = useMemo(() => selections.flatMap((r) => [...rangeRefs(r)]), [selections]);
  const anchorRef = toA1(selection.c1, selection.r1);

  // ---- collab: per-sheet keys in a shared Y.Map; remote applies merge in ----
  const session = useCollabSession(item.id);
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
          if (i >= 0) next.sheets[i] = sh; else next.sheets.push(sh);
        }
      }
      return next;
    });
  };
  const mapSync = useMapSync(session, "sheets", applyRemoteRef);

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
    mutate((w) => fn(w.sheets[active]), true);
  }, [mutate, active]);
  mutateRef.current = mutateSheet;

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
    if (!mounted.current) { mounted.current = true; return; }
    pendingJson.current = { kind: "sheets", workbook: wb };
    if (mapSync) {
      const m = new Map<string, string>();
      for (const s of wb.sheets) m.set(s.name, JSON.stringify(s));
      m.set("$order", JSON.stringify(wb.sheets.map((s) => s.name)));
      mapSync.push(m);
    }
  }, [wb, mapSync]);

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
  const commitCell = useCallback((ref: string, raw: string) => {
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
      s.cells[ref] = { s: s.cells[ref]?.s, ...parseInput(raw) };
    });
  }, [mutateSheet, sheet, wb, toast]);

  const clearCells = useCallback((refs: string[]) => {
    mutateSheet((s) => refs.forEach((r) => { if (s.cells[r]) s.cells[r] = { s: s.cells[r].s }; }));
  }, [mutateSheet]);

  const pasteTsv = useCallback((anchor: Ref, tsv: string) => {
    const cells = tsvToCells(tsv, anchor);
    mutateSheet((s) => Object.assign(s.cells, cells));
    const rows = tsv.replace(/\r/g, "").split("\n");
    const maxC = Math.max(...rows.map((r) => r.split("\t").length));
    setSelection({ c1: anchor.col, r1: anchor.row, c2: anchor.col + maxC - 1, r2: anchor.row + rows.length - 1 });
  }, [mutateSheet]);

  const setStyle = useCallback((patch: CellStyle) => {
    mutateSheet((s) => selRefs.forEach((r) => {
      s.cells[r] = { ...s.cells[r], s: { ...s.cells[r]?.s, ...patch } };
    }));
  }, [mutateSheet, selRefs]);

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
  }, [mutateSheet, wb]);

  // sort selected rows by anchor column; formula refs pointing into the
  // sorted block are remapped to the rows' new positions (Excel semantics)
  const sortSel = useCallback((asc: boolean) => {
    mutateSheet((s) => {
      const ev = evaluateSheetIn(wb, s.name);
      const rows: number[] = [];
      for (let r = selection.r1; r <= selection.r2; r++) rows.push(r);
      const val = (r: number) => {
        const ref = toA1(selection.c1, r);
        const cell = s.cells[ref];
        const res = ev.get(ref);
        return cell?.f ? res?.value : cell?.v;
      };
      rows.sort((a, b) => {
        const va = val(a), vb = val(b);
        const na = Number(va), nb = Number(vb);
        const cmp = !isNaN(na) && !isNaN(nb) ? na - nb : String(va ?? "").localeCompare(String(vb ?? ""));
        return asc ? cmp : -cmp;
      });
      const rowMap = new Map<number, number>();
      rows.forEach((srcRow, i) => rowMap.set(srcRow, selection.r1 + i));
      const next: Record<string, (typeof s.cells)[string] | undefined> = {};
      rows.forEach((srcRow, i) => {
        for (let c = selection.c1; c <= selection.c2; c++) {
          next[toA1(c, selection.r1 + i)] = s.cells[toA1(c, srcRow)];
        }
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
    });
  }, [mutateSheet, selection, wb]);

  // insert / delete rows & cols (formulas incl. cross-sheet refs, merges,
  // cf, charts all shift)
  const insRows = useCallback(() => {
    mutate((w) => adjustForRowsCols(w.sheets[active], "row", selection.r1, Math.max(1, selection.r2 - selection.r1 + 1), w));
  }, [mutate, active, selection]);
  const delRows = useCallback(() => {
    mutate((w) => adjustForRowsCols(w.sheets[active], "row", selection.r1, -(selection.r2 - selection.r1 + 1), w));
  }, [mutate, active, selection]);
  const insCols = useCallback(() => {
    mutate((w) => adjustForRowsCols(w.sheets[active], "col", selection.c1, Math.max(1, selection.c2 - selection.c1 + 1), w));
  }, [mutate, active, selection]);
  const delCols = useCallback(() => {
    mutate((w) => adjustForRowsCols(w.sheets[active], "col", selection.c1, -(selection.c2 - selection.c1 + 1), w));
  }, [mutate, active, selection]);

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
  }, [mutate, mutateSheet, selection, active]);

  // merge / unmerge
  const mergeSel = useCallback(() => {
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
  }, [mutateSheet, selection, toast]);
  const unmergeSel = useCallback(() => {
    mutateSheet((s) => {
      s.merges = (s.merges ?? []).filter((m) =>
        !(m.c1 <= selection.c2 && m.c2 >= selection.c1 && m.r1 <= selection.r2 && m.r2 >= selection.r1));
    });
  }, [mutateSheet, selection]);

  // ---- sheets tabs ----
  const addSheet = () => {
    mutate((w) => {
      let n = w.sheets.length + 1;
      while (w.sheets.some((s) => s.name === `Sheet${n}`)) n++;
      w.sheets.push({ name: `Sheet${n}`, cells: {} });
    });
    setActive(wb.sheets.length);
  };
  const delSheet = (i: number) => {
    if (wb.sheets.length <= 1) return toast("Workbook needs at least one sheet");
    mutate((w) => { w.sheets.splice(i, 1); });
    setActive((a) => Math.min(a, wb.sheets.length - 2));
  };
  const dupSheet = (i: number) => {
    mutate((w) => {
      const copy = structuredClone(w.sheets[i]);
      copy.name = `${copy.name} copy`;
      w.sheets.splice(i + 1, 0, copy);
    });
    setActive(i + 1);
  };
  const hideSheet = (i: number) => {
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

  // ---- conditional formatting ----
  const addCF = (op: string, value: number, bg: string) => {
    mutateSheet((s) => {
      s.cf = [...(s.cf ?? []), { range: rangeToA1(selection), op: op as never, value, bg }];
    });
    setCfOpen(false);
    toast(`Rule added to ${rangeToA1(selection)}`);
  };

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
      mutate((w) => { w.sheets = imported.sheets; });
      setActive(0);
      toast(`Imported ${imported.sheets.length} sheet(s) from ${f.name}`);
    } catch {
      toast("Could not read that workbook");
    }
  };

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
    const buf = getCopyBuffer();
    if (!buf) return toast("Nothing copied yet — copy a range first");
    mutateSheet((s) => {
      pasteCells(s.cells, { col: selection.c1, row: selection.r1 }, buf, mode, op, evals);
    });
    setPasteSpec(false);
    toast("Pasted");
  }, [mutateSheet, selection, evals, toast]);

  // Ctrl+G → Go To (focus the name box); Ctrl+Alt+V / Ctrl+Shift+V → Paste Special
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
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

  return (
    <div className="editor-shell sheets-shell">
      <div className="editor-top">
        <button className="back" onClick={() => navigate(-1)} title="Back">←</button>
        <div className="app-ico sheets" style={{ width: 34, height: 34, borderRadius: 10, fontSize: 13 }}>S</div>
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
        <button className="btn-ghost btn-sm" onClick={() => setPanel(panel === "comments" ? "none" : "comments")}>
          Comments{comments.length ? ` (${comments.length})` : ""}
        </button>
        <button className="btn-ghost btn-sm" onClick={() => setPanel(panel === "versions" ? "none" : "versions")}>History</button>
        <button className="btn-ghost btn-sm" title="Kreatix AI" onClick={() => setPanel(panel === "ai" ? "none" : "ai")}>✨ AI</button>
        <button className="btn-ghost btn-sm" onClick={() => setSharing(true)}>Share</button>
        <button className="btn-primary btn-sm" onClick={() => void workbookToXLSX(wb, title)}>Export .xlsx</button>
      </div>

      {canEdit && (
        <div className="ribbon">
          <button className="rb" title="Undo" disabled={!undoStack.current.length} onClick={undo}>↶</button>
          <button className="rb" title="Redo" disabled={!redoStack.current.length} onClick={redo}>↷</button>
          <div className="rb-sep" />
          <select className="rb-sel" value={anchorStyle.font ?? "Inter"} title="Font family" style={{ width: 96 }}
            onChange={(e) => setStyle({ font: e.target.value === "Inter" ? undefined : e.target.value })}>
            {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <select className="rb-sel" value={String(anchorStyle.size ?? 12)} title="Font size" style={{ width: 52 }}
            onChange={(e) => setStyle({ size: Number(e.target.value) === 12 ? undefined : Number(e.target.value) })}>
            {SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
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
          <div className="rb-sep" />
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
          <div className="rb-sep" />
          {(["left", "center", "right"] as const).map((a) => (
            <button key={a} className={`rb ${anchorStyle.align === a ? "on" : ""}`} title={`Align ${a}`}
              onClick={() => setStyle({ align: a })}>
              {a === "left" ? "⇤" : a === "center" ? "≡" : "⇥"}
            </button>
          ))}
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
          <div className="rb-sep" />
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
          <button className={`rb ${painter ? "on" : ""}`} title="Format Painter — click to copy this cell's format, then drag over targets"
            onClick={() => setPainter(painter ? null : { s: { ...anchorStyle } })}>🖌</button>
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
          <div className="rb-sep" />
          <button className="rb" title="Freeze rows above" style={{ width: "auto", padding: "0 8px", fontSize: 11 }}
            onClick={() => mutateSheet((s) => { s.freeze = { rows: selection.r1, cols: s.freeze?.cols ?? 0 }; })}>
            ❄ {selection.r1 || "No"} rows
          </button>
          <button className="rb" title="Freeze columns left" style={{ width: "auto", padding: "0 8px", fontSize: 11 }}
            onClick={() => mutateSheet((s) => { s.freeze = { rows: s.freeze?.rows ?? 0, cols: selection.c1 }; })}>
            ❄ {selection.c1 || "No"} cols
          </button>
          <button className="rb" title="Conditional formatting" onClick={() => setCfOpen(true)}>◐</button>
          <button className="rb" title="Merge selection" onClick={mergeSel}>▦</button>
          <button className="rb" title="Unmerge" onClick={unmergeSel}>▢</button>
          <div className="rb-sep" />
          <button className="rb" title="Insert rows above" onClick={insRows}>R+</button>
          <button className="rb" title="Delete rows" onClick={delRows}>R−</button>
          <button className="rb" title="Insert columns left" onClick={insCols}>C+</button>
          <button className="rb" title="Delete columns" onClick={delCols}>C−</button>
          <button className="rb" title="Sort A→Z" onClick={() => sortSel(true)}>A↓</button>
          <button className="rb" title="Sort Z→A" onClick={() => sortSel(false)}>Z↑</button>
          <button className="rb" title="Data validation — lists, ranges, rules" onClick={() => setValDlg(true)}>✓⃞</button>
          <button className="rb" title="Paste Special — values/formats/formulas/transpose/operations (Ctrl+Alt+V)"
            onClick={() => getCopyBuffer() ? setPasteSpec(true) : toast("Nothing copied yet")}>⧉</button>
          <button className="rb" title="Name Manager — define named ranges" onClick={() => setNameMgr(true)}>📛</button>
          <button className={`rb ${audit === "pre" ? "on" : ""}`} title="Trace precedents" style={{ width: "auto", padding: "0 8px", fontSize: 11 }}
            onClick={() => setAudit(audit === "pre" ? null : "pre")}>⇠Pre</button>
          <button className={`rb ${audit === "dep" ? "on" : ""}`} title="Trace dependents" style={{ width: "auto", padding: "0 8px", fontSize: 11 }}
            onClick={() => setAudit(audit === "dep" ? null : "dep")}>Dep⇢</button>
          <button className="rb" title="Insert chart from selection" onClick={() => setChartOpen(true)}>📊</button>
          <div className="rb-sep" />
          <button className="rb" title="Add comment on cell" onClick={() => { setNewComment(true); setPanel("comments"); }}>💬</button>
          <button className="rb" title="Import CSV / XLSX" onClick={() => csvRef.current?.click()}>⇪</button>
          <button className="rb" title="Export CSV" onClick={exportCSV}>⇩</button>
          <input ref={csvRef} type="file" accept=".csv" hidden onChange={(e) => e.target.files?.[0] && onCsvImport(e.target.files[0])} />
          <input ref={xlsxRef} type="file" accept=".xlsx,.xls" hidden onChange={(e) => e.target.files?.[0] && onXlsxImport(e.target.files[0])} />
          <span style={{ marginLeft: "auto", fontSize: 10, color: "#A19A95" }}>{usedRangeA1(sheet.cells)}</span>
        </div>
      )}

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
        <Grid sheet={sheet} evals={evals} canEdit={canEdit} wb={wb}
          audit={auditRefs ? { refs: auditRefs, kind: audit! } : undefined}
          selections={selections} selection={selection} setSelection={selWithPaint}
          addSelection={addSelection} extendSelection={extWithPaint}
          invalid={invalidCells}
          noted={notedCells}
          onCellMenu={(ref, x, y) => setCellMenu({ ref, x, y })}
          listDrop={canEdit && activeList ? { ref: anchorRef, items: activeList } : undefined}
          onCommit={commitCell} onClear={clearCells} onPaste={pasteTsv} onFillHandle={fillHandle}
          onGeom={onGeom} onHeader={onHeader} />
        {(sheet.charts ?? []).map((c) => (
          <ChartCard key={c.id} spec={c} sheet={sheet} wb={wb}
            onMove={canEdit ? (id, x, y) => mutateSheet((s) => { const ch = s.charts?.find((k) => k.id === id); if (ch) { ch.x = x; ch.y = y; } }) : undefined}
            onRemove={canEdit ? (id) => mutateSheet((s) => { s.charts = s.charts?.filter((k) => k.id !== id); }) : undefined} />
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
              if (from === null || from === i) return;
              mutate((w) => { const [moved] = w.sheets.splice(from, 1); w.sheets.splice(i, 0, moved); });
              setActive(i);
            }}
            onClick={() => setActive(i)}
            onDoubleClick={() => canEdit && setRenamingTab(i)}
            onContextMenu={(e) => { e.preventDefault(); if (canEdit) setTabMenu({ i, x: e.clientX, y: e.clientY }); }}>
            {renamingTab === i ? (
              <input autoFocus defaultValue={s.name}
                onBlur={(e) => {
                  const nn = (e.target.value || s.name).trim();
                  if (nn !== s.name) mutate((w) => { renameSheetRefs(w, s.name, nn); w.sheets[i].name = nn; });
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
            onClick={(e) => setTabMenu({ i: -1, x: e.clientX, y: e.clientY })}>👁</button>
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
              <div style={{ padding: "6px 10px 2px", fontSize: 10, color: "#A19A95" }}>Tab color</div>
              <div style={{ display: "flex", gap: 6, padding: "0 10px 8px" }}>
                {["#F2782E", "#3578E5", "#1F9D66", "#D84B57", "#8E6BC8", "#E9B44C"].map((c) => (
                  <button key={c} onMouseDown={() => { mutate((w) => { w.sheets[tabMenu.i].tabColor = c; }); setTabMenu(null); }}
                    style={{ width: 16, height: 16, borderRadius: 4, background: c, border: "none", cursor: "pointer" }} />
                ))}
                <button title="No color" onMouseDown={() => { mutate((w) => { w.sheets[tabMenu.i].tabColor = undefined; }); setTabMenu(null); }}
                  style={{ width: 16, height: 16, border: "1px solid var(--line)", borderRadius: 4, background: "#fff", fontSize: 9 }}>✕</button>
              </div>
            </>
          ) : (
            <>
              <div style={{ padding: "6px 10px 2px", fontSize: 10, color: "#A19A95" }}>Hidden sheets</div>
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
      {cfOpen && <CfDialog selection={rangeToA1(selection)} onAdd={addCF} onClose={() => setCfOpen(false)} />}
      {pasteSpec && <PasteSpecialDialog onPick={pasteSpecial} onClose={() => setPasteSpec(false)} />}
      {cellMenu && (
        <div className="ctx-back" onMouseDown={() => setCellMenu(null)} onContextMenu={(e) => e.preventDefault()}>
          <div className="hmenu" style={{ left: cellMenu.x, top: cellMenu.y, position: "fixed" }}
            onMouseDown={(e) => e.stopPropagation()}>
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
        <FindDialog wb={wb} replace={findDlg.replace} canEdit={canEdit}
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
      {chartOpen && (
        <div className="dlg-back" onClick={() => setChartOpen(false)}>
          <div className="dlg" onClick={(e) => e.stopPropagation()}>
            <h3>Chart from {rangeToA1(selection)}</h3>
            <p style={{ fontSize: 12, color: "#8B8480" }}>First column = labels, other columns = series.</p>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              {(["bar", "line", "area", "pie"] as const).map((t) => (
                <button key={t} className="btn-ghost btn-sm" style={{ textTransform: "capitalize" }}
                  onClick={() => addChart(t)}>{t}</button>
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

function CfDialog({ selection, onAdd, onClose }: {
  selection: string;
  onAdd: (op: string, value: number, bg: string) => void;
  onClose: () => void;
}) {
  const [op, setOp] = useState(">");
  const [value, setValue] = useState("0");
  const [bg, setBg] = useState(CF_COLORS[0]);
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()}>
        <h3>Conditional format — {selection}</h3>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
          <span style={{ fontSize: 12 }}>Highlight cells</span>
          <select value={op} onChange={(e) => setOp(e.target.value)}
            style={{ height: 30, border: "1px solid var(--line)", borderRadius: 8, padding: "0 8px" }}>
            {[">", "<", ">=", "<=", "=", "!="].map((o) => <option key={o}>{o}</option>)}
          </select>
          <input value={value} onChange={(e) => setValue(e.target.value)} type="number"
            style={{ height: 30, width: 90, border: "1px solid var(--line)", borderRadius: 8, padding: "0 8px" }} />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          {CF_COLORS.map((c) => (
            <button key={c} onClick={() => setBg(c)}
              style={{ width: 28, height: 28, borderRadius: 8, background: c, border: bg === c ? "2px solid #171717" : "1px solid var(--line)" }} />
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={() => onAdd(op, Number(value) || 0, bg)}>Apply</button>
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
        <p style={{ fontSize: 12, color: "#8B8480", margin: "6px 0 0" }}>Paste</p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          {MODES.map(([m, label]) => (
            <label key={m} className={`ps-opt ${mode === m ? "on" : ""}`}>
              <input type="radio" name="ps-mode" checked={mode === m} onChange={() => setMode(m)} hidden />
              {label}
            </label>
          ))}
        </div>
        <p style={{ fontSize: 12, color: "#8B8480", margin: "14px 0 0" }}>Operation</p>
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

function FindDialog({ wb, replace, canEdit, onMutate, onJump, toast, onClose }: {
  wb: Workbook;
  replace: boolean;
  canEdit: boolean;
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
    onMutate((w) => {
      for (const s of w.sheets) {
        const refs = bySheet.get(s.name);
        if (!refs) continue;
        for (const ref of refs) {
          const cell = s.cells[ref];
          if (cell && replaceInCell(cell, q, rep, matchCase)) n++;
        }
      }
    });
    toast(n ? `Replaced ${n} cell${n > 1 ? "s" : ""}` : "Nothing replaced");
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
            {hits.length === 0 && <div style={{ padding: 12, fontSize: 12, color: "#8B8480" }}>No matches</div>}
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
                <span style={{ color: "#8B8480" }}>
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
            <p style={{ fontSize: 12, color: "#8B8480" }}>No named ranges yet. Names work in any formula — e.g. <code>=SUM(Sales)</code>.</p>
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
                  <span style={{ flex: 1, fontSize: 12, fontFamily: "monospace", color: "#6E6862" }}>{ref}</span>
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


