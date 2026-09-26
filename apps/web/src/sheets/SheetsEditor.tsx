import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Comment, DriveItem } from "@kreatix/shared";
import { api } from "../lib/api";
import { ShareDialog } from "../components/ShareDialog";
import { VersionsPanel } from "../components/VersionsPanel";
import { CommentsPanel } from "../components/CommentsPanel";
import { useToast } from "../pages/Home";
import type { Workbook, SheetData, Range, Ref, CellStyle, ChartSpec } from "./model";
import { toA1, rangeToA1, rangeRefs, parseInput, cellEditText, parseA1, shiftForFill, adjustForRowsCols, translateFormula } from "./model";
import { evaluateSheet } from "./engine";
import { formatValue, NUM_FORMATS } from "./format";
import { sheetToCSV, csvToSheet, workbookToXLSX, xlsxToWorkbook, tsvToCells, usedRangeA1 } from "./io";
import { Grid } from "./Grid";
import { ChartCard } from "./Chart";

type SaveState = "saved" | "saving" | "unsaved" | "error";

const CF_COLORS = ["#D4F5E2", "#FFE1DA", "#FFF3C4", "#DCE9FF"];

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
  const [panel, setPanel] = useState<"none" | "comments" | "versions">("none");
  const [sharing, setSharing] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState(false);
  const [cfOpen, setCfOpen] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const csvRef = useRef<HTMLInputElement>(null);
  const xlsxRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const pendingJson = useRef<unknown>(null);

  const [wb, setWb] = useState<Workbook>(() => {
    const d = initialDoc as { workbook?: Workbook } | null;
    return d?.workbook?.sheets?.length ? d.workbook : { sheets: [{ name: "Sheet1", cells: {} }] };
  });
  const [active, setActive] = useState(0);
  const [selection, setSelection] = useState<Range>({ c1: 0, r1: 0, c2: 0, r2: 0 });
  const [renamingTab, setRenamingTab] = useState<number | null>(null);
  const undoStack = useRef<Workbook[]>([]);
  const redoStack = useRef<Workbook[]>([]);
  const [, forceUi] = useState(0);

  const sheet = wb.sheets[Math.min(active, wb.sheets.length - 1)];
  const evals = useMemo(() => evaluateSheet(sheet.cells), [sheet.cells]);
  const selRefs = useMemo(() => [...rangeRefs(selection)], [selection]);
  const anchorRef = toA1(selection.c1, selection.r1);
  const anchorCell = sheet.cells[anchorRef];
  const anchorRes = evals.get(anchorRef);
  const anchorStyle = anchorCell?.s ?? {};

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

  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    pendingJson.current = { kind: "sheets", workbook: wb };
  }, [wb]);

  const flushSave = useCallback(async () => {
    if (!pendingJson.current) return;
    const payload = pendingJson.current;
    pendingJson.current = null;
    setSaveState("saving");
    try {
      await api.put(`/api/files/${item.id}/content`, { content: payload });
      setSaveState("saved");
    } catch {
      setSaveState("error");
      toast("Could not save — will retry on next edit");
    }
  }, [item.id, toast]);

  useEffect(() => {
    const flush = () => { if (saveTimer.current) { clearTimeout(saveTimer.current); flushSave(); } };
    window.addEventListener("beforeunload", flush);
    return () => { window.removeEventListener("beforeunload", flush); flush(); };
  }, [flushSave]);

  // ---- cell ops ----
  const commitCell = useCallback((ref: string, raw: string) => {
    mutateSheet((s) => {
      if (raw.trim() === "") {
        const style = s.cells[ref]?.s;
        if (style) s.cells[ref] = { s: style }; else delete s.cells[ref];
        return;
      }
      s.cells[ref] = { s: s.cells[ref]?.s, ...parseInput(raw) };
    });
  }, [mutateSheet]);

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

  const toggleStyle = useCallback((key: "b" | "i" | "u") => {
    setStyle({ [key]: !anchorStyle[key] });
  }, [setStyle, anchorStyle]);

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
      for (const ref of rangeRefs(dst)) {
        const p = parseA1(ref)!;
        if (p.col >= src.c1 && p.col <= src.c2 && p.row >= src.r1 && p.row <= src.r2) continue;
        const sr = toA1(src.c1 + ((p.col - src.c1) % sw + sw) % sw, src.r1 + ((p.row - src.r1) % sh + sh) % sh);
        const srcCell = s.cells[sr];
        if (srcCell) {
          const copy = structuredClone(srcCell);
          if (copy.f) copy.f = shiftForFill(copy.f, p.col - (parseA1(sr)!.col), p.row - (parseA1(sr)!.row));
          s.cells[ref] = copy;
        }
      }
    });
  }, [mutateSheet]);

  // sort selected rows by anchor column; formula refs pointing into the
  // sorted block are remapped to the rows' new positions (Excel semantics)
  const sortSel = useCallback((asc: boolean) => {
    mutateSheet((s) => {
      const ev = evaluateSheet(s.cells);
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
  }, [mutateSheet, selection]);

  // insert / delete rows & cols (formulas, merges, cf, charts all shift)
  const insRows = useCallback(() => {
    mutateSheet((s) => adjustForRowsCols(s, "row", selection.r1, Math.max(1, selection.r2 - selection.r1 + 1)));
  }, [mutateSheet, selection]);
  const delRows = useCallback(() => {
    mutateSheet((s) => adjustForRowsCols(s, "row", selection.r1, -(selection.r2 - selection.r1 + 1)));
  }, [mutateSheet, selection]);
  const insCols = useCallback(() => {
    mutateSheet((s) => adjustForRowsCols(s, "col", selection.c1, Math.max(1, selection.c2 - selection.c1 + 1)));
  }, [mutateSheet, selection]);
  const delCols = useCallback(() => {
    mutateSheet((s) => adjustForRowsCols(s, "col", selection.c1, -(selection.c2 - selection.c1 + 1)));
  }, [mutateSheet, selection]);

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
    const blob = new Blob([sheetToCSV(sheet)], { type: "text/csv" });
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
        <div className="spacer" />
        <button className="btn-ghost btn-sm" onClick={() => setPanel(panel === "comments" ? "none" : "comments")}>
          Comments{comments.length ? ` (${comments.length})` : ""}
        </button>
        <button className="btn-ghost btn-sm" onClick={() => setPanel(panel === "versions" ? "none" : "versions")}>History</button>
        <button className="btn-ghost btn-sm" onClick={() => setSharing(true)}>Share</button>
        <button className="btn-primary btn-sm" onClick={() => void workbookToXLSX(wb, title)}>Export .xlsx</button>
      </div>

      {canEdit && (
        <div className="ribbon">
          <button className="rb" title="Undo" disabled={!undoStack.current.length} onClick={undo}>↶</button>
          <button className="rb" title="Redo" disabled={!redoStack.current.length} onClick={redo}>↷</button>
          <div className="rb-sep" />
          <select className="rb-sel" value={anchorStyle.fmt ?? "auto"} title="Number format"
            onChange={(e) => setStyle({ fmt: e.target.value === "auto" ? undefined : e.target.value })}>
            {NUM_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <div className="rb-sep" />
          <button className={`rb ${anchorStyle.b ? "on" : ""}`} title="Bold" onClick={() => toggleStyle("b")}><b>B</b></button>
          <button className={`rb ${anchorStyle.i ? "on" : ""}`} title="Italic" onClick={() => toggleStyle("i")}><i>I</i></button>
          <button className={`rb ${anchorStyle.u ? "on" : ""}`} title="Underline" onClick={() => toggleStyle("u")}><u>U</u></button>
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
        <div className="name-box">{anchorRef}{selection.c2 - selection.c1 || selection.r2 - selection.r1 ? ` : ${rangeToA1(selection)}` : ""}</div>
        <span className="fx">fx</span>
        <input className="fx-input" disabled={!canEdit}
          key={anchorRef + (anchorCell ? "1" : "0")}
          defaultValue={cellEditText(anchorCell)}
          placeholder={canEdit ? "Value or =formula" : ""}
          onKeyDown={(e) => {
            if (e.key === "Enter") { commitCell(anchorRef, (e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur(); }
            else if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
          onBlur={(e) => e.target.value !== cellEditText(anchorCell) && commitCell(anchorRef, e.target.value)} />
        <span className="fx-val">{anchorCell?.f ? `= ${anchorRes?.error ?? formatValue(anchorRes?.value, anchorStyle.fmt)}` : ""}</span>
      </div>

      <div className="sheet-workspace" style={{ marginRight: panel !== "none" ? 330 : 0 }}>
        <Grid sheet={sheet} evals={evals} canEdit={canEdit}
          selection={selection} setSelection={setSelection}
          onCommit={commitCell} onClear={clearCells} onPaste={pasteTsv} onFillHandle={fillHandle} />
        {(sheet.charts ?? []).map((c) => (
          <ChartCard key={c.id} spec={c} sheet={sheet}
            onMove={canEdit ? (id, x, y) => mutateSheet((s) => { const ch = s.charts?.find((k) => k.id === id); if (ch) { ch.x = x; ch.y = y; } }) : undefined}
            onRemove={canEdit ? (id) => mutateSheet((s) => { s.charts = s.charts?.filter((k) => k.id !== id); }) : undefined} />
        ))}
      </div>

      {/* sheet tabs */}
      <div className="sheet-tabs" style={{ marginRight: panel !== "none" ? 330 : 0 }}>
        {canEdit && <button className="tab-add" title="Add sheet" onClick={addSheet}>＋</button>}
        {wb.sheets.map((s, i) => (
          <div key={i} className={`sheet-tab ${i === active ? "active" : ""}`}
            onClick={() => setActive(i)}
            onDoubleClick={() => canEdit && setRenamingTab(i)}>
            {renamingTab === i ? (
              <input autoFocus defaultValue={s.name}
                onBlur={(e) => { mutate((w) => { w.sheets[i].name = e.target.value || s.name; }); setRenamingTab(null); }}
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
      </div>

      {/* conditional format dialog */}
      {cfOpen && <CfDialog selection={rangeToA1(selection)} onAdd={addCF} onClose={() => setCfOpen(false)} />}
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
      {sharing && <ShareDialog item={item} onClose={() => setSharing(false)} toast={toast} />}
      {msg && <div className="toast">{msg}</div>}
    </div>
  );
}

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


