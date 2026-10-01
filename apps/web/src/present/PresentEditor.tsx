import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { Comment, DriveItem } from "@kreatix/shared";
import { api } from "../lib/api";
import { saveContent } from "../lib/drafts";
import { useCollabSession, useMapSync } from "../collab/useCollab";
import { PresenceBar } from "../collab/PresenceBar";
import { AiPanel, type AiOp } from "../ai/AiPanel";
import { writeKx, readKx } from "../lib/clipboard";
import { AppIcon } from "../components/AppIcon";
import { RibbonTabs } from "../components/RibbonTabs";
import { createDoc } from "../lib/create";
import { openLocalFile } from "../lib/offline/openLocal";
import { ShareDialog } from "../components/ShareDialog";
import { VersionsPanel } from "../components/VersionsPanel";
import { CommentsPanel } from "../components/CommentsPanel";
import { useToast } from "../pages/Home";
import type { Deck, Slide, SlideObject, Theme, TransitionType, TransitionDir } from "./model";
import { THEMES, LAYOUTS, themeOf, newId, applyLayout, blankSlide, SLIDE_W, SLIDE_H, chartSeries, anchorPoint, masterObjects, layoutObjects, deckSize, TRANSITION_DIRS, animKind } from "./model";
import { SlideCanvas, SHAPE_MENU, type ObjPatch } from "./SlideCanvas";
import { Presenter } from "./Presenter";
import { exportPptx } from "./export";
import { useIsMobile } from "../lib/mobile";
import { exportVideo } from "./video";
import { importPptx, importOdp } from "./import";

type SaveState = "saved" | "saving" | "unsaved" | "error";

