import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type * as pdfjsTypes from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import type { DriveItem, Comment } from "@kreatix/shared";
import { api, getToken } from "../lib/api";
import { saveContent } from "../lib/drafts";
import { useCollabSession, useMapSync } from "../collab/useCollab";
import { AiPanel, type AiOp } from "../ai/AiPanel";
import { PresenceBar } from "../collab/PresenceBar";
import { ShareDialog } from "../components/ShareDialog";
import { VersionsPanel } from "../components/VersionsPanel";
import { CommentsPanel } from "../components/CommentsPanel";
import { useToast } from "../pages/Home";
import { useAuth } from "../lib/auth";
import type { PdfAnn, PdfDoc, AnnType, PdfField, FieldKind } from "./model";
import { emptyPdfDoc, STAMPS } from "./model";
import { remapAnns, reorganizePdf, mergePdf, extractPages, splitPdf, downloadPdf } from "./pages";
const flattenMod = () => import("./flatten");

// pdf.js is heavy (~430KB) — lazy-loaded only when a PDF is actually opened
let pdfjs!: typeof pdfjsTypes;
let pdfjsReady: Promise<void> | null = null;
const ensurePdfjs = () => (pdfjsReady ??= import("pdfjs-dist").then((m) => {
  pdfjs = m;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
}));

type SaveState = "saved" | "saving" | "unsaved" | "error";
type Tool = "select" | AnnType | "pan" | "zoombox" | "measure" | "edittext" | "field";
const SIG_KEY = "kx.signature";
type Panel = "none" | "thumbs" | "outline" | "search" | "anns" | "comments" | "versions" | "ai" | "organize";
type Rect4 = [number, number, number, number];

const TOOLS: { id: Tool; ico: string; label: string }[] = [
  { id: "select", ico: "➤", label: "Select / move annotations" },
  { id: "highlight", ico: "🖍", label: "Highlight text (select text, or drag a region)" },
  { id: "underline", ico: "U̲", label: "Underline text" },
  { id: "strikeout", ico: "S̶", label: "Strikeout text" },
  { id: "squiggly", ico: "≋", label: "Squiggly underline" },
  { id: "freehand", ico: "✏", label: "Freehand draw" },
  { id: "polyline", ico: "⛓", label: "Polyline — click vertices, double-click to finish" },
  { id: "rect", ico: "▭", label: "Rectangle" },
  { id: "ellipse", ico: "◯", label: "Ellipse" },
  { id: "line", ico: "╱", label: "Line" },
  { id: "arrow", ico: "↗", label: "Arrow" },
  { id: "callout", ico: "🗨", label: "Callout — box with a tail to the point you drag from" },
  { id: "cloud", ico: "☁", label: "Cloud" },
  { id: "measure", ico: "📏", label: "Measure — drag to measure distance" },
  { id: "edittext", ico: "✎T", label: "Edit text — drag over a text block to retype it" },
  { id: "image", ico: "🖼", label: "Insert image — drag a box, then pick a file" },
  { id: "whiteout", ico: "▨", label: "White-out — erase content under a white block" },
  { id: "field", ico: "▣", label: "Form field — drag to place a fillable field" },
  { id: "note", ico: "💬", label: "Sticky note" },
  { id: "textbox", ico: "T", label: "Text box" },
  { id: "stamp", ico: "✅", label: "Stamp" },
  { id: "sign", ico: "✍", label: "Signature — draw or type, then click the page to place" },
];
const MARKUP_COLORS = ["#FFD23F", "#F2782E", "#D84B57", "#1F9D66", "#3578E5", "#8E6BC8"];
const MARKUP_TOOLS = new Set<Tool>(["highlight", "underline", "strikeout", "squiggly", "freehand", "polyline", "rect", "ellipse", "line", "arrow", "callout", "cloud", "note", "textbox", "stamp", "measure", "edittext", "image", "whiteout"]);

// minimal LinkService stub — external links open in a new tab, internal dests go nowhere (we use our own nav)
const LINK_SERVICE = {
  externalLinkEnabled: true,
  getDestinationHash: () => "#",
  getAnchorUrl: () => "#",
  addLinkAttributes: (a: HTMLAnchorElement) => { a.target = "_blank"; a.rel = "noopener noreferrer"; },
  goToDestination: () => Promise.resolve(),
  goToPage: () => Promise.resolve(),
};

interface OutlineNode { title: string; dest: unknown; items?: OutlineNode[] }

