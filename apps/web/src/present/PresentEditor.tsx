import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { Comment, DriveItem } from "@kreatix/shared";
import { api } from "../lib/api";
import { useCollabSession, useMapSync } from "../collab/useCollab";
import { PresenceBar } from "../collab/PresenceBar";
import { ShareDialog } from "../components/ShareDialog";
import { VersionsPanel } from "../components/VersionsPanel";
import { CommentsPanel } from "../components/CommentsPanel";
import { useToast } from "../pages/Home";
import type { Deck, Slide, SlideObject, TransitionType } from "./model";
import { THEMES, LAYOUTS, themeOf, newId, applyLayout, blankSlide, SLIDE_W, SLIDE_H, chartSeries } from "./model";
import { SlideCanvas, type ObjPatch } from "./SlideCanvas";
import { Presenter } from "./Presenter";
import { exportPptx } from "./export";
import { importPptx } from "./import";

type SaveState = "saved" | "saving" | "unsaved" | "error";

export function PresentEditor({ item, initialDoc, permission }: {
  item: DriveItem;
  initialDoc: unknown;
  permission: string;
}) {
  const navigate = useNavigate();
  const canEdit = permission === "owner" || permission === "editor";
  const { msg, toast } = useToast();
  const [title, setTitle] = useState(item.name);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [panel, setPanel] = useState<"none" | "comments" | "versions" | "objects">("none");
  const [sharing, setSharing] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState(false);
  const [presenting, setPresenting] = useState<"none" | "present" | "presenter">("none");
  const [printing, setPrinting] = useState(false);
  const [chartDlg, setChartDlg] = useState<{ id: string | null } | null>(null);
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
  const slide = deck.slides[Math.min(slideIdx, deck.slides.length - 1)];
  const selObjs = slide.objects.filter((o) => selection.has(o.id));
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
    try {
      await api.put(`/api/files/${item.id}/content${session ? "?collab=1" : ""}`, { content: payload });
      setSaveState("saved");
    } catch {
      setSaveState("error");
      toast("Could not save — will retry on next edit");
    }
  }, [item.id, session, toast]);

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
    mutate((d) => fn(d.slides[slideIdx]), actionKey);
  }, [mutate, slideIdx]);

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

  const onTableCommit = (id: string, rows: string[][]) => {
    mutateSlide((s) => { const o = s.objects.find((x) => x.id === id); if (o) o.table = rows; });
  };

  const onObjDblClick = (o: SlideObject) => {
    if (o.type === "chart") setChartDlg({ id: o.id });
  };

  const onImportPptx = async (f: File) => {
    try {
      const d = await importPptx(f);
      mutate((deck) => { deck.theme = d.theme; deck.customTheme = d.customTheme; deck.slides = d.slides; });
      setSlideIdx(0);
      setSelection(new Set());
      toast(`Imported ${d.slides.length} slide${d.slides.length === 1 ? "" : "s"} from ${f.name}`);
    } catch {
      toast("Could not read that .pptx file");
    }
  };

  const setTransition = (type: TransitionType) => {
    mutateSlide((s) => { s.transition = type === "none" ? undefined : { type, duration: 500 }; });
  };

  const setAnim = (type: string) => {
    mutateSlide((s) => s.objects.forEach((o) => {
      if (!selection.has(o.id)) return;
      if (!type) o.anim = undefined;
      else {
        const maxOrder = Math.max(0, ...s.objects.map((x) => x.anim?.order ?? 0));
        o.anim = { type: type as never, order: o.anim?.order ?? maxOrder + 1 };
      }
    }));
  };

  const objName = (o: SlideObject, i: number) =>
    o.type === "text" ? `Text ${i + 1}` : o.type === "shape" ? `${o.shape ?? "shape"} ${i + 1}`
      : `${o.type} ${i + 1}`;

  // ---- insert objects ----
  const insertText = () => addObject({ type: "text", x: 120, y: 120, w: 480, h: 60, html: "Double-click to edit", fontSize: 24, color: theme.ink });
  const insertShape = (shape: string) => addObject({ type: "shape", shape: shape as SlideObject["shape"], x: 200, y: 160, w: 240, h: 160, fill: theme.accent, stroke: "none" });
  const insertLine = () => addObject({ type: "line", x: 200, y: 240, w: 320, h: 40, x2: 320, y2: 0, stroke: theme.ink, strokeW: 2 });
  const insertImage = async (f: File) => {
    const src = await new Promise<string>((res) => {
      const r = new FileReader(); r.onload = () => res(r.result as string); r.readAsDataURL(f);
    });
    addObject({ type: "image", src, x: 160, y: 100, w: 480, h: 320 });
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
  const setLayout = (layoutId: string) => {
    mutate((d) => { d.slides[slideIdx] = applyLayout(d.slides[slideIdx], layoutId, theme); });
  };
  const setTheme = (themeId: string) => {
    if (themeId === "imported") return; // reselecting the active custom theme is a no-op
    mutate((d) => { d.theme = themeId; d.customTheme = undefined; d.slides.forEach((s) => { s.bg = THEMES.find((t) => t.id === themeId)?.bg ?? s.bg; }); });
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
      else if (e.key === "Escape") setSelection(new Set());
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") { e.preventDefault(); e.shiftKey ? ungroupSel() : groupSel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const fitZoom = () => {
    const el = canvasWrap.current;
    if (el) setZoom(Math.min((el.clientWidth - 60) / SLIDE_W, (el.clientHeight - 60) / SLIDE_H));
  };
  useEffect(fitZoom, []);

  const thumbScale = 0.145;
  const saveLabel: Record<SaveState, string> = {
    saved: "All changes saved", saving: "Saving…", unsaved: "Unsaved changes", error: "Save failed",
  };

  const selCount = selection.size;

  return (
    <div className="editor-shell present-shell">
      <div className="editor-top">
        <button className="back" onClick={() => navigate(-1)} title="Back">←</button>
        <div className="app-ico present" style={{ width: 34, height: 34, borderRadius: 10, fontSize: 13 }}>P</div>
        <input className="doc-title" value={title} disabled={!canEdit}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== item.name && rename(title.trim())}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        <span className={`save-state ${saveState === "saving" || saveState === "unsaved" ? "saving" : ""}`}>{saveLabel[saveState]}</span>
        {permission !== "owner" && <span className="perm-badge">{permission}</span>}
        <PresenceBar session={session} />
        <div className="spacer" />
        <button className="btn-ghost btn-sm" onClick={() => setPanel(panel === "comments" ? "none" : "comments")}>
          Comments{comments.length ? ` (${comments.length})` : ""}
        </button>
        <button className="btn-ghost btn-sm" onClick={() => setPanel(panel === "versions" ? "none" : "versions")}>History</button>
        <button className="btn-ghost btn-sm" onClick={() => setSharing(true)}>Share</button>
        <button className="btn-ghost btn-sm" onClick={() => pptxRef.current?.click()}>Import</button>
        <input ref={pptxRef} type="file" accept=".pptx" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportPptx(f); e.target.value = ""; }} />
        <button className="btn-ghost btn-sm" onClick={() => setPrinting(true)}>Export PDF</button>
        <button className="btn-ghost btn-sm" onClick={() => void exportPptx(deck, title).catch(() => toast("Export failed"))}>Export .pptx</button>
        <button className="btn-primary btn-sm" onClick={() => setPresenting("present")}>▶ Present</button>
      </div>

      {canEdit && (
        <div className="ribbon">
          <button className="rb" title="Undo" disabled={!undoStack.current.length} onClick={undo}>↶</button>
          <button className="rb" title="Redo" disabled={!redoStack.current.length} onClick={redo}>↷</button>
          <div className="rb-sep" />
          <select className="rb-sel" value="" title="Add slide with layout"
            onChange={(e) => { if (e.target.value) addSlide(e.target.value); e.target.value = ""; }}>
            <option value="">＋ Slide…</option>
            {LAYOUTS.filter((l) => l.id !== "blank").map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <button className="rb" title="Presenter view" style={{ fontSize: 11 }} onClick={() => setPresenting("presenter")}>🖥</button>
          <select className="rb-sel" value={slide.layout ?? "blank"} onChange={(e) => setLayout(e.target.value)} title="Layout (replaces objects)">
            {LAYOUTS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <select className="rb-sel" value={deck.customTheme ? "imported" : deck.theme ?? "kreatix"} onChange={(e) => setTheme(e.target.value)} title="Theme">
            {deck.customTheme && <option value="imported">Imported ({deck.customTheme.name})</option>}
            {THEMES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <div className="rb-sep" />
          <button className="rb" title="Text box" onClick={insertText}>T</button>
          <button className="rb" title="Rectangle" onClick={() => insertShape("rect")}>▭</button>
          <button className="rb" title="Ellipse" onClick={() => insertShape("ellipse")}>◯</button>
          <button className="rb" title="Triangle" onClick={() => insertShape("triangle")}>△</button>
          <button className="rb" title="Arrow" onClick={() => insertShape("arrow")}>➜</button>
          <button className="rb" title="Star" onClick={() => insertShape("star")}>★</button>
          <button className="rb" title="Line" onClick={insertLine}>╱</button>
          <button className="rb" title="Image" onClick={() => imageRef.current?.click()}>🖼</button>
          <button className="rb" title="Table" onClick={insertTable}>⊞</button>
          <button className="rb" title="Chart" onClick={insertChart}>📊</button>
          <button className="rb" title="Objects pane" onClick={() => setPanel(panel === "objects" ? "none" : "objects")}>☰</button>
          <select className="rb-sel" value={slide.transition?.type ?? "none"} title="Slide transition"
            onChange={(e) => setTransition(e.target.value as TransitionType)}>
            <option value="none">No transition</option>
            <option value="fade">Fade</option>
            <option value="slide">Slide</option>
            <option value="zoom">Zoom</option>
            <option value="push">Push</option>
          </select>
          <div className="rb-sep" />
          {firstSel?.type === "text" && (
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
          {(firstSel?.type === "shape" || firstSel?.type === "line") && (
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
          {selCount > 0 && (
            <select className="rb-sel" value={firstSel?.anim?.type ?? ""} title="Entrance animation"
              onChange={(e) => setAnim(e.target.value)}>
              <option value="">No animation</option>
              <option value="fade">Fade in</option>
              <option value="slide-up">Slide up</option>
              <option value="slide-left">Slide left</option>
              <option value="zoom">Zoom in</option>
              <option value="wipe">Wipe</option>
            </select>
          )}
          {selCount > 0 && <button className="rb" title="Delete" onClick={() => delSelected()}>⌫</button>}
          <div className="rb-sep" />
          <button className="rb" title="Add comment" onClick={() => { setNewComment(true); setPanel("comments"); }}>💬</button>
          <input ref={imageRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && void insertImage(e.target.files[0])} />
          <span style={{ marginLeft: "auto", display: "flex", gap: 4, alignItems: "center" }}>
            <select className="rb-sel" style={{ width: 76 }} value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
              {[0.4, 0.5, 0.6, 0.75, 1, 1.25].map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
            </select>
            <button className="rb" style={{ width: "auto", padding: "0 8px", fontSize: 11 }} onClick={fitZoom}>Fit</button>
          </span>
        </div>
      )}

      <div className="present-body" style={{ marginRight: panel !== "none" ? 330 : 0 }}>
        {/* slide rail */}
        <div className="slide-rail">
          {deck.slides.map((s, i) => (
            <div key={s.id} className={`rail-slide ${i === slideIdx ? "active" : ""}`}
              onClick={() => { setSlideIdx(i); setSelection(new Set()); }}>
              <span className="rail-num">{i + 1}</span>
              <div className="rail-thumb" style={{ width: SLIDE_W * thumbScale, height: SLIDE_H * thumbScale }}>
                <SlideCanvas slide={s} theme={theme} scale={thumbScale} selection={new Set()} />
              </div>
            </div>
          ))}
          {canEdit && (
            <div className="rail-ops">
              <button title="Add slide" onClick={() => addSlide()}>＋</button>
              <button title="Duplicate" onClick={dupSlide}>⧉</button>
              <button title="Move up" disabled={slideIdx === 0} onClick={() => moveSlide(-1)}>↑</button>
              <button title="Move down" disabled={slideIdx === deck.slides.length - 1} onClick={() => moveSlide(1)}>↓</button>
              <button title="Delete slide" onClick={delSlide}>✕</button>
            </div>
          )}
        </div>

        {/* canvas + notes */}
        <div className="canvas-col">
          <div className="canvas-wrap" ref={canvasWrap}>
            <div style={{ width: SLIDE_W * zoom, height: SLIDE_H * zoom, position: "relative", boxShadow: "0 16px 48px rgba(23,18,15,.18)" }}>
              <SlideCanvas slide={slide} theme={theme} scale={zoom} interactive
                canEdit={canEdit} selection={selection} onSelect={setSelection}
                onPatch={onPatch} onTextCommit={onTextCommit}
                onTableCommit={onTableCommit} onObjDblClick={onObjDblClick} />
            </div>
          </div>
          <textarea className="notes-box" placeholder="Speaker notes…" disabled={!canEdit}
            value={slide.notes ?? ""}
            onChange={(e) => mutateSlide((s) => { s.notes = e.target.value; }, `notes:${slide.id}`)} />
        </div>
      </div>

      {/* print overlay for PDF export (portal so print CSS can hide the app) */}
      {printing && createPortal(
        <div className="print-deck">
          {deck.slides.map((s) => (
            <div key={s.id} className="print-slide" style={{ width: SLIDE_W, height: SLIDE_H, position: "relative", overflow: "hidden" }}>
              <SlideCanvas slide={s} theme={theme} scale={1} selection={new Set()} />
            </div>
          ))}
        </div>,
        document.body,
      )}

      {presenting !== "none" && (
        <Presenter deck={deck} theme={theme} startIndex={slideIdx}
          presenterView={presenting === "presenter"} onClose={() => setPresenting("none")} />
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
              <div key={o.id} className={`obj-row ${selection.has(o.id) ? "sel" : ""}`}
                onClick={(e) => {
                  const grp = o.groupId ? slide.objects.filter((x) => x.groupId === o.groupId) : [o];
                  const next = e.shiftKey ? new Set(selection) : new Set<string>();
                  grp.forEach((g) => next.add(g.id));
                  setSelection(next);
                }}>
                <span className="obj-ico">{o.type === "text" ? "T" : o.type === "shape" ? "▭" : o.type === "image" ? "🖼" : o.type === "table" ? "⊞" : o.type === "chart" ? "📊" : "╱"}</span>
                <span className="obj-name">{objName(o, slide.objects.indexOf(o))}</span>
                {o.anim && <span className="obj-anim" title={`Animates on click ${o.anim.order}`}>✦{o.anim.order}</span>}
                <span className="obj-ops">
                  <button title="Raise" onClick={(e) => { e.stopPropagation(); setSelection(new Set([o.id])); setZ("up", new Set([o.id])); }}>↑</button>
                  <button title="Lower" onClick={(e) => { e.stopPropagation(); setSelection(new Set([o.id])); setZ("down", new Set([o.id])); }}>↓</button>
                  <button title="Delete" onClick={(e) => { e.stopPropagation(); delSelected(new Set([o.id])); }}>✕</button>
                </span>
              </div>
            ))}
            {!slide.objects.length && <div className="empty">No objects on this slide</div>}
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