export function PresentEditor({ item, initialDoc, sourceFile, permission }: {
  item: DriveItem;
  initialDoc: unknown;
  /** Native binary upload (pptx/odp) — auto-imported on mount. */
  sourceFile?: File | null;
  permission: string;
}) {
  const navigate = useNavigate();
  const canEdit = permission === "owner" || permission === "editor";
  const { msg, toast } = useToast();
  const [title, setTitle] = useState(item.name);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [panel, setPanel] = useState<"none" | "comments" | "versions" | "objects" | "ai" | "anim">("none");
  const [sharing, setSharing] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState(false);
  const [presenting, setPresenting] = useState<"none" | "present" | "presenter">("none");
  const [printing, setPrinting] = useState(false);
  const [exporting, setExporting] = useState(false); // P6.3 — video export in progress
  const [editingObj, setEditingObj] = useState<string | null>(null); // P1.1 — text object in run-editing mode
  const [cropId, setCropId] = useState<string | null>(null); // P1.6 — image in crop mode
  const [paintArmed, setPaintArmed] = useState(false); // P1.8 — format painter armed
  const fmtCopy = useRef<Partial<SlideObject> | null>(null);
  // P2.1 — "off" | "master" | `layout:${key}` (live-linked layout editing)
  const [masterView, setMasterView] = useState<string>("off");
  const [bgMenu, setBgMenu] = useState(false); // P2.5 — background panel
  const [railView, setRailView] = useState<"slides" | "outline" | "sorter">("slides"); // P4.1/P4.2
  const [sorterSel, setSorterSel] = useState<Set<number>>(new Set()); // P4.2 — sorter multi-select
  const [renameId, setRenameId] = useState<string | null>(null); // P7 — object rename in selection pane
  const [presStart, setPresStart] = useState<number | null>(null); // P7 — F5 vs Shift+F5
  const dragSlide = useRef<number | null>(null); // P4.2 — sorter drag source
  const [grad, setGrad] = useState({ c1: "#FFFFFF", c2: "#F2782E", angle: 135 });
  const bgImageRef = useRef<HTMLInputElement>(null);
  const mediaRef = useRef<HTMLInputElement>(null);
  const [chartDlg, setChartDlg] = useState<{ id: string | null } | null>(null);
  const [shapeMenu, setShapeMenu] = useState(false);
  const [tableDlg, setTableDlg] = useState<{ id: string | null } | null>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const pendingJson = useRef<unknown>(null);
  const canvasWrap = useRef<HTMLDivElement>(null);

  const [deck, setDeck] = useState<Deck>(() => {
    const d = initialDoc as { deck?: Deck } | null;
    return d?.deck?.slides?.length ? d.deck : { theme: "kreatix", slides: [blankSlide(THEMES[0])] };
  });
  const [slideIdx, setSlideIdx] = useState(0);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(0.6);
  const undoStack = useRef<Deck[]>([]);
  const redoStack = useRef<Deck[]>([]);
  const dragBase = useRef<Deck | null>(null);
  const lastAction = useRef<string | null>(null);
  const pptxRef = useRef<HTMLInputElement>(null);

  const theme = themeOf(deck);
  const dims = deckSize(deck);
  const slide = deck.slides[Math.min(slideIdx, deck.slides.length - 1)];
  // P2.2 — contiguous section spans for the rail
  const railSections: { name: string; headId: string; idxs: number[] }[] = [];
  const railPreface: number[] = [];
  deck.slides.forEach((s, i) => {
    if (s.sectionStart) railSections.push({ name: s.sectionStart, headId: s.id, idxs: [i] });
    else if (railSections.length) railSections[railSections.length - 1].idxs.push(i);
    else railPreface.push(i);
  });
  const [collapsedSecs, setCollapsedSecs] = useState<Set<string>>(new Set());
  // P2.1 — what the main canvas edits: the slide, the deck master, or a custom layout
  const editSlide: Slide = masterView === "master" ? { id: "__master", objects: deck.master ?? [] }
    : masterView.startsWith("layout:") ? { id: masterView.slice(7), objects: deck.layouts?.[masterView.slice(7)] ?? [] }
    : slide;
  const underObjs = (s: Slide) => [...masterObjects(deck), ...layoutObjects(deck, s)];
  const selObjs = editSlide.objects.filter((o) => selection.has(o.id));
  const firstSel = selObjs[0];

  // ---- collab: per-slide keys + deck meta in a shared Y.Map ----
  const session = useCollabSession(item.id);
  const applyRemoteRef = useRef<(changed: Map<string, string | null>) => void>(() => {});
  applyRemoteRef.current = (changed) => {
    setDeck((prev) => {
      const next = structuredClone(prev);
      for (const [k, v] of changed) {
        if (k === "$meta") {
          if (v) {
            const meta = JSON.parse(v) as { theme?: string; customTheme?: Deck["customTheme"]; order: string[] };
            next.theme = meta.theme; next.customTheme = meta.customTheme;
            next.slides.sort((a, b) => meta.order.indexOf(a.id) - meta.order.indexOf(b.id));
          }
        } else if (v == null) {
          const i = next.slides.findIndex((s) => s.id === k);
          if (i >= 0 && next.slides.length > 1) next.slides.splice(i, 1);
        } else {
          const s = JSON.parse(v) as Slide;
          const i = next.slides.findIndex((x) => x.id === k);
          if (i >= 0) next.slides[i] = s; else next.slides.push(s);
        }
      }
      return next;
    });
  };
  const mapSync = useMapSync(session, "present", applyRemoteRef);

  // presence: which slide we're on
  useEffect(() => {
    session?.setLocal({ where: { label: `Slide ${slideIdx + 1}` } });
  }, [session, slideIdx]);

  // ---- persistence ----
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    pendingJson.current = { kind: "present", deck };
    if (mapSync) {
      const m = new Map<string, string>();
      for (const s of deck.slides) m.set(s.id, JSON.stringify(s));
      m.set("$meta", JSON.stringify({ theme: deck.theme, customTheme: deck.customTheme, order: deck.slides.map((s) => s.id) }));
      mapSync.push(m);
    }
  }, [deck, mapSync]);

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

  const scheduleSave = () => {
    setSaveState("unsaved");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, 1200);
  };

  const mutate = useCallback((fn: (d: Deck) => void, actionKey?: string) => {
    setDeck((prev) => {
      const next = structuredClone(prev);
      fn(next);
      if (!actionKey || lastAction.current !== actionKey) {
        undoStack.current.push(prev);
        if (undoStack.current.length > 60) undoStack.current.shift();
        lastAction.current = actionKey ?? null;
      }
      redoStack.current = [];
      return next;
    });
    scheduleSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mutateSlide = useCallback((fn: (s: Slide) => void, actionKey?: string) => {
    mutate((d) => {
      if (masterView === "master") {
        const s: Slide = { id: "__master", objects: (d.master ??= []) };
        fn(s); d.master = s.objects;
      } else if (masterView.startsWith("layout:")) {
        const key = masterView.slice(7);
        d.layouts ??= {};
        const s: Slide = { id: key, objects: (d.layouts[key] ??= []) };
        fn(s); d.layouts[key] = s.objects;
      } else fn(d.slides[slideIdx]);
    }, actionKey);
  }, [mutate, slideIdx, masterView]);

  // ---- AI ops (tool-constrained; routed through mutate → undo/autosave/collab) ----
  const aiSerialize = useCallback(() => deck.slides.map((s, i) =>
    `Slide ${i + 1}${s.layout ? ` [${s.layout}]` : ""}:\n` +
    s.objects.map((o, oi) => `  [${oi}] ${o.type}${o.html ? `: ${o.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 80)}` : ""}`).join("\n") +
    (s.notes ? `\n  notes: ${s.notes.slice(0, 120)}` : ""),
  ).join("\n").slice(0, 24000), [deck]);

  const aiApplyOps = useCallback((ops: AiOp[]) => {
    mutate((d) => {
      for (const o of ops) {
        const idx = typeof o.slide === "number" ? o.slide : -1;
        if (o.op === "update_slide" && d.slides[idx]) {
          if (o.notes !== undefined) d.slides[idx].notes = String(o.notes);
          if (o.bg !== undefined) d.slides[idx].bg = String(o.bg);
        } else if (o.op === "add_slide") {
          const s = blankSlide(themeOf(d));
          d.slides.push(o.layout ? applyLayout(s, String(o.layout), themeOf(d)) : s);
        } else if (o.op === "add_text" && d.slides[idx]) {
          const maxZ = Math.max(0, ...d.slides[idx].objects.map((x) => x.z));
          d.slides[idx].objects.push({
            id: newId(), type: "text", x: Number(o.x), y: Number(o.y), w: Number(o.w), h: Number(o.h),
            z: maxZ + 1, html: String(o.html), fontSize: o.fontSize as number | undefined,
            color: o.color as string | undefined, align: o.align as SlideObject["align"],
          });
        } else if (o.op === "add_shape" && d.slides[idx]) {
          const maxZ = Math.max(0, ...d.slides[idx].objects.map((x) => x.z));
          d.slides[idx].objects.push({
            id: newId(), type: "shape", shape: o.shape as SlideObject["shape"],
            x: Number(o.x), y: Number(o.y), w: Number(o.w), h: Number(o.h), z: maxZ + 1,
            fill: (o.fill as string) ?? themeOf(d).accent, stroke: (o.stroke as string) ?? "none",
            html: o.html as string | undefined,
          });
        } else if (o.op === "add_table" && d.slides[idx]) {
          const maxZ = Math.max(0, ...d.slides[idx].objects.map((x) => x.z));
          d.slides[idx].objects.push({
            id: newId(), type: "table", table: o.rows as string[][],
            x: Number(o.x), y: Number(o.y), w: Number(o.w), h: Number(o.h), z: maxZ + 1,
            fontSize: 15, color: themeOf(d).ink,
          });
        } else if (o.op === "add_chart" && d.slides[idx]) {
          const maxZ = Math.max(0, ...d.slides[idx].objects.map((x) => x.z));
          d.slides[idx].objects.push({
            id: newId(), type: "chart",
            chart: { type: o.type as "bar" | "line" | "pie", labels: o.labels as string[], series: o.series as { name: string; values: number[] }[], title: o.title as string | undefined },
            x: Number(o.x), y: Number(o.y), w: Number(o.w), h: Number(o.h), z: maxZ + 1,
          });
        } else if (o.op === "delete_slide" && d.slides.length > 1 && d.slides[idx]) {
          d.slides.splice(idx, 1);
        } else if (o.op === "edit_object_text" && d.slides[idx]) {
          const obj = d.slides[idx].objects[o.index as number];
          if (obj && obj.type === "text") obj.html = String(o.html);
        } else if (o.op === "delete_object" && d.slides[idx]) {
          const i = o.index as number;
          if (i >= 0 && i < d.slides[idx].objects.length) d.slides[idx].objects.splice(i, 1);
        }
      }
    });
  }, [mutate]);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    lastAction.current = null;
    redoStack.current.push(deck);
    setDeck(prev); scheduleSave();
  }, [deck]); // eslint-disable-line react-hooks/exhaustive-deps

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    lastAction.current = null;
    undoStack.current.push(deck);
    setDeck(next); scheduleSave();
  }, [deck]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- object ops ----
  const onPatch = useCallback((patches: ObjPatch[], commit: boolean) => {
    if (!patches.length && commit) {
      // drag ended — push pre-drag snapshot as one undo step
      if (dragBase.current) {
        lastAction.current = null;
        undoStack.current.push(dragBase.current);
        if (undoStack.current.length > 60) undoStack.current.shift();
        redoStack.current = [];
        dragBase.current = null;
        scheduleSave();
      }
      return;
    }
    if (!dragBase.current) dragBase.current = deck;
    setDeck((prev) => {
      const next = structuredClone(prev);
      const s = next.slides[slideIdx];
      for (const p of patches) {
        const o = s.objects.find((x) => x.id === p.id);
        if (o) Object.assign(o, p.patch);
      }
      return next;
    });
  }, [deck, slideIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  // unified clipboard — objects paste into the current slide (or another deck)
  const pasteObjects = (objs: SlideObject[]) => {
    mutate((d) => {
      const s = d.slides[slideIdx];
      let z = Math.max(0, ...s.objects.map((o) => o.z)) + 1;
      const pasted: string[] = [];
      // keep groups coherent: remap group ids
      const groupMap = new Map<string, string>();
      for (const src of objs) {
        const o = structuredClone(src);
        o.id = newId();
        o.x += 16; o.y += 16;
        o.z = z++;
        if (o.groupId) {
          if (!groupMap.has(o.groupId)) groupMap.set(o.groupId, newId());
          o.groupId = groupMap.get(o.groupId);
        }
        s.objects.push(o);
        pasted.push(o.id);
      }
      setSelection(new Set(pasted));
    });
    toast(`Pasted ${objs.length} object${objs.length === 1 ? "" : "s"}`);
  };

  const addObject = (obj: Omit<SlideObject, "id" | "z">) => {
    const id = newId();
    mutateSlide((s) => s.objects.push({ ...obj, id, z: Math.max(-1, ...s.objects.map((o) => o.z)) + 1 }));
    setSelection(new Set([id]));
    return id;
  };

  const delSelected = (ids?: Set<string>) => {
    const del = ids ?? selection;
    mutateSlide((s) => { s.objects = s.objects.filter((o) => !del.has(o.id)); });
    setSelection(new Set());
  };

  const patchSel = (patch: Partial<SlideObject>) => {
    mutateSlide((s) => s.objects.forEach((o) => { if (selection.has(o.id)) Object.assign(o, patch); }));
  };

  // ---- P1.8 format painter — copy appearance fields, apply to next click
  const FMT_KEYS = ["fill", "stroke", "strokeW", "fontSize", "color", "bold", "italic",
    "align", "fontFamily", "imgOpacity", "imgFilter", "imgFlipH", "imgFlipV"] as const;
  const copyFmt = () => {
    if (!firstSel) return;
    const out: Record<string, unknown> = {};
    for (const k of FMT_KEYS) if (firstSel[k] !== undefined) out[k] = firstSel[k];
    fmtCopy.current = out;
    setPaintArmed(true);
  };
  /** Selection entry point — armed painter applies the copied format instead */
  const handleSelect = (ids: Set<string>, additive: boolean) => {
    if (paintArmed && fmtCopy.current && ids.size) {
      const fmt = fmtCopy.current;
      mutateSlide((s) => s.objects.forEach((o) => { if (ids.has(o.id)) Object.assign(o, fmt); }));
      setPaintArmed(false);
      return;
    }
    void additive;
    setSelection(ids);
  };

  const setZ = (mode: "front" | "back" | "up" | "down", ids?: Set<string>) => {
    const pick = ids ?? selection;
    mutateSlide((s) => {
      const sel = s.objects.filter((o) => pick.has(o.id));
      if (!sel.length) return;
      const zs = s.objects.map((o) => o.z).sort((a, b) => a - b);
      if (mode === "front") sel.forEach((o) => { o.z = zs[zs.length - 1] + 1; });
      else if (mode === "back") sel.forEach((o) => { o.z = zs[0] - 1; });
      else if (mode === "up") sel.forEach((o) => {
        const above = s.objects.filter((x) => x.z > o.z).sort((a, b) => a.z - b.z)[0];
        if (above) { const t = o.z; o.z = above.z; above.z = t; }
      });
      else sel.forEach((o) => {
        const below = s.objects.filter((x) => x.z < o.z).sort((a, b) => b.z - a.z)[0];
        if (below) { const t = o.z; o.z = below.z; below.z = t; }
      });
    });
  };

  const alignSel = (mode: "left" | "center" | "right" | "top" | "middle" | "bottom") => {
    if (selObjs.length < 2) return;
    const xs = selObjs.map((o) => o.x), xe = selObjs.map((o) => o.x + o.w);
    const ys = selObjs.map((o) => o.y), ye = selObjs.map((o) => o.y + o.h);
    const minX = Math.min(...xs), maxX = Math.max(...xe);
    const minY = Math.min(...ys), maxY = Math.max(...ye);
    mutateSlide((s) => s.objects.forEach((o) => {
      if (!selection.has(o.id)) return;
      if (mode === "left") o.x = minX;
      else if (mode === "right") o.x = maxX - o.w;
      else if (mode === "center") o.x = Math.round((minX + maxX - o.w) / 2);
      else if (mode === "top") o.y = minY;
      else if (mode === "bottom") o.y = maxY - o.h;
      else o.y = Math.round((minY + maxY - o.h) / 2);
    }));
  };

  const distributeSel = (axis: "h" | "v") => {
    if (selObjs.length < 3) return;
    mutateSlide((s) => {
      const sel = s.objects.filter((o) => selection.has(o.id));
      sel.sort((a, b) => (axis === "h" ? a.x - b.x : a.y - b.y));
      const first = sel[0], last = sel[sel.length - 1];
      const total = axis === "h" ? last.x - first.x : last.y - first.y;
      const span = sel.reduce((a, o) => a + (axis === "h" ? o.w : o.h), 0);
      const space = (total + (axis === "h" ? last.w : last.h) - span) / (sel.length - 1);
      let pos = axis === "h" ? first.x : first.y;
      sel.forEach((o) => {
        if (axis === "h") { o.x = Math.round(pos); pos += o.w + space; }
        else { o.y = Math.round(pos); pos += o.h + space; }
      });
    });
  };

  const groupSel = () => {
    if (selObjs.length < 2) return;
    const gid = newId();
    patchSel({ groupId: gid });
  };
  const ungroupSel = () => patchSel({ groupId: undefined });

  const onTextCommit = (id: string, html: string) => {
    mutateSlide((s) => { const o = s.objects.find((x) => x.id === id); if (o) o.html = html; });
  };

  const onTableCommit = (id: string, rows: string[][], meta?: SlideObject["tableMeta"]) => {
    mutateSlide((s) => { const o = s.objects.find((x) => x.id === id); if (o) { o.table = rows; if (meta !== undefined) o.tableMeta = meta; } });
  };

  const onObjDblClick = (o: SlideObject) => {
    if (o.type === "chart") setChartDlg({ id: o.id });
  };

  const onImportPptx = async (f: File) => {
    try {
      const d = /\.odp$/i.test(f.name) ? await importOdp(f) : await importPptx(f);
      // P6.2 — import now carries slide size, master, layouts, transitions, anims
      mutate((deck) => {
        // clear import-owned fields that may be absent this time
        for (const k of ["theme", "customTheme", "slideW", "slideH", "master", "layouts"] as const) delete deck[k];
        Object.assign(deck, d);
      });
      setSlideIdx(0);
      setSelection(new Set());
      toast(`Imported ${d.slides.length} slide${d.slides.length === 1 ? "" : "s"} from ${f.name}`);
    } catch {
      toast(`Could not read ${f.name}`);
    }
  };
  // Native-binary item opened from Drive/desktop — import once so a
  // double-clicked .pptx opens as slides, not a blank deck.
  const autoImported = useRef(false);
  useEffect(() => {
    if (!sourceFile || autoImported.current) return;
    autoImported.current = true;
    void onImportPptx(sourceFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceFile]);

  const setTransition = (type: TransitionType, dir?: string) => {
    mutateSlide((s) => {
      if (type === "none") { s.transition = undefined; return; }
      const dirs = TRANSITION_DIRS[type];
      const d = (dir ?? s.transition?.dir) as TransitionDir | undefined;
      s.transition = { type, duration: s.transition?.duration ?? 500, dir: dirs?.includes(d as TransitionDir) ? d : dirs?.[0] };
    });
  };

  // P3.3 — patch a single object's anim (pane edits) or set type on selection
  const patchAnim = (id: string, patch: Partial<NonNullable<SlideObject["anim"]>>) =>
    mutateSlide((s) => { const o = s.objects.find((x) => x.id === id); if (o?.anim) Object.assign(o.anim, patch); });
  const moveAnim = (id: string, dir: -1 | 1) =>
    mutateSlide((s) => {
      const anims = s.objects.filter((o) => o.anim).sort((a, b) => a.anim!.order - b.anim!.order);
      const k = anims.findIndex((o) => o.id === id);
      const j = k + dir;
      if (k < 0 || j < 0 || j >= anims.length) return;
      const t = anims[k].anim!.order; anims[k].anim!.order = anims[j].anim!.order; anims[j].anim!.order = t;
    });
  const setAnim = (type: string) => {
    mutateSlide((s) => s.objects.forEach((o) => {
      if (!selection.has(o.id)) return;
      if (!type) o.anim = undefined;
      else {
        const maxOrder = Math.max(0, ...s.objects.map((x) => x.anim?.order ?? 0));
        o.anim = {
          ...(o.anim ?? { order: maxOrder + 1 }),
          type: type as SlideObject["anim"] extends { type: infer T } ? T : never,
          // P3.2 — motion paths default to a rightward destination
          motion: type === "path" ? (o.anim?.motion ?? { dx: 160, dy: 0 }) : undefined,
        } as SlideObject["anim"];
      }
    }));
  };

  const objName = (o: SlideObject, i: number) =>
    o.type === "text" ? `Text ${i + 1}` : o.type === "shape" ? `${o.shape ?? "shape"} ${i + 1}`
      : `${o.type} ${i + 1}`;

  // ---- P1.1/P1.2 run-level text commands — act on the focused editable div.
  // Buttons must not steal focus (onMouseDown preventDefault) so the text
  // selection survives; the div's onBlur commits innerHTML to the model.
  const runCmd = (cmd: string, arg?: string) => {
    const el = document.querySelector<HTMLElement>(`.s-text.editing[data-oid="${editingObj}"]`);
    if (!el) return;
    el.focus();
    document.execCommand(cmd, false, arg);
  };
  /** Wrap the current selection in a styled span (px font-size / font-family
   *  don't map onto execCommand's legacy args). */
  const runSpan = (style: string) => {
    const el = document.querySelector<HTMLElement>(`.s-text.editing[data-oid="${editingObj}"]`);
    const sel = window.getSelection();
    if (!el || !sel || sel.isCollapsed || !sel.rangeCount) return;
    el.focus();
    const range = sel.getRangeAt(0);
    const span = document.createElement("span");
    span.setAttribute("style", style);
    try { range.surroundContents(span); }
    catch { const frag = range.extractContents(); span.appendChild(frag); range.insertNode(span); }
  };
  const RunBtn = ({ cmd, arg, title, children }: { cmd: string; arg?: string; title: string; children: ReactNode }) => (
    <button className="rb" title={title} onMouseDown={(e) => e.preventDefault()} onClick={() => runCmd(cmd, arg)}>{children}</button>
  );

  // ---- insert objects ----
  const insertText = () => addObject({ type: "text", x: 120, y: 120, w: 480, h: 60, html: "Double-click to edit", fontSize: 24, color: theme.ink });
  const insertShape = (shape: string) => addObject({ type: "shape", shape: shape as SlideObject["shape"], x: 200, y: 160, w: 240, h: 160, fill: theme.accent, stroke: "none" });
  const insertLine = () => addObject({ type: "line", x: 200, y: 240, w: 320, h: 40, x2: 320, y2: 0, stroke: theme.ink, strokeW: 2 });
  // P1.4 — connector: attaches to the two selected objects' facing anchors,
  // or drops a free straight connector at center when <2 selected
  const insertConnector = (kind: "straight" | "elbow" | "curve") => {
    const targets = selObjs.filter((o) => o.type !== "connector");
    if (targets.length === 2) {
      const [a, b] = targets;
      // pick facing sides from relative centers
      const acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
      const horiz = Math.abs(bcx - acx) >= Math.abs(bcy - acy);
      const sideA = horiz ? (bcx > acx ? "r" : "l") : (bcy > acy ? "b" : "t");
      const sideB = horiz ? (bcx > acx ? "l" : "r") : (bcy > acy ? "t" : "b");
      const p1 = anchorPoint(a, sideA), p2 = anchorPoint(b, sideB);
      const bb = { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y) };
      addObject({ type: "connector", ...bb, stroke: theme.ink, strokeW: 2,
        conn: { kind, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, from: { id: a.id, side: sideA }, to: { id: b.id, side: sideB } } });
    } else {
      addObject({ type: "connector", x: 340, y: 250, w: 280, h: 40, stroke: theme.ink, strokeW: 2,
        conn: { kind, x1: 340, y1: 270, x2: 620, y2: 270 } });
    }
  };
  const insertImage = async (f: File) => {
    const src = await new Promise<string>((res) => {
      const r = new FileReader(); r.onload = () => res(r.result as string); r.readAsDataURL(f);
    });
    addObject({ type: "image", src, x: 160, y: 100, w: 480, h: 320 });
  };
  const insertMedia = async (f: File) => {
    const src = await new Promise<string>((res) => {
      const r = new FileReader(); r.onload = () => res(r.result as string); r.readAsDataURL(f);
    });
    const mediaKind = f.type.startsWith("audio") ? "audio" as const : "video" as const;
    addObject({ type: "media", mediaSrc: src, mediaKind, x: 160, y: 100, w: mediaKind === "audio" ? 320 : 480, h: mediaKind === "audio" ? 64 : 270 });
  };
  const insertTable = () => setTableDlg({ id: null });
  const insertChart = () => setChartDlg({ id: null });

  // ---- slide ops ----
  const addSlide = (layoutId = "title-content") => {
    const s = applyLayout(blankSlide(theme), layoutId, theme);
    mutate((d) => d.slides.splice(slideIdx + 1, 0, s));
    setSlideIdx(slideIdx + 1);
  };
  const dupSlide = () => {
    mutate((d) => {
      const copy = structuredClone(d.slides[slideIdx]);
      copy.id = newId();
      copy.objects.forEach((o) => { o.id = newId(); });
      d.slides.splice(slideIdx + 1, 0, copy);
    });
    setSlideIdx(slideIdx + 1);
  };
  const delSlide = () => {
    if (deck.slides.length <= 1) return toast("Deck needs at least one slide");
    mutate((d) => d.slides.splice(slideIdx, 1));
    setSlideIdx((i) => Math.max(0, i - 1));
  };
  const moveSlide = (d: number) => {
    const j = slideIdx + d;
    if (j < 0 || j >= deck.slides.length) return;
    mutate((deck) => { const [s] = deck.slides.splice(slideIdx, 1); deck.slides.splice(j, 0, s); });
    setSlideIdx(j);
  };
  // P2.3 — hide/unhide the current slide (skipped during presentation)
  const toggleHidden = () => mutate((d) => { const s = d.slides[slideIdx]; s.hidden = !s.hidden; });
  // P2.2 — section ops: flag the current slide as a section head; rename/remove/move blocks
  const startSection = () => {
    const name = prompt("Section name:", slide.sectionStart ?? `Section ${railSections.length + 1}`);
    if (name === null) return;
    mutate((d) => { d.slides[slideIdx].sectionStart = name || undefined; });
  };
  const renameSection = (headId: string, cur: string) => {
    const name = prompt("Rename section:", cur);
    if (name === null) return;
    mutate((d) => { const s = d.slides.find((x) => x.id === headId); if (s) s.sectionStart = name || undefined; });
  };
  const moveSection = (headId: string, dir: -1 | 1) => {
    mutate((d) => {
      const blocks: { headId: string | null; idxs: number[] }[] = [];
      let cur: { headId: string | null; idxs: number[] } = { headId: null, idxs: [] };
      d.slides.forEach((s, i) => {
        if (s.sectionStart) { blocks.push(cur); cur = { headId: s.id, idxs: [i] }; }
        else cur.idxs.push(i);
      });
      blocks.push(cur);
      const k = blocks.findIndex((b) => b.headId === headId);
      const j = k + dir;
      if (k < 0 || j < 0 || j >= blocks.length) return;
      [blocks[k], blocks[j]] = [blocks[j], blocks[k]];
      d.slides = blocks.flatMap((b) => b.idxs.map((i) => d.slides[i]));
    });
  };
  // P2.4 — slide size presets + custom
  const setSlideSize = (w: number, h: number) => mutate((d) => { d.slideW = w; d.slideH = h; });
  // ---- P4.1 outline helpers — title = first text object; bullets = the rest
  const stripHtml = (h?: string) => (h ?? "").replace(/<br\s*\/?\s*>/gi, "\n").replace(/<li[^>]*>/gi, "• ").replace(/<\/li>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();
  const outlineTitle = (s: Slide) => s.objects.find((o) => o.type === "text");
  const outlineBodies = (s: Slide) => s.objects.filter((o) => o.type === "text").slice(1);
  const commitOutlineTitle = (i: number, v: string) => {
    mutate((d) => {
      const s = d.slides[i];
      const t = s.objects.find((o) => o.type === "text");
      if (t) t.html = v;
      else if (v.trim()) {
        const maxZ = Math.max(0, ...s.objects.map((o) => o.z));
        s.objects.push({ id: newId(), type: "text", x: 48, y: 32, w: dims.w - 96, h: 64, z: maxZ + 1, html: v, fontSize: 34, bold: true, color: theme.ink });
      }
    });
  };
  const commitOutlineBody = (i: number, objId: string, v: string) => {
    mutate((d) => { const o = d.slides[i].objects.find((x) => x.id === objId); if (o) o.html = v.replace(/\n/g, "<br/>"); });
  };
  // P4.2 — sorter reorder/multi ops
  const sorterMove = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= deck.slides.length || to >= deck.slides.length) return;
    mutate((d) => { const [s] = d.slides.splice(from, 1); d.slides.splice(to, 0, s); });
    setSlideIdx(to);
  };
  const sorterDelete = () => {
    if (deck.slides.length - sorterSel.size < 1) return toast("Deck needs at least one slide");
    mutate((d) => { d.slides = d.slides.filter((_, i) => !sorterSel.has(i)); });
    setSorterSel(new Set());
    setSlideIdx(0);
  };
  const sorterDup = () => {
    mutate((d) => {
      const copies = [...sorterSel].sort((a, b) => a - b).map((i) => {
        const c = structuredClone(d.slides[i]); c.id = newId(); c.objects.forEach((o) => { o.id = newId(); }); return c;
      });
      d.slides.push(...copies);
    });
    setSorterSel(new Set());
  };
  const sorterSetTransition = (type: string) => {
    mutate((d) => { sorterSel.forEach((i) => { d.slides[i].transition = type === "none" ? undefined : { type: type as TransitionType, duration: 500 }; }); });
  };

  // P4.3 — find & replace across the deck (text objects + notes)
  const [findQ, setFindQ] = useState("");
  const [replaceQ, setReplaceQ] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [activeShow, setActiveShow] = useState<number[] | undefined>(undefined); // P5.3 — show being presented
  const [showDlg, setShowDlg] = useState(false); // P5.3 — custom shows manager
  const [printLayout, setPrintLayout] = useState<"slides" | "handout2" | "handout4" | "handout6" | "notes">("slides");
  const findBarRef = useRef<HTMLDivElement>(null);
  const findMatches = useMemo(() => {
    const q = findQ.trim().toLowerCase();
    if (!q) return [] as { slide: number; objId: string | null; where: string; snippet: string }[];
    const out: { slide: number; objId: string | null; where: string; snippet: string }[] = [];
    deck.slides.forEach((s, i) => {
      for (const o of s.objects) {
        const txt = stripHtml(o.html);
        const k = txt.toLowerCase().indexOf(q);
        if (k >= 0) out.push({ slide: i, objId: o.id, where: o.type, snippet: txt.slice(Math.max(0, k - 18), k + q.length + 22) });
      }
      const nk = (s.notes ?? "").toLowerCase().indexOf(q);
      if (nk >= 0) out.push({ slide: i, objId: null, where: "notes", snippet: s.notes!.slice(Math.max(0, nk - 18), nk + q.length + 22) });
    });
    return out.slice(0, 60);
  }, [deck, findQ]);
  const replaceAll = () => {
    const q = findQ.trim();
    if (!q) return;
    mutate((d) => {
      for (const s of d.slides) {
        for (const o of s.objects) if (o.html) o.html = replaceInHtml(o.html, q, replaceQ);
        if (s.notes) s.notes = s.notes.split(q).join(replaceQ);
      }
    });
    toast(`Replaced ${findMatches.length} match${findMatches.length === 1 ? "" : "es"}`);
  };
  /** Case-insensitive replace limited to text nodes (never inside tags). */
  const replaceInHtml = (html: string, from: string, to: string) =>
    html.split(/(<[^>]+>)/g).map((seg) => seg.startsWith("<") ? seg : seg.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), to)).join("");

  // P2.5 — slide background: flat color, gradient string, or picture layer
  const setBg = (v?: string) => mutate((d) => { d.slides[slideIdx].bg = v; });
  const applyBgToAll = () => mutate((d) => {
    const { bg, bgImage } = d.slides[slideIdx];
    d.slides.forEach((s) => { s.bg = bg; s.bgImage = bgImage; });
  });
  const pickSlideSize = (v: string) => {
    if (v === "custom") {
      const raw = prompt("Slide size WxH (px):", `${dims.w}x${dims.h}`);
      const m = raw?.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
      if (m) setSlideSize(+m[1], +m[2]);
      return;
    }
    const [w, h] = v.split("x").map(Number);
    setSlideSize(w, h);
  };
  const setLayout = (layoutId: string) => {
    mutate((d) => {
      if (deck.layouts?.[layoutId]) {
        // live-linked custom layout — keeps the slide's own objects as overrides
        d.slides[slideIdx].layout = layoutId;
      } else {
        d.slides[slideIdx] = applyLayout(d.slides[slideIdx], layoutId, theme);
      }
    });
  };
  const setTheme = (themeId: string) => {
    if (themeId === "imported") return; // reselecting the active custom theme is a no-op
    if (themeId.startsWith("variant:")) { // P2.6 — apply a saved per-deck variant
      const v = deck.themeVariants?.find((t) => `variant:${t.id}` === themeId);
      if (v) mutate((d) => { d.customTheme = { ...v }; });
      return;
    }
    mutate((d) => { d.theme = themeId; d.customTheme = undefined; d.slides.forEach((s) => { s.bg = THEMES.find((t) => t.id === themeId)?.bg ?? s.bg; }); });
  };
  // P2.6 — theme editor: live-edits deck.customTheme, "save variant" persists it
  const [themeEd, setThemeEd] = useState<Theme | null>(null);
  const applyThemeEd = (t: Theme) => { setThemeEd(t); mutate((d) => { d.customTheme = { ...t }; }); };
  const saveVariant = () => {
    if (!themeEd) return;
    const name = prompt("Variant name:", themeEd.name) ?? themeEd.name;
    mutate((d) => { (d.themeVariants ??= []).push({ ...themeEd, id: newId(), name }); });
    setThemeEd(null);
  };

  // ---- comments ----
  const loadComments = useCallback(async () => {
    const r = await api.get<{ comments: Comment[] }>(`/api/files/${item.id}/comments`);
    setComments(r.comments);
  }, [item.id]);
  useEffect(() => { loadComments().catch(() => {}); }, [loadComments]);
  const submitComment = async (body: string) => {
    await api.post(`/api/files/${item.id}/comments`, { body, anchor: `slide:${slideIdx + 1}` });
    setNewComment(false);
    loadComments();
  };

  const rename = useCallback(async (name: string) => {
    await api.patch(`/api/drive/${item.id}`, { name });
  }, [item.id]);

  // ---- print (PDF export) ----
  useEffect(() => {
    if (!printing) return;
    const t = setTimeout(() => {
      window.print();
      setPrinting(false);
    }, 250);
    return () => clearTimeout(t);
  }, [printing]);

  // keyboard: delete/escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).isContentEditable || /input|textarea|select/i.test((e.target as HTMLElement).tagName)) return;
      if ((e.key === "Delete" || e.key === "Backspace") && canEdit && selection.size) { e.preventDefault(); delSelected(); }
      else if (e.key === "Escape") { setSelection(new Set()); setPaintArmed(false); setCropId(null); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") { e.preventDefault(); e.shiftKey ? ungroupSel() : groupSel(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && selection.size) {
        e.preventDefault();
        const objs = slide.objects.filter((o) => selection.has(o.id));
        writeKx("present-objects", objs, `${objs.length} object${objs.length === 1 ? "" : "s"}`);
        toast(`Copied ${objs.length} object${objs.length === 1 ? "" : "s"}`);
      }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x" && canEdit && selection.size) {
        e.preventDefault();
        const objs = slide.objects.filter((o) => selection.has(o.id));
        writeKx("present-objects", objs, `${objs.length} objects`);
        delSelected();
      }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && canEdit) {
        const objs = readKx<SlideObject[]>("present-objects");
        if (!objs?.length) return;
        e.preventDefault();
        pasteObjects(objs);
      }
      // P7 — shortcut map completion
      else if (e.key === "F5") {
        e.preventDefault();
        setPresStart(e.shiftKey ? slideIdx : 0);
        setPresenting("present");
      }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d" && canEdit && selection.size) {
        e.preventDefault();
        pasteObjects(slide.objects.filter((o) => selection.has(o.id)));
      }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void flushSave(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); setFindOpen((v) => !v); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "m" && canEdit) { e.preventDefault(); addSlide(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault(); setSelection(new Set(slide.objects.map((o) => o.id)));
      }
      else if (e.key.startsWith("Arrow") && canEdit && selection.size) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
        const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
        mutateSlide((s) => s.objects.forEach((o) => { if (selection.has(o.id)) { o.x += dx; o.y += dy; } }));
      }
      else if (e.key === "PageDown" || e.key === "PageUp") {
        e.preventDefault();
        setSlideIdx((i) => Math.max(0, Math.min(deck.slides.length - 1, i + (e.key === "PageDown" ? 1 : -1))));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const fitZoom = () => {
    const el = canvasWrap.current;
    if (el) setZoom(Math.min((el.clientWidth - 60) / SLIDE_W, (el.clientHeight - 60) / SLIDE_H));
  };
  useEffect(fitZoom, []);
  const isMobile = useIsMobile();

  // touch: pinch-zoom the slide canvas + single-finger pan on empty space.
  // Slide objects stopPropagation on pointerdown, so pans only start on the
  // slide background / wrap.
  const cPtrs = useRef(new Map<number, { x: number; y: number }>());
  const cGest = useRef<{ d0: number; z0: number; lx: number; ly: number } | null>(null);
  const canvasDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") return;
    cPtrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (cPtrs.current.size === 2) {
      const [a, b] = [...cPtrs.current.values()];
      cGest.current = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: zoom, lx: 0, ly: 0 };
    } else if (cPtrs.current.size === 1) {
      cGest.current = { d0: 0, z0: zoom, lx: e.clientX, ly: e.clientY };
    }
  };
  const canvasMove = (e: React.PointerEvent) => {
    if (!cPtrs.current.has(e.pointerId)) return;
    cPtrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = cGest.current, wrap = canvasWrap.current;
    if (!g || !wrap) return;
    if (cPtrs.current.size === 2 && g.d0 > 0) {
      const [a, b] = [...cPtrs.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      setZoom(Math.min(3, Math.max(0.1, g.z0 * (d / g.d0))));
    } else if (cPtrs.current.size === 1 && g.d0 === 0) {
      // single-finger pan scrolls the wrap
      wrap.scrollLeft += g.lx - e.clientX;
      wrap.scrollTop += g.ly - e.clientY;
      g.lx = e.clientX; g.ly = e.clientY;
    }
  };
  const canvasUp = (e: React.PointerEvent) => {
    cPtrs.current.delete(e.pointerId);
    if (cPtrs.current.size === 0) cGest.current = null;
    else if (cPtrs.current.size === 1) {
      const [a] = [...cPtrs.current.values()];
      cGest.current = { d0: 0, z0: zoom, lx: a.x, ly: a.y };
    }
  };

  const thumbScale = isMobile ? 0.1 : 0.145;
  const saveLabel: Record<SaveState, string> = {
    saved: "All changes saved", saving: "Saving…", unsaved: "Unsaved changes", error: "Save failed",
  };

  const selCount = selection.size;

  // contextual "Format" tab — auto-activates when a selection appears
  const [ribTab, setRibTab] = useState(() => {
    try { return localStorage.getItem("kx-ribtab-present") || "home"; } catch { return "home"; }
  });
  const hadCtx = useRef(false);
  useEffect(() => {
    const ctx = selCount > 0 || !!editingObj;
    if (ctx !== hadCtx.current) {
      hadCtx.current = ctx;
      setRibTab((t) => ctx ? "format" : (t === "format" ? "home" : t));
    }
  }, [selCount, editingObj]);

  return (
    <div className="editor-shell present-shell">
      <div className="editor-top">
        <button className="back" onClick={() => navigate(-1)} title="Back">←</button>
        <AppIcon kind="present" size={34} />
        <input className="doc-title" value={title} disabled={!canEdit}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== item.name && rename(title.trim())}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        <span className={`save-state ${saveState === "saving" || saveState === "unsaved" ? "saving" : ""}`}>{saveLabel[saveState]}</span>
        {permission !== "owner" && <span className="perm-badge">{permission}</span>}
        <PresenceBar session={session} />
        <div className="spacer" />
        <button className="btn-ghost btn-sm" onClick={() => setSharing(true)}>Share</button>
        <button className="btn-primary btn-sm" onClick={() => setPresenting("present")}>▶ Present</button>
      </div>

      {canEdit && (<>
        <RibbonTabs persistKey="present" active={ribTab} onActive={setRibTab}
          end={<>
            <button className={`rb ${panel === "comments" ? "on" : ""}`} title="Comments"
              onClick={() => setPanel(panel === "comments" ? "none" : "comments")}>💬</button>
            <button className={`rb ${panel === "ai" ? "on" : ""}`} title="Kreatix AI"
              onClick={() => setPanel(panel === "ai" ? "none" : "ai")}>✨</button>
            <select className="rb-sel" style={{ width: 76 }} value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
              {[0.4, 0.5, 0.6, 0.75, 1, 1.25].map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
            </select>
            <button className="rb" style={{ width: "auto", padding: "0 8px", fontSize: 11 }} onClick={fitZoom}>Fit</button>
          </>}
          tabs={[
            { id: "file", label: "File", icon: "📁", menu: [
              { label: "New presentation", onClick: () => void createDoc("present").then((d) => navigate(`/edit/${d.id}`)).catch(() => toast("Couldn't create presentation")) },
              { label: "Open…", onClick: () => navigate("/drive") },
              { label: "Open from this computer…", onClick: () => void openLocalFile().then((id) => id && navigate(`/edit/${id}`)).catch((e) => toast((e as Error).message)) },
              { divider: true },
              { label: "Save", shortcut: "Ctrl+S", onClick: () => void flushSave() },
              { divider: true },
              { label: "Import PPTX / ODP…", onClick: () => pptxRef.current?.click() },
              { divider: true },
              { label: "Export PDF", submenu: [
                { label: "Full-page slides", onClick: () => { setPrintLayout("slides"); setPrinting(true); } },
                { label: "Handouts · 2/page", onClick: () => { setPrintLayout("handout2"); setPrinting(true); } },
                { label: "Handouts · 4/page", onClick: () => { setPrintLayout("handout4"); setPrinting(true); } },
                { label: "Handouts · 6/page", onClick: () => { setPrintLayout("handout6"); setPrinting(true); } },
                { label: "Notes pages", onClick: () => { setPrintLayout("notes"); setPrinting(true); } },
              ]},
              { label: "Export .pptx", onClick: () => void exportPptx(deck, title).catch(() => toast("Export failed")) },
              { label: exporting ? "Recording video…" : "Export video", disabled: exporting, onClick: () => {
                setExporting(true);
                void exportVideo(deck, title, (m) => toast(m))
                  .catch(() => toast("Video export failed"))
                  .finally(() => setExporting(false));
              }},
              { divider: true },
              { label: "Version history", onClick: () => setPanel("versions") },
            ]},
            { id: "home", label: "Home", icon: "🏠", groups: [
              { id: "clip", label: "Clipboard", node: <>
          <button className="rb" title="Undo" disabled={!undoStack.current.length} onClick={undo}>↶</button>
          <button className="rb" title="Redo" disabled={!redoStack.current.length} onClick={redo}>↷</button>
              </>},
              { id: "slides", label: "Slides", node: <>
          <select className="rb-sel" value="" title="Add slide with layout"
            onChange={(e) => { if (e.target.value) addSlide(e.target.value); e.target.value = ""; }}>
            <option value="">＋ Slide…</option>
            {LAYOUTS.filter((l) => l.id !== "blank").map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <select className="rb-sel" value={masterView !== "off" ? "__mv" : slide.layout ?? "blank"} onChange={(e) => setLayout(e.target.value)} title="Layout (built-ins replace objects; custom layouts render live-linked)" disabled={masterView !== "off"}>
            {LAYOUTS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            {Object.keys(deck.layouts ?? {}).map((k) => <option key={k} value={k}>◆ {k}</option>)}
            {masterView !== "off" && <option value="__mv">— editing master —</option>}
          </select>
              </>},
            ]},
            { id: "design", label: "Design", icon: "🎨", groups: [
              { id: "theme", label: "Themes", node: <>
          <select className="rb-sel" title="Theme" disabled={masterView !== "off"}
            value={deck.customTheme ? (deck.themeVariants?.some((v) => v.id === deck.customTheme!.id) ? `variant:${deck.customTheme.id}` : "imported") : deck.theme ?? "kreatix"}
            onChange={(e) => setTheme(e.target.value)}>
            {deck.customTheme && !deck.themeVariants?.some((v) => v.id === deck.customTheme!.id) && <option value="imported">Imported ({deck.customTheme.name})</option>}
            {THEMES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            {(deck.themeVariants?.length ?? 0) > 0 && (
              <optgroup label="Deck variants">
                {deck.themeVariants!.map((v) => <option key={v.id} value={`variant:${v.id}`}>◆ {v.name}</option>)}
              </optgroup>
            )}
          </select>
          <div style={{ position: "relative" }}>
            <button className={`rb ${themeEd ? "on" : ""}`} title="Edit theme colors" disabled={masterView !== "off"}
              onClick={() => setThemeEd(themeEd ? null : { ...theme })}>🎨</button>
            {themeEd && (
            <div className="shape-menu" style={{ gridTemplateColumns: "1fr", width: 200, gap: 6 }}>
              <input className="rb-sel" value={themeEd.name} style={{ fontSize: 12 }}
                onChange={(e) => applyThemeEd({ ...themeEd, name: e.target.value })} />
              {(["bg", "ink", "accent", "soft"] as const).map((k) => (
                <label key={k} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, textTransform: "capitalize" }}>
                  {k}
                  <input type="color" value={themeEd[k]} style={{ marginLeft: "auto" }}
                    onChange={(e) => applyThemeEd({ ...themeEd, [k]: e.target.value })} />
                </label>
              ))}
              <select className="rb-sel" value={themeEd.font}
                onChange={(e) => applyThemeEd({ ...themeEd, font: e.target.value })}>
                {["Inter", "Georgia", "Garamond", "Trebuchet MS", "Courier New"].map((f) => <option key={f}>{f}</option>)}
              </select>
              <div style={{ display: "flex", gap: 6 }}>
                <button className="rb" style={{ flex: 1, fontSize: 11 }} onClick={saveVariant}>Save variant</button>
                <button className="rb" style={{ fontSize: 11 }} onClick={() => setThemeEd(null)}>Done</button>
              </div>
            </div>
            )}
          </div>
          <button className={`rb ${masterView !== "off" ? "on" : ""}`} title="Master view — objects here render under every slide (P2.1)"
            onClick={() => { setMasterView(masterView === "off" ? "master" : "off"); setSelection(new Set()); setEditingObj(null); }}>◈</button>
          {masterView !== "off" && (
            <>
              <select className="rb-sel" value={masterView} title="Edit target"
                onChange={(e) => { setMasterView(e.target.value); setSelection(new Set()); }}>
                <option value="master">Slide master</option>
                {Object.keys(deck.layouts ?? {}).map((k) => <option key={k} value={`layout:${k}`}>Layout: {k}</option>)}
              </select>
              <button className="rb" title="New live-linked layout"
                onClick={() => {
                  const name = prompt("Layout name:");
                  if (!name) return;
                  mutate((d) => { (d.layouts ??= {})[name] ??= []; });
                  setMasterView(`layout:${name}`);
                }}>＋</button>
              <button className="rb" title="Exit master view" onClick={() => setMasterView("off")}>Done</button>
            </>
          )}
              </>},
              { id: "size", label: "Slide Setup", node: <>
          <select className="rb-sel" value={`${dims.w}x${dims.h}`} title="Slide size (P2.4)" disabled={masterView !== "off"}
            onChange={(e) => { if (e.target.value) pickSlideSize(e.target.value); e.target.value = `${dims.w}x${dims.h}`; }}>
            <option value={`${dims.w}x${dims.h}`} hidden>{dims.w}×{dims.h}</option>
            <option value="960x540">16:9 widescreen</option>
            <option value="720x540">4:3 standard</option>
            <option value="540x960">9:16 portrait</option>
            <option value="custom">Custom…</option>
          </select>
          <div style={{ position: "relative" }}>
            <button className={`rb ${bgMenu ? "on" : ""}`} title="Slide background" disabled={masterView !== "off"}
              onClick={() => setBgMenu((v) => !v)}>BG ▾</button>
            {bgMenu && (
              <div className="shape-menu" style={{ gridTemplateColumns: "1fr", width: 210, gap: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)" }}>BACKGROUND</div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer" }}>
                  Flat
                  <input type="color" defaultValue={/^#/.test(slide.bg ?? "") ? slide.bg! : theme.bg}
                    onChange={(e) => setBg(e.target.value)} />
                </label>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", marginTop: 2 }}>GRADIENT</div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="color" value={grad.c1} onChange={(e) => { const g = { ...grad, c1: e.target.value }; setGrad(g); setBg(`linear-gradient(${g.angle}deg, ${g.c1}, ${g.c2})`); }} />
                  <input type="color" value={grad.c2} onChange={(e) => { const g = { ...grad, c2: e.target.value }; setGrad(g); setBg(`linear-gradient(${g.angle}deg, ${g.c1}, ${g.c2})`); }} />
                  <select className="rb-sel" value={grad.angle} style={{ flex: 1 }}
                    onChange={(e) => { const g = { ...grad, angle: Number(e.target.value) }; setGrad(g); setBg(`linear-gradient(${g.angle}deg, ${g.c1}, ${g.c2})`); }}>
                    {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => <option key={a} value={a}>{a}°</option>)}
                  </select>
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  <button className="rb" style={{ flex: 1 }} title="Picture background" onClick={() => bgImageRef.current?.click()}>🖼 Picture</button>
                  {slide.bgImage && <button className="rb" title="Remove picture" onClick={() => mutate((d) => { d.slides[slideIdx].bgImage = undefined; })}>✕</button>}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="rb" style={{ flex: 1, fontSize: 11 }} onClick={applyBgToAll}>Apply to all</button>
                  <button className="rb" style={{ fontSize: 11 }} onClick={() => { setBg(undefined); mutate((d) => { d.slides[slideIdx].bgImage = undefined; }); }}>Reset</button>
                </div>
              </div>
            )}
          </div>
              </>},
            ]},
            { id: "insert", label: "Insert", icon: "➕", groups: [
              { id: "obj", label: "Objects", node: <>
          <button className="rb" title="Text box" onClick={insertText}>T</button>
          <div style={{ position: "relative" }}>
            <button className="rb" title="Shapes" onClick={() => setShapeMenu((v) => !v)}>▢▾</button>
            {shapeMenu && (
              <div className="shape-menu">
                {SHAPE_MENU.map((s) => (
                  <button key={s.id} title={s.name}
                    onClick={() => { insertShape(s.id); setShapeMenu(false); }}>{s.glyph}</button>
                ))}
              </div>
            )}
          </div>
          <button className="rb" title="Line" onClick={insertLine}>╱</button>
          <button className="rb" title="Connector — straight (select 2 objects to auto-attach)" onClick={() => insertConnector("straight")}>↔</button>
          <button className="rb" title="Connector — elbow" onClick={() => insertConnector("elbow")}>⌐</button>
          <button className="rb" title="Connector — curved" onClick={() => insertConnector("curve")}>⌒</button>
              </>},
              { id: "media", label: "Media", node: <>
          <button className="rb" title="Image" onClick={() => imageRef.current?.click()}>🖼</button>
          <button className="rb" title="Audio / video (P6.4)" onClick={() => mediaRef.current?.click()}>🎬</button>
          <button className="rb" title="Table" onClick={insertTable}>⊞</button>
          <button className="rb" title="Chart" onClick={insertChart}>📊</button>
              </>},
            ]},
            { id: "view", label: "View", icon: "👁", groups: [
              { id: "panes", label: "Panes & Guides", node: <>
          <button className={`rb ${panel === "objects" ? "on" : ""}`} title="Objects pane" onClick={() => setPanel(panel === "objects" ? "none" : "objects")}>☰</button>
          <button className={`rb ${findOpen ? "on" : ""}`} title="Find & replace (P4.3)" onClick={() => setFindOpen((v) => !v)}>🔍</button>
          <button className={`rb ${deck.showGrid ? "on" : ""}`} title="Gridlines (P5.4)"
            onClick={() => mutate((d) => { d.showGrid = !d.showGrid; })}>⌗</button>
          <button className={`rb ${deck.showRuler ? "on" : ""}`} title="Ruler + guides — drag from ruler edges to create guides (P5.4)"
            onClick={() => mutate((d) => { d.showRuler = !d.showRuler; })}>📏</button>
              </>},
            ]},
            { id: "transitions", label: "Transitions", icon: "🎬", groups: [
              { id: "trans", label: "Transition", node: <>
          <select className="rb-sel" value={slide.transition?.type ?? "none"} title="Slide transition (P3.4)"
            onChange={(e) => setTransition(e.target.value as TransitionType)}>
            <option value="none">No transition</option>
            <option value="fade">Fade</option>
            <option value="slide">Slide</option>
            <option value="push">Push</option>
            <option value="cover">Cover</option>
            <option value="wipe">Wipe</option>
            <option value="split">Split</option>
            <option value="blinds">Blinds</option>
            <option value="zoom">Zoom</option>
            <option value="dissolve">Dissolve</option>
            <option value="morph">Morph</option>
            <option value="flip">Flip</option>
          </select>
          {slide.transition && TRANSITION_DIRS[slide.transition.type] && (
            <select className="rb-sel" value={slide.transition.dir ?? TRANSITION_DIRS[slide.transition.type]![0]} title="Direction"
              onChange={(e) => setTransition(slide.transition!.type, e.target.value)}>
              {TRANSITION_DIRS[slide.transition.type]!.map((d) => (
                <option key={d} value={d}>{{ l: "← Left", r: "→ Right", t: "↓ Down", b: "↑ Up", h: "Horizontal", v: "Vertical" }[d]}</option>
              ))}
            </select>
          )}
              </>},
              { id: "timing", label: "Timing", node: <>
          {/* P5.2 — auto-advance + kiosk loop; P5.3 — custom shows; P5.4 — grid/ruler */}
          <input className="rb-sel" style={{ width: 58 }} type="number" min={0} step={1} title="Auto-advance after N seconds (0 = manual)"
            value={Math.round((slide.advanceAfter ?? 0) / 1000)}
            onChange={(e) => mutateSlide((s) => { s.advanceAfter = Math.max(0, Number(e.target.value) || 0) * 1000 || undefined; })} />
          <button className={`rb ${deck.showLoop ? "on" : ""}`} title="Kiosk loop — restart deck at end (P5.2)"
            onClick={() => mutate((d) => { d.showLoop = !d.showLoop; })}>⟲</button>
              </>},
            ]},
            { id: "show", label: "Slide Show", icon: "▶", groups: [
              { id: "play", label: "Present", node: <>
          <button className="rb" title="Slideshow from this slide (reading view)" onClick={() => setPresenting("present")}>▶</button>
          <button className="rb" title="Presenter view" style={{ fontSize: 11 }} onClick={() => setPresenting("presenter")}>🖥</button>
          <select className="rb-sel" value="" title="Custom shows (P5.3)"
            onChange={(e) => {
              if (e.target.value === "__manage") setShowDlg(true);
              else if (e.target.value) { const s = deck.shows?.[Number(e.target.value)]; if (s) { setActiveShow(s.slides); setPresenting("present"); } }
              e.target.value = "";
            }}>
            <option value="">Shows…</option>
            {(deck.shows ?? []).map((s, i) => <option key={i} value={i}>▶ {s.name}</option>)}
            <option value="__manage">⚙ Manage…</option>
          </select>
              </>},
            ]},
            ...(selCount > 0 || editingObj ? [{
              id: "format", label: "Format", icon: "✎", contextual: true, groups: [
                { id: "text", label: "Text", node: <>
          {editingObj && (
            <>
              <RunBtn cmd="bold" title="Bold"><b>B</b></RunBtn>
              <RunBtn cmd="italic" title="Italic"><i>I</i></RunBtn>
              <RunBtn cmd="underline" title="Underline"><u>U</u></RunBtn>
              <RunBtn cmd="strikeThrough" title="Strikethrough"><s>S</s></RunBtn>
              <RunBtn cmd="superscript" title="Superscript">x²</RunBtn>
              <RunBtn cmd="subscript" title="Subscript">x₂</RunBtn>
              <select className="rb-sel" value="" title="Run font size (selected text)" style={{ width: 56 }}
                onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => { if (e.target.value) runSpan(`font-size:${e.target.value}px`); e.target.value = ""; }}>
                <option value="">pt</option>
                {[10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 60, 72].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              {["#171717", "#D64545", "#F2782E", "#3578E5", "#1F9D66", "#8E6BC8", "#A19A95", "#FFFFFF"].map((c) => (
                <button key={c} className="rb" title={`Text ${c}`} style={{ padding: 4 }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => runCmd("foreColor", c)}>
                  <span style={{ display: "inline-block", width: 14, height: 14, borderRadius: 3, background: c, border: "1px solid var(--line)" }} />
                </button>
              ))}
              <div className="rb-sep" />
              <RunBtn cmd="justifyLeft" title="Align left">⇤</RunBtn>
              <RunBtn cmd="justifyCenter" title="Center">≡</RunBtn>
              <RunBtn cmd="justifyRight" title="Align right">⇥</RunBtn>
              <div className="rb-sep" />
              <RunBtn cmd="insertUnorderedList" title="Bulleted list">•</RunBtn>
              <RunBtn cmd="insertOrderedList" title="Numbered list">1.</RunBtn>
              <RunBtn cmd="outdent" title="Decrease indent">⇤|</RunBtn>
              <RunBtn cmd="indent" title="Increase indent">|⇥</RunBtn>
              <div className="rb-sep" />
              <button className="rb" title="Link selected text" onMouseDown={(e) => e.preventDefault()}
                onClick={() => { const u = prompt("Link URL:", "https://"); if (u) runCmd("createLink", u); }}>🔗</button>
              <RunBtn cmd="unlink" title="Remove link">⛓</RunBtn>
              <div className="rb-sep" />
            </>
          )}
          {!editingObj && firstSel?.type === "text" && (
            <>
              <button className={`rb ${firstSel.bold ? "on" : ""}`} title="Bold" onClick={() => patchSel({ bold: !firstSel.bold })}><b>B</b></button>
              <button className={`rb ${firstSel.italic ? "on" : ""}`} title="Italic" onClick={() => patchSel({ italic: !firstSel.italic })}><i>I</i></button>
              <select className="rb-sel" value={firstSel.fontSize ?? 20} title="Font size" style={{ width: 60 }}
                onChange={(e) => patchSel({ fontSize: Number(e.target.value) })}>
                {[12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 54, 64, 72].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <label className="rb" title="Text color" style={{ padding: 4, cursor: "pointer" }}>
                A<input type="color" value={firstSel.color ?? "#171717"} style={{ position: "absolute", opacity: 0, width: 0 }}
                  onChange={(e) => patchSel({ color: e.target.value })} />
              </label>
              {(["left", "center", "right"] as const).map((a) => (
                <button key={a} className={`rb ${firstSel.align === a ? "on" : ""}`} onClick={() => patchSel({ align: a })}>
                  {a === "left" ? "⇤" : a === "center" ? "≡" : "⇥"}
                </button>
              ))}
              <div className="rb-sep" />
            </>
          )}
                </>},
                { id: "pic", label: "Picture", node: <>
          {firstSel?.type === "image" && !editingObj && (
            <>
              <button className={`rb ${cropId === firstSel.id ? "on" : ""}`} title="Crop mode — drag the edge bars; double-click image to exit"
                onClick={() => setCropId(cropId === firstSel.id ? null : firstSel.id)}>⬚ Crop</button>
              <button className="rb" title="Reset crop" onClick={() => patchSel({ imgCrop: { l: 0, t: 0, r: 0, b: 0 } })}>⟲</button>
              <button className={`rb ${firstSel.imgFlipH ? "on" : ""}`} title="Flip horizontal" onClick={() => patchSel({ imgFlipH: !firstSel.imgFlipH })}>⇋</button>
              <button className={`rb ${firstSel.imgFlipV ? "on" : ""}`} title="Flip vertical" onClick={() => patchSel({ imgFlipV: !firstSel.imgFlipV })}>⇵</button>
              <select className="rb-sel" title="Opacity" value={firstSel.imgOpacity ?? 1}
                onChange={(e) => patchSel({ imgOpacity: Number(e.target.value) })}>
                <option value={1}>Opaque</option><option value={0.75}>75%</option><option value={0.5}>50%</option><option value={0.25}>25%</option>
              </select>
              <select className="rb-sel" title="Color filter" value={firstSel.imgFilter ?? "none"}
                onChange={(e) => patchSel({ imgFilter: e.target.value as SlideObject["imgFilter"] })}>
                <option value="none">No filter</option><option value="grayscale">Grayscale</option><option value="sepia">Sepia</option><option value="invert">Invert</option><option value="blur">Soft blur</option>
              </select>
              <div className="rb-sep" />
            </>
          )}
                </>},
                { id: "shape", label: "Shape & Line", node: <>
          {firstSel?.type === "connector" && !editingObj && (
            <select className="rb-sel" value={firstSel.conn?.kind ?? "straight"} title="Connector style"
              onChange={(e) => patchSel({ conn: { ...firstSel.conn!, kind: e.target.value as "straight" | "elbow" | "curve" } })}>
              <option value="straight">Straight</option>
              <option value="elbow">Elbow</option>
              <option value="curve">Curved</option>
            </select>
          )}
          {(firstSel?.type === "shape" || firstSel?.type === "line" || firstSel?.type === "connector") && (
            <>
              <label className="rb" title="Fill" style={{ padding: 4, cursor: "pointer" }}>
                ▨<input type="color" value={firstSel.fill ?? firstSel.stroke ?? "#F2782E"} style={{ position: "absolute", opacity: 0, width: 0 }}
                  onChange={(e) => patchSel(firstSel.type === "line" ? { stroke: e.target.value } : { fill: e.target.value })} />
              </label>
              {firstSel.type === "shape" && (
                <button className="rb" title="No fill" onClick={() => patchSel({ fill: "transparent" })}>∅</button>
              )}
              <div className="rb-sep" />
            </>
          )}
                </>},
                { id: "arrange", label: "Arrange", node: <>
          {selCount > 0 && !editingObj && (
            <>
              <button className={`rb ${firstSel?.link ? "on" : ""}`} title="Object hyperlink (Ctrl+click to open, clickable in present mode)"
                onClick={() => {
                  const u = prompt("Link URL (empty to clear):", firstSel?.link ?? "https://");
                  if (u !== null) patchSel({ link: u || undefined });
                }}>🔗</button>
              <button className={`rb ${paintArmed ? "on" : ""}`} title="Format painter — copy this object's formatting, then click the target"
                onClick={copyFmt}>🖌</button>
              <div className="rb-sep" />
            </>
          )}
          {selCount > 0 && (
            <>
              <button className="rb" title="Bring to front" onClick={() => setZ("front")}>⬒</button>
              <button className="rb" title="Send to back" onClick={() => setZ("back")}>⬓</button>
              <button className="rb" title="Raise" onClick={() => setZ("up")}>↑</button>
              <button className="rb" title="Lower" onClick={() => setZ("down")}>↓</button>
            </>
          )}
          {selCount > 1 && (
            <>
              <div className="rb-sep" />
              <button className="rb" title="Align left" onClick={() => alignSel("left")}>⇤</button>
              <button className="rb" title="Center horizontally" onClick={() => alignSel("center")}>↔</button>
              <button className="rb" title="Align right" onClick={() => alignSel("right")}>⇥</button>
              <button className="rb" title="Align top" onClick={() => alignSel("top")}>⤒</button>
              <button className="rb" title="Center vertically" onClick={() => alignSel("middle")}>↕</button>
              <button className="rb" title="Align bottom" onClick={() => alignSel("bottom")}>⤓</button>
              {selCount > 2 && (
                <>
                  <button className="rb" title="Distribute horizontally" onClick={() => distributeSel("h")}>⇹</button>
                  <button className="rb" title="Distribute vertically" onClick={() => distributeSel("v")}>⇳</button>
                </>
              )}
              <button className="rb" title="Group (Ctrl+G)" onClick={groupSel}>⧉</button>
              <button className="rb" title="Ungroup" onClick={ungroupSel}>⧈</button>
            </>
          )}
                </>},
                { id: "anim", label: "Animation", node: <>
          {selCount > 0 && (
            <>
            <select className="rb-sel" value={firstSel?.anim?.type ?? ""} title="Animation (P3.1/3.2)"
              onChange={(e) => setAnim(e.target.value)}>
              <option value="">No animation</option>
              <optgroup label="Entrance">
                <option value="fade">Fade</option>
                <option value="slide-up">Slide up</option>
                <option value="slide-left">Slide left</option>
                <option value="zoom">Zoom</option>
                <option value="wipe">Wipe</option>
                <option value="float">Float in</option>
                <option value="spin-in">Spin in</option>
              </optgroup>
              <optgroup label="Exit">
                <option value="fade-out">Fade out</option>
                <option value="slide-out">Slide out</option>
                <option value="zoom-out">Zoom out</option>
                <option value="wipe-out">Wipe out</option>
              </optgroup>
              <optgroup label="Emphasis">
                <option value="pulse">Pulse</option>
                <option value="grow">Grow/shrink</option>
                <option value="shake">Shake</option>
                <option value="color">Color pulse</option>
              </optgroup>
              <optgroup label="Motion">
                <option value="path">Motion path</option>
              </optgroup>
            </select>
            <button className={`rb ${panel === "anim" ? "on" : ""}`} title="Animation pane (order, timing, triggers)"
              onClick={() => setPanel(panel === "anim" ? "none" : "anim")}>✦</button>
            </>
          )}
                </>},
                { id: "act", label: "Actions", node: <>
          {selCount > 0 && <button className="rb" title="Delete" onClick={() => delSelected()}>⌫</button>}
          <button className="rb" title="Add comment" onClick={() => { setNewComment(true); setPanel("comments"); }}>💬</button>
                </>},
              ],
            }] : []),
          ]} />
        <input ref={pptxRef} type="file" accept=".pptx,.potx,.odp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportPptx(f); e.target.value = ""; }} />
        <input ref={bgImageRef} type="file" accept="image/*" hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const r = new FileReader();
            r.onload = () => mutate((d) => { d.slides[slideIdx].bgImage = String(r.result); });
            r.readAsDataURL(f);
            e.target.value = "";
          }} />
        <input ref={imageRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && void insertImage(e.target.files[0])} />
        <input ref={mediaRef} type="file" accept="video/*,audio/*" hidden onChange={(e) => e.target.files?.[0] && void insertMedia(e.target.files[0])} />
      </>)}

      {/* P4.3 — find & replace across the deck */}
      {findOpen && (
        <div className="find-bar" ref={findBarRef}>
          <input className="fb-in" placeholder="Find in deck…" value={findQ} autoFocus
            onChange={(e) => setFindQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setFindOpen(false); }} />
          <input className="fb-in" placeholder="Replace with…" value={replaceQ}
            onChange={(e) => setReplaceQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setFindOpen(false); }} />
          <button className="rb" disabled={!findMatches.length} onClick={replaceAll}>Replace all ({findMatches.length})</button>
          <button className="rb" onClick={() => setFindOpen(false)}>✕</button>
          {findQ && (
            <div className="fb-results">
              {findMatches.map((m, i) => (
                <div key={i} className="fb-match" title={`Slide ${m.slide + 1} · ${m.where}`}
                  onClick={() => { setSlideIdx(m.slide); if (m.objId) setSelection(new Set([m.objId])); setRailView("slides"); }}>
                  <b>S{m.slide + 1}</b> <span className="fb-where">{m.where}</span> …{m.snippet}…
                </div>
              ))}
              {findQ && !findMatches.length && <div className="fb-match" style={{ cursor: "default" }}>No matches</div>}
            </div>
          )}
        </div>
      )}

      <div className="present-body" style={{ marginRight: panel !== "none" ? 330 : 0 }}>
        {/* slide rail — P2.2 section headers group contiguous slides; P2.3 hidden slides dim; P4.1/4.2 view modes */}
        <div className="slide-rail">
          <div className="rail-view-sw">
            {([["slides", "▤", "Slides"], ["outline", "¶", "Outline view"], ["sorter", "⊞", "Slide sorter"]] as const).map(([v, g, t]) => (
              <button key={v} className={railView === v ? "on" : ""} title={t}
                onClick={() => { setRailView(v); if (v === "sorter") setSorterSel(new Set([slideIdx])); }}>{g}</button>
            ))}
          </div>
          {railView === "outline" && (
            <div className="outline">
              {deck.slides.map((s, i) => (
                <div key={s.id} className={`ol-card ${i === slideIdx ? "active" : ""}`}>
                  <div className="ol-title-row">
                    <span className="rail-num">{i + 1}</span>
                    <input className="ol-title" placeholder="Slide title" defaultValue={stripHtml(outlineTitle(s)?.html)}
                      key={`t${s.id}:${(outlineTitle(s)?.html ?? "").length}`}
                      onFocus={() => setSlideIdx(i)}
                      onBlur={(e) => commitOutlineTitle(i, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); commitOutlineTitle(i, (e.target as HTMLInputElement).value); if (i === deck.slides.length - 1) addSlide("title-content"); else setSlideIdx(i + 1); }
                        if (e.key === "Escape") (e.target as HTMLInputElement).blur();
                      }} />
                  </div>
                  {outlineBodies(s).map((o) => (
                    <textarea key={`b${o.id}:${(o.html ?? "").length}`} className="ol-body" placeholder="Bullets…"
                      defaultValue={stripHtml(o.html)} rows={Math.min(6, Math.max(1, stripHtml(o.html).split("\n").length))}
                      onFocus={() => setSlideIdx(i)}
                      onBlur={(e) => commitOutlineBody(i, o.id, e.target.value)} />
                  ))}
                </div>
              ))}
            </div>
          )}
          {railView !== "outline" && (() => {
            const thumb = (s: Slide, i: number) => (
              <div key={s.id} className={`rail-slide ${i === slideIdx ? "active" : ""} ${s.hidden ? "hidden" : ""}`}
                onClick={() => { setSlideIdx(i); setSelection(new Set()); setEditingObj(null); setCropId(null); }}>
                <span className="rail-num">{i + 1}</span>
                <div className="rail-thumb" style={{ width: dims.w * thumbScale, height: dims.h * thumbScale }}>
                  <SlideCanvas slide={s} theme={theme} scale={thumbScale} selection={new Set()} under={underObjs(s)} size={dims} />
                </div>
                {s.hidden && <span className="rail-hbadge">∅</span>}
              </div>
            );
            const secHead = (sec: { name: string; headId: string; idxs: number[] }) => (
              <div className="rail-sec" key={`sec-${sec.headId}`}>
                <button className="rail-sec-caret" title="Collapse/expand"
                  onClick={() => setCollapsedSecs((c) => { const n = new Set(c); n.has(sec.headId) ? n.delete(sec.headId) : n.add(sec.headId); return n; })}>
                  {collapsedSecs.has(sec.headId) ? "▸" : "▾"}
                </button>
                <span className="rail-sec-name" title="Double-click to rename" onDoubleClick={() => renameSection(sec.headId, sec.name)}>{sec.name}</span>
                <span className="rail-sec-count">{sec.idxs.length}</span>
                <button title="Move section up" onClick={() => moveSection(sec.headId, -1)}>↑</button>
                <button title="Move section down" onClick={() => moveSection(sec.headId, 1)}>↓</button>
                <button title="Rename" onClick={() => renameSection(sec.headId, sec.name)}>✎</button>
                <button title="Remove section (keeps slides)"
                  onClick={() => mutate((d) => { const s = d.slides.find((x) => x.id === sec.headId); if (s) s.sectionStart = undefined; })}>✕</button>
              </div>
            );
            return (
              <>
                {railPreface.map((i) => thumb(deck.slides[i], i))}
                {railSections.map((sec) => (
                  <Fragment key={sec.headId}>
                    {secHead(sec)}
                    {!collapsedSecs.has(sec.headId) && sec.idxs.map((i) => thumb(deck.slides[i], i))}
                  </Fragment>
                ))}
              </>
            );
          })()}
          {canEdit && (
            <div className="rail-ops">
              <button title="Add slide" onClick={() => addSlide()}>＋</button>
              <button title="Duplicate" onClick={dupSlide}>⧉</button>
              <button title="Move up" disabled={slideIdx === 0} onClick={() => moveSlide(-1)}>↑</button>
              <button title="Move down" disabled={slideIdx === deck.slides.length - 1} onClick={() => moveSlide(1)}>↓</button>
              <button title={slide.sectionStart ? "Edit/remove section start" : "Start section here"} onClick={startSection}>§</button>
              <button title={slide.hidden ? "Unhide slide" : "Hide slide (skipped in show)"} onClick={toggleHidden}>👁</button>
              <button title="Delete slide" onClick={delSlide}>✕</button>
            </div>
          )}
        </div>

        {/* P4.2 — slide sorter replaces the canvas; otherwise canvas + notes */}
        {railView === "sorter" ? (
          <div className="sorter">
            <div className="sorter-bar">
              <span>{sorterSel.size ? `${sorterSel.size} selected` : "Slide sorter"}</span>
              <button className="rb" disabled={!sorterSel.size} onClick={sorterDup} title="Duplicate selected">⧉</button>
              <button className="rb" disabled={!sorterSel.size} title="Hide/unhide selected"
                onClick={() => mutate((d) => { sorterSel.forEach((i) => { const s = d.slides[i]; s.hidden = !s.hidden; }); })}>👁</button>
              <select className="rb-sel" value="" title="Transition for selected"
                onChange={(e) => { if (e.target.value) sorterSetTransition(e.target.value); e.target.value = ""; }}>
                <option value="">Transition…</option>
                <option value="none">None</option>
                <option value="fade">Fade</option><option value="slide">Slide</option><option value="push">Push</option>
                <option value="cover">Cover</option><option value="wipe">Wipe</option><option value="split">Split</option>
                <option value="blinds">Blinds</option><option value="zoom">Zoom</option><option value="dissolve">Dissolve</option>
                <option value="morph">Morph</option><option value="flip">Flip</option>
              </select>
              <button className="rb" disabled={!sorterSel.size || deck.slides.length - sorterSel.size < 1} onClick={sorterDelete} title="Delete selected">🗑</button>
              <button className="rb" style={{ marginLeft: "auto" }} onClick={() => setRailView("slides")}>Done</button>
            </div>
            <div className="sorter-grid">
              {deck.slides.map((s, i) => (
                <div key={s.id} className={`sorter-cell ${sorterSel.has(i) ? "sel" : ""} ${s.hidden ? "hidden" : ""}`}
                  draggable
                  onDragStart={() => { dragSlide.current = i; }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => { if (dragSlide.current != null) sorterMove(dragSlide.current, i); dragSlide.current = null; }}
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey) { const n = new Set(sorterSel); n.has(i) ? n.delete(i) : n.add(i); setSorterSel(n); }
                    else if (e.shiftKey && sorterSel.size) { const a = Math.min(...sorterSel); const n = new Set<number>(); for (let k = Math.min(a, i); k <= Math.max(a, i); k++) n.add(k); setSorterSel(n); }
                    else { setSorterSel(new Set([i])); setSlideIdx(i); }
                  }}
                  onDoubleClick={() => { setSlideIdx(i); setRailView("slides"); }}>
                  <div className="sorter-thumb" style={{ width: dims.w * 0.19, height: dims.h * 0.19 }}>
                    <SlideCanvas slide={s} theme={theme} scale={0.19} selection={new Set()} under={underObjs(s)} size={dims} />
                  </div>
                  <div className="sorter-meta">
                    <span>{i + 1}</span>
                    {s.transition && s.transition.type !== "none" && <span className="sorter-t" title={`Transition: ${s.transition.type}`}>⚡{s.transition.type}</span>}
                    {s.hidden && <span title="Hidden">∅</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
        <div className="canvas-col">
          <div className="canvas-wrap" ref={canvasWrap}
            onPointerDown={canvasDown} onPointerMove={canvasMove}
            onPointerUp={canvasUp} onPointerCancel={canvasUp}>
            <div style={{ width: dims.w * zoom, height: dims.h * zoom, position: "relative", boxShadow: "0 16px 48px rgba(23,18,15,.18)" }}>
              <SlideCanvas slide={editSlide} theme={theme} scale={zoom} interactive size={dims}
                under={masterView === "off" ? underObjs(slide) : undefined}
                canEdit={canEdit} selection={selection} onSelect={handleSelect}
                onPatch={onPatch} onTextCommit={onTextCommit}
                onTableCommit={onTableCommit} onObjDblClick={onObjDblClick}
                onEditingChange={setEditingObj}
                cropId={cropId} onCropChange={setCropId} />
              {deck.showGrid && <div className="slide-grid" style={{ backgroundSize: `${40 * zoom}px ${40 * zoom}px` }} />}
              {(deck.showRuler || (deck.guides?.v?.length ?? 0) > 0 || (deck.guides?.h?.length ?? 0) > 0) && canEdit && (
                <GuidesLayer zoom={zoom} deck={deck} mutate={mutate} rulerOn={!!deck.showRuler} />
              )}
            </div>
          </div>
          <textarea className="notes-box" placeholder="Speaker notes…" disabled={!canEdit}
            value={slide.notes ?? ""}
            onChange={(e) => mutateSlide((s) => { s.notes = e.target.value; }, `notes:${slide.id}`)} />
        </div>
        )}
      </div>

      {/* print overlay for PDF export (portal so print CSS can hide the app) — P4.5 layouts */}
      {printing && createPortal(
        <div className="print-deck">
          {printLayout === "slides" && deck.slides.map((s) => (
            <div key={s.id} className="print-slide" style={{ width: dims.w, height: dims.h, position: "relative", overflow: "hidden" }}>
              <SlideCanvas slide={s} theme={theme} scale={1} selection={new Set()} under={underObjs(s)} size={dims} />
            </div>
          ))}
          {printLayout === "notes" && deck.slides.map((s, i) => (
            <div key={s.id} className="print-notes-page">
              <div className="pn-slide" style={{ width: dims.w * 0.55, height: dims.h * 0.55, position: "relative", overflow: "hidden" }}>
                <SlideCanvas slide={s} theme={theme} scale={0.55} selection={new Set()} under={underObjs(s)} size={dims} />
              </div>
              <div className="pn-num">Slide {i + 1}</div>
              <div className="pn-notes">{s.notes || <i style={{ color: "var(--muted)" }}>No speaker notes</i>}</div>
            </div>
          ))}
          {printLayout.startsWith("handout") && (() => {
            const per = printLayout === "handout2" ? 2 : printLayout === "handout4" ? 4 : 6;
            const pages: Slide[][] = [];
            for (let i = 0; i < deck.slides.length; i += per) pages.push(deck.slides.slice(i, i + per));
            const tw = per === 2 ? 620 : per === 4 ? 360 : 240;
            return pages.map((pg, pi) => (
              <div key={pi} className="print-handout-page" style={{ gridTemplateColumns: `repeat(${per === 2 ? 1 : per === 4 ? 2 : 3}, ${tw}px)` }}>
                {pg.map((s, si) => {
                  const gi = pi * per + si;
                  return (
                    <div key={s.id} className="ph-cell">
                      <div className="ph-slide" style={{ width: tw, height: Math.round(tw * dims.h / dims.w), position: "relative", overflow: "hidden" }}>
                        <SlideCanvas slide={s} theme={theme} scale={tw / dims.w} selection={new Set()} under={underObjs(s)} size={dims} />
                      </div>
                      <span className="ph-num">{gi + 1}</span>
                    </div>
                  );
                })}
              </div>
            ));
          })()}
        </div>,
        document.body,
      )}

      {presenting !== "none" && (
        <Presenter deck={deck} theme={theme} startIndex={Math.min(presStart ?? slideIdx, (activeShow?.length ?? deck.slides.length) - 1)}
          presenterView={presenting === "presenter"} showSlides={activeShow}
          onRehearsed={(times) => mutate((d) => { for (const [k, v] of Object.entries(times)) d.slides[+k].advanceAfter = v; })}
          onClose={() => { setPresenting("none"); setActiveShow(undefined); setPresStart(null); }} />
      )}

      {showDlg && (
        <ShowsDialog deck={deck} mutate={mutate} onClose={() => setShowDlg(false)}
          onPlay={(slides) => { setActiveShow(slides); setPresenting("present"); setShowDlg(false); }} />
      )}

      {/* table dialog */}
      {tableDlg && (
        <TableDialog initial={tableDlg.id ? slide.objects.find((o) => o.id === tableDlg.id)?.table : undefined}
          onClose={() => setTableDlg(null)}
          onSave={(rows) => {
            if (tableDlg.id) mutateSlide((s) => { const o = s.objects.find((x) => x.id === tableDlg.id); if (o) o.table = rows; });
            else addObject({ type: "table", table: rows, x: 160, y: 140, w: 560, h: 200, fontSize: 15, color: theme.ink });
            setTableDlg(null);
          }} />
      )}
      {/* chart dialog */}
      {chartDlg && (
        <ChartDialog initial={chartDlg.id ? slide.objects.find((o) => o.id === chartDlg.id)?.chart : undefined}
          onClose={() => setChartDlg(null)}
          onSave={(chart) => {
            if (chartDlg.id) mutateSlide((s) => { const o = s.objects.find((x) => x.id === chartDlg.id); if (o) o.chart = chart; });
            else addObject({ type: "chart", chart, x: 180, y: 120, w: 560, h: 340 });
            setChartDlg(null);
          }} />
      )}

      {panel === "objects" && (
        <div className="side-panel">
          <div className="sp-head">
            <h3>Objects — slide {slideIdx + 1}</h3>
            <button className="sp-close" onClick={() => setPanel("none")}>✕</button>
          </div>
          <div className="sp-body">
            {[...slide.objects].sort((a, b) => b.z - a.z).map((o) => (
              <div key={o.id} className={`obj-row ${selection.has(o.id) ? "sel" : ""} ${o.hidden ? "obj-hidden" : ""}`}
                onClick={(e) => {
                  const grp = o.groupId ? slide.objects.filter((x) => x.groupId === o.groupId) : [o];
                  const next = e.shiftKey ? new Set(selection) : new Set<string>();
                  grp.forEach((g) => next.add(g.id));
                  setSelection(next);
                }}>
                <span className="obj-ico">{o.type === "text" ? "T" : o.type === "shape" ? "▭" : o.type === "image" ? "🖼" : o.type === "table" ? "⊞" : o.type === "chart" ? "📊" : o.type === "media" ? "🎬" : "╱"}</span>
                {renameId === o.id ? (
                  <input className="obj-rename" autoFocus defaultValue={o.name ?? objName(o, slide.objects.indexOf(o))}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenameId(null); e.stopPropagation(); }}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      mutateSlide((s) => { const x = s.objects.find((y) => y.id === o.id); if (x) x.name = v || undefined; });
                      setRenameId(null);
                    }} />
                ) : (
                  <span className="obj-name" title="Double-click to rename"
                    onDoubleClick={(e) => { e.stopPropagation(); setRenameId(o.id); }}>
                    {o.name ?? objName(o, slide.objects.indexOf(o))}
                  </span>
                )}
                {o.anim && <span className="obj-anim" title={`Animates on click ${o.anim.order}`}>✦{o.anim.order}</span>}
                <span className="obj-ops" onClick={(e) => e.stopPropagation()}>
                  <button title={o.hidden ? "Show object" : "Hide object"} className={o.hidden ? "on" : ""}
                    onClick={() => mutateSlide((s) => { const x = s.objects.find((y) => y.id === o.id); if (x) x.hidden = !x.hidden; })}>
                    {o.hidden ? "🚫" : "👁"}
                  </button>
                  <button title="Rename" onClick={() => setRenameId(o.id)}>✎</button>
                  <button title="Raise" onClick={() => { setSelection(new Set([o.id])); setZ("up", new Set([o.id])); }}>↑</button>
                  <button title="Lower" onClick={() => { setSelection(new Set([o.id])); setZ("down", new Set([o.id])); }}>↓</button>
                  <button title="Delete" onClick={() => delSelected(new Set([o.id]))}>✕</button>
                </span>
                {selection.has(o.id) && (o.type === "image" || o.type === "media" || o.type === "shape") && (
                  <input className="obj-alt" placeholder="Alt text (accessibility)…" defaultValue={o.alt ?? ""}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); e.stopPropagation(); }}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      mutateSlide((s) => { const x = s.objects.find((y) => y.id === o.id); if (x) x.alt = v || undefined; });
                    }} />
                )}
              </div>
            ))}
            {!slide.objects.length && <div className="empty">No objects on this slide</div>}
          </div>
        </div>
      )}
      {panel === "anim" && (
        <div className="side-panel">
          <div className="sp-head">
            <h3>Animations — slide {slideIdx + 1}</h3>
            <button className="sp-close" onClick={() => setPanel("none")}>✕</button>
          </div>
          <div className="sp-body">
            {editSlide.objects.filter((o) => o.anim).sort((a, b) => a.anim!.order - b.anim!.order).map((o) => (
              <div key={o.id} className={`obj-row ${selection.has(o.id) ? "sel" : ""}`} style={{ flexWrap: "wrap", rowGap: 4 }}
                onClick={() => setSelection(new Set([o.id]))}>
                <span className="obj-anim" title={`Order ${o.anim!.order}`}>✦{o.anim!.order}</span>
                <span className="obj-name">
                  {animKind(o.anim!.type) === "exit" ? "↗" : animKind(o.anim!.type) === "emphasis" ? "◎" : animKind(o.anim!.type) === "path" ? "⤳" : "➤"} {o.anim!.type}
                  <span style={{ color: "var(--muted)", fontWeight: 400 }}> · {objName(o, editSlide.objects.indexOf(o))}</span>
                </span>
                <span className="obj-ops" onClick={(e) => e.stopPropagation()}>
                  <button title="Move earlier" onClick={() => moveAnim(o.id, -1)}>↑</button>
                  <button title="Move later" onClick={() => moveAnim(o.id, 1)}>↓</button>
                  <button title="Remove animation" onClick={() => mutateSlide((s) => { const x = s.objects.find((v) => v.id === o.id); if (x) x.anim = undefined; })}>✕</button>
                </span>
                <div className="anim-fields" onClick={(e) => e.stopPropagation()}>
                  <select value={o.anim!.trigger ?? "click"} title="Trigger"
                    onChange={(e) => patchAnim(o.id, { trigger: e.target.value as "click" | "with" | "after" })}>
                    <option value="click">On click</option>
                    <option value="with">With previous</option>
                    <option value="after">After previous</option>
                  </select>
                  <input type="number" min={50} step={50} value={o.anim!.duration ?? 450} title="Duration (ms)"
                    onChange={(e) => patchAnim(o.id, { duration: Math.max(50, Number(e.target.value) || 450) })} />
                  {(o.anim!.trigger ?? "click") !== "after" && (
                    <input type="number" min={0} step={50} value={o.anim!.delay ?? 0} title="Delay (ms)"
                      onChange={(e) => patchAnim(o.id, { delay: Math.max(0, Number(e.target.value) || 0) })} />
                  )}
                </div>
              </div>
            ))}
            {!editSlide.objects.some((o) => o.anim) && <div className="empty">No animations on this slide — select an object and pick an effect in the ribbon.</div>}
          </div>
        </div>
      )}
      {panel === "comments" && (
        <CommentsPanel fileId={item.id} comments={comments}
          canComment={canEdit || permission === "commenter" || permission === "reviewer"}
          onReload={loadComments}
          onAnchorClick={(a) => { const n = Number(a.split(":")[1]); if (!isNaN(n)) setSlideIdx(n - 1); }}
          onNewComment={submitComment} newCommentOpen={newComment}
          onCancelNew={() => { setNewComment(false); setPanel("none"); }}
          toast={toast} />
      )}
      {panel === "versions" && (
        <VersionsPanel item={item} onClose={() => setPanel("none")}
          onRestore={async () => {
            const r = await api.get<{ content: { deck: Deck } }>(`/api/files/${item.id}/content`);
            if (r.content?.deck) setDeck(r.content.deck);
          }} toast={toast} />
      )}
      {panel === "ai" && (
        <AiPanel fileId={item.id} kind="present" canEdit={canEdit}
          serialize={aiSerialize}
          selection={() => `Slide ${slideIdx + 1}`}
          applyOps={aiApplyOps} onClose={() => setPanel("none")} toast={toast} />
      )}
      {sharing && <ShareDialog item={item} onClose={() => setSharing(false)} toast={toast} />}
      {msg && <div className="toast">{msg}</div>}
    </div>
  );
}