export function PdfEditor({ item, initialDoc, permission }: {
  item: DriveItem;
  initialDoc: unknown;
  permission: string;
}) {
  const { msg, toast } = useToast();
  const { user } = useAuth();
  const canEdit = permission === "owner" || permission === "editor";
  const [title, setTitle] = useState(item.name);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [panel, setPanel] = useState<Panel>("thumbs");
  const [sharing, setSharing] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState(false);

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [annDoc, setAnnDoc] = useState<PdfDoc>(emptyPdfDoc());
  const [loadErr, setLoadErr] = useState("");
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.1);
  const [curPage, setCurPage] = useState(1);
  const [tool, setTool] = useState<Tool>("select");
  const [toolColor, setToolColor] = useState("#FFD23F");
  const [stampText, setStampText] = useState(STAMPS[0]);
  const [sigImg, setSigImg] = useState<string | null>(() => localStorage.getItem(SIG_KEY));
  const [sigPadOpen, setSigPadOpen] = useState(false);
  const [fieldKind, setFieldKind] = useState<FieldKind>("text");
  const [selField, setSelField] = useState<string | null>(null);
  // PDF-3 — view depth
  const [viewMode, setViewMode] = useState<"cont" | "single" | "two">("cont");
  const [viewRot, setViewRot] = useState(0);       // session-only rotation, degrees
  const [dark, setDark] = useState(false);
  const [selAnn, setSelAnn] = useState<string | null>(null);
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  const [printing, setPrinting] = useState(false);
  const [exportDlg, setExportDlg] = useState(false);
  const [pdfOpts, setPdfOpts] = useState<{ pageNumbers: boolean; watermark: string; header: string; footer: string }>
    ({ pageNumbers: false, watermark: "", header: "", footer: "" });

  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [matches, setMatches] = useState<{ page: number; snippet: string; rects: Rect4[] }[]>([]);
  const [matchIdx, setMatchIdx] = useState(-1);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // PDF-1 — undo entries pair the annotation doc with the pdf bytes of that
  // moment, so page-organization ops are undoable too
  const undoStack = useRef<{ d: PdfDoc; b: ArrayBuffer | null }[]>([]);
  const redoStack = useRef<{ d: PdfDoc; b: ArrayBuffer | null }[]>([]);
  const lastAction = useRef<string | null>(null);
  const pdfDataRef = useRef<ArrayBuffer | null>(null);
  const [pwPrompt, setPwPrompt] = useState<{ wrong: boolean } | null>(null);
  const [pwValue, setPwValue] = useState("");
  const pwCbRef = useRef<((pw: string) => void) | null>(null);
  const loadTaskRef = useRef<{ destroy: () => void } | null>(null);
  const mergeRef = useRef<HTMLInputElement>(null);
  const imgFileRef = useRef<HTMLInputElement>(null);
  const imgPending = useRef<{ page: number; rect: Rect4 } | null>(null);
  const session = useCollabSession(item.id);

  // ---------- load ----------
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        await ensurePdfjs();
        let bytes: ArrayBuffer | null = null;
        let anns = emptyPdfDoc();
        if (initialDoc instanceof Blob) {
          bytes = await initialDoc.arrayBuffer();
        } else {
          const c = initialDoc as PdfDoc | null;
          if (c?.kind === "pdf") anns = c;
          bytes = await (await api.get<Blob>(`/api/files/${item.id}/raw`)).arrayBuffer();
        }
        if (dead || !bytes) return;
        pdfDataRef.current = bytes;
        const task = pdfjs.getDocument({ data: bytes.slice(0) });
        loadTaskRef.current = task;
        task.onPassword = (cb: (pw: string) => void, reason: number) => {
          pwCbRef.current = cb;
          setPwPrompt({ wrong: reason === 2 });
        };
        const d = await task.promise;
        if (dead) { d.loadingTask.destroy(); return; }
        // restore saved form values into pdf.js storage before pages render
        if (anns.form) for (const [k, v] of Object.entries(anns.form)) {
          try { d.annotationStorage.setValue(k, v as Record<string, unknown>); } catch { /* skip */ }
        }
        setDoc(d);
        setNumPages(d.numPages);
        setAnnDoc(anns);
        d.getOutline().then((o) => !dead && setOutline((o as OutlineNode[]) ?? [])).catch(() => {});
      } catch {
        if (!dead) setLoadErr((e) => e || "Could not open this PDF (it may be encrypted or corrupted)");
      }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  // ---------- comments ----------
  const loadComments = useCallback(async () => {
    try { setComments((await api.get<{ comments: Comment[] }>(`/api/files/${item.id}/comments`)).comments); } catch { /* ignore */ }
  }, [item.id]);
  useEffect(() => { void loadComments(); }, [loadComments]);
  const submitComment = async (body: string) => {
    await api.post(`/api/files/${item.id}/comments`, { body, anchor: `page:${curPage}` });
    setNewComment(false);
    loadComments();
  };

  // ---------- save ----------
  const formValues = useCallback((): Record<string, unknown> => {
    const form: Record<string, unknown> = {};
    if (doc) for (const [k, v] of doc.annotationStorage) form[k] = v;
    return form;
  }, [doc]);

  const flushSave = useCallback(async () => {
    setSaveState("saving");
    const form = formValues();
    const ok = await saveContent(item.id,
      { ...annDoc, form: Object.keys(form).length ? form : annDoc.form }, !!session);
    setSaveState(ok ? "saved" : "error");
  }, [annDoc, formValues, item.id, session]);

  // replay pending saves when connectivity returns (annDoc holds latest edits)
  useEffect(() => {
    const on = () => { void flushSave(); };
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, [flushSave]);

  const scheduleSave = useCallback(() => {
    setSaveState("unsaved");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, 1500);
  }, [flushSave]);

  const rename = async () => {
    const t = title.trim();
    if (!t || t === item.name) return;
    try { await api.patch(`/api/drive/${item.id}`, { name: t }); } catch { toast("Rename failed"); }
  };

  // ---------- annotation mutations (undo stacks) ----------
  const mutate = useCallback((fn: (d: PdfDoc) => void, actionKey?: string) => {
    setAnnDoc((prev) => {
      const next = structuredClone(prev);
      fn(next);
      if (!actionKey || lastAction.current !== actionKey) {
        undoStack.current.push({ d: prev, b: pdfDataRef.current });
        if (undoStack.current.length > 80) undoStack.current.shift();
        lastAction.current = actionKey ?? null;
      }
      redoStack.current = [];
      return next;
    });
    scheduleSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // PDF-1 — reload pdf.js from new bytes (page ops rebuild the document)
  const [docGen, setDocGen] = useState(0);
  const reloadPdf = useCallback(async (bytes: ArrayBuffer) => {
    pdfDataRef.current = bytes;
    pageTextCache.current.clear();
    const task = pdfjs.getDocument({ data: bytes.slice(0) });
    loadTaskRef.current = task;
    const d = await task.promise;
    // restore saved form values so widgets repaint with data
    const form = annDoc.form;
    if (form) for (const [k, v] of Object.entries(form)) {
      try { d.annotationStorage.setValue(k, v as Record<string, unknown>); } catch { /* skip */ }
    }
    setDoc(d);
    setNumPages(d.numPages);
    d.getOutline().then((o) => setOutline((o as OutlineNode[]) ?? [])).catch(() => {});
    setDocGen((g) => g + 1); // forces PdfPage remount — they cache PDFPageProxy
  }, [annDoc.form]);

  const persistBytes = useCallback(async (bytes: ArrayBuffer, label: string) => {
    try {
      const headers: Record<string, string> = { "content-type": "application/pdf" };
      const t = getToken();
      if (t) headers.authorization = `Bearer ${t}`;
      const res = await fetch(`/api/files/${item.id}/pdf-bytes?label=${encodeURIComponent(label)}`, {
        method: "PUT", headers, body: bytes,
      });
      if (!res.ok) throw new Error();
    } catch { toast("Could not persist the edited PDF"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  // apply a page reorganization: new bytes + remapped anns, one undo entry, persist both
  const applyOrganize = useCallback(async (
    order: ({ src: number } | { blank: { w: number; h: number } })[],
    rots: Map<number, number>,
    rotDims: Map<number, { deg: number; w: number; h: number }>,
    label: string,
  ) => {
    const bytes = pdfDataRef.current;
    if (!bytes || !doc) return;
    try {
      const out = await reorganizePdf(bytes, order, rots);
      const newBytes = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
      mutate((d) => { d.annotations = remapAnns(d.annotations, order.map((e) => "src" in e ? e.src : -1), rotDims); });
      await reloadPdf(newBytes);
      void persistBytes(newBytes, label);
      toast(label);
    } catch { toast("Page operation failed"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, mutate, reloadPdf, persistBytes]);

  // ---------- PDF-1: page organization ----------
  const [orgSel, setOrgSel] = useState<Set<number>>(new Set());
  const dragPage = useRef<number | null>(null);

  const pageDims = async (p: number): Promise<{ w: number; h: number }> => {
    const pg = await doc!.getPage(p);
    const v = pg.getViewport({ scale: 1, rotation: 0 });
    return { w: v.width, h: v.height };
  };

  const identOrder = (n = numPages): ({ src: number } | { blank: { w: number; h: number } })[] =>
    Array.from({ length: n }, (_, i) => ({ src: i }));

  const orgReorder = (from: number, to: number) => {
    const order = identOrder();
    const [m] = order.splice(from, 1);
    order.splice(to, 0, m);
    void applyOrganize(order, new Map(), new Map(), `Moved page ${from + 1}`);
    setOrgSel(new Set([to + 1]));
  };
  const orgDelete = () => {
    const order = identOrder().filter((e) => "src" in e && !orgSel.has(e.src + 1));
    if (!order.length) { toast("Cannot delete every page"); return; }
    void applyOrganize(order, new Map(), new Map(), `Deleted ${orgSel.size} page${orgSel.size === 1 ? "" : "s"}`);
    setOrgSel(new Set());
  };
  const orgRotate = async (deg: number) => {
    const rots = new Map<number, number>();
    const rotDims = new Map<number, { deg: number; w: number; h: number }>();
    for (const p of orgSel) {
      const d = await pageDims(p);
      rots.set(p - 1, deg);
      rotDims.set(p - 1, { deg, ...d });
    }
    void applyOrganize(identOrder(), rots, rotDims, `Rotated ${orgSel.size} page${orgSel.size === 1 ? "" : "s"} ${deg}°`);
  };
  const orgInsertBlank = async () => {
    const d = await pageDims(curPage);
    const order = identOrder();
    order.splice(curPage, 0, { blank: d });
    void applyOrganize(order, new Map(), new Map(), "Inserted blank page");
  };
  const orgMerge = async (f: File) => {
    const bytes = pdfDataRef.current;
    if (!bytes) return;
    try {
      const { bytes: out, count } = await mergePdf(bytes, await f.arrayBuffer());
      const newBytes = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
      mutate(() => {}); // undo entry — anns unchanged, bytes snapshot differs
      await reloadPdf(newBytes);
      void persistBytes(newBytes, `Merged ${f.name}`);
      toast(`Merged ${count} page${count === 1 ? "" : "s"} from ${f.name}`);
    } catch { toast("Merge failed — is that a valid PDF?"); }
  };
  const orgExtract = async () => {
    const bytes = pdfDataRef.current;
    if (!bytes || !orgSel.size) return;
    const out = await extractPages(bytes, [...orgSel].sort((a, b) => a - b));
    downloadPdf(out, `${title.replace(/\.pdf$/i, "")}-extract.pdf`);
  };
  const orgSplit = async () => {
    const bytes = pdfDataRef.current;
    if (!bytes || curPage <= 1 || curPage > numPages) return;
    const [a, b] = await splitPdf(bytes, curPage, numPages);
    const base = title.replace(/\.pdf$/i, "");
    downloadPdf(a, `${base}-part1.pdf`);
    downloadPdf(b, `${base}-part2.pdf`);
    toast(`Split at page ${curPage}`);
  };

  const undo = useCallback(() => {
    const e = undoStack.current.pop();
    if (!e) return;
    lastAction.current = null;
    redoStack.current.push({ d: annDoc, b: pdfDataRef.current });
    setAnnDoc(e.d);
    if (e.b && e.b !== pdfDataRef.current) { void reloadPdf(e.b); void persistBytes(e.b, "Undo page edit"); }
    scheduleSave();
  }, [annDoc, reloadPdf, persistBytes]); // eslint-disable-line react-hooks/exhaustive-deps
  const redo = useCallback(() => {
    const e = redoStack.current.pop();
    if (!e) return;
    lastAction.current = null;
    undoStack.current.push({ d: annDoc, b: pdfDataRef.current });
    setAnnDoc(e.d);
    if (e.b && e.b !== pdfDataRef.current) { void reloadPdf(e.b); void persistBytes(e.b, "Redo page edit"); }
    scheduleSave();
  }, [annDoc, reloadPdf, persistBytes]); // eslint-disable-line react-hooks/exhaustive-deps

  const addAnn = (page: number, a: Omit<PdfAnn, "id" | "page" | "createdAt">) => {
    mutate((d) => d.annotations.push({ ...a, id: crypto.randomUUID().slice(0, 8), page,
      author: user?.displayName, createdAt: new Date().toISOString() }));
  };
  const delAnn = (id: string) => mutate((d) => { d.annotations = d.annotations.filter((a) => a.id !== id); });
  const patchAnn = (id: string, patch: Partial<PdfAnn>, actionKey?: string) =>
    mutate((d) => { const a = d.annotations.find((x) => x.id === id); if (a) Object.assign(a, patch); }, actionKey);
  const moveAnn = (id: string, dx: number, dy: number) =>
    mutate((d) => {
      const a = d.annotations.find((x) => x.id === id);
      if (!a) return;
      a.rects?.forEach((r) => { r[0] += dx; r[1] += dy; });
      a.points?.forEach((p) => { p[0] += dx; p[1] += dy; });
    }, `move:${id}`);

  // ---------- PDF-6: form fields ----------
  const addField = (page: number, rect: Rect4) =>
    mutate((d) => {
      d.fields ??= [];
      const n = d.fields.filter((f) => f.kind === fieldKind).length + 1;
      d.fields.push({ id: crypto.randomUUID().slice(0, 8), page, kind: fieldKind, rect,
        name: `${fieldKind}_${n}`, group: fieldKind === "radio" ? "radio_1" : undefined,
        options: fieldKind === "dropdown" || fieldKind === "list" ? ["Option 1", "Option 2"] : undefined });
    });
  const patchField = (id: string, p: Partial<PdfField>, key?: string) =>
    mutate((d) => { const f = d.fields?.find((x) => x.id === id); if (f) Object.assign(f, p); }, key);
  const delField = (id: string) => mutate((d) => { d.fields = (d.fields ?? []).filter((f) => f.id !== id); });
  const moveField = (id: string, dx: number, dy: number) =>
    mutate((d) => { const f = d.fields?.find((x) => x.id === id); if (f) { f.rect[0] += dx; f.rect[1] += dy; } }, `fmove:${id}`);
  const checkRadio = (f: PdfField) =>
    mutate((d) => {
      const grp = f.group ?? f.name;
      for (const x of d.fields ?? []) if (x.kind === "radio" && x.page === f.page && (x.group ?? x.name) === grp) x.value = x.id === f.id;
    });

  // ---------- collab: per-annotation keys + form values in a shared Y.Map ----------
  const applyRemoteRef = useRef<(changed: Map<string, string | null>) => void>(() => {});
  applyRemoteRef.current = (changed) => {
    setAnnDoc((prev) => {
      const next = structuredClone(prev);
      for (const [k, v] of changed) {
        if (k === "$fields") {
          next.fields = v ? JSON.parse(v) : [];
        } else if (k === "$form") {
          next.form = v ? JSON.parse(v) : undefined;
          // restore into live pdf.js storage so form widgets repaint
          if (doc && v) for (const [fk, fv] of Object.entries(JSON.parse(v))) {
            try { doc.annotationStorage.setValue(fk, fv as Record<string, unknown>); } catch { /* skip */ }
          }
        } else if (v == null) {
          next.annotations = next.annotations.filter((a) => a.id !== k);
        } else {
          const a = JSON.parse(v) as PdfAnn;
          const i = next.annotations.findIndex((x) => x.id === k);
          if (i >= 0) next.annotations[i] = a; else next.annotations.push(a);
        }
      }
      return next;
    });
    scheduleSave();
  };
  const mapSync = useMapSync(session, "pdf", applyRemoteRef);

  // push annotation changes to the shared map (echo is a no-op via dirty check)
  useEffect(() => {
    if (!mapSync || !doc) return;
    const m = new Map<string, string>();
    for (const a of annDoc.annotations) m.set(a.id, JSON.stringify(a));
    m.set("$fields", JSON.stringify(annDoc.fields ?? []));
    if (annDoc.form && Object.keys(annDoc.form).length) m.set("$form", JSON.stringify(annDoc.form));
    mapSync.push(m);
  }, [annDoc, mapSync, doc]);

  // presence: which page we're on
  useEffect(() => {
    session?.setLocal({ where: { label: `Page ${curPage}` } });
  }, [session, curPage]);

  // ---------- search ----------
  const runSearch = async () => {
    if (!doc || !query.trim()) { setMatches([]); setMatchIdx(-1); return; }
    const flags = matchCase ? "" : "i";
    const pat = wholeWord ? `\\b${query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b` : query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(pat, `g${flags}`);
    const out: typeof matches = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const vp1 = page.getViewport({ scale: 1 });
      const text = tc.items.map((i) => ("str" in i ? i.str : "")).join("");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        // map the char range → overlapped text items → pdf-space rects
        const rects: Rect4[] = [];
        let off = 0;
        for (const it of tc.items) {
          const str = "str" in it ? it.str : "";
          const s = off, e = off + str.length;
          off = e;
          if (e <= m.index || s >= m.index + m[0].length || !("transform" in it)) continue;
          const tx = pdfjs.Util.transform(vp1.transform, it.transform);
          const fh = Math.max(2, Math.hypot(tx[2], tx[3]));
          const [px, py] = vp1.convertToPdfPoint(tx[4], tx[5]);
          rects.push([px, py - fh * 0.25, Math.max(4, (it.width / Math.max(1, str.length)) * Math.min(str.length, m.index + m[0].length - Math.max(s, m.index)) * (vp1.scale)), fh * 1.25]);
        }
        out.push({ page: p, snippet: text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).trim(), rects });
        if (out.length >= 200) break;
      }
      if (out.length >= 200) break;
    }
    setMatches(out);
    setMatchIdx(out.length ? 0 : -1);
    if (out.length) scrollToPage(out[0].page);
  };

  const scrollToPage = (p: number) => {
    setCurPage(p);
    pageRefs.current.get(p)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // PDF-3 — fit-width / fit-page use the current page's rotated viewport
  const fitWidth = async () => {
    if (!doc || !scrollRef.current) return;
    const pg = await doc.getPage(curPage);
    const v = pg.getViewport({ scale: 1, rotation: (pg.rotate + viewRot) % 360 });
    setScale(Math.min(4, Math.max(0.4, +(((scrollRef.current.clientWidth - 56) / v.width)).toFixed(2))));
  };
  const fitPage = async () => {
    if (!doc || !scrollRef.current) return;
    const pg = await doc.getPage(curPage);
    const v = pg.getViewport({ scale: 1, rotation: (pg.rotate + viewRot) % 360 });
    setScale(Math.min(4, Math.max(0.4, +(Math.min((scrollRef.current.clientWidth - 56) / v.width, (scrollRef.current.clientHeight - 40) / v.height)).toFixed(2))));
  };
  // marquee zoom — PdfPage reports the dragged rect in viewport px
  const zoomToRect = (r: { x: number; y: number; w: number; h: number }, pageEl: HTMLElement) => {
    const host = scrollRef.current;
    if (!host || r.w < 8 || r.h < 8) return;
    const k = Math.min(host.clientWidth / r.w, host.clientHeight / r.h);
    setScale((s) => Math.min(4, +(s * k * 0.96).toFixed(2)));
    pageEl.scrollIntoView({ block: "start" });
  };

  // ---------- AI ops (tool-constrained; routed through mutate → undo/autosave/collab) ----------
  const pageTextCache = useRef<Map<number, string>>(new Map());
  const aiSerialize = useCallback(async () => {
    if (!doc) return "";
    const chunks: string[] = [];
    let len = 0;
    for (let p = 1; p <= doc.numPages && len < 24000; p++) {
      let t = pageTextCache.current.get(p);
      if (t === undefined) {
        try {
          const tc = await doc.getPage(p).then((pg) => pg.getTextContent());
          t = tc.items.map((i) => ("str" in i ? i.str : "")).join("");
        } catch { t = ""; }
        pageTextCache.current.set(p, t);
      }
      const part = `--- page ${p} ---\n${t}\n`;
      chunks.push(part);
      len += part.length;
    }
    // expose annotations + form fields so ops can reference them
    if (annDoc.annotations.length) {
      chunks.push("--- annotations (0-based index for delete_annotation) ---");
      annDoc.annotations.forEach((a, i) => {
        chunks.push(`[${i}] ${a.type} page ${a.page}${a.text ? `: ${a.text.slice(0, 60)}` : ""}`);
      });
    }
    const formKeys = Object.keys(annDoc.form ?? {});
    if (formKeys.length) {
      chunks.push("--- form fields (use the id as `name` in set_form_value) ---");
      for (const k of formKeys) chunks.push(`form[${k}] = ${JSON.stringify((annDoc.form![k] as { value?: unknown })?.value ?? annDoc.form![k])}`);
    }
    return chunks.join("\n").slice(0, 30000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, annDoc]);

  const aiApplyOps = useCallback((ops: AiOp[]) => {
    for (const o of ops) {
      if (o.op === "add_annotation") {
        const page = Number(o.page);
        if (!doc || page < 1 || page > doc.numPages) continue;
        addAnn(page, {
          type: o.type as PdfAnn["type"],
          rects: o.rects as PdfAnn["rects"],
          points: o.points as PdfAnn["points"],
          text: o.text as string | undefined,
          color: (o.color as string) ?? "#FFD23F",
        });
      } else if (o.op === "delete_annotation") {
        const i = Number(o.index);
        mutate((d) => { if (i >= 0 && i < d.annotations.length) d.annotations.splice(i, 1); });
      } else if (o.op === "set_form_value") {
        const name = String(o.name);
        mutate((d) => { d.form = { ...d.form, [name]: { value: o.value } }; });
        try { doc?.annotationStorage.setValue(name, { value: o.value }); } catch { /* field may not exist */ }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  const resolveDest = async (dest: unknown): Promise<number | null> => {
    if (!doc || !dest) return null;
    try {
      const d = typeof dest === "string" ? await doc.getDestination(dest) : dest;
      const ref = Array.isArray(d) ? d[0] : null;
      if (!ref) return null;
      return (await doc.getPageIndex(ref as never)) + 1;
    } catch { return null; }
  };

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
      else if ((e.key === "Delete" || e.key === "Backspace") && selAnn && canEdit) { e.preventDefault(); delAnn(selAnn); setSelAnn(null); }
      else if ((e.key === "Delete" || e.key === "Backspace") && selField && canEdit) { e.preventDefault(); delField(selField); setSelField(null); }
      else if (e.key === "Escape") { setSelAnn(null); setSelField(null); }
      // PDF-3 — paged-view navigation
      else if (viewMode !== "cont" && (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown"))
        { e.preventDefault(); setCurPage((p) => Math.min(numPages, p + (viewMode === "two" ? 2 : 1))); }
      else if (viewMode !== "cont" && (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp"))
        { e.preventDefault(); setCurPage((p) => Math.max(1, p - (viewMode === "two" ? 2 : 1))); }
      else if ((e.ctrlKey || e.metaKey) && e.key === "f") { e.preventDefault(); setPanel("search"); }
      else if ((e.ctrlKey || e.metaKey) && e.key === "p") { e.preventDefault(); setPrinting(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const saveLabel = { saved: "Saved", saving: "Saving…", unsaved: "Unsaved", error: "Save failed" }[saveState];

  return (
    <div className="editor">
      <div className="topbar">
        <input className="doc-title" value={title} disabled={!canEdit}
          onChange={(e) => setTitle(e.target.value)} onBlur={rename} />
        <span className={`save-state ${saveState}`}>{saveLabel}</span>
        <button className="btn-ghost btn-sm" onClick={() => setPanel(panel === "comments" ? "none" : "comments")}>
          Comments{comments.length ? ` (${comments.length})` : ""}
        </button>
        <button className="btn-ghost btn-sm" onClick={() => setPanel(panel === "versions" ? "none" : "versions")}>History</button>
        <button className="btn-ghost btn-sm" title="Kreatix AI" onClick={() => setPanel(panel === "ai" ? "none" : "ai")}>✨ AI</button>
        <PresenceBar session={session} />
        <button className="btn-ghost btn-sm" onClick={() => setSharing(true)}>Share</button>
        <button className="btn-ghost btn-sm" disabled={!pdfDataRef.current}
          onClick={() => setExportDlg(true)}>Export PDF</button>
        <button className="btn-ghost btn-sm" onClick={() => setPrinting(true)}>Print</button>
      </div>

      <div className="ribbon">
        <button className={`rb ${panel === "thumbs" ? "on" : ""}`} title="Page thumbnails" onClick={() => setPanel(panel === "thumbs" ? "none" : "thumbs")}>▦</button>
        <button className={`rb ${panel === "outline" ? "on" : ""}`} title="Bookmarks" onClick={() => setPanel(panel === "outline" ? "none" : "outline")}>🔖</button>
        <button className={`rb ${panel === "search" ? "on" : ""}`} title="Search" onClick={() => setPanel(panel === "search" ? "none" : "search")}>🔍</button>
        <button className={`rb ${panel === "anns" ? "on" : ""}`} title="Annotations list — review status and replies"
          onClick={() => setPanel(panel === "anns" ? "none" : "anns")}>📋</button>
        <button className={`rb ${panel === "organize" ? "on" : ""}`} title="Organize pages (PDF-1)" disabled={!canEdit}
          onClick={() => { setPanel(panel === "organize" ? "none" : "organize"); setOrgSel(new Set()); }}>⧉</button>
        <div className="rb-sep" />
        {TOOLS.map((t) => (
          <button key={t.id} className={`rb ${tool === t.id ? "on" : ""}`} title={t.label} disabled={!canEdit && t.id !== "select"}
            onClick={() => { setTool(t.id); if (t.id === "sign" && !sigImg) setSigPadOpen(true); }}>{t.ico}</button>
        ))}
        {tool === "sign" && (
          <button className="rb" style={{ fontSize: 11, width: "auto", padding: "0 8px" }}
            title={sigImg ? "Change signature" : "Create signature"}
            onClick={() => setSigPadOpen(true)}>{sigImg ? "✍ Edit" : "✍ Create"}</button>
        )}
        {tool === "stamp" && (
          <select className="rb-sel" value={stampText} onChange={(e) => setStampText(e.target.value)} title="Stamp text">
            {STAMPS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        {tool === "field" && (
          <select className="rb-sel" value={fieldKind} onChange={(e) => setFieldKind(e.target.value as FieldKind)} title="Field kind">
            <option value="text">Text field</option>
            <option value="checkbox">Checkbox</option>
            <option value="radio">Radio</option>
            <option value="dropdown">Dropdown</option>
            <option value="list">List box</option>
          </select>
        )}
        {MARKUP_TOOLS.has(tool) && tool !== "stamp" && tool !== "whiteout" && tool !== "image" && tool !== "measure" && tool !== "edittext" && (
          <div className="rb-colors">
            {MARKUP_COLORS.map((c) => (
              <button key={c} className={`sw ${toolColor === c ? "on" : ""}`} style={{ background: c }} onClick={() => setToolColor(c)} />
            ))}
          </div>
        )}
        <div className="rb-sep" />
        <button className="rb" onClick={undo} title="Undo">↶</button>
        <button className="rb" onClick={redo} title="Redo">↷</button>
        <div className="rb-sep" />
        <button className="rb" title="Zoom out" onClick={() => setScale((s) => Math.max(0.4, +(s - 0.2).toFixed(2)))}>−</button>
        <select className="rb-sel" style={{ width: 76 }} value={scale} onChange={(e) => setScale(Number(e.target.value))}>
          {[0.5, 0.75, 1, 1.1, 1.25, 1.5, 2, 3].map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
        </select>
        <button className="rb" title="Zoom in" onClick={() => setScale((s) => Math.min(4, +(s + 0.2).toFixed(2)))}>＋</button>
        <button className="rb" title="Fit width" onClick={() => void fitWidth()}>⇤⇥</button>
        <button className="rb" title="Fit page" onClick={() => void fitPage()}>⛶</button>
        <button className={`rb ${tool === "zoombox" ? "on" : ""}`} title="Marquee zoom — drag a box to fill the view"
          onClick={() => setTool(tool === "zoombox" ? "select" : "zoombox")}>🔍+</button>
        <button className="rb" title="Rotate view (session only)" onClick={() => setViewRot((r) => (r + 90) % 360)}>⟳</button>
        <button className="rb" title="Reading view: continuous / single / two-page" onClick={() => setViewMode((m) => m === "cont" ? "single" : m === "single" ? "two" : "cont")}>{viewMode === "cont" ? "📜" : viewMode === "single" ? "📄" : "📑"}</button>
        <button className={`rb ${dark ? "on" : ""}`} title="Dark render" onClick={() => setDark((d) => !d)}>🌙</button>
        <button className="rb" title="Fullscreen" onClick={() => scrollRef.current?.closest(".editor")?.requestFullscreen?.().catch(() => {})}>⛶</button>
        <span className="rb-info">Page <input className="pg-in" type="number" min={1} max={numPages} value={curPage}
          onChange={(e) => scrollToPage(Math.max(1, Math.min(numPages, Number(e.target.value) || 1)))} /> / {numPages}</span>
        <div className="rb-sep" />
        <button className="rb" title="Add comment" onClick={() => { setPanel("comments"); }}>💬+</button>
        {panel === "organize" && (
          <>
            <div className="rb-sep" />
            <span className="rb-info" style={{ fontSize: 11 }}>{orgSel.size ? `${orgSel.size} selected` : "Click pages · drag to reorder"}</span>
            <button className="rb" title="Delete selected pages" disabled={!orgSel.size} onClick={orgDelete}>🗑</button>
            <button className="rb" title="Rotate left 90°" disabled={!orgSel.size} onClick={() => void orgRotate(270)}>↺</button>
            <button className="rb" title="Rotate right 90°" disabled={!orgSel.size} onClick={() => void orgRotate(90)}>↻</button>
            <button className="rb" title="Insert blank page after current" onClick={() => void orgInsertBlank()}>＋▤</button>
            <button className="rb" title="Merge another PDF at the end" onClick={() => mergeRef.current?.click()}>⇤📄</button>
            <button className="rb" title="Extract selected pages → new PDF" disabled={!orgSel.size} onClick={() => void orgExtract()}>⤓</button>
            <button className="rb" title={`Split at page ${curPage} → two PDFs`} disabled={curPage <= 1} onClick={() => void orgSplit()}>✂</button>
            <input ref={mergeRef} type="file" accept=".pdf" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void orgMerge(f); e.target.value = ""; }} />
          </>
        )}
        <input ref={imgFileRef} type="file" accept="image/png,image/jpeg" hidden
          onChange={(e) => {
            const f = e.target.files?.[0]; const pend = imgPending.current; e.target.value = "";
            if (!f || !pend) return;
            const fr = new FileReader();
            fr.onload = () => addAnn(pend.page, { type: "image", rects: [pend.rect], img: String(fr.result) });
            fr.readAsDataURL(f);
            imgPending.current = null;
          }} />
      </div>

      <div className="work">
        {panel !== "none" && panel !== "comments" && panel !== "versions" && (
          <div className="pdf-rail">
            {panel === "thumbs" && doc && Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
              <Thumb key={p} doc={doc} page={p} active={p === curPage} onClick={() => scrollToPage(p)} />
            ))}
            {panel === "outline" && (
              outline.length
                ? <div className="pdf-outline">{outline.map((n, i) => (
                    <OutlineItem key={i} node={n} depth={0} onGo={async (d) => { const p = await resolveDest(d); if (p) scrollToPage(p); }} />
                  ))}</div>
                : <div className="empty">No bookmarks in this document</div>
            )}
            {panel === "search" && (
              <div className="pdf-search">
                <div style={{ display: "flex", gap: 6 }}>
                  <input value={query} placeholder="Search text…" style={{ flex: 1, height: 30, border: "1px solid var(--line)", borderRadius: 8, padding: "0 10px", fontSize: 12 }}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void runSearch()} />
                  <button className="btn-primary btn-sm" onClick={() => void runSearch()}>Go</button>
                </div>
                <label style={{ display: "flex", gap: 6, fontSize: 11, color: "#8B8480", marginTop: 8 }}>
                  <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Case sensitive
                  <input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} style={{ marginLeft: 10 }} /> Whole word
                </label>
                <div className="pdf-results">
                  {matches.map((m, i) => (
                    <div key={i} className={`pdf-match ${i === matchIdx ? "on" : ""}`}
                      onClick={() => { setMatchIdx(i); scrollToPage(m.page); }}>
                      <b>p.{m.page}</b> {m.snippet.slice(0, 70)}
                    </div>
                  ))}
                  {query && !matches.length && <div className="empty">No matches</div>}
                </div>
              </div>
            )}
            {panel === "anns" && (
              <div className="pdf-annlist">
                {!annDoc.annotations.length && <div className="empty">No annotations yet — draw one with the markup tools</div>}
                {[...annDoc.annotations].sort((x, y) => x.page - y.page || (x.createdAt ?? "").localeCompare(y.createdAt ?? "")).map((a) => (
                  <AnnRow key={a.id} a={a} sel={selAnn === a.id} canEdit={canEdit} userName={user?.displayName ?? "You"}
                    onPick={() => { setSelAnn(a.id); scrollToPage(a.page); }}
                    onDel={() => delAnn(a.id)}
                    onPatch={(p) => patchAnn(a.id, p)} />
                ))}
              </div>
            )}
          </div>
        )}

        {panel === "organize" && doc ? (
          <div className="pages pdf-org">
            {Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
              <div key={`${docGen}:${p}`}
                className={`pdf-org-cell ${orgSel.has(p) ? "sel" : ""} ${p === curPage ? "cur" : ""}`}
                draggable
                onDragStart={() => { dragPage.current = p - 1; }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); if (dragPage.current !== null && dragPage.current !== p - 1) orgReorder(dragPage.current, p - 1); dragPage.current = null; }}
                onClick={(e) => {
                  setCurPage(p);
                  const next = new Set(e.ctrlKey || e.metaKey ? orgSel : []);
                  if (e.shiftKey && orgSel.size) {
                    const lo = Math.min(...orgSel, p), hi = Math.max(...orgSel, p);
                    for (let i = lo; i <= hi; i++) next.add(i);
                  } else next.has(p) && orgSel.size > 1 ? next.delete(p) : next.add(p);
                  setOrgSel(next);
                }}>
                <Thumb doc={doc} page={p} active={p === curPage} onClick={() => scrollToPage(p)} />
              </div>
            ))}
          </div>
        ) : (
        <div className="pages pdf-pages" ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const kids = [...el.querySelectorAll<HTMLElement>("[data-page]")];
            const mid = el.scrollTop + el.clientHeight * 0.35;
            const vis = kids.find((k) => k.offsetTop + k.offsetHeight > mid);
            if (vis) setCurPage(Number(vis.dataset.page));
          }}>
          {loadErr && <div className="empty" style={{ padding: 60 }}>{loadErr}</div>}
          {!doc && !loadErr && <div className="empty" style={{ padding: 60 }}>Loading PDF…</div>}
          {doc && (viewMode === "cont" ? Array.from({ length: numPages }, (_, i) => i + 1)
            : viewMode === "single" ? [curPage]
            : (() => { const s = curPage % 2 === 0 ? curPage - 1 : curPage; return [s, s + 1].filter((p) => p <= numPages); })()
          ).map((p) => (
            <div key={`${docGen}:${p}`} data-page={p} ref={(el) => { if (el) pageRefs.current.set(p, el); }} className="pdf-page-wrap">
              <PdfPage doc={doc} pageNum={p} scale={scale}
                anns={annDoc.annotations.filter((a) => a.page === p)}
                selAnn={selAnn} setSelAnn={setSelAnn}
                tool={canEdit ? tool : "select"} toolColor={toolColor} stampText={stampText} sigImg={sigImg}
                canEdit={canEdit} viewRot={viewRot} dark={dark}
                searchRects={matches.filter((m, i) => m.page === p && i <= matchIdx + 3).flatMap((m) => m.rects)}
                onAdd={(a) => addAnn(p, a)}
                onMove={moveAnn}
                onPatch={patchAnn}
                onZoomTo={zoomToRect}
                onPickImage={(r) => { imgPending.current = { page: p, rect: r }; imgFileRef.current?.click(); }}
                fieldApi={{
                  fields: (annDoc.fields ?? []).filter((f) => f.page === p),
                  sel: selField, select: setSelField,
                  add: (r) => addField(p, r), move: moveField, patch: patchField,
                  del: delField, checkRadio,
                }} />
            </div>
          ))}
          {viewMode !== "cont" && doc && (
            <div className="pdf-vmnav">
              <button className="btn-ghost btn-sm" disabled={curPage <= 1}
                onClick={() => setCurPage((p) => Math.max(1, p - (viewMode === "two" ? 2 : 1)))}>← Prev</button>
              <button className="btn-ghost btn-sm" disabled={curPage >= numPages}
                onClick={() => setCurPage((p) => Math.min(numPages, p + (viewMode === "two" ? 2 : 1)))}>Next →</button>
            </div>
          )}
        </div>
        )}
      </div>

      {panel === "comments" && (
        <CommentsPanel fileId={item.id} comments={comments}
          canComment={canEdit || permission === "commenter" || permission === "reviewer"}
          onReload={loadComments}
          onAnchorClick={(a) => { const n = Number(a.split(":")[1]); if (!isNaN(n)) scrollToPage(n); }}
          onNewComment={submitComment} newCommentOpen={newComment}
          onCancelNew={() => { setNewComment(false); setPanel("none"); }}
          toast={toast} />
      )}
      {panel === "versions" && (
        <VersionsPanel item={item} onClose={() => setPanel("none")}
          onRestore={async () => {
            const r = await api.get<{ content: PdfDoc }>(`/api/files/${item.id}/content`);
            if (r?.content?.kind === "pdf") setAnnDoc(r.content);
          }} toast={toast} />
      )}
      {panel === "ai" && (
        <AiPanel fileId={item.id} kind="pdf" canEdit={canEdit}
          serialize={aiSerialize}
          selection={() => `Page ${curPage}`}
          applyOps={aiApplyOps} onClose={() => setPanel("none")} toast={toast} />
      )}
      {pwPrompt && (
        <div className="dlg-back" onClick={() => {
          pwCbRef.current = null; setPwPrompt(null);
          loadTaskRef.current?.destroy();
          setLoadErr("This PDF requires a password — open it again to retry");
        }}>
          <div className="dlg" onClick={(e) => e.stopPropagation()}>
            <h3>Password required</h3>
            <p style={{ fontSize: 12, color: "var(--muted)", margin: "8px 0 14px" }}>
              {pwPrompt.wrong ? "Incorrect password — try again." : "This PDF is password-protected. Enter the password to open it."}
            </p>
            <form onSubmit={(e) => {
              e.preventDefault();
              const cb = pwCbRef.current;
              pwCbRef.current = null;
              setPwPrompt(null);
              cb?.(pwValue);
            }}>
              <input type="password" autoFocus value={pwValue} placeholder="PDF password"
                onChange={(e) => setPwValue(e.target.value)}
                style={{ width: "100%", height: 40, border: "1px solid var(--line)", borderRadius: 11, padding: "0 11px", fontSize: 12, background: "#FBFAF9", boxSizing: "border-box" }} />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
                <button type="submit" className="btn-primary" style={{ height: 34, padding: "0 18px" }}>Open</button>
              </div>
            </form>
          </div>
        </div>
      )}
      {sharing && <ShareDialog item={item} onClose={() => setSharing(false)} toast={toast} />}
      {printing && <PrintDeck doc={doc} anns={annDoc.annotations} fields={annDoc.fields} onDone={() => setPrinting(false)} />}
      {exportDlg && (
        <div className="dlg-back" onClick={() => setExportDlg(false)}>
          <div className="dlg" onClick={(e) => e.stopPropagation()}>
            <h3>Export PDF</h3>
            <p style={{ fontSize: 12, color: "var(--muted)", margin: "4px 0 12px" }}>
              Annotations are baked into the page; form fields are filled and flattened.
            </p>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, marginBottom: 10 }}>
              <input type="checkbox" checked={pdfOpts.pageNumbers}
                onChange={(e) => setPdfOpts({ ...pdfOpts, pageNumbers: e.target.checked })} />
              Page numbers
            </label>
            {(["watermark", "header", "footer"] as const).map((k) => (
              <input key={k} value={pdfOpts[k]} placeholder={k === "watermark" ? "Watermark text (e.g. CONFIDENTIAL)" : `${k[0].toUpperCase()}${k.slice(1)} line…`}
                onChange={(e) => setPdfOpts({ ...pdfOpts, [k]: e.target.value })}
                style={{ width: "100%", height: 34, border: "1px solid var(--line)", borderRadius: 8, padding: "0 10px", fontSize: 12, marginBottom: 8, boxSizing: "border-box" }} />
            ))}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn-ghost btn-sm" onClick={() => setExportDlg(false)}>Cancel</button>
              <button className="btn-primary btn-sm" onClick={() => {
                setExportDlg(false);
                if (!pdfDataRef.current) return;
                flattenMod()
                  .then(({ exportFlattenedPdf }) => exportFlattenedPdf(pdfDataRef.current!, annDoc.annotations, formValues(), doc, title,
                    { pageNumbers: pdfOpts.pageNumbers, watermark: pdfOpts.watermark || undefined, header: pdfOpts.header || undefined, footer: pdfOpts.footer || undefined },
                    annDoc.fields ?? []))
                  .catch(() => toast("PDF export failed"));
              }}>Export</button>
            </div>
          </div>
        </div>
      )}
      {sigPadOpen && (
        <SignPad initial={sigImg} onDone={(img) => {
          if (img) { setSigImg(img); localStorage.setItem(SIG_KEY, img); }
          else { setSigImg(null); localStorage.removeItem(SIG_KEY); }
          setSigPadOpen(false);
          setTool("sign");
        }} onClose={() => setSigPadOpen(false)} />
      )}
      {msg && <div className="toast">{msg}</div>}
    </div>
  );
}

// ---------- PDF-2: signature pad (draw or type → PNG data URL) ----------
function SignPad({ initial, onDone, onClose }: { initial: string | null; onDone: (img: string | null) => void; onClose: () => void }) {
  const [tab, setTab] = useState<"draw" | "type">("draw");
  const [typed, setTyped] = useState("");
  const cvRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  const W = 360, H = 120;
  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#1a1a6e"; ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (initial && tab === "draw") {
      const im = new Image();
      im.onload = () => ctx.drawImage(im, 0, 0, W, H);
      im.src = initial;
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const pt = (e: React.PointerEvent): [number, number] => {
    const b = cvRef.current!.getBoundingClientRect();
    return [(e.clientX - b.left) * (W / b.width), (e.clientY - b.top) * (H / b.height)];
  };
  const clear = () => {
    const ctx = cvRef.current!.getContext("2d")!;
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#1a1a6e"; ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round";
  };

  const done = () => {
    let url: string | null = null;
    if (tab === "draw") {
      const ctx = cvRef.current!.getContext("2d");
      const d = ctx?.getImageData(0, 0, W, H);
      const blank = d && [...d.data].every((v, i) => (i + 1) % 4 === 0 ? v === 255 : v >= 245);
      url = blank ? null : cvRef.current!.toDataURL("image/png");
    } else {
      if (!typed.trim()) { onDone(null); return; }
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#1a1a6e";
      ctx.font = `italic 54px "Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive`;
      ctx.textBaseline = "middle";
      const tw = ctx.measureText(typed).width;
      const scale = Math.min(1, (W - 24) / Math.max(tw, 1));
      ctx.setTransform(scale, 0, 0, scale, 12, H / 2 - 8 * scale);
      ctx.fillText(typed, 0, 0);
      url = cv.toDataURL("image/png");
    }
    onDone(url);
  };

  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
        <h3>Add signature</h3>
        <div style={{ display: "flex", gap: 6, margin: "8px 0 12px" }}>
          {(["draw", "type"] as const).map((t) => (
            <button key={t} className={`btn-ghost btn-sm ${tab === t ? "on" : ""}`}
              style={{ textTransform: "capitalize" }} onClick={() => setTab(t)}>{t}</button>
          ))}
          <span style={{ flex: 1 }} />
          {tab === "draw" && <button className="btn-ghost btn-sm" onClick={clear}>Clear</button>}
        </div>
        {tab === "draw" ? (
          <canvas ref={cvRef} width={W} height={H} className="sig-pad"
            onPointerDown={(e) => { drawing.current = true; cvRef.current!.setPointerCapture(e.pointerId); const [x, y] = pt(e); cvRef.current!.getContext("2d")!.beginPath(); cvRef.current!.getContext("2d")!.moveTo(x, y); }}
            onPointerMove={(e) => { if (!drawing.current) return; const [x, y] = pt(e); const c = cvRef.current!.getContext("2d")!; c.lineTo(x, y); c.stroke(); }}
            onPointerUp={() => { drawing.current = false; }} />
        ) : (
          <input autoFocus value={typed} placeholder="Type your name"
            onChange={(e) => setTyped(e.target.value)}
            style={{ width: "100%", height: 44, border: "1px solid var(--line)", borderRadius: 10, padding: "0 12px", fontSize: 18, fontFamily: '"Segoe Script", cursive', boxSizing: "border-box" }} />
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 14 }}>
          <button className="btn-ghost btn-sm" onClick={() => onDone(null)}>Remove signature</button>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
            <button className="btn-primary btn-sm" onClick={done}>Use signature</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- outline tree ----------
function OutlineItem({ node, depth, onGo }: { node: OutlineNode; depth: number; onGo: (dest: unknown) => void }) {
  return (
    <>
      <div className="pdf-ol-item" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => onGo(node.dest)}>{node.title}</div>
      {(node.items ?? []).map((n, i) => <OutlineItem key={i} node={n} depth={depth + 1} onGo={onGo} />)}
    </>
  );
}

// ---------- thumbnail ----------
function Thumb({ doc, page, active, onClick }: { doc: PDFDocumentProxy; page: number; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(async ([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      try {
        const p = await doc.getPage(page);
        const vp = p.getViewport({ scale: 0.18 });
        el.width = vp.width; el.height = vp.height;
        await p.render({ canvas: el, viewport: vp }).promise;
        setDone(true);
      } catch { /* skip */ }
    }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [doc, page, done]);
  return (
    <div className={`pdf-thumb ${active ? "active" : ""}`} onClick={onClick}>
      <canvas ref={ref} />
      <span>{page}</span>
    </div>
  );
}

// ---------- a single page: canvas + text layer + form layer + annotation overlay ----------
function PdfPage({ doc, pageNum, scale, anns, selAnn, setSelAnn, tool, toolColor, stampText, sigImg, canEdit, searchRects, viewRot, dark, onAdd, onMove, onPatch, onZoomTo, onPickImage, fieldApi }: {
  doc: PDFDocumentProxy;
  pageNum: number;
  scale: number;
  anns: PdfAnn[];
  selAnn: string | null;
  setSelAnn: (id: string | null) => void;
  tool: Tool; toolColor: string; stampText: string; sigImg?: string | null;
  canEdit: boolean;
  viewRot?: number; dark?: boolean;
  searchRects: Rect4[];
  onAdd: (a: Omit<PdfAnn, "id" | "page" | "createdAt">) => void;
  onMove: (id: string, dx: number, dy: number) => void;
  onPatch: (id: string, p: Partial<PdfAnn>, key?: string) => void;
  onZoomTo?: (r: { x: number; y: number; w: number; h: number }, el: HTMLElement) => void;
  onPickImage?: (rect: Rect4) => void;
  fieldApi?: {
    fields: PdfField[]; sel: string | null;
    add: (rect: Rect4) => void;
    select: (id: string | null) => void;
    move: (id: string, dx: number, dy: number) => void;
    patch: (id: string, p: Partial<PdfField>, key?: string) => void;
    del: (id: string) => void;
    checkRadio: (f: PdfField) => void;
  };
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<PDFPageProxy | null>(null);
  const [near, setNear] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [preview, setPreview] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [penPts, setPenPts] = useState<[number, number][]>([]);
  const [plPts, setPlPts] = useState<[number, number][]>([]);   // in-progress polyline vertices (viewport px)
  const [plCur, setPlCur] = useState<[number, number] | null>(null);
  const [readout, setReadout] = useState<string | null>(null); // measure result badge
  const [editText, setEditText] = useState<string | null>(null);
  const dragRef = useRef<{ kind: "draw"; sx: number; sy: number; x: number; y: number } | { kind: "move"; id: string; sx: number; sy: number; field?: boolean } | null>(null);
  const movedFlag = useRef(false);
  const renderedKey = useRef("");

  // proximity observer — only render pages near the viewport
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: "1200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // render canvas + text layer + form widgets
  useEffect(() => {
    if (!near) return;
    let dead = false;
    (async () => {
      try {
        const page = pageRef.current ?? await doc.getPage(pageNum);
        pageRef.current = page;
        const vp = page.getViewport({ scale, rotation: (page.rotate + (viewRot ?? 0)) % 360 });
        setSize({ w: vp.width, h: vp.height });
        const key = `${pageNum}:${scale}:${viewRot ?? 0}`;
        if (renderedKey.current === key) return;
        renderedKey.current = key;
        const canvas = canvasRef.current!;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = `${vp.width}px`; canvas.style.height = `${vp.height}px`;
        await page.render({
          canvas, viewport: vp,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        }).promise;
        if (dead) return;
        // selectable text layer
        const tl = textRef.current!;
        tl.innerHTML = "";
        tl.className = "textLayer";
        tl.style.setProperty("--scale-factor", `${scale}`);
        await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp }).render();
        if (dead) return;
        // AcroForm widgets
        const fl = formRef.current!;
        fl.innerHTML = "";
        fl.className = "annotationLayer";
        fl.style.setProperty("--scale-factor", `${scale}`);
        try {
          const annotations = await page.getAnnotations();
          if (annotations.some((a) => a.fieldType)) {
            const layer = new pdfjs.AnnotationLayer({
              div: fl, page, viewport: vp.clone({ dontFlip: true }),
              linkService: LINK_SERVICE, annotationStorage: doc.annotationStorage,
              accessibilityManager: null, annotationCanvasMap: null,
              annotationEditorUIManager: null, structTreeLayer: null, commentManager: null,
            });
            await layer.render({
              viewport: vp.clone({ dontFlip: true }), annotations, renderForms: true,
              linkService: LINK_SERVICE, annotationStorage: doc.annotationStorage,
              imageResourcesPath: "", downloadManager: null, fieldObjects: null,
            } as never);
          }
        } catch { /* forms are best-effort */ }
      } catch { /* page render failed */ }
    })();
    return () => { dead = true; };
  }, [doc, pageNum, scale, near, viewRot]);

  const vp = () => pageRef.current?.getViewport({ scale }) ?? null;
  const toPdf = (cx: number, cy: number): [number, number] => {
    const v = vp(); if (!v) return [0, 0];
    const b = boxRef.current!.getBoundingClientRect();
    return v.convertToPdfPoint(cx - b.left, cy - b.top) as [number, number];
  };
  const toVp = (px: number, py: number): [number, number] => {
    const v = vp(); if (!v) return [0, 0];
    return v.convertToViewportPoint(px, py) as [number, number];
  };
  const vpRect = (r: Rect4): Rect4 => {
    const [x1, y1] = toVp(r[0], r[1] + r[3]);
    const [x2, y2] = toVp(r[0] + r[2], r[1]);
    return [x1, y1, x2 - x1, y2 - y1];
  };

  // ---------- drawing tools ----------
  // Enter/Esc finish or cancel an in-progress polyline
  useEffect(() => {
    if (!plPts.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setPlPts([]); setPlCur(null); }
      else if (e.key === "Enter" && plPts.length > 1) finishPolyline(plPts);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [plPts]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPlPts([]); setPlCur(null); setReadout(null); }, [tool]);

  const finishPolyline = (pts: [number, number][]) => {
    if (pts.length > 1 && vp())
      onAdd({ type: "polyline", points: pts.map(([x, y]) => vp()!.convertToPdfPoint(x, y) as [number, number]), color: toolColor });
    setPlPts([]); setPlCur(null);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!canEdit && tool !== "zoombox") return;
    if (tool === "select" || tool === "pan") return;
    const b = boxRef.current!.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;
    if (tool === "polyline") {
      // two consecutive clicks on the same spot (≤6px) finish the path
      const last = plPts[plPts.length - 1];
      if (last && Math.abs(last[0] - x) < 6 && Math.abs(last[1] - y) < 6 && plPts.length > 1) finishPolyline(plPts);
      else { setPlPts((p) => [...p, [x, y]]); setPlCur([x, y]); }
      return;
    }
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    if (tool === "note") {
      onAdd({ type: "note", points: [toPdf(e.clientX, e.clientY)], color: toolColor, text: "" });
      return;
    }
    if (tool === "stamp") {
      const [px, py] = toPdf(e.clientX, e.clientY);
      onAdd({ type: "stamp", rects: [[px - 60, py - 14, 120, 28]], text: stampText, color: toolColor });
      return;
    }
    if (tool === "sign") {
      if (!sigImg) return; // pad opens from the toolbar; nothing to place yet
      const [px, py] = toPdf(e.clientX, e.clientY);
      onAdd({ type: "sign", rects: [[px - 80, py - 20, 160, 40]], img: sigImg });
      return;
    }
    dragRef.current = { kind: "draw", sx: x, sy: y, x, y };
    if (tool === "freehand") setPenPts([[x, y]]);
    else setPreview({ x, y, w: 0, h: 0 }); // zoombox/measure preview via the same rect
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const b = boxRef.current!.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;
    if (d.kind === "move") {
      if (Math.abs(x - d.sx) + Math.abs(y - d.sy) > 1) movedFlag.current = true;
      (d.field ? fieldApi?.move : onMove)?.(d.id, (x - d.sx) / scale, (y - d.sy) / scale); d.sx = x; d.sy = y;
      return;
    }
    d.x = x; d.y = y;
    if (tool === "freehand") setPenPts((p) => [...p, [x, y]]);
    else setPreview({ x: Math.min(d.sx, x), y: Math.min(d.sy, y), w: Math.abs(x - d.sx), h: Math.abs(y - d.sy) });
  };
  const onPolylineHover = (e: React.PointerEvent) => {
    if (tool !== "polyline" || !plPts.length) return;
    const b = boxRef.current!.getBoundingClientRect();
    setPlCur([e.clientX - b.left, e.clientY - b.top]);
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.kind !== "draw" || !vp()) return;
    if (tool === "freehand") {
      if (penPts.length > 1) {
        onAdd({ type: "freehand", points: penPts.map(([x, y]) => vp()!.convertToPdfPoint(x, y) as [number, number]), color: toolColor });
      }
      setPenPts([]);
      return;
    }
    if (!preview) return;
    const { x, y, w, h } = preview;
    setPreview(null);
    if (w < 4 && h < 4) return;
    if (tool === "zoombox") { onZoomTo?.(preview, boxRef.current!); return; }
    if (tool === "measure") {
      const pt = Math.hypot(d.x - d.sx, d.y - d.sy) / scale;
      setReadout(`${pt.toFixed(1)} pt · ${(pt / 72).toFixed(2)} in · ${(pt / 72 * 2.54).toFixed(2)} cm`);
      return;
    }
    // text-markup tools: let onMouseUp handle a real text selection instead
    if (tool === "highlight" || tool === "underline" || tool === "strikeout" || tool === "squiggly") {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
    }
    const [px0, py0] = vp()!.convertToPdfPoint(x, y) as [number, number];
    const [px1, py1] = vp()!.convertToPdfPoint(x + w, y + h) as [number, number];
    const rect: Rect4 = [Math.min(px0, px1), Math.min(py0, py1), Math.abs(px1 - px0), Math.abs(py1 - py0)];
    if (tool === "callout") {
      // tail tip = the point you dragged from; box sits where you released
      const [tx, ty] = vp()!.convertToPdfPoint(d.sx, d.sy) as [number, number];
      onAdd({ type: "callout", rects: [rect], points: [[tx, ty]], color: toolColor, text: "" });
      return;
    }
    if (tool === "whiteout") { onAdd({ type: "whiteout", rects: [rect] }); return; }
    if (tool === "field") { fieldApi?.add(rect); return; }
    if (tool === "image") { onPickImage?.(rect); return; }
    if (tool === "edittext") { void editTextAt(rect); return; }
    if (tool === "line" || tool === "arrow") {
      const [ax, ay] = vp()!.convertToPdfPoint(d.sx, d.sy) as [number, number];
      const [bx, by] = vp()!.convertToPdfPoint(d.x, d.y) as [number, number];
      onAdd({ type: tool, points: [[ax, ay], [bx, by]], color: toolColor });
    } else {
      onAdd({ type: tool as AnnType, rects: [rect], color: toolColor, text: tool === "textbox" ? "" : undefined });
    }
  };

  // PDF-4 — edit-text approximation: white-out the block, prefill a textbox
  // with the text that was under it
  const editTextAt = async (rect: Rect4) => {
    const pg = pageRef.current;
    if (!pg) return;
    let text = "";
    try {
      const tc = await pg.getTextContent();
      const vp1 = pg.getViewport({ scale: 1 });
      const hits: { str: string; x: number; y: number }[] = [];
      for (const it of tc.items) {
        if (!("str" in it) || !it.str.trim() || !("transform" in it)) continue;
        const tx = pdfjs.Util.transform(vp1.transform, it.transform);
        const fh = Math.max(2, Math.hypot(tx[2], tx[3]));
        const [px, py] = vp1.convertToPdfPoint(tx[4], tx[5]);
        const iw = it.width * vp1.scale;
        const [rx, ry, rw, rh] = rect;
        if (px + iw < rx || px > rx + rw || py - fh * 0.25 > ry + rh || py + fh < ry) continue;
        hits.push({ str: it.str, x: px, y: py });
      }
      hits.sort((a, b) => b.y - a.y || a.x - b.x);
      const lines: string[] = [];
      let curY = NaN, cur = "";
      for (const hIt of hits) {
        if (isNaN(curY) || Math.abs(hIt.y - curY) < 3) { cur += hIt.str; curY = isNaN(curY) ? hIt.y : curY; }
        else { lines.push(cur); cur = hIt.str; curY = hIt.y; }
      }
      if (cur) lines.push(cur);
      text = lines.join("\n");
    } catch { /* extraction is best-effort */ }
    onAdd({ type: "whiteout", rects: [rect] });
    onAdd({ type: "textbox", rects: [rect], color: "#171717", text });
  };

  // text-selection → highlight/underline/strikeout
  const onMouseUp = () => {
    if (!canEdit || (tool !== "highlight" && tool !== "underline" && tool !== "strikeout" && tool !== "squiggly")) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const b = boxRef.current!.getBoundingClientRect();
    const rects: Rect4[] = [];
    for (let i = 0; i < sel.rangeCount; i++) {
      for (const r of [...sel.getRangeAt(i).getClientRects()]) {
        if (r.width < 1 || r.height < 1) continue;
        const [x0, y0] = vp()!.convertToPdfPoint(r.left - b.left, r.top - b.top) as [number, number];
        const [x1, y1] = vp()!.convertToPdfPoint(r.right - b.left, r.bottom - b.top) as [number, number];
        rects.push([Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)]);
      }
    }
    if (rects.length) {
      onAdd({ type: tool, rects, color: toolColor });
      sel.removeAllRanges();
    }
  };

  const startMove = (e: React.PointerEvent, a: PdfAnn) => {
    if (tool !== "select" || !canEdit) return;
    e.stopPropagation();
    setSelAnn(a.id);
    const b = boxRef.current!.getBoundingClientRect();
    dragRef.current = { kind: "move", id: a.id, sx: e.clientX - b.left, sy: e.clientY - b.top };
    movedFlag.current = false;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const startFieldMove = (e: React.PointerEvent, f: PdfField) => {
    if (tool !== "select" || !canEdit) return;
    e.stopPropagation();
    fieldApi?.select(f.id);
    const b = boxRef.current!.getBoundingClientRect();
    dragRef.current = { kind: "move", id: f.id, sx: e.clientX - b.left, sy: e.clientY - b.top, field: true };
    movedFlag.current = false;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const v = vp();

  return (
    <div ref={boxRef} className={`pdf-page ${tool !== "select" ? "draw" : ""}`}
      style={{ width: size.w || undefined, height: size.h || undefined }}
      onPointerDown={onPointerDown} onPointerMove={(e) => { onPointerMove(e); onPolylineHover(e); }} onPointerUp={onPointerUp} onMouseUp={onMouseUp}
      onDoubleClick={() => { if (tool === "polyline" && plPts.length > 1) finishPolyline(plPts.slice(0, -1)); }}>
      <canvas ref={canvasRef} className={`pdf-canvas ${dark ? "dark" : ""}`} />
      <div ref={textRef} />
      <div ref={formRef} />
      {/* search match flashes */}
      {v && searchRects.map((r, i) => {
        const [x, y, w2, h2] = vpRect(r);
        return <div key={`m${i}`} className="pdf-searchmark" style={{ left: x, top: y, width: w2, height: h2 }} />;
      })}
      {/* annotation overlay */}
      {v && (
        <svg className="ann-layer" width={size.w} height={size.h} style={{ pointerEvents: "none" }}>
          {penPts.length > 1 && (
            <polyline points={penPts.map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke={toolColor} strokeWidth={2.2} strokeLinecap="round" />
          )}
          {plPts.length > 0 && (
            <polyline points={[...plPts, ...(plCur ? [plCur] : [])].map(([x, y]) => `${x},${y}`).join(" ")}
              fill="none" stroke={toolColor} strokeWidth={2} strokeLinecap="round" strokeDasharray={plCur ? "0" : undefined} />
          )}
          {plPts.map(([x, y], i) => <circle key={`plv${i}`} cx={x} cy={y} r={2.4} fill={toolColor} />)}
          {preview && tool === "measure" && dragRef.current?.kind === "draw" && (() => {
            const d = dragRef.current;
            const pt = Math.hypot(d.x - d.sx, d.y - d.sy) / scale;
            return (
              <g>
                <line x1={d.sx} y1={d.sy} x2={d.x} y2={d.y} stroke="#3578E5" strokeWidth={1.5} strokeDasharray="5 3" />
                <circle cx={d.sx} cy={d.sy} r={3} fill="#3578E5" /><circle cx={d.x} cy={d.y} r={3} fill="#3578E5" />
                <text x={(d.sx + d.x) / 2} y={(d.sy + d.y) / 2 - 6} textAnchor="middle" fontSize={11} fill="#3578E5"
                  style={{ paintOrder: "stroke", stroke: "#fff", strokeWidth: 3 }}>{pt.toFixed(1)} pt</text>
              </g>
            );
          })()}
          {preview && tool !== "measure" && (
            <rect x={preview.x} y={preview.y} width={preview.w} height={preview.h}
              fill={tool === "highlight" ? toolColor : "none"} fillOpacity={tool === "highlight" ? 0.35 : 0}
              stroke={toolColor} strokeWidth={1.5} strokeDasharray="4 3" />
          )}
          {anns.map((a) => (
            <AnnSvg key={a.id} a={a} vpRect={vpRect} toVp={toVp} scale={scale}
              selected={selAnn === a.id} selectable={tool === "select" && canEdit}
              onDown={(e) => startMove(e, a)} />
          ))}
        </svg>
      )}
      {readout && <div className="pdf-measure">📏 {readout}</div>}
      {/* html-rendered anns: notes, textboxes, stamps */}
      {v && anns.filter((a) => a.type === "note" || a.type === "textbox" || a.type === "stamp" || a.type === "sign" || a.type === "callout" || a.type === "image").map((a) => {
        const sel = selAnn === a.id;
        if (a.type === "callout") {
          const [x, y, w2, h2] = vpRect(a.rects![0]);
          return (
            <div key={a.id} className={`ann-callout ${sel ? "sel" : ""}`}
              style={{ left: x, top: y, width: w2, minHeight: h2, borderColor: a.color === "#FFD23F" ? "#F2782E" : a.color }}
              contentEditable={canEdit && tool === "select" && sel} suppressContentEditableWarning
              onPointerDown={(e) => { if (tool === "select" && !sel) startMove(e, a); }}
              onClick={() => setSelAnn(a.id)}
              onBlur={(e) => onPatch(a.id, { text: (e.target as HTMLElement).innerText }, `co:${a.id}`)}>{a.text}</div>
          );
        }
        if (a.type === "note") {
          const [x, y] = toVp(a.points?.[0]?.[0] ?? 0, a.points?.[0]?.[1] ?? 0);
          return (
            <div key={a.id} className={`ann-note ${sel ? "sel" : ""}`} style={{ left: x - 8, top: y - 8, background: a.color ?? "#FFD23F" }}
              onPointerDown={(e) => startMove(e, a)}
              onClick={() => { if (!movedFlag.current) setEditText(a.id); }}>💬
              {editText === a.id && (
                <div className="ann-pop" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
                  <textarea autoFocus value={a.text ?? ""} placeholder="Note…"
                    onChange={(e) => onPatch(a.id, { text: e.target.value }, `note:${a.id}`)} />
                  <button className="btn-ghost btn-sm" onClick={() => setEditText(null)}>Done</button>
                </div>
              )}
            </div>
          );
        }
        if (a.type === "image") {
          const [x, y, w2, h2] = vpRect(a.rects![0]);
          return (
            <img key={a.id} src={a.img} alt="inserted" draggable={false}
              className={`ann-sign ${sel ? "sel" : ""}`}
              style={{ left: x, top: y, width: w2, height: h2 }}
              onPointerDown={(e) => startMove(e, a)} />
          );
        }
        if (a.type === "sign") {
          const [x, y, w2, h2] = vpRect(a.rects![0]);
          return (
            <img key={a.id} src={a.img} alt="signature" draggable={false}
              className={`ann-sign ${sel ? "sel" : ""}`}
              style={{ left: x, top: y, width: w2, height: h2 }}
              onPointerDown={(e) => startMove(e, a)} />
          );
        }
        if (a.type === "stamp") {
          const [x, y, w2, h2] = vpRect(a.rects![0]);
          return (
            <div key={a.id} className={`ann-stamp ${sel ? "sel" : ""}`}
              style={{ left: x, top: y, width: w2, height: h2, borderColor: a.color, color: a.color }}
              onPointerDown={(e) => startMove(e, a)}>{a.text}</div>
          );
        }
        const [x, y, w2, h2] = vpRect(a.rects![0]);
        return (
          <div key={a.id} className={`ann-textbox ${sel ? "sel" : ""}`}
            style={{ left: x, top: y, width: w2, minHeight: h2, color: a.color === "#FFD23F" ? "#171717" : a.color }}
            contentEditable={canEdit && tool === "select" && sel} suppressContentEditableWarning
            onPointerDown={(e) => { if (tool === "select" && !sel) startMove(e, a); }}
            onBlur={(e) => onPatch(a.id, { text: (e.target as HTMLElement).innerText }, `tb:${a.id}`)}>{a.text}</div>
        );
      })}
      {/* PDF-6 — authored form fields */}
      {v && (fieldApi?.fields ?? []).map((f) => {
        const [x, y, w2, h2] = vpRect(f.rect);
        const sel = fieldApi?.sel === f.id;
        const shell = (kids: React.ReactNode) => (
          <div key={f.id} className={`pdf-field ${sel ? "sel" : ""}`}
            style={{ left: x, top: y, width: w2, height: h2 }}
            onPointerDown={(e) => { if (tool === "select") startFieldMove(e, f); }}
            onClick={() => fieldApi?.select(f.id)}>
            {kids}
            {f.required && <span className="pdf-field-req">*</span>}
          </div>
        );
        switch (f.kind) {
          case "text":
            return shell(<input className="pdf-field-in" value={String(f.value ?? "")}
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
              onChange={(e) => fieldApi?.patch(f.id, { value: e.target.value }, `fv:${f.id}`)} />);
          case "checkbox":
            return shell(<span className="pdf-field-check" onClick={(e) => { e.stopPropagation(); fieldApi?.patch(f.id, { value: !f.value }); }}>
              {f.value ? "✔" : ""}</span>);
          case "radio":
            return shell(<span className={`pdf-field-radio ${f.value ? "on" : ""}`}
              onClick={(e) => { e.stopPropagation(); fieldApi?.checkRadio(f); }} />);
          case "dropdown":
            return shell(<select className="pdf-field-in" value={String(f.value ?? "")}
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
              onChange={(e) => fieldApi?.patch(f.id, { value: e.target.value })}>
              <option value=""></option>
              {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>);
          case "list":
            return shell(<select className="pdf-field-in" multiple value={String(f.value ?? "").split("\n").filter(Boolean)}
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
              onChange={(e) => fieldApi?.patch(f.id, { value: [...e.target.selectedOptions].map((o) => o.value).join("\n") })}>
              {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>);
        }
      })}
      {/* selected-field property editor */}
      {v && canEdit && fieldApi?.sel && (() => {
        const f = fieldApi.fields.find((x) => x.id === fieldApi.sel);
        if (!f) return null;
        const [x, y, , h2] = vpRect(f.rect);
        return (
          <div className="pdf-fieldprops" style={{ left: x, top: y + h2 + 4 }}
            onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            <input value={f.name} title="Field name"
              onChange={(e) => fieldApi.patch(f.id, { name: e.target.value }, `fn:${f.id}`)} />
            <select value={f.kind} onChange={(e) => fieldApi.patch(f.id, { kind: e.target.value as FieldKind })}>
              <option value="text">text</option><option value="checkbox">checkbox</option>
              <option value="radio">radio</option><option value="dropdown">dropdown</option><option value="list">list</option>
            </select>
            {(f.kind === "dropdown" || f.kind === "list") && (
              <input value={(f.options ?? []).join(", ")} title="Options (comma-separated)" placeholder="a, b, c"
                onChange={(e) => fieldApi.patch(f.id, { options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) }, `fo:${f.id}`)} />
            )}
            {f.kind === "radio" && (
              <input value={f.group ?? ""} title="Radio group" placeholder="group"
                onChange={(e) => fieldApi.patch(f.id, { group: e.target.value }, `fg:${f.id}`)} />
            )}
            <label title="Required"><input type="checkbox" checked={!!f.required}
              onChange={(e) => fieldApi.patch(f.id, { required: e.target.checked })} />req</label>
            <button className="btn-ghost btn-sm" title="Delete field"
              onClick={() => { fieldApi.del(f.id); fieldApi.select(null); }}>🗑</button>
          </div>
        );
      })()}
      <div className="pdf-pageno">{pageNum}</div>
    </div>
  );
}

// ---------- vector annotation renderer ----------
function AnnSvg({ a, vpRect, toVp, scale, selected, selectable, onDown }: {
  a: PdfAnn;
  vpRect: (r: Rect4) => Rect4;
  toVp: (x: number, y: number) => [number, number];
  scale: number;
  selected: boolean;
  selectable: boolean;
  onDown: (e: React.PointerEvent) => void;
}) {
  const color = a.color ?? "#F2782E";
  const pe = selectable ? { pointerEvents: "visiblePainted" as const, cursor: "move" } : { pointerEvents: "none" as const };
  const sw = Math.max(1.2, 1.6 * scale);
  const selOutline = selected ? { outline: "1.5px dashed #3578E5", outlineOffset: 2 } : {};

  switch (a.type) {
    case "highlight":
      return <g style={selOutline} onPointerDown={onDown}>{(a.rects ?? []).map((r, i) => {
        const [x, y, w, h] = vpRect(r);
        return <rect key={i} x={x} y={y} width={w} height={h} fill={color} fillOpacity={0.38} style={{ ...pe, mixBlendMode: "multiply" }} />;
      })}</g>;
    case "underline":
    case "strikeout":
      return <g style={selOutline} onPointerDown={onDown}>{(a.rects ?? []).map((r, i) => {
        const [x, y, w, h] = vpRect(r);
        const ly = a.type === "underline" ? y + h - 1 : y + h / 2;
        return <line key={i} x1={x} y1={ly} x2={x + w} y2={ly} stroke={color} strokeWidth={sw} style={pe} />;
      })}</g>;
    case "squiggly":
      return <g style={selOutline} onPointerDown={onDown}>{(a.rects ?? []).map((r, i) => {
        const [x, y, w, h] = vpRect(r);
        const ly = y + h - 1, step = Math.max(3, 4 * scale), amp = Math.max(1.4, 1.8 * scale);
        let d = `M ${x} ${ly}`;
        for (let px = step, up = true; px < w + step; px += step, up = !up)
          d += ` l ${Math.min(step, x + w - (px - step))} ${up ? -amp : amp}`;
        return <path key={i} d={d} fill="none" stroke={color} strokeWidth={sw} style={pe} />;
      })}</g>;
    case "polyline":
      return <polyline points={(a.points ?? []).map(([px, py]) => { const [x, y] = toVp(px, py); return `${x},${y}`; }).join(" ")}
        fill="none" stroke={color} strokeWidth={sw} strokeLinejoin="round" style={{ ...pe, ...selOutline }} onPointerDown={onDown} />;
    case "cloud": {
      const [x, y, w, h] = vpRect(a.rects![0]);
      const b = Math.max(5, 7 * scale); // bump radius
      let d = `M ${x} ${y}`;
      const bump = (x1: number, y1: number, x2: number, y2: number) => {
        const n = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / (1.7 * b)));
        const ux = (x2 - x1) / n, uy = (y2 - y1) / n;
        for (let i = 0; i < n; i++) d += ` a ${b} ${b} 0 0 1 ${ux.toFixed(1)} ${uy.toFixed(1)}`;
      };
      bump(x, y, x + w, y); bump(x + w, y, x + w, y + h); bump(x + w, y + h, x, y + h); bump(x, y + h, x, y);
      return <path d={d + " Z"} fill="none" stroke={color} strokeWidth={sw} style={{ ...pe, ...selOutline }} onPointerDown={onDown} />;
    }
    case "callout": {
      // svg draws just the tail; the bordered text box renders in the html layer
      const [x, y, w, h] = vpRect(a.rects![0]);
      const [tx, ty] = toVp(a.points?.[0]?.[0] ?? 0, a.points?.[0]?.[1] ?? 0);
      const cx = x + w / 2, cy = y + h / 2, dx = tx - cx, dy = ty - cy;
      const t = Math.min(dx ? (w / 2) / Math.abs(dx) : Infinity, dy ? (h / 2) / Math.abs(dy) : Infinity);
      return <line x1={tx} y1={ty} x2={cx + dx * t} y2={cy + dy * t} stroke={color} strokeWidth={sw} style={pe} />;
    }
    case "freehand":
      return <polyline points={(a.points ?? []).map(([px, py]) => { const [x, y] = toVp(px, py); return `${x},${y}`; }).join(" ")}
        fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" style={{ ...pe, ...selOutline }} onPointerDown={onDown} />;
    case "whiteout": {
      const [x, y, w, h] = vpRect(a.rects![0]);
      return <rect x={x} y={y} width={w} height={h} fill="#fff" stroke="#ddd" strokeWidth={0.6} style={{ ...pe, ...selOutline }} onPointerDown={onDown} />;
    }
    case "rect": {
      const [x, y, w, h] = vpRect(a.rects![0]);
      return <rect x={x} y={y} width={w} height={h} fill="none" stroke={color} strokeWidth={sw} style={{ ...pe, ...selOutline }} onPointerDown={onDown} />;
    }
    case "ellipse": {
      const [x, y, w, h] = vpRect(a.rects![0]);
      return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} fill="none" stroke={color} strokeWidth={sw} style={{ ...pe, ...selOutline }} onPointerDown={onDown} />;
    }
    case "line":
    case "arrow": {
      const [ax, ay] = toVp(a.points![0][0], a.points![0][1]);
      const [bx, by] = toVp(a.points![1][0], a.points![1][1]);
      const ang = Math.atan2(by - ay, bx - ax);
      const hl = 9 * scale;
      return (
        <g style={{ ...pe, ...selOutline }} onPointerDown={onDown}>
          <line x1={ax} y1={ay} x2={bx} y2={by} stroke={color} strokeWidth={sw} />
          {a.type === "arrow" && (
            <polygon fill={color}
              points={`${bx},${by} ${bx - hl * Math.cos(ang - 0.45)},${by - hl * Math.sin(ang - 0.45)} ${bx - hl * Math.cos(ang + 0.45)},${by - hl * Math.sin(ang + 0.45)}`} />
          )}
        </g>
      );
    }
    default:
      return null;
  }
}

// ---------- print all pages ----------
function PrintDeck({ doc, anns, fields, onDone }: { doc: PDFDocumentProxy | null; anns: PdfAnn[]; fields?: PdfField[]; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!doc) return;
    let dead = false;
    (async () => {
      const host = ref.current!;
      for (let p = 1; p <= doc.numPages; p++) {
        if (dead) return;
        const page = await doc.getPage(p);
        const vp = page.getViewport({ scale: 1.4 });
        const wrap = document.createElement("div");
        wrap.className = "print-pdf-page";
        wrap.style.width = `${vp.width}px`; wrap.style.height = `${vp.height}px`;
        const canvas = document.createElement("canvas");
        canvas.width = vp.width; canvas.height = vp.height;
        await page.render({ canvas, viewport: vp }).promise;
        wrap.appendChild(canvas);
        // bake annotations as svg
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("width", String(vp.width)); svg.setAttribute("height", String(vp.height));
        svg.style.cssText = "position:absolute;inset:0;pointer-events:none";
        const toVp = (x: number, y: number) => vp.convertToViewportPoint(x, y);
        const vpR = (r: Rect4) => { const [x1, y1] = toVp(r[0], r[1] + r[3]); const [x2, y2] = toVp(r[0] + r[2], r[1]); return [x1, y1, x2 - x1, y2 - y1]; };
        for (const a of anns.filter((x) => x.page === p)) {
          const c = a.color ?? "#F2782E";
          if (a.type === "highlight") for (const r of a.rects ?? []) {
            const [x, y, w, h] = vpR(r);
            const el = document.createElementNS(svgNS, "rect");
            el.setAttribute("x", `${x}`); el.setAttribute("y", `${y}`); el.setAttribute("width", `${w}`); el.setAttribute("height", `${h}`);
            el.setAttribute("fill", c); el.setAttribute("fill-opacity", "0.38");
            svg.appendChild(el);
          } else if ((a.type === "underline" || a.type === "strikeout")) for (const r of a.rects ?? []) {
            const [x, y, w, h] = vpR(r);
            const ly = a.type === "underline" ? y + h - 1 : y + h / 2;
            const el = document.createElementNS(svgNS, "line");
            el.setAttribute("x1", `${x}`); el.setAttribute("y1", `${ly}`); el.setAttribute("x2", `${x + w}`); el.setAttribute("y2", `${ly}`);
            el.setAttribute("stroke", c); el.setAttribute("stroke-width", "1.6");
            svg.appendChild(el);
          } else if (a.type === "squiggly") for (const r of a.rects ?? []) {
            const [x, y, w, h] = vpR(r);
            const ly = y + h - 1, step = 4, amp = 1.8;
            let d = `M ${x} ${ly}`;
            for (let px = step, up = true; px < w + step; px += step, up = !up)
              d += ` l ${Math.min(step, x + w - (px - step)).toFixed(1)} ${up ? -amp : amp}`;
            const el = document.createElementNS(svgNS, "path");
            el.setAttribute("d", d); el.setAttribute("fill", "none");
            el.setAttribute("stroke", c); el.setAttribute("stroke-width", "1.3");
            svg.appendChild(el);
          } else if ((a.type === "freehand" || a.type === "polyline") && a.points?.length) {
            const el = document.createElementNS(svgNS, "polyline");
            el.setAttribute("points", a.points.map(([px, py]) => { const [x, y] = toVp(px, py); return `${x},${y}`; }).join(" "));
            el.setAttribute("fill", "none"); el.setAttribute("stroke", c); el.setAttribute("stroke-width", "1.8");
            svg.appendChild(el);
          } else if (a.type === "rect" || a.type === "ellipse") {
            const [x, y, w, h] = vpR(a.rects![0]);
            const el = document.createElementNS(svgNS, a.type === "rect" ? "rect" : "ellipse");
            if (a.type === "rect") { el.setAttribute("x", `${x}`); el.setAttribute("y", `${y}`); el.setAttribute("width", `${w}`); el.setAttribute("height", `${h}`); }
            else { el.setAttribute("cx", `${x + w / 2}`); el.setAttribute("cy", `${y + h / 2}`); el.setAttribute("rx", `${w / 2}`); el.setAttribute("ry", `${h / 2}`); }
            el.setAttribute("fill", "none"); el.setAttribute("stroke", c); el.setAttribute("stroke-width", "1.6");
            svg.appendChild(el);
          } else if ((a.type === "line" || a.type === "arrow") && a.points?.length === 2) {
            const [ax, ay] = toVp(a.points[0][0], a.points[0][1]);
            const [bx, by] = toVp(a.points[1][0], a.points[1][1]);
            const el = document.createElementNS(svgNS, "line");
            el.setAttribute("x1", `${ax}`); el.setAttribute("y1", `${ay}`); el.setAttribute("x2", `${bx}`); el.setAttribute("y2", `${by}`);
            el.setAttribute("stroke", c); el.setAttribute("stroke-width", "1.6");
            svg.appendChild(el);
          } else if (a.type === "cloud" && a.rects?.length) {
            const [x, y, w, h] = vpR(a.rects[0]);
            const b = 7;
            let d = `M ${x} ${y}`;
            const bump = (x1: number, y1: number, x2: number, y2: number) => {
              const n = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / (1.7 * b)));
              const ux = (x2 - x1) / n, uy = (y2 - y1) / n;
              for (let i = 0; i < n; i++) d += ` a ${b} ${b} 0 0 1 ${ux.toFixed(1)} ${uy.toFixed(1)}`;
            };
            bump(x, y, x + w, y); bump(x + w, y, x + w, y + h); bump(x + w, y + h, x, y + h); bump(x, y + h, x, y);
            const el = document.createElementNS(svgNS, "path");
            el.setAttribute("d", d + " Z"); el.setAttribute("fill", "none");
            el.setAttribute("stroke", c); el.setAttribute("stroke-width", "1.6");
            svg.appendChild(el);
          } else if (a.type === "callout" && a.rects?.length) {
            const [x, y, w, h] = vpR(a.rects[0]);
            const [tx, ty] = toVp(a.points?.[0]?.[0] ?? 0, a.points?.[0]?.[1] ?? 0);
            const cx = x + w / 2, cy = y + h / 2, dx = tx - cx, dy = ty - cy;
            const t = Math.min(dx ? (w / 2) / Math.abs(dx) : Infinity, dy ? (h / 2) / Math.abs(dy) : Infinity);
            const ln = document.createElementNS(svgNS, "line");
            ln.setAttribute("x1", `${tx}`); ln.setAttribute("y1", `${ty}`);
            ln.setAttribute("x2", `${cx + dx * t}`); ln.setAttribute("y2", `${cy + dy * t}`);
            ln.setAttribute("stroke", c); ln.setAttribute("stroke-width", "1.4");
            svg.appendChild(ln);
            const bx = document.createElementNS(svgNS, "rect");
            bx.setAttribute("x", `${x}`); bx.setAttribute("y", `${y}`); bx.setAttribute("width", `${w}`); bx.setAttribute("height", `${h}`);
            bx.setAttribute("fill", "#fff"); bx.setAttribute("stroke", c); bx.setAttribute("stroke-width", "1.4");
            svg.appendChild(bx);
            if (a.text) {
              const t2 = document.createElementNS(svgNS, "text");
              t2.setAttribute("x", `${x + 4}`); t2.setAttribute("y", `${y + 14}`);
              t2.setAttribute("fill", "#171717"); t2.setAttribute("font-size", "10");
              t2.textContent = a.text.slice(0, 90);
              svg.appendChild(t2);
            }
          } else if (a.type === "whiteout" && a.rects?.length) {
            const [x, y, w, h] = vpR(a.rects[0]);
            const el = document.createElementNS(svgNS, "rect");
            el.setAttribute("x", `${x}`); el.setAttribute("y", `${y}`); el.setAttribute("width", `${w}`); el.setAttribute("height", `${h}`);
            el.setAttribute("fill", "#fff");
            svg.appendChild(el);
          } else if ((a.type === "sign" || a.type === "image") && a.img) {
            const [x, y, w, h] = vpR(a.rects![0]);
            const el = document.createElementNS(svgNS, "image");
            el.setAttribute("x", `${x}`); el.setAttribute("y", `${y}`);
            el.setAttribute("width", `${w}`); el.setAttribute("height", `${h}`);
            el.setAttribute("href", a.img);
            svg.appendChild(el);
          } else if (a.type === "stamp" || a.type === "textbox" || a.type === "note") {
            const r = a.rects?.[0] ?? (a.points ? [a.points[0][0] - 60, a.points[0][1] - 14, 120, 28] as Rect4 : null);
            if (r) {
              const [x, y, w, h] = vpR(r);
              const t = document.createElementNS(svgNS, "text");
              t.setAttribute("x", `${x + 4}`); t.setAttribute("y", `${y + h / 2 + 5}`);
              t.setAttribute("fill", a.type === "stamp" ? c : "#171717");
              t.setAttribute("font-size", a.type === "stamp" ? "16" : "11");
              t.setAttribute("font-weight", "700");
              t.textContent = a.type === "note" ? `💬 ${a.text ?? ""}` : a.text ?? "";
              svg.appendChild(t);
              if (a.type === "stamp") {
                const b = document.createElementNS(svgNS, "rect");
                b.setAttribute("x", `${x}`); b.setAttribute("y", `${y}`); b.setAttribute("width", `${w}`); b.setAttribute("height", `${h}`);
                b.setAttribute("fill", "none"); b.setAttribute("stroke", c); b.setAttribute("stroke-width", "2.4"); b.setAttribute("rx", "5");
                svg.appendChild(b);
              }
            }
          }
        }
        // PDF-6 — authored form fields print as boxed values
        for (const f of (fields ?? []).filter((x) => x.page === p)) {
          const [x, y, w, h] = vpR(f.rect);
          const bx = document.createElementNS(svgNS, "rect");
          bx.setAttribute("x", `${x}`); bx.setAttribute("y", `${y}`); bx.setAttribute("width", `${w}`); bx.setAttribute("height", `${h}`);
          bx.setAttribute("fill", "rgba(240,244,255,.5)"); bx.setAttribute("stroke", "#8098c9"); bx.setAttribute("stroke-width", "0.8");
          svg.appendChild(bx);
          const val = f.kind === "checkbox" ? (f.value ? "✔" : "") : f.kind === "radio" ? (f.value ? "●" : "") : String(f.value ?? "");
          if (val) {
            const t = document.createElementNS(svgNS, "text");
            t.setAttribute("x", `${x + 3}`); t.setAttribute("y", `${y + h / 2 + 4}`);
            t.setAttribute("fill", "#171717"); t.setAttribute("font-size", "10");
            t.textContent = val.slice(0, 80);
            svg.appendChild(t);
          }
        }
        wrap.appendChild(svg);
        host.appendChild(wrap);
      }
      setTimeout(() => { window.print(); onDone(); }, 60);
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);
  return createPortal(<div className="print-deck" ref={ref} />, document.body);
}

// ---------- PDF-5: annotation list row (author · status · replies) ----------
const ANN_ICON: Record<string, string> = {
  highlight: "🖍", underline: "U̲", strikeout: "S̶", squiggly: "≋", freehand: "✏", polyline: "⛓",
  rect: "▭", ellipse: "◯", line: "╱", arrow: "↗", callout: "🗨", cloud: "☁",
  note: "💬", textbox: "T", stamp: "◈", sign: "✍",
};
const ANN_STATUS = ["none", "accepted", "rejected", "completed"] as const;

function AnnRow({ a, sel, canEdit, userName, onPick, onDel, onPatch }: {
  a: PdfAnn; sel: boolean; canEdit: boolean; userName: string;
  onPick: () => void; onDel: () => void; onPatch: (p: Partial<PdfAnn>) => void;
}) {
  const [reply, setReply] = useState("");
  const label = a.type === "note" || a.type === "textbox" || a.type === "callout" || a.type === "stamp"
    ? (a.text ?? "").slice(0, 60) : a.type;
  return (
    <div className={`pdf-annrow ${sel ? "on" : ""}`} onClick={onPick}>
      <div className="pdf-annrow-top">
        <span className="pdf-annrow-ico" style={{ borderColor: a.color }}>{ANN_ICON[a.type] ?? "◌"}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="pdf-annrow-label">{label || a.type}</div>
          <div className="pdf-annrow-meta">p.{a.page}{a.author ? ` · ${a.author}` : ""}</div>
        </div>
        {canEdit && <button className="btn-ghost btn-sm" title="Delete" onClick={(e) => { e.stopPropagation(); onDel(); }}>🗑</button>}
      </div>
      {sel && (
        <div className="pdf-annrow-detail" onClick={(e) => e.stopPropagation()}>
          <select className="rb-sel" style={{ width: "100%" }} value={a.status ?? "none"}
            disabled={!canEdit}
            onChange={(e) => onPatch({ status: e.target.value as PdfAnn["status"] })}>
            {ANN_STATUS.map((s) => <option key={s} value={s}>Status: {s}</option>)}
          </select>
          {(a.replies ?? []).map((r, i) => (
            <div key={i} className="pdf-annreply"><b>{r.by}</b> {r.text}</div>
          ))}
          {canEdit && (
            <div style={{ display: "flex", gap: 4 }}>
              <input value={reply} placeholder="Reply…" style={{ flex: 1, height: 26, fontSize: 11 }}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && reply.trim()) {
                  onPatch({ replies: [...(a.replies ?? []), { by: userName, text: reply.trim(), at: new Date().toISOString() }] });
                  setReply("");
                } }} />
              <button className="btn-ghost btn-sm" disabled={!reply.trim()}
                onClick={() => { onPatch({ replies: [...(a.replies ?? []), { by: userName, text: reply.trim(), at: new Date().toISOString() }] }); setReply(""); }}>↩</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