// ---------- dialogs ----------

function TableDialog({ initial, onSave, onClose }: {
  initial?: string[][];
  onSave: (rows: string[][]) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<string[][]>(initial ?? [["Header 1", "Header 2", "Header 3"], ["", "", ""], ["", "", ""]]);
  const set = (r: number, c: number, v: string) => setRows((rs) => rs.map((row, i) => i === r ? row.map((cell, j) => j === c ? v : cell) : row));
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <h3>{initial ? "Edit table" : "Insert table"}</h3>
        <div className="tbl-edit">
          {rows.map((row, i) => (
            <div key={i} style={{ display: "flex", gap: 4, marginBottom: 4 }}>
              {row.map((cell, j) => (
                <input key={j} value={cell} onChange={(e) => set(i, j, e.target.value)}
                  style={{ flex: 1, height: 30, border: "1px solid var(--line)", borderRadius: 7, padding: "0 8px", fontSize: 12 }} />
              ))}
              <button className="rb" onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))}>✕</button>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button className="btn-ghost btn-sm" onClick={() => setRows((rs) => [...rs, rs[0].map(() => "")])}>+ Row</button>
          <button className="btn-ghost btn-sm" onClick={() => setRows((rs) => rs.map((r) => [...r, ""]))}>+ Col</button>
          <div style={{ flex: 1 }} />
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={() => onSave(rows)}>Save</button>
        </div>
      </div>
    </div>
  );
}

function ChartDialog({ initial, onSave, onClose }: {
  initial?: SlideObject["chart"];
  onSave: (c: NonNullable<SlideObject["chart"]>) => void;
  onClose: () => void;
}) {
  const [type, setType] = useState(initial?.type ?? "bar");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [data, setData] = useState(() =>
    initial
      ? initial.labels.map((l, i) => [l, ...chartSeries(initial).map((s) => s.values[i] ?? 0)].join(",")).join("\n")
      : "Q1,24\nQ2,38\nQ3,31\nQ4,45",
  );
  const save = () => {
    const labels: string[] = [];
    const cols: number[][] = [];
    for (const line of data.split("\n")) {
      const parts = line.split(",");
      if (!parts[0]?.trim()) continue;
      labels.push(parts[0].trim());
      if (parts.length === 1) (cols[0] ??= []).push(0);
      parts.slice(1).forEach((p, ci) => { (cols[ci] ??= []).push(Number(p) || 0); });
    }
    const series = (cols.length ? cols : [labels.map(() => 0)]).map((values, i) => ({ name: `Series ${i + 1}`, values }));
    onSave({ type: type as "bar" | "line" | "pie", labels, series, title: title || undefined });
  };
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()}>
        <h3>{initial ? "Edit chart" : "Insert chart"}</h3>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          {(["bar", "line", "pie"] as const).map((t) => (
            <button key={t} className={`btn-ghost btn-sm ${type === t ? "on" : ""}`} style={{ textTransform: "capitalize" }}
              onClick={() => setType(t)}>{t}</button>
          ))}
        </div>
        <input placeholder="Chart title" value={title} onChange={(e) => setTitle(e.target.value)}
          style={{ width: "100%", height: 32, border: "1px solid var(--line)", borderRadius: 8, padding: "0 10px", fontSize: 12, marginTop: 10 }} />
        <textarea value={data} onChange={(e) => setData(e.target.value)} rows={6}
          placeholder="label,series1,series2,… per line"
          style={{ width: "100%", border: "1px solid var(--line)", borderRadius: 8, padding: 8, fontSize: 12, marginTop: 10, fontFamily: "monospace" }} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ---------- P5.4 guides layer — rulers + draggable guide lines ----------
function GuidesLayer({ zoom, deck, mutate, rulerOn }: {
  zoom: number;
  deck: Deck;
  mutate: (fn: (d: Deck) => void, actionKey?: string) => void;
  rulerOn: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ axis: "v" | "h"; idx: number } | null>(null);
  const pt = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = pt(e);
    mutate((dk) => {
      const g = dk.guides!;
      const arr = (d.axis === "v" ? g.v : g.h)!;
      arr[d.idx] = Math.round(d.axis === "v" ? p.x : p.y);
    }, `guide:${d.axis}:${d.idx}`);
  };
  const onUp = () => { drag.current = null; };
  const startGuide = (axis: "v" | "h", idx: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    drag.current = { axis, idx };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const fromRuler = (axis: "v" | "h") => (e: React.PointerEvent) => {
    const p = pt(e);
    let idx = 0;
    mutate((dk) => {
      const g = (dk.guides ??= {});
      const arr = (axis === "v" ? (g.v ??= []) : (g.h ??= []));
      idx = arr.push(Math.round(axis === "v" ? p.x : p.y)) - 1;
    });
    drag.current = { axis, idx };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const delGuide = (axis: "v" | "h", idx: number) =>
    mutate((d) => { const g = d.guides!; const arr = (axis === "v" ? g.v : g.h)!; arr.splice(idx, 1); });

  return (
    <div ref={box} className="guides-layer" onPointerMove={onMove} onPointerUp={onUp}>
      {rulerOn && (
        <>
          <div className="ruler ruler-h" title="Drag down to create a horizontal guide"
            onPointerDown={fromRuler("h")} onPointerMove={onMove} onPointerUp={onUp}
            style={{ backgroundSize: `${40 * zoom}px 100%` }} />
          <div className="ruler ruler-v" title="Drag right to create a vertical guide"
            onPointerDown={fromRuler("v")} onPointerMove={onMove} onPointerUp={onUp}
            style={{ backgroundSize: `100% ${40 * zoom}px` }} />
        </>
      )}
      {(deck.guides?.v ?? []).map((x, i) => (
        <div key={`v${i}`} className="gline gline-v" style={{ left: x * zoom }}
          title="Drag to move — double-click to delete"
          onPointerDown={startGuide("v", i)} onDoubleClick={() => delGuide("v", i)} />
      ))}
      {(deck.guides?.h ?? []).map((y, i) => (
        <div key={`h${i}`} className="gline gline-h" style={{ top: y * zoom }}
          title="Drag to move — double-click to delete"
          onPointerDown={startGuide("h", i)} onDoubleClick={() => delGuide("h", i)} />
      ))}
    </div>
  );
}

// ---------- P5.3 custom shows manager ----------
function ShowsDialog({ deck, mutate, onPlay, onClose }: {
  deck: Deck;
  mutate: (fn: (d: Deck) => void) => void;
  onPlay: (slides: number[]) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const shows = deck.shows ?? [];
  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
        <h3>Custom slide shows</h3>
        {shows.map((s, i) => (
          <div key={i} className="obj-row" style={{ marginBottom: 4 }}>
            <span className="obj-name">{s.name}</span>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>{s.slides.length} slides</span>
            <span className="obj-ops">
              <button title="Present this show" onClick={() => onPlay(s.slides)}>▶</button>
              <button title="Delete show" onClick={() => mutate((d) => { d.shows!.splice(i, 1); })}>✕</button>
            </span>
          </div>
        ))}
        {!shows.length && <div className="empty">No custom shows yet</div>}
        <div style={{ borderTop: "1px solid var(--line)", marginTop: 10, paddingTop: 10 }}>
          <input className="fb-in" style={{ width: "100%", marginBottom: 8 }} placeholder="New show name…"
            value={name} onChange={(e) => setName(e.target.value)} />
          <div style={{ maxHeight: 220, overflowY: "auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
            {deck.slides.map((s, i) => (
              <label key={s.id} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, padding: "3px 4px", borderRadius: 5, cursor: "pointer" }}>
                <input type="checkbox" checked={picked.has(i)}
                  onChange={(e) => { const n = new Set(picked); e.target.checked ? n.add(i) : n.delete(i); setPicked(n); }} />
                <span>Slide {i + 1}{s.hidden ? " (hidden)" : ""}</span>
              </label>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button className="btn-ghost btn-sm" onClick={() => setPicked(new Set(deck.slides.map((_, i) => i)))}>All</button>
            <button className="btn-ghost btn-sm" onClick={() => setPicked(new Set())}>None</button>
            <div style={{ flex: 1 }} />
            <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
            <button className="btn-primary btn-sm" disabled={!name.trim() || !picked.size}
              onClick={() => {
                mutate((d) => { (d.shows ??= []).push({ name: name.trim(), slides: [...picked].sort((a, b) => a - b) }); });
                setName(""); setPicked(new Set());
              }}>Save show</button>
          </div>
        </div>
      </div>
    </div>
  );
}
