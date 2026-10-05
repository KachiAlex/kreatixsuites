import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type * as pdfjsTypes from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import pdfViewerCss from "pdfjs-dist/web/pdf_viewer.css?inline";
import type { DriveItem, Comment } from "@kreatix/shared";
import { api, getToken } from "../lib/api";
import { saveContent } from "../lib/drafts";
import { useCollabSession, useMapSync } from "../collab/useCollab";
import { AiPanel, type AiOp } from "../ai/AiPanel";
import { PresenceBar } from "../collab/PresenceBar";
import { ShareDialog } from "../components/ShareDialog";
import { VersionsPanel } from "../components/VersionsPanel";
import { CommentsPanel } from "../components/CommentsPanel";
import { useToast } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { RibbonTabs } from "../components/RibbonTabs";
import { AppIcon } from "../components/AppIcon";
import type { PdfAnn, PdfDoc, AnnType, PdfField, FieldKind, OcrWord } from "./model";
import { emptyPdfDoc, STAMPS } from "./model";
import { remapAnns, reorganizePdf, mergePdf, extractPages, splitPdf, downloadPdf, appendImagePages, attachFilesToPdf, makePortfolio, webTextToPdf } from "./pages";
import { SUBTYPE, PDFJS_TYPE, annotRectOf, pdfjsIdsOf, embedIntoPdf } from "./embed";
import { verifySignatures, type SigReport } from "./sigs";
import type { CertSource } from "./sign";
const flattenMod = () => import("./flatten");

// pdf.js is heavy (~430KB) — lazy-loaded only when a PDF is actually opened
let pdfjs!: typeof pdfjsTypes;

// pdf_viewer.css ships global, unprefixed class names (.sidebar, .dialog,
// .page, .hidden …) that collide with the app shell — under
// prefers-color-scheme:dark its .sidebar rule paints our app sidebar navy.
// Inject it inside @scope so it only applies within the editor subtree.
// Its :root vars (light-dark flip) remap to :scope = the editor root.
{
  const style = document.createElement("style");
  style.id = "pdfjs-viewer-scoped";
  // :root vars → :scope so the light-dark flip still works inside the subtree;
  // relative url(images/…) → the pdfjs icons copied into /pdfjs-images
  const scoped = pdfViewerCss
    .replace(/:root/g, ":scope")
    .replace(/url\((['"]?)images\//g, "url($1/pdfjs-images/");
  style.textContent = `@scope (.pdfjs-scope) {\n${scoped}\n}`;
  document.head.appendChild(style);
}
let pdfjsReady: Promise<void> | null = null;
const ensurePdfjs = () => (pdfjsReady ??= import("pdfjs-dist").then((m) => {
  pdfjs = m;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
}));

type SaveState = "saved" | "saving" | "unsaved" | "error";
type Tool = "select" | AnnType | "pan" | "zoombox" | "measure" | "edittext" | "field" | "loupe" | "snapshot" | "cryptosign";
// tools that stay enabled for read-only viewers
const VIEW_TOOLS = new Set<Tool>(["select", "pan", "zoombox", "loupe", "snapshot"]);
const SIG_KEY = "kx.signature";
type Panel = "none" | "thumbs" | "outline" | "search" | "anns" | "layers" | "attach" | "access" | "comments" | "versions" | "ai" | "organize" | "compare" | "sigs";
type Rect4 = [number, number, number, number];

// Tools grouped by task — the ribbon renders each group as a labeled dropdown
// so every function is discoverable by name without a 26-icon row.
const TOOL_GROUPS: { label: string; tools: { id: Tool; ico: string; label: string; viewer?: boolean }[] }[] = [
  { label: "Markup", tools: [
    { id: "highlight", ico: "🖍", label: "Highlight text" },
    { id: "underline", ico: "U̲", label: "Underline text" },
    { id: "strikeout", ico: "S̶", label: "Strikeout text" },
    { id: "squiggly", ico: "≋", label: "Squiggly underline" },
  ]},
  { label: "Draw", tools: [
    { id: "freehand", ico: "✏", label: "Freehand draw" },
    { id: "polyline", ico: "⛓", label: "Polyline (click vertices, double-click ends)" },
    { id: "rect", ico: "▭", label: "Rectangle" },
    { id: "ellipse", ico: "◯", label: "Ellipse" },
    { id: "line", ico: "╱", label: "Line" },
    { id: "arrow", ico: "↗", label: "Arrow" },
    { id: "callout", ico: "🗨", label: "Callout (box + tail)" },
    { id: "cloud", ico: "☁", label: "Cloud" },
    { id: "measure", ico: "📏", label: "Measure distance" },
  ]},
  { label: "Fill & Sign", tools: [
    { id: "textbox", ico: "T", label: "Typewriter — type text anywhere on the form" },
    { id: "check", ico: "✔", label: "Check mark — click to tick a checkbox" },
    { id: "cross", ico: "✖", label: "Cross mark — click to place ✖" },
    { id: "sign", ico: "✍", label: "Signature — draw or type, then click to place" },
    { id: "cryptosign", ico: "🖋", label: "Digital signature — cryptographically sign with a certificate" },
    { id: "note", ico: "💬", label: "Sticky note" },
    { id: "stamp", ico: "✅", label: "Stamp (APPROVED / DRAFT / …)" },
  ]},
  { label: "Edit content", tools: [
    { id: "edittext", ico: "✎T", label: "Edit text — click a line to retype it, or drag a block" },
    { id: "image", ico: "🖼", label: "Insert image" },
    { id: "whiteout", ico: "▨", label: "White-out — erase content" },
    { id: "redact", ico: "▮", label: "Redact — permanently remove on export" },
  ]},
  { label: "Forms", tools: [
    { id: "field", ico: "▣", label: "Form field — drag to place" },
  ]},
  { label: "Review", tools: [
    { id: "caret", ico: "⌃", label: "Insert text at caret" },
    { id: "replace", ico: "⌁", label: "Replace text — suggest a correction" },
  ]},
  { label: "Inspect", tools: [
    { id: "pan", ico: "✋", label: "Hand — drag to pan (or hold Space)", viewer: true },
    { id: "zoombox", ico: "🔍+", label: "Marquee zoom — drag a box to fill the view", viewer: true },
    { id: "loupe", ico: "🔎", label: "Loupe — hover to magnify", viewer: true },
    { id: "snapshot", ico: "📸", label: "Snapshot — drag an area to copy it as an image", viewer: true },
  ]},
];

const MARKUP_COLORS = ["#FFD23F", "#F2782E", "#D84B57", "#1F9D66", "#3578E5", "#8E6BC8"];
const COLOR_NAMES: Record<string, string> = {
  "#FFD23F": "Yellow", "#F2782E": "Orange", "#D84B57": "Red",
  "#1F9D66": "Green", "#3578E5": "Blue", "#8E6BC8": "Purple",
};
const MARKUP_TOOLS = new Set<Tool>(["highlight", "underline", "strikeout", "squiggly", "freehand", "polyline", "rect", "ellipse", "line", "arrow", "callout", "cloud", "note", "textbox", "stamp", "measure", "edittext", "image", "whiteout", "redact", "caret", "replace", "check", "cross"]);

const REDACT_PRESETS: Record<string, { label: string; re: string }> = {
  ssn:    { label: "SSN (###-##-####)",  re: "\\b\\d{3}-\\d{2}-\\d{4}\\b" },
  email:  { label: "Email address",      re: "\\b[\\w.+-]+@[\\w-]+\\.[\\w.]+\\b" },
  phone:  { label: "US phone number",    re: "\\b(?:\\+?1[\\s.-]?)?\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4}\\b" },
  cc:     { label: "Credit card number", re: "\\b(?:\\d[ -]?){13,16}\\b" },
  date:   { label: "Date (MM/DD/YYYY)",  re: "\\b\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}\\b" },
  custom: { label: "Custom regex…",      re: "" },
};

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

export function PdfEditor({ item, initialDoc, permission, aiPrompt }: {
  item: DriveItem;
  initialDoc: unknown;
  permission: string;
  /** ?ai=<prompt> deep-link — opens the AI panel with a seeded prompt. */
  aiPrompt?: string;
}) {
  const { msg, toast } = useToast();
  const { user } = useAuth();
  const navigate = useNavigate();
  const canEdit = permission === "owner" || permission === "editor";
  const [title, setTitle] = useState(item.name);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  // rail overlays the document on small screens — start closed there
  const [panel, setPanel] = useState<Panel>(() => (aiPrompt !== undefined ? "ai" : typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches ? "none" : "thumbs"));
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
  const [tbFont, setTbFont] = useState<"helv" | "times" | "courier">("helv");
  const [tbSize, setTbSize] = useState(9);
  // PDF-3 — view depth
  const [viewMode, setViewMode] = useState<"cont" | "single" | "two" | "reflow">("cont");
  const [cover, setCover] = useState(false); // PDF-11.4 — page 1 alone in two-page mode
  const [viewRot, setViewRot] = useState(0);       // session-only rotation, degrees
  const [dark, setDark] = useState(false);
  const [selAnn, setSelAnn] = useState<string | null>(null);
  const [focusAnn, setFocusAnn] = useState<string | null>(null); // newly placed textbox → focus for typing
  const [hlFields, setHlFields] = useState(true);      // Acrobat-style blue tint on fillable fields
  const [spaceDown, setSpaceDown] = useState(false);   // spacebar held → drag-to-pan
  const [panning, setPanning] = useState(false);
  const [showKeys, setShowKeys] = useState(false);     // shortcuts overlay
  const [redactDlg, setRedactDlg] = useState(false);
  const [redactPat, setRedactPat] = useState("ssn");
  const [redactCustom, setRedactCustom] = useState("");
  const [redactCase, setRedactCase] = useState(false);
  const [redactScan, setRedactScan] = useState<{ page: number; text: string; rects: Rect4[] }[] | null>(null);
  const [redactBusy, setRedactBusy] = useState(false);
  const [curDims, setCurDims] = useState<{ w: number; h: number } | null>(null);
  const [pageLabels, setPageLabels] = useState<string[] | null>(null); // logical labels (i, ii, 1, A-1)
  const [showAnns, setShowAnns] = useState(true);   // global show/hide comments & markup
  const [autoScroll, setAutoScroll] = useState(0);  // px/frame — 0 = off
  const [readMode, setReadMode] = useState(false);  // chrome-free reading view
  const [searchBm, setSearchBm] = useState(false);  // search bookmarks/outline titles
  const [searchCm, setSearchCm] = useState(false);  // search comment contents
  const [propsOpen, setPropsOpen] = useState(false);
  const [docProps, setDocProps] = useState<{ k: string; v: string }[] | null>(null);
  // Acrobat-style view history: Alt+←/→ jumps back/forward through navigations
  const navHist = useRef<{ stack: { page: number; top: number }[]; idx: number }>({ stack: [], idx: -1 });
  const navPush = (p: number) => {
    const h = navHist.current;
    const top = scrollRef.current?.scrollTop ?? 0;
    const cur = h.stack[h.idx];
    if (cur && cur.page === p && Math.abs(cur.top - top) < 40) return;
    h.stack = h.stack.slice(0, h.idx + 1);
    h.stack.push({ page: p, top });
    if (h.stack.length > 60) h.stack.shift();
    h.idx = h.stack.length - 1;
  };
  const navStep = (dir: -1 | 1) => {
    const h = navHist.current;
    const e = h.stack[h.idx + dir];
    if (!e || e.page > numPages) return;
    h.idx += dir;
    setCurPage(e.page);
    for (const t of [0, 200]) setTimeout(() => {
      const el = scrollRef.current;
      if (!el) return;
      pageRefs.current.get(e.page)?.scrollIntoView();
      el.scrollTop = e.top;
    }, t);
  };
  const zoomAnchor = useRef<{ fx: number; fy: number; ratio: number; sl: number; st: number } | null>(null);
  // pinch-zoom — live touch points + gesture start distance/scale
  const touchPts = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ d0: number; s0: number; last: number } | null>(null);
  const didInitView = useRef(false);
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  const [printing, setPrinting] = useState(false);
  const [exportDlg, setExportDlg] = useState(false);
  const [pdfOpts, setPdfOpts] = useState<{ pageNumbers: boolean; watermark: string; header: string; footer: string; sanitize: boolean; optimize: boolean; batesPrefix: string; batesStart: number }>
    ({ pageNumbers: false, watermark: "", header: "", footer: "", sanitize: false, optimize: false, batesPrefix: "", batesStart: 1 });
  const [speaking, setSpeaking] = useState(false);
  // read-aloud settings — persisted voice + rate
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [tts, setTts] = useState<{ voice?: string; rate?: number }>(() => { try { return JSON.parse(localStorage.getItem("kx:tts") ?? "{}"); } catch { return {}; } });
  // View ▸ Rulers & grids
  const [showRulers, setShowRulers] = useState(false);
  const [showGrid, setShowGrid] = useState(false);
  // digital-signature integrity report (filled after load)
  const [sigs, setSigs] = useState<SigReport[] | null>(null);
  // check/cross mark size + custom color; digital-signature identity dialog
  const [markSize, setMarkSize] = useState(18);
  const [digSignDlg, setDigSignDlg] = useState(false);
  const [digId, setDigId] = useState<{ name: string; reason: string; location: string; cert: CertSource } | null>(null);
  const [digMode, setDigMode] = useState<"self" | "p12">("self");
  const [digName, setDigName] = useState(""); const [digEmail, setDigEmail] = useState(""); const [digOrg, setDigOrg] = useState("");
  const [digReason, setDigReason] = useState(""); const [digLoc, setDigLoc] = useState("");
  const [digPw, setDigPw] = useState(""); const [digP12, setDigP12] = useState<Uint8Array | null>(null);
  const digP12Ref = useRef<HTMLInputElement>(null);
  const [cmp, setCmp] = useState<{ page: number; st: string; a?: string; b?: string }[] | null>(null);
  // shared tool picker — ribbon dropdowns and the menubar route through here
  const pickTool = (t: Tool) => {
    setTool(t);
    if (t === "sign" && !sigImg) setSigPadOpen(true);
    if (t === "cryptosign" && !digId) setDigSignDlg(true);
  };
  const cmpRef = useRef<HTMLInputElement>(null);
  const openFileRef = useRef<HTMLInputElement>(null);
  // PDF-11.1 — optional content groups (layers)
  const ocgCfgRef = useRef<{ getGroups: () => Record<string, { name?: string }>; setVisibility: (id: string, v: boolean) => void } | null>(null);
  const [ocg, setOcg] = useState<{ id: string; name: string; on: boolean }[]>([]);
  const [ocgRev, setOcgRev] = useState(0);
  // PDF-11.5 — embedded file attachments
  const [attachments, setAttachments] = useState<{ name: string; content: Uint8Array }[]>([]);
  // PDF-14.1 — accessibility check results
  const [accessReport, setAccessReport] = useState<{ ok: boolean; label: string }[] | null>(null);
  // PDF-8.3 — OCR
  const [ocrBusy, setOcrBusy] = useState(false);
  // PDF-12.3 — review filter in the annotations panel
  const [annFilter, setAnnFilter] = useState<"all" | "open" | "accepted" | "rejected" | "completed">("all");
  // PDF-13.4 — web page → pages
  const [webUrl, setWebUrl] = useState("");
  const attachRef = useRef<HTMLInputElement>(null);
  const portRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [matches, setMatches] = useState<{ page: number; snippet: string; rects: Rect4[]; kind?: "text" | "bookmark" | "comment"; dest?: unknown; annId?: string }[]>([]);
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
  const fdfRef = useRef<HTMLInputElement>(null);
  const imgPageRef = useRef<HTMLInputElement>(null);
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
        // logical page labels (i, ii, 1, A-1…) when the doc defines them
        (d.getPageLabels?.() ?? Promise.resolve(null)).then((l) => !dead && setPageLabels(l)).catch(() => {});
        // digital signatures — verify byte-range integrity + signer identity
        setSigs(null);
        verifySignatures(bytes).then((s) => !dead && setSigs(s)).catch(() => {});
        // honor the document's initial view — unless we remember a position from before
        const hasSavedPos = (() => { try { return !!localStorage.getItem(`kx:pdfpos:${item.id}`); } catch { return false; } })();
        if (!hasSavedPos) {
          d.getPageLayout?.().then((l) => {
            if (dead) return;
            if (l === "SinglePage") setViewMode("single");
            else if (l === "TwoPageRight") { setViewMode("two"); setCover(true); }
            else if (l === "TwoPageLeft" || l === "TwoColumnLeft" || l === "TwoColumnRight") setViewMode("two");
          }).catch(() => {});
          d.getPageMode?.().then((m) => {
            if (dead) return;
            if (m === "UseOutlines") setPanel("outline");
            else if (m === "UseThumbs") setPanel("thumbs");
            else if (m === "UseAttachments") setPanel("attach");
          }).catch(() => {});
          d.getOpenAction?.().then((a) => {
            if (dead || !a) return;
            const dest = (a as Map<string, unknown>).get?.("dest") ?? (a as Map<string, unknown>).get?.("D");
            if (dest != null) void resolveDest(dest).then((p) => { if (p && !dead) setTimeout(() => scrollToPage(p), 400); });
          }).catch(() => {});
        }
        // PDF-11.1 — optional content groups for the layers pane
        d.getOptionalContentConfig?.().then((cfg) => {
          if (dead || !cfg) return;
          ocgCfgRef.current = cfg as unknown as typeof ocgCfgRef.current;
          // pdf.js exposes getGroup/setVisibility but no enumerator — the
          // groups live in the internal _groups map (id → {name, intent, usage})
          const groups = (cfg as unknown as { _groups?: Map<string, { name?: string }> })._groups ?? new Map();
          setOcg([...groups.entries()].map(([id, g]) => ({ id, name: g.name || id, on: true })));
        }).catch(() => {});
        // PDF-11.5 — embedded attachments
        d.getAttachments?.().then((att) => {
          if (dead || !att) return;
          setAttachments(Object.entries(att).map(([name, v]) => ({ name, content: (v as { content: Uint8Array }).content })));
        }).catch(() => {});
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

  const currentPayload = useCallback(() => {
    const form = formValues();
    return { ...annDoc, form: Object.keys(form).length ? form : annDoc.form };
  }, [annDoc, formValues]);

  const flushSave = useCallback(async () => {
    setSaveState("saving");
    const ok = await saveContent(item.id, currentPayload(), !!session);
    setSaveState(ok ? "saved" : "error");
  }, [currentPayload, item.id, session]);

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

  /**
   * Acrobat-style save: embed annotations as real /Annots objects + authored
   * fields as real AcroForm fields + form values into /V — the work becomes
   * part of the file itself, visible/editable in Foxit, Acrobat, browsers.
   * Autosave still writes the JSON layer only; this is the explicit Save.
   */
  const saveIntoFile = async () => {
    if (!pdfDataRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (!canEdit) { void flushSave(); return; }
    setSaveState("saving");
    try {
      const rasters = await rasterizeRedacted();
      const { bytes, doc: next } = await embedIntoPdf(
        pdfDataRef.current.slice(0), annDoc, formValues(), doc, rasters);
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      setAnnDoc(next);
      await persistBytes(buf, "Annotations embedded");
      const form = formValues();
      const ok = await saveContent(item.id,
        { ...next, form: Object.keys(form).length ? form : next.form }, !!session);
      setSaveState(ok ? "saved" : "error");
      if (ok) toast("Saved — annotations are now part of the PDF");
      await reloadPdf(buf); // reload so embedded annots/fields render from the file
    } catch (e) {
      console.error(e);
      setSaveState("error");
      toast("Could not write into the PDF — saved annotation layer only");
      void flushSave();
    }
  };

  /** Cryptographic signing — embeds current work, writes a real /Sig field at the
   *  click point, and produces a detached-PKCS#7 signed file. Terminal-ish:
   *  saving again rewrites the bytes and invalidates the signature. */
  const cryptoSignAt = async (page: number, x: number, y: number) => {
    if (!digId || !pdfDataRef.current || !doc) return;
    setSaveState("saving");
    try {
      const rasters = await rasterizeRedacted();
      const { bytes, doc: next } = await embedIntoPdf(pdfDataRef.current.slice(0), annDoc, formValues(), doc, rasters);
      const { signPdf } = await import("./sign");
      const w = 220, h = 48;
      const signed = await signPdf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
        page: page - 1, rect: [x - w / 2, y - h / 2, w, h],
        name: digId.name, reason: digId.reason, location: digId.location, cert: digId.cert,
      });
      const buf = signed.buffer.slice(signed.byteOffset, signed.byteOffset + signed.byteLength) as ArrayBuffer;
      setAnnDoc(next);
      await persistBytes(buf, "Digitally signed");
      await reloadPdf(buf);
      setSaveState("saved");
      setTool("select");
      toast("Digitally signed — another save rewrites the file and invalidates the signature; Download keeps a signed copy");
    } catch (e) {
      console.error(e);
      setSaveState("error");
      toast("Signing failed — check the certificate file and password");
    }
  };

  // Download the working PDF — embeds current annotations/fields into the
  // bytes on the fly so the local file matches what you see, saved or not.
  const downloadCurrent = async () => {
    const b = pdfDataRef.current;
    if (!b) return;
    const name = /\.pdf$/i.test(title) ? title : `${title}.pdf`;
    try {
      const rasters = await rasterizeRedacted();
      const { bytes } = await embedIntoPdf(b.slice(0), annDoc, formValues(), doc, rasters);
      downloadPdf(bytes, name);
      toast("Downloaded — annotations and fields are embedded in the file");
    } catch (e) {
      console.warn("[pdf] annotation embed failed, falling back to flattened export", e);
      try {
        const { buildFlattenedPdf } = await import("./flatten");
        const bytes = await buildFlattenedPdf(
          b.slice(0), annDoc.annotations, formValues(), doc,
          {}, annDoc.fields ?? [], await rasterizeRedacted(), annDoc.ocr);
        downloadPdf(bytes, name);
        toast("Downloaded — edits baked into the page");
      } catch (e2) {
        console.error("[pdf] flattened export failed too", e2);
        toast("Download failed — your edits could not be written to the file");
      }
    }
  };

  const rename = async () => {
    const t = title.trim();
    if (!t || t === item.name) return;
    try { await api.patch(`/api/drive/${item.id}`, { name: t }); } catch { toast("Rename failed"); }
  };

  // ---------- file ops (File menu) ----------
  /** Upload a PDF from the computer as a new Drive item, then open it. */
  const openFromComputer = async (f: File) => {
    try {
      const r = await api.upload<{ item: { id: string } }>(
        `/api/drive/upload?name=${encodeURIComponent(f.name)}&kind=pdf`, f);
      navigate(`/edit/${r.item.id}`);
    } catch { toast("Could not open that file"); }
  };

  /** Word-style Save As — flush a labeled immutable version. */
  const saveNamed = async () => {
    const label = window.prompt("Name this version", "e.g. Signed copy");
    if (label === null || !label.trim()) return;
    const ok = await saveContent(item.id, currentPayload(), !!session, label.trim());
    toast(ok ? `Saved version "${label.trim()}"` : "Could not save named version");
  };

  /** Duplicate this PDF (bytes + annotations) as a new Drive item. */
  const makeCopy = async () => {
    try {
      const r = await api.post<{ item: { id: string } }>("/api/drive",
        { name: `Copy of ${title}`, kind: "pdf" });
      const nid = r.item.id;
      if (pdfDataRef.current) {
        const headers: Record<string, string> = { "content-type": "application/pdf" };
        const t = getToken();
        if (t) headers.authorization = `Bearer ${t}`;
        const res = await fetch(`/api/files/${nid}/pdf-bytes?label=${encodeURIComponent(`Copied from ${title}`)}`,
          { method: "PUT", headers, body: pdfDataRef.current });
        if (!res.ok) throw new Error();
      }
      await api.put(`/api/files/${nid}/content`, { content: currentPayload() });
      toast("Copy created");
      navigate(`/edit/${nid}`);
    } catch { toast("Could not make a copy"); }
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
    (d.getPageLabels?.() ?? Promise.resolve(null)).then((l) => setPageLabels(l)).catch(() => {});
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
  const orgInsertImages = async (files: FileList) => {
    const bytes = pdfDataRef.current;
    if (!bytes) return;
    try {
      const images = await Promise.all([...files].map(async (f) => {
        const dataUrl = await new Promise<string>((res, rej) => {
          const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsDataURL(f);
        });
        const dims = await new Promise<{ w: number; h: number }>((res, rej) => {
          const im = new Image();
          im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
          im.onerror = () => rej(new Error(`undecodable image: ${f.name}`));
          im.src = dataUrl;
        });
        return { dataUrl, ...dims };
      }));
      const { bytes: out } = { bytes: await appendImagePages(bytes, images) };
      const newBytes = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
      mutate(() => {});
      await reloadPdf(newBytes);
      void persistBytes(newBytes, `Inserted ${images.length} image page${images.length === 1 ? "" : "s"}`);
      toast(`Added ${images.length} image page${images.length === 1 ? "" : "s"}`);
    } catch { toast("Could not insert those images"); }
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

  // ---------- PDF-8.3: OCR — rasterize page, recognize words, invisible selectable layer ----------
  const runOcr = async () => {
    if (!doc || !pdfDataRef.current || ocrBusy || !canEdit) return;
    setOcrBusy(true);
    try {
      const { recognize } = await import("tesseract.js");
      // self-hosted runtime (public/tesseract/) — worker/core/lang never hit a CDN,
      // which keeps the CSP free of script/connect exceptions
      const tessBase = `${window.location.origin}/tesseract`;
      const tessOpts = {
        workerPath: `${tessBase}/worker.min.js`,
        workerBlobURL: false,
        corePath: `${tessBase}/tesseract-core-simd-lstm.wasm.js`,
        langPath: tessBase,
      };
      const page = await doc.getPage(curPage);
      const S = 2;
      const vp = page.getViewport({ scale: S });
      const cv = document.createElement("canvas");
      cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
      const ctx = cv.getContext("2d");
      if (!ctx) throw new Error("no canvas ctx");
      await page.render({ canvasContext: ctx, canvas: cv, viewport: vp }).promise;
      const res = await recognize(cv, "eng", tessOpts);
      // tesseract bbox is top-left canvas px; convert to bottom-left pdf units
      const words: OcrWord[] = ((res.data as { words?: { bbox: { x0: number; y0: number; x1: number; y1: number }; text: string }[] }).words ?? [])
        .map((w) => ({
          x: w.bbox.x0 / S, y: (vp.height - w.bbox.y1) / S,
          w: (w.bbox.x1 - w.bbox.x0) / S, h: (w.bbox.y1 - w.bbox.y0) / S, text: w.text,
        }));
      mutate((d) => { d.ocr = { ...(d.ocr ?? {}), [String(curPage)]: words }; });
      toast(`OCR complete — ${words.length} words on page ${curPage}`);
    } catch { toast("OCR failed"); }
    finally { setOcrBusy(false); }
  };

  // ---------- PDF-10.2: auto-detect fields (underscore runs, checkbox glyphs) ----------
  const detectFields = async () => {
    if (!doc || !canEdit) return;
    const found: PdfField[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const vp1 = page.getViewport({ scale: 1 });
      for (const it of tc.items) {
        if (!("str" in it) || !it.transform) continue;
        const str = it.str;
        if (!str) continue;
        const tx = pdfjs.Util.transform(vp1.transform, it.transform);
        const fh = Math.max(6, Math.hypot(tx[2], tx[3]));
        const [px, py] = vp1.convertToPdfPoint(tx[4], tx[5]);
        const cw = it.width / Math.max(1, str.length);
        for (const mm of str.matchAll(/_{3,}/g))
          found.push({ id: crypto.randomUUID().slice(0, 8), page: p, kind: "text",
            name: `field_${p}_${found.length + 1}`,
            rect: [px + cw * (mm.index ?? 0), py - fh * 0.3, Math.max(20, cw * mm[0].length), fh * 1.4] });
        for (const mm of str.matchAll(/☐|▢|\[\s?\]/g))
          found.push({ id: crypto.randomUUID().slice(0, 8), page: p, kind: "checkbox",
            name: `check_${p}_${found.length + 1}`,
            rect: [px + cw * (mm.index ?? 0), py - fh * 0.3, fh, fh] });
      }
    }
    if (!found.length) { toast("No blank fields detected on this PDF"); return; }
    mutate((d) => { d.fields = [...(d.fields ?? []), ...found]; });
    toast(`Detected ${found.length} field${found.length === 1 ? "" : "s"}`);
  };

  // ---------- PDF-13.5: attach files / build a portfolio cover ----------
  const attachFiles = async (list: FileList | null, withCover: boolean) => {
    const bytes = pdfDataRef.current;
    if (!bytes || !list?.length || !canEdit) return;
    try {
      const files = await Promise.all([...list].map(async (f) => ({
        name: f.name, data: new Uint8Array(await f.arrayBuffer()), mime: f.type || undefined,
      })));
      const out = withCover ? await makePortfolio(bytes, files, title) : await attachFilesToPdf(bytes, files);
      const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
      if (withCover)
        mutate((d) => {
          d.annotations = d.annotations.map((a) => ({ ...a, page: a.page + 1 }));
          d.fields = (d.fields ?? []).map((f) => ({ ...f, page: f.page + 1 }));
          if (d.ocr) d.ocr = Object.fromEntries(Object.entries(d.ocr).map(([k, v]) => [String(Number(k) + 1), v]));
        });
      else mutate(() => {});
      await reloadPdf(ab);
      void persistBytes(ab, withCover ? "Created portfolio" : `Attached ${files.length} file(s)`);
      setAttachments((a) => [...a, ...files.map((f) => ({ name: f.name, content: f.data }))]);
      toast(withCover ? "Portfolio cover + attachments added" : `${files.length} file(s) attached`);
    } catch { toast("Attach failed"); }
  };

  // ---------- PDF-13.4: web page → appended text pages ----------
  const insertWebPage = async (u?: string) => {
    const url = (u ?? webUrl).trim();
    const bytes = pdfDataRef.current;
    if (!url || !bytes || !canEdit) return;
    try {
      const res = await api.get<{ url: string; html: string }>(`/api/fetch-html?url=${encodeURIComponent(url)}`);
      const dom = new DOMParser().parseFromString(res.html, "text/html");
      dom.querySelectorAll("script,style,noscript").forEach((n) => n.remove());
      const t = dom.title || res.url;
      const text = (dom.body?.innerText ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 30000);
      if (!text) { toast("No readable text on that page"); return; }
      const pageBytes = await webTextToPdf(t, res.url, text);
      const { bytes: merged, count } = await mergePdf(bytes, pageBytes.buffer.slice(pageBytes.byteOffset, pageBytes.byteOffset + pageBytes.byteLength) as ArrayBuffer);
      const ab = merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength) as ArrayBuffer;
      mutate(() => {});
      await reloadPdf(ab);
      void persistBytes(ab, `Inserted web page ${res.url}`);
      setWebUrl("");
      toast(`Added ${count} page${count === 1 ? "" : "s"} from ${res.url}`);
    } catch { toast("Could not fetch that page"); }
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

  const addAnn = (page: number, a: Omit<PdfAnn, "id" | "page" | "createdAt">): string => {
    const id = crypto.randomUUID().slice(0, 8);
    mutate((d) => d.annotations.push({ ...a, id, page,
      author: user?.displayName, createdAt: new Date().toISOString() }));
    return id;
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
  const addField = (page: number, rect: Rect4, clicked?: boolean) =>
    mutate((d) => {
      d.fields ??= [];
      // click-placement: use a kind-appropriate default size centered on the point
      const rr: Rect4 = clicked
        ? fieldKind === "checkbox" || fieldKind === "radio" ? [rect[0] - 7, rect[1] - 7, 14, 14]
          : fieldKind === "signature" ? [rect[0] - 80, rect[1] - 20, 160, 40]
          : fieldKind === "barcode" ? [rect[0] - 70, rect[1] - 20, 140, 40]
          : [rect[0] - 70, rect[1] - 11, 140, 22]
        : rect;
      const n = d.fields.filter((f) => f.kind === fieldKind).length + 1;
      d.fields.push({ id: crypto.randomUUID().slice(0, 8), page, kind: fieldKind, rect: rr,
        name: `${fieldKind}_${n}`, group: fieldKind === "radio" ? "radio_1" : undefined,
        options: fieldKind === "dropdown" || fieldKind === "list" ? ["Option 1", "Option 2"] : undefined });
    });
  const patchField = (id: string, p: Partial<PdfField>, key?: string) =>
    mutate((d) => {
      const f = d.fields?.find((x) => x.id === id);
      if (f) Object.assign(f, p);
      // PDF-10.1 — recompute calc fields whenever a value changes
      for (const cf of d.fields ?? []) {
        if (!cf.calc?.startsWith("sum:")) continue;
        const names = cf.calc.slice(4).split(",").map((s) => s.trim()).filter(Boolean);
        cf.value = names.reduce((s, n) => s + (parseFloat(String(d.fields?.find((x) => x.name === n)?.value ?? "")) || 0), 0).toString();
      }
    }, key);
  const delField = (id: string) => mutate((d) => { d.fields = (d.fields ?? []).filter((f) => f.id !== id); });
  const moveField = (id: string, dx: number, dy: number) =>
    mutate((d) => { const f = d.fields?.find((x) => x.id === id); if (f) { f.rect[0] += dx; f.rect[1] += dy; } }, `fmove:${id}`);
  // PDF-10.3 — tab order = array order
  const reorderField = (id: string, dir: -1 | 1) =>
    mutate((d) => {
      const arr = d.fields ?? [];
      const i = arr.findIndex((f) => f.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) return;
      [arr[i], arr[j]] = [arr[j], arr[i]];
    });
  const sigFieldRef = useRef<string | null>(null);
  // PDF-10.3 — signature field: click applies the saved signature or opens the pad
  const signField = (id: string) => {
    if (sigImg) { patchField(id, { value: sigImg }); return; }
    sigFieldRef.current = id;
    setSigPadOpen(true);
  };
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
      // PDF-8.3 — OCR'd words on scanned pages participate in search too
      const ocrWords = annDoc.ocr?.[String(p)] ?? [];
      if (ocrWords.length) {
        const ocrText = ocrWords.map((w) => w.text).join(" ");
        re.lastIndex = 0;
        while ((m = re.exec(ocrText))) {
          const ms = m.index, me = ms + m[0].length;
          const rects: Rect4[] = [];
          let off = 0;
          for (const w of ocrWords) {
            const ws = off; off += w.text.length + 1; // joined with spaces
            if (ws + w.text.length <= ms || ws >= me) continue;
            rects.push([w.x, w.y, w.w, w.h]);
          }
          out.push({ page: p, snippet: ocrText.slice(Math.max(0, ms - 30), me + 30).trim(), rects });
          if (out.length >= 200) break;
        }
      }
      if (out.length >= 200) break;
    }
    // Acrobat's "Include bookmarks" — outline titles become jump-to results
    if (searchBm && out.length < 200) {
      const walk = (nodes: OutlineNode[]) => nodes.forEach((n) => {
        re.lastIndex = 0;
        if (re.test(n.title)) out.push({ page: 0, snippet: n.title, rects: [], kind: "bookmark", dest: n.dest });
        if (n.items?.length) walk(n.items);
      });
      walk(outline);
    }
    // "Include comments" — annotation contents + replies
    if (searchCm && out.length < 200) {
      for (const a of annDoc.annotations) {
        re.lastIndex = 0;
        if (a.text && re.test(a.text)) out.push({ page: a.page, snippet: a.text.slice(0, 90), rects: [], kind: "comment", annId: a.id });
        for (const r of a.replies ?? []) {
          re.lastIndex = 0;
          if (re.test(r.text)) out.push({ page: a.page, snippet: `↳ ${r.by}: ${r.text}`, rects: [], kind: "comment", annId: a.id });
        }
        if (out.length >= 200) break;
      }
    }
    setMatches(out);
    setMatchIdx(out.length ? 0 : -1);
    if (out.length) scrollToPage(out[0].page || 1);
  };

  const scrollToPage = (p: number) => {
    if (p !== curPage) navPush(curPage);
    setCurPage(p);
    pageRefs.current.get(p)?.scrollIntoView({ behavior: "smooth", block: "start" });
    // record the destination once the scroll settles
    setTimeout(() => navPush(p), 350);
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
  // Acrobat "Fit Visible" — zoom to the content bounding box, ignoring margins
  const fitVisible = async () => {
    if (!doc || !scrollRef.current) return;
    const pg = await doc.getPage(curPage);
    const S = 0.3;
    const vp0 = pg.getViewport({ scale: S, rotation: (pg.rotate + viewRot) % 360 });
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(vp0.width));
    c.height = Math.max(1, Math.ceil(vp0.height));
    try { await pg.render({ canvas: c, viewport: vp0 }).promise; }
    catch { return void fitWidth(); }
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let minX = c.width, minY = c.height, maxX = 0, maxY = 0, found = false;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (data[i] < 246 || data[i + 1] < 246 || data[i + 2] < 246) {
        found = true;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    if (!found || maxX - minX < 6) return void fitWidth();
    const bw = (maxX - minX) / S;                 // content width in pt
    const ns = Math.min(4, Math.max(0.4, +(((scrollRef.current.clientWidth - 48) / bw)).toFixed(2)));
    setScale(ns);
    setTimeout(() => {
      const el = scrollRef.current; const wrap = pageRefs.current.get(curPage);
      if (!el || !wrap) return;
      el.scrollLeft = (minX / S) * ns - (el.clientWidth - bw * ns) / 2;
      el.scrollTop = wrap.offsetTop + (minY / S) * ns - 12;
    }, 100);
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

  // ---------- PDF-14.1: accessibility checker (heuristic) ----------
  const runAccessCheck = async () => {
    if (!doc) return;
    const rep: { ok: boolean; label: string }[] = [];
    try {
      const meta = await doc.getMetadata().catch(() => null);
      rep.push({ ok: !!(meta?.info as { Title?: string } | undefined)?.Title, label: "Document has a title" });
    } catch { rep.push({ ok: false, label: "Could not read document metadata" }); }
    try {
      const mark = await doc.getMarkInfo?.();
      rep.push({ ok: !!mark?.Marked, label: "Document is tagged (marked content / structure)" });
    } catch { rep.push({ ok: false, label: "Tag information unavailable" }); }
    const untitled = (annDoc.fields ?? []).filter((f) => !f.name.trim());
    rep.push({ ok: !untitled.length, label: untitled.length ? `${untitled.length} form field(s) missing a name` : "All form fields named" });
    const emptyMarks = annDoc.annotations.filter((a) => ["note", "caret", "replace", "textbox", "callout"].includes(a.type) && !(a.text ?? "").trim());
    rep.push({ ok: !emptyMarks.length, label: emptyMarks.length ? `${emptyMarks.length} annotation(s) have empty text` : "All text annotations have content" });
    try {
      let chars = 0;
      for (let p = 1; p <= Math.min(3, doc.numPages); p++)
        chars += (await (await doc.getPage(p)).getTextContent()).items.length;
      rep.push({ ok: chars > 0, label: chars > 0 ? "Pages contain extractable text" : "No extractable text — likely a scan (OCR needed)" });
    } catch { /* ignore */ }
    setAccessReport(rep);
  };

  // ---------- PDF-7: read aloud / compare / redaction rasterize ----------
  const speakPage = async () => {
    if (speaking) { speechSynthesis.cancel(); setSpeaking(false); return; }
    if (!doc) return;
    try {
      const tc = await doc.getPage(curPage).then((pg) => pg.getTextContent());
      const t = tc.items.map((i) => ("str" in i ? i.str : "")).join(" ").replace(/\s+/g, " ").trim();
      if (!t) { toast("No text on this page to read"); return; }
      const u = new SpeechSynthesisUtterance(t);
      u.rate = tts.rate || 1;
      const v = voices.find((x) => x.voiceURI === tts.voice);
      if (v) u.voice = v;
      u.onend = () => setSpeaking(false);
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      setSpeaking(true);
    } catch { toast("Read-aloud failed"); }
  };
  useEffect(() => () => speechSynthesis.cancel(), []);
  // speech voices arrive asynchronously in most browsers
  useEffect(() => {
    const load = () => setVoices(speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener("voiceschanged", load);
    return () => speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);
  useEffect(() => { try { localStorage.setItem("kx:tts", JSON.stringify(tts)); } catch { /* private mode */ } }, [tts]);

  const runCompare = async (f: File) => {
    if (!doc) return;
    try {
      const other = await pdfjs.getDocument({ data: await f.arrayBuffer() }).promise;
      const pageText = async (d: typeof doc, p: number) =>
        p <= d.numPages
          ? (await d.getPage(p)).getTextContent().then((t) => t.items.map((i) => ("str" in i ? i.str : "")).join("").replace(/\s+/g, " ").trim())
          : null;
      const out: { page: number; st: string; a?: string; b?: string }[] = [];
      for (let p = 1; p <= Math.max(doc.numPages, other.numPages); p++) {
        const [a, b] = await Promise.all([pageText(doc, p), pageText(other, p)]);
        const row: { page: number; st: string; a?: string; b?: string } =
          { page: p, st: a === b ? "identical" : a == null ? "only in other" : b == null ? "missing in other" : "changed" };
        if (row.st === "changed") {
          // first divergence — longest common prefix, then show context
          let i = 0;
          while (i < a!.length && i < b!.length && a![i] === b![i]) i++;
          row.a = a!.slice(Math.max(0, i - 15), i + 45);
          row.b = b!.slice(Math.max(0, i - 15), i + 45);
        }
        out.push(row);
      }
      setCmp(out);
      setPanel("compare");
    } catch { toast("Compare failed — is that a valid PDF?"); }
  };

  // true redaction: render each marked page to PNG so export can drop its stream
  const rasterizeRedacted = async (): Promise<Record<number, string> | undefined> => {
    if (!doc) return undefined;
    const set = new Set(annDoc.annotations.filter((a) => a.type === "redact").map((a) => a.page));
    if (!set.size) return undefined;
    const out: Record<number, string> = {};
    for (const p of set) {
      const pg = await doc.getPage(p);
      const v = pg.getViewport({ scale: 2 });
      const c = document.createElement("canvas");
      c.width = v.width; c.height = v.height;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvas: c, viewport: v }).promise;
      // burn the marks into the pixels — covered content is destroyed in the
      // image itself, not merely hidden under an overlaid rect
      ctx.fillStyle = "#000";
      for (const a of annDoc.annotations.filter((x) => x.type === "redact" && x.page === p)) {
        for (const [rx, ry, rw, rh] of a.rects ?? []) {
          const [x1, y1] = v.convertToViewportPoint(rx, ry);
          const [x2, y2] = v.convertToViewportPoint(rx + rw, ry + rh);
          ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        }
      }
      out[p] = c.toDataURL("image/png");
    }
    return out;
  };

  // ---------- find & redact: scan every page for pattern hits → mark rects ----------
  const redactRunScan = async () => {
    if (!doc || redactBusy) return;
    setRedactBusy(true); setRedactScan(null);
    try {
      const src = redactPat === "custom" ? redactCustom.trim() : REDACT_PRESETS[redactPat].re;
      if (!src) { toast("Enter a pattern to search for"); return; }
      const re = new RegExp(src, `g${redactCase ? "" : "i"}`);
      const out: { page: number; text: string; rects: Rect4[] }[] = [];
      for (let p = 1; p <= doc.numPages && out.length < 500; p++) {
        const pg = await doc.getPage(p);
        const tc = await pg.getTextContent();
        const vp1 = pg.getViewport({ scale: 1 });
        // joined text so matches spanning text items still hit — then map the
        // char range back to per-item rects (same mapping as search marks)
        const text = tc.items.map((i) => ("str" in i ? i.str : "")).join("");
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          const rects: Rect4[] = [];
          let off = 0;
          for (const it of tc.items) {
            const str = "str" in it ? it.str : "";
            const s = off, e = off + str.length; off = e;
            const os = Math.max(s, m.index), oe = Math.min(e, m.index + m[0].length);
            if (oe <= os || !("transform" in it) || !str) continue;
            const tx = pdfjs.Util.transform(vp1.transform, it.transform);
            const fh = Math.max(2, Math.hypot(tx[2], tx[3]));
            const [ix, iy] = vp1.convertToPdfPoint(tx[4], tx[5]);
            const cw = it.width / Math.max(1, str.length);
            rects.push([ix + cw * (os - s) - 0.5, iy - fh * 0.32, Math.max(2.5, cw * (oe - os)) + 1, fh * 1.18]);
          }
          if (rects.length) out.push({ page: p, text: m[0], rects });
          if (m[0].length === 0) re.lastIndex++;
          if (out.length >= 500) break;
        }
      }
      setRedactScan(out);
      if (!out.length) toast("No matches found");
    } catch { toast("Invalid pattern"); }
    finally { setRedactBusy(false); }
  };
  const redactMarkAll = () => {
    if (!redactScan?.length) return;
    const hits = redactScan;
    mutate((d) => {
      for (const h of hits) d.annotations.push({ id: crypto.randomUUID().slice(0, 8), type: "redact",
        page: h.page, rects: h.rects, author: user?.displayName, createdAt: new Date().toISOString() });
    });
    toast(`Marked ${hits.length} item${hits.length === 1 ? "" : "s"} — Save applies redaction permanently`);
    setRedactDlg(false); setRedactScan(null);
  };

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
      else if (e.key === "Escape") { setSelAnn(null); setSelField(null); if (tool !== "select") setTool("select"); if (autoScroll) setAutoScroll(0); if (readMode) setReadMode(false); }
      else if (e.key === " " && !e.repeat) { e.preventDefault(); setSpaceDown(true); }
      else if (e.key === "?") { e.preventDefault(); setShowKeys((v) => !v); }
      // auto-scroll speed — Acrobat-style ↑ faster / ↓ slower
      else if (autoScroll && e.key === "ArrowUp") { e.preventDefault(); setAutoScroll((s) => Math.min(8, +(s * 1.35).toFixed(2))); }
      else if (autoScroll && e.key === "ArrowDown") { e.preventDefault(); setAutoScroll((s) => Math.max(0.25, +(s / 1.35).toFixed(2))); }
      // Acrobat view history — Alt+← back, Alt+→ forward
      else if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); navStep(-1); }
      else if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); navStep(1); }
      // PDF-3 — paged-view navigation
      else if ((viewMode === "single" || viewMode === "two") && (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown"))
        { e.preventDefault(); setCurPage((p) => Math.min(numPages, cover && viewMode === "two" && p === 1 ? 2 : p + (viewMode === "two" ? 2 : 1))); }
      else if ((viewMode === "single" || viewMode === "two") && (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp"))
        { e.preventDefault(); setCurPage((p) => Math.max(1, cover && viewMode === "two" && p <= 3 ? 1 : p - (viewMode === "two" ? 2 : 1))); }
      else if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void saveIntoFile();
      }
      else if ((e.ctrlKey || e.metaKey) && e.key === "o") { e.preventDefault(); openFileRef.current?.click(); }
      else if ((e.ctrlKey || e.metaKey) && e.key === "f") { e.preventDefault(); setPanel("search"); }
      else if ((e.ctrlKey || e.metaKey) && e.key === "p") { e.preventDefault(); setPrinting(true); }
      else if ((e.ctrlKey || e.metaKey) && e.key === "d") { e.preventDefault(); void openDocProps(); }
      else if ((e.ctrlKey || e.metaKey) && e.key === "h") { e.preventDefault(); setReadMode((v) => !v); }
    };
    window.addEventListener("keydown", onKey);
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === " ") setSpaceDown(false); };
    window.addEventListener("keyup", onKeyUp);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKeyUp); };
  });

  // clipboard: image → image annotation, text → typewriter box, PDF → merge (all on the current page)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
      if (!canEdit || !doc || !pdfDataRef.current) return;
      const cd = e.clipboardData;
      if (!cd) return;
      const file = [...cd.files].find((f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"))
        ?? [...cd.files].find((f) => f.type.startsWith("image/"));
      if (file) e.preventDefault();
      void pasteClipboard(cd, file ?? null, curPage);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });
  // File ▸ Document properties — metadata + file characteristics via pdf.js
  const openDocProps = async () => {
    if (!doc) return;
    setPropsOpen(true);
    setDocProps(null);
    const rows: { k: string; v: string }[] = [];
    try {
      const meta = await doc.getMetadata();
      const info = (meta.info ?? {}) as Record<string, unknown>;
      const put = (k: string, v: unknown) => { if (v != null && String(v).trim() !== "") rows.push({ k, v: String(v) }); };
      put("Title", info.Title); put("Author", info.Author); put("Subject", info.Subject);
      put("Keywords", info.Keywords); put("Creator", info.Creator); put("Producer", info.Producer);
      put("Created", info.CreationDate); put("Modified", info.ModDate); put("Trapped", info.Trapped);
      put("PDF version", info.PDFFormatVersion);
      rows.push({ k: "Pages", v: String(doc.numPages) });
      if (pdfDataRef.current) {
        const mb = pdfDataRef.current.byteLength;
        rows.push({ k: "File size", v: mb >= 1048576 ? `${(mb / 1048576).toFixed(2)} MB` : `${(mb / 1024).toFixed(1)} KB` });
      }
      const d0 = await pageDims(1).catch(() => null);
      if (d0) rows.push({ k: "Page 1 size", v: `${(d0.w / 72).toFixed(2)} × ${(d0.h / 72).toFixed(2)} in (${d0.w.toFixed(0)} × ${d0.h.toFixed(0)} pt)` });
      rows.push({ k: "Tagged", v: (await doc.getMarkInfo().catch(() => null))?.Marked ? "Yes" : "No" });
      const perms = await doc.getPermissions().catch(() => null);
      if (perms) {
        rows.push({ k: "Security", v: "Restricted — " + ([
          [0x04, "print"], [0x08, "modify"], [0x10, "copy"], [0x20, "annotate"],
          [0x100, "fill forms"], [0x200, "accessibility copy"], [0x400, "assemble"], [0x800, "print hi-res"],
        ] as [number, string][]).filter(([f]) => !perms.has(f)).map(([, n]) => n).join(", ") + " not allowed" });
      } else rows.push({ k: "Security", v: "None" });
      put("Fast Web View", info.IsLinearized === true ? "Yes" : info.IsLinearized === false ? "No" : undefined);
      put("AcroForm", info.IsAcroFormPresent === true ? "Yes" : undefined);
      put("Signatures", info.IsSignaturesPresent === true ? "Yes" : undefined);
      // fonts seen while rendering this session
      const fonts = new Set<string>();
      for (let p = 1; p <= Math.min(doc.numPages, 25); p++) {
        const pg = await doc.getPage(p).catch(() => null);
        if (!pg) continue;
        for (const [, obj] of pg.commonObjs as unknown as Iterable<[string, unknown]>) {
          const f = obj as { name?: string; loadedName?: string } | null;
          if (f?.loadedName && f?.name) fonts.add(f.name);
        }
      }
      if (fonts.size) rows.push({ k: `Fonts (${fonts.size})`, v: [...fonts].sort().join(", ") });
    } catch { rows.push({ k: "Error", v: "Could not read document metadata" }); }
    setDocProps(rows);
  };

  // Acrobat's "Export Form Data" — authored + native field values → .fdf
  const exportFormData = async () => {
    if (!doc) return;
    const rows: { name: string; value: string | boolean | string[] }[] = [];
    for (const f of annDoc.fields ?? []) {
      const v = f.value ?? f.defaultValue;
      if (v != null && v !== "" && v !== false) rows.push({ name: f.name, value: v as string });
    }
    try {
      const fo = await doc.getFieldObjects();
      if (fo) for (const [name, kids] of fo) {
        const kidsArr = kids as { id?: string; value?: unknown }[];
        const kid = kidsArr.find((k) => k.id) ?? kidsArr[0];
        if (!kid) continue;
        const cur = kid.id ? doc.annotationStorage.getValue(kid.id, { value: kid.value }) as { value?: unknown } : null;
        const v = cur?.value ?? kid.value;
        if (v != null && v !== "" && v !== false && v !== "Off") rows.push({ name, value: v as string });
      }
    } catch { /* non-form docs */ }
    if (!rows.length) { toast("No form values to export"); return; }
    void import("./fdf").then(({ exportFormFdf }) => exportFormFdf(rows, title));
  };

  const pasteClipboard = async (cd: DataTransfer, file: File | null, page: number) => {
    if (file?.type === "application/pdf" || file?.name.toLowerCase().endsWith(".pdf")) {
      await orgMerge(file);
      return;
    }
    const dims = await pageDims(page).catch(() => ({ w: 612, h: 792 }));
    if (file?.type.startsWith("image/")) {
      const data = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result)); r.onerror = rej;
        r.readAsDataURL(file);
      });
      const { w: iw, h: ih } = await new Promise<{ w: number; h: number }>((res) => {
        const im = new Image();
        im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
        im.onerror = () => res({ w: 300, h: 200 });
        im.src = data;
      });
      const maxW = dims.w * 0.5;
      const sc = Math.min(1, maxW / iw);
      const w = iw * sc, h = ih * sc;
      addAnn(page, { type: "image", rects: [[(dims.w - w) / 2, (dims.h - h) / 2, w, h]], img: data });
      toast("Image pasted");
      return;
    }
    const text = cd.getData("text/plain");
    if (text?.trim()) {
      const w = Math.min(300, dims.w - 20), h = Math.max(24, (text.split("\n").length + 1) * (tbSize + 4));
      const id = addAnn(page, { type: "textbox", rects: [[10, (dims.h - h) / 2, w, h]], text, color: toolColor, font: tbFont, fontSize: tbSize });
      setSelAnn(id);
      toast("Text pasted as typewriter box");
    }
  };

  // drag a PDF (or image) anywhere onto the editor to open/insert it
  useEffect(() => {
    const over = (e: DragEvent) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      const pdf = files.find((f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
      if (pdf) { void openFromComputer(pdf); return; }
      const img = files.find((f) => f.type.startsWith("image/"));
      if (img && canEdit && doc) void pasteClipboard(e.dataTransfer!, img, curPage);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragover", over); window.removeEventListener("drop", drop); };
  });

  // auto-scroll — rAF-driven smooth scroll, ↑/↓ adjust speed, stops at the end
  useEffect(() => {
    if (!autoScroll) return;
    let raf = 0; let last = performance.now();
    const step = (t: number) => {
      const dt = Math.min(50, t - last); last = t;
      const el = scrollRef.current;
      if (!el) return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) { setAutoScroll(0); toast("End of document"); return; }
      el.scrollTop += autoScroll * (dt / 16.7);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [autoScroll]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl+wheel zoom centered on the cursor — non-passive so we can preventDefault
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const fx = e.clientX - rect.left, fy = e.clientY - rect.top;
      setScale((s) => {
        const ns = Math.min(4, Math.max(0.4, +(s * (e.deltaY < 0 ? 1.12 : 1 / 1.12)).toFixed(3)));
        if (ns !== s) zoomAnchor.current = { fx, fy, ratio: ns / s, sl: el.scrollLeft, st: el.scrollTop };
        return ns;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [doc]);
  // apply the zoom anchor after re-render so the point under the cursor stays put
  useEffect(() => {
    const a = zoomAnchor.current; const el = scrollRef.current;
    if (!a || !el) return;
    zoomAnchor.current = null;
    el.scrollLeft = (a.sl + a.fx) * a.ratio - a.fx;
    el.scrollTop = (a.st + a.fy) * a.ratio - a.fy;
  }, [scale]);

  // open at remembered zoom+page, else fit-width
  useEffect(() => {
    if (!doc || didInitView.current) return;
    didInitView.current = true;
    const saved = (() => { try { const r = localStorage.getItem(`kx:pdfpos:${item.id}`); return r ? JSON.parse(r) as { scale?: number; page?: number } : null; } catch { return null; } })();
    if (saved?.scale) setScale(Math.min(4, Math.max(0.4, saved.scale)));
    else void fitWidth();
    if (saved?.page && saved.page > 1 && saved.page <= numPages) {
      setCurPage(saved.page);
      for (const t of [150, 500, 1000]) setTimeout(() => pageRefs.current.get(saved.page!)?.scrollIntoView(), t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, numPages]);
  useEffect(() => {
    if (!doc) return;
    const t = setTimeout(() =>
      localStorage.setItem(`kx:pdfpos:${item.id}`, JSON.stringify({ scale, page: curPage })), 400);
    return () => clearTimeout(t);
  }, [scale, curPage, doc, item.id]);

  // status bar — current page dimensions (cached via effect)
  useEffect(() => {
    if (!doc) { setCurDims(null); return; }
    let dead = false;
    void pageDims(curPage).then((d) => { if (!dead) setCurDims(d); }).catch(() => {});
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, curPage]);

  const saveLabel = { saved: "Saved", saving: "Saving…", unsaved: "Unsaved", error: "Save failed" }[saveState];

  return (
    <div className={`editor pdfjs-scope${readMode ? " read-mode" : ""}`}>
      <div className="topbar">
        <button className="back" onClick={() => navigate(-1)} title="Back">←</button>
        <AppIcon kind="pdf" size={34} />
        <input className="doc-title" value={title} disabled={!canEdit}
          onChange={(e) => setTitle(e.target.value)} onBlur={rename} />
        <button className="btn-ghost btn-sm" disabled={!canEdit}
          title="Save — write annotations, fields and filled values into the PDF file"
          onClick={() => void saveIntoFile()}>💾 Save</button>
        <span className={`save-state ${saveState}`}>{saveLabel}</span>
        <PresenceBar session={session} />
        <button className="btn-ghost btn-sm" onClick={() => setSharing(true)}>Share</button>
        <button className="btn-ghost btn-sm" disabled={!pdfDataRef.current}
          title="Download this PDF with your annotations embedded"
          onClick={() => void downloadCurrent()}>⬇ Download</button>
        <button className="btn-ghost btn-sm" disabled={!pdfDataRef.current}
          onClick={() => setExportDlg(true)}>Export PDF</button>
      </div>

      {/* ---- ribbon tabs: every feature, grouped + labeled (Acrobat/Office-style) ---- */}
      <RibbonTabs persistKey="pdf"
        end={<>
          <span className="rb-info">Page <input className="pg-in" key={`pg${curPage}`} defaultValue={pageLabels?.[curPage - 1] ?? curPage}
            title={pageLabels?.[curPage - 1] ? `Label ${pageLabels[curPage - 1]} — page ${curPage} of ${numPages}` : `${curPage} of ${numPages}`}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const v = e.currentTarget.value.trim();
              const li = pageLabels?.findIndex((l) => l.toLowerCase() === v.toLowerCase()) ?? -1;
              const n = li >= 0 ? li + 1 : parseInt(v, 10);
              if (!isNaN(n)) scrollToPage(Math.max(1, Math.min(numPages, n)));
              else e.currentTarget.value = pageLabels?.[curPage - 1] ?? String(curPage);
            }}
            onBlur={(e) => { e.target.value = pageLabels?.[curPage - 1] ?? String(curPage); }} /> / {numPages}</span>
          <button className={`rb ${panel === "comments" ? "on" : ""}`} title="Comments"
            onClick={() => setPanel(panel === "comments" ? "none" : "comments")}>💬</button>
          <button className={`rb ${panel === "ai" ? "on" : ""}`} title="Kreatix AI"
            onClick={() => setPanel(panel === "ai" ? "none" : "ai")}>✨</button>
        </>}
        tabs={[
        { id: "file", label: "File", icon: "📁", menu: [
          { label: "Open…", icon: "📂", shortcut: "Ctrl+O", onClick: () => navigate("/drive") },
          { label: "Open from this computer…", icon: "💻", onClick: () => openFileRef.current?.click() },
          { divider: true },
          { label: "Save — write changes into the PDF", icon: "💾", shortcut: "Ctrl+S", disabled: !canEdit,
            onClick: () => void saveIntoFile() },
          { label: "Save named version…", icon: "🏷", onClick: () => void saveNamed(), disabled: !canEdit },
          { label: "Make a copy", icon: "⧉", onClick: () => void makeCopy() },
          { divider: true },
          { label: "Download a copy (with annotations)", icon: "⬇", onClick: () => void downloadCurrent(), disabled: !pdfDataRef.current },
          { divider: true },
          { label: "Export PDF…", icon: "⤓", onClick: () => setExportDlg(true), disabled: !pdfDataRef.current },
          { label: "Export as", icon: "📤", submenu: [
            { label: "Word (.docx)", onClick: () => void import("./exportDocx").then(({ exportPdfToDocx }) => doc && exportPdfToDocx(doc, title)).catch(() => toast("DOCX export failed")) },
            { label: "Excel (.xlsx)", onClick: () => void import("./convert").then(({ exportPdfToXlsx }) => doc && exportPdfToXlsx(doc, title)).catch(() => toast("XLSX export failed")) },
            { label: "Slides (.pptx)", onClick: () => { toast("Rendering slides…"); void import("./convert").then(({ exportPdfToPptx }) => doc && exportPdfToPptx(doc, title)).catch(() => toast("PPTX export failed")); } },
            { label: "HTML (.html)", onClick: () => void import("./convert").then(({ exportPdfToText }) => doc && exportPdfToText(doc, title, true)).catch(() => toast("HTML export failed")) },
            { label: "Plain text (.txt)", onClick: () => void import("./convert").then(({ exportPdfToText }) => doc && exportPdfToText(doc, title, false)).catch(() => toast("TXT export failed")) },
          ]},
          { label: "Print…", icon: "🖨", shortcut: "Ctrl+P", onClick: () => setPrinting(true) },
          { divider: true },
          { label: "Version history", icon: "🕘", onClick: () => setPanel("versions") },
          { label: "Comments", icon: "💬", onClick: () => setPanel("comments") },
          { divider: true },
          { label: "Document properties…", icon: "ℹ", shortcut: "Ctrl+D", onClick: () => void openDocProps() },
          { divider: true },
          { label: "Share…", icon: "🔗", onClick: () => setSharing(true) },
          { divider: true },
          { label: "Close", icon: "✕", shortcut: "Ctrl+W", onClick: () => navigate(-1) },
        ]},
        { id: "home", label: "Home", icon: "🏠", groups: [
          { id: "nav", label: "Navigate", node: <>
            <button className={`rb ${panel === "thumbs" ? "on" : ""}`} title="Page thumbnails" onClick={() => setPanel(panel === "thumbs" ? "none" : "thumbs")}>▦</button>
            <button className={`rb ${panel === "outline" ? "on" : ""}`} title="Bookmarks" onClick={() => setPanel(panel === "outline" ? "none" : "outline")}>🔖</button>
            <button className={`rb ${panel === "search" ? "on" : ""}`} title="Search" onClick={() => setPanel(panel === "search" ? "none" : "search")}>🔍</button>
            <button className={`rb ${panel === "anns" ? "on" : ""}`} title="Annotations list — review status and replies"
              onClick={() => setPanel(panel === "anns" ? "none" : "anns")}>📋</button>
            {ocg.length > 0 && (
              <button className={`rb ${panel === "layers" ? "on" : ""}`} title="Layers — toggle optional content groups"
                onClick={() => setPanel(panel === "layers" ? "none" : "layers")}>⧈</button>
            )}
            <button className={`rb ${panel === "attach" ? "on" : ""}`} title="Embedded attachments — attach files, build portfolio"
              onClick={() => setPanel(panel === "attach" ? "none" : "attach")}>📎</button>
            <button className={`rb ${panel === "access" ? "on" : ""}`} title="Accessibility check"
              onClick={() => { setPanel(panel === "access" ? "none" : "access"); if (!accessReport) void runAccessCheck(); }}>♿</button>
          </>},
          { id: "tools", label: "Tools", node: <>
            <button className={`rb ${tool === "select" ? "on" : ""}`} title="Select / move annotations"
              onClick={() => setTool("select")}>➤</button>
            <button className={`rb ${tool === "pan" ? "on" : ""}`} title="Hand tool — drag to pan"
              onClick={() => setTool("pan")}>✋</button>
            <button className={`rb ${speaking ? "on" : ""}`} title="Read page aloud (text-to-speech)" onClick={() => void speakPage()}>{speaking ? "⏸" : "🔊"}</button>
          </>},
          { id: "doc", label: "Document", node: <>
            <button className={`rb ${panel === "compare" ? "on" : ""}`} title="Compare with another PDF" onClick={() => cmpRef.current?.click()}>⇄</button>
            <button className="rb" title="OCR this page — recognize text on scans (searchable/selectable)"
              disabled={!canEdit || ocrBusy} onClick={() => void runOcr()}>{ocrBusy ? "⏳" : "OCR"}</button>
          </>},
          { id: "clip", label: "Clipboard", node: <>
            <button className="rb" onClick={undo} title="Undo" disabled={!canEdit}>↶</button>
            <button className="rb" onClick={redo} title="Redo" disabled={!canEdit}>↷</button>
          </>},
        ]},
        { id: "edit", label: "Edit", icon: "✎", menu: [
          { label: "Undo", icon: "↶", shortcut: "Ctrl+Z", onClick: undo, disabled: !canEdit },
          { label: "Redo", icon: "↷", shortcut: "Ctrl+Y", onClick: redo, disabled: !canEdit },
          { divider: true },
          { label: "Find in document…", icon: "🔍", shortcut: "Ctrl+F", onClick: () => setPanel("search") },
          { label: "Find & redact patterns…", icon: "🛡", onClick: () => setRedactDlg(true), disabled: !canEdit },
          { divider: true },
          { label: "Take a snapshot — drag an area to copy it as an image", icon: "📸", checked: tool === "snapshot",
            onClick: () => pickTool("snapshot") },
          { label: "Paste", icon: "📋", shortcut: "Ctrl+V", disabled: !canEdit,
            onClick: () => void navigator.clipboard.read().then((items) => {
              for (const it of items) {
                const pdf = it.types.find((t) => t === "application/pdf");
                const img = it.types.find((t) => t.startsWith("image/"));
                const t = pdf ?? img;
                if (t) return it.getType(t).then((b) => pasteClipboard(new DataTransfer(), new File([b], "clipboard" + (pdf ? ".pdf" : ".png"), { type: t }), curPage));
              }
              return navigator.clipboard.readText().then((txt) => {
                const dt = new DataTransfer();
                dt.setData("text/plain", txt);
                return pasteClipboard(dt, null, curPage);
              });
            }).catch(() => toast("Clipboard is empty or blocked")) },
          { divider: true },
          { label: "Edit page content", icon: "✎", submenu: [
            { label: "Edit text — retype a block", icon: "✎T", checked: tool === "edittext", onClick: () => pickTool("edittext"), disabled: !canEdit },
            { label: "Insert image…", icon: "🖼", checked: tool === "image", onClick: () => pickTool("image"), disabled: !canEdit },
            { label: "White-out", icon: "▨", checked: tool === "whiteout", onClick: () => pickTool("whiteout"), disabled: !canEdit },
            { label: "Redact (permanent)", icon: "▮", checked: tool === "redact", onClick: () => pickTool("redact"), disabled: !canEdit },
          ]},
          { divider: true },
          { label: "OCR this page (make text searchable)", icon: "OCR", onClick: () => void runOcr(), disabled: !canEdit },
          { label: "Compare with another PDF…", icon: "⇄", onClick: () => cmpRef.current?.click() },
        ]},
        { id: "annotate", label: "Annotate", icon: "🖊", groups: [
          { id: "markup", label: "Markup", node: <>
            {TOOL_GROUPS[0].tools.map((t) => (
              <button key={t.id} className={`rb ${tool === t.id ? "on" : ""}`} title={t.label}
                disabled={!canEdit && !t.viewer} onClick={() => pickTool(t.id)}>{t.ico}</button>
            ))}
          </>},
          { id: "draw", label: "Draw", node: <>
            {TOOL_GROUPS[1].tools.map((t) => (
              <button key={t.id} className={`rb ${tool === t.id ? "on" : ""}`} title={t.label}
                disabled={!canEdit && !t.viewer} onClick={() => pickTool(t.id)}>{t.ico}</button>
            ))}
          </>},
          { id: "rev", label: "Review", node: <>
            {TOOL_GROUPS[5].tools.map((t) => (
              <button key={t.id} className={`rb ${tool === t.id ? "on" : ""}`} title={t.label}
                disabled={!canEdit && !t.viewer} onClick={() => pickTool(t.id)}>{t.ico}</button>
            ))}
          </>},
          { id: "comm", label: "Comments", items: [
            { label: "Sticky note", icon: "💬", checked: tool === "note", onClick: () => pickTool("note"), disabled: !canEdit },
            { label: "Stamp", icon: "✅", checked: tool === "stamp", onClick: () => pickTool("stamp"), disabled: !canEdit },
            { divider: true },
            { label: "Annotation list", icon: "📋", onClick: () => setPanel("anns") },
            { label: "Export comments (.fdf)", onClick: () => void import("./fdf").then(({ exportFdf }) => exportFdf(annDoc.annotations, title)), disabled: !annDoc.annotations.length },
            { label: "Import comments (.fdf)…", onClick: () => fdfRef.current?.click(), disabled: !canEdit },
            { label: "Summarize comments — printable PDF report", icon: "🖨", onClick: () => void import("./summarize").then(({ summarizeComments }) => summarizeComments(annDoc.annotations, title)), disabled: !annDoc.annotations.length },
          ]},
        ]},
        { id: "sign", label: "Fill & Sign", icon: "✍", groups: [
          { id: "fill", label: "Fill", node: <>
            {TOOL_GROUPS[2].tools.filter((t) => ["textbox", "check", "cross"].includes(t.id)).map((t) => (
              <button key={t.id} className={`rb ${tool === t.id ? "on" : ""}`} title={t.label}
                disabled={!canEdit && !t.viewer} onClick={() => pickTool(t.id)}>{t.ico}</button>
            ))}
          </>},
          { id: "sgn", label: "Sign", node: <>
            <button className={`rb ${tool === "sign" ? "on" : ""}`} title="Signature — draw or type, then click to place"
              disabled={!canEdit} onClick={() => pickTool("sign")}>✍</button>
            <button className={`rb ${tool === "cryptosign" ? "on" : ""}`} title="Digital signature — sign with certificate"
              disabled={!canEdit} onClick={() => (digId ? pickTool("cryptosign") : setDigSignDlg(true))}>🖋</button>
            <button className="rb" style={{ fontSize: 11, width: "auto", padding: "0 8px" }}
              title={sigImg ? "Change signature" : "Create signature"}
              disabled={!canEdit} onClick={() => setSigPadOpen(true)}>{sigImg ? "✍ Edit" : "✍ Create"}</button>
          </>},
          { id: "ns", label: "Note & Stamp", node: <>
            <button className={`rb ${tool === "note" ? "on" : ""}`} title="Sticky note" disabled={!canEdit} onClick={() => pickTool("note")}>💬</button>
            <button className={`rb ${tool === "stamp" ? "on" : ""}`} title="Stamp (APPROVED / DRAFT / …)" disabled={!canEdit} onClick={() => pickTool("stamp")}>✅</button>
          </>},
          { id: "dig", label: "Digital ID", items: [
            { label: "Digital ID settings…", icon: "🖋", onClick: () => setDigSignDlg(true), disabled: !canEdit },
          ]},
        ]},
        { id: "forms", label: "Forms", icon: "▣", groups: [
          { id: "fld", label: "Fields", node: <>
            <button className={`rb ${tool === "field" ? "on" : ""}`} title="Form field — drag to place"
              disabled={!canEdit} onClick={() => pickTool("field")}>▣</button>
            <select className="rb-sel" value={fieldKind} onChange={(e) => setFieldKind(e.target.value as FieldKind)} title="Field kind">
              <option value="text">Text field</option>
              <option value="checkbox">Checkbox</option>
              <option value="radio">Radio</option>
              <option value="dropdown">Dropdown</option>
              <option value="list">List box</option>
              <option value="signature">Signature</option>
              <option value="barcode">Barcode</option>
            </select>
            <button className="rb" title="Auto-detect blank fields (underscores, checkbox glyphs)"
              disabled={!canEdit} onClick={() => void detectFields()}>⚡ Detect</button>
          </>},
          { id: "fdata", label: "Form data", items: [
            { label: "Place a field", icon: "▣", checked: tool === "field", onClick: () => pickTool("field"), disabled: !canEdit },
            { label: "Field kind", submenu: (["text", "checkbox", "radio", "dropdown", "list", "signature", "barcode"] as FieldKind[]).map((k) => ({
              label: k[0].toUpperCase() + k.slice(1), checked: fieldKind === k,
              onClick: () => { setFieldKind(k); pickTool("field"); },
            }))},
            { divider: true },
            { label: "Auto-detect fields on this PDF", icon: "⚡", onClick: () => void detectFields(), disabled: !canEdit },
            { divider: true },
            { label: "Export form data (.fdf)", icon: "📤", onClick: () => void exportFormData() },
            { label: "Clear form — reset all entered values", icon: "⟲", onClick: () => {
              if (!confirm("Clear all entered form values? Fields keep their layout.")) return;
              mutate((d) => {
                for (const f of d.fields ?? []) f.value = undefined;
                d.form = {};
              });
              try { doc?.annotationStorage.resetModified(); } catch { /* best effort */ }
              setDocGen((g) => g + 1);
              toast("Form cleared");
            }, disabled: !canEdit },
          ]},
        ]},
        { id: "insert", label: "Insert", icon: "➕", menu: [
          { label: "Image…", icon: "🖼", checked: tool === "image", onClick: () => pickTool("image"), disabled: !canEdit },
          { label: "Sticky note", icon: "💬", checked: tool === "note", onClick: () => pickTool("note"), disabled: !canEdit },
          { label: "Stamp", icon: "✅", checked: tool === "stamp", onClick: () => pickTool("stamp"), disabled: !canEdit },
          { divider: true },
          { label: "Blank page", icon: "▤", onClick: () => void orgInsertBlank(), disabled: !canEdit },
          { label: "Images as pages…", icon: "🖼", onClick: () => imgPageRef.current?.click(), disabled: !canEdit },
          { label: "Web page…", icon: "🌐", onClick: () => { const u = window.prompt("Web page URL to append as pages:"); if (u?.trim()) void insertWebPage(u); }, disabled: !canEdit },
          { label: "PDF file — merge at end…", icon: "📄", onClick: () => mergeRef.current?.click(), disabled: !canEdit },
        ]},
        { id: "format", label: "Format", icon: "Aa", menu: [
          { label: "Typewriter font", icon: "T", submenu: [
            { label: "Helvetica", checked: tbFont === "helv", onClick: () => setTbFont("helv") },
            { label: "Times", checked: tbFont === "times", onClick: () => setTbFont("times") },
            { label: "Courier", checked: tbFont === "courier", onClick: () => setTbFont("courier") },
          ]},
          { label: "Typewriter size", icon: "↕", submenu: [8, 9, 10, 12, 14, 18, 24].map((s) => ({
            label: `${s} pt`, checked: tbSize === s, onClick: () => setTbSize(s),
          }))},
          { divider: true },
          { label: "Annotation color", icon: "🎨", submenu: MARKUP_COLORS.map((c) => ({
            label: COLOR_NAMES[c] ?? c, icon: <span className="fmt-swatch" style={{ background: c }} />,
            checked: toolColor === c, onClick: () => setToolColor(c),
          }))},
          { label: "Stamp text", icon: "◈", submenu: STAMPS.map((s) => ({
            label: s, checked: stampText === s, onClick: () => { setStampText(s); pickTool("stamp"); },
          }))},
        ]},
        { id: "pages", label: "Pages", icon: "⧉", groups: [
          { id: "org", label: "Organize", node: <>
            <button className={`rb ${panel === "organize" ? "on" : ""}`} title="Organize pages (PDF-1)" disabled={!canEdit}
              onClick={() => { setPanel(panel === "organize" ? "none" : "organize"); setOrgSel(new Set()); }}>⧉</button>
            {panel === "organize" && (
              <>
                <span className="rb-info" style={{ fontSize: 11 }}>{orgSel.size ? `${orgSel.size} selected` : "Click pages · drag to reorder"}</span>
                <button className="rb" title="Delete selected pages" disabled={!orgSel.size} onClick={orgDelete}>🗑</button>
                <button className="rb" title="Rotate left 90°" disabled={!orgSel.size} onClick={() => void orgRotate(270)}>↺</button>
                <button className="rb" title="Rotate right 90°" disabled={!orgSel.size} onClick={() => void orgRotate(90)}>↻</button>
                <button className="rb" title="Insert blank page after current" onClick={() => void orgInsertBlank()}>＋▤</button>
                <button className="rb" title="Merge another PDF at the end" onClick={() => mergeRef.current?.click()}>⇤📄</button>
                <button className="rb" title="Insert images as new pages at the end" onClick={() => imgPageRef.current?.click()}>＋🖼</button>
                <button className="rb" title="Extract selected pages → new PDF" disabled={!orgSel.size} onClick={() => void orgExtract()}>⤓</button>
                <button className="rb" title={`Split at page ${curPage} → two PDFs`} disabled={curPage <= 1} onClick={() => void orgSplit()}>✂</button>
                <span className="rb-info" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                  <input className="pg-in" style={{ width: 180 }} placeholder="https://… → pages (PDF-13.4)"
                    value={webUrl} onChange={(e) => setWebUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void insertWebPage(); }} />
                  <button className="rb" title="Fetch web page and append as text pages" disabled={!webUrl.trim()}
                    onClick={() => void insertWebPage()}>🌐</button>
                </span>
              </>
            )}
          </>},
          { id: "pgact", label: "Page actions", items: [
            { label: "Organize pages…", icon: "⧉", checked: panel === "organize", disabled: !canEdit,
              onClick: () => { setPanel(panel === "organize" ? "none" : "organize"); setOrgSel(new Set()); } },
            { divider: true },
            { label: "Insert blank page", onClick: () => void orgInsertBlank(), disabled: !canEdit },
            { label: "Insert images as pages…", onClick: () => imgPageRef.current?.click(), disabled: !canEdit },
            { label: "Insert web page…", onClick: () => { const u = window.prompt("Web page URL to append as pages:"); if (u?.trim()) void insertWebPage(u); }, disabled: !canEdit },
            { label: "Merge another PDF…", onClick: () => mergeRef.current?.click(), disabled: !canEdit },
            { divider: true },
            { label: "Rotate current page right", onClick: () => { setOrgSel(new Set([curPage])); void orgRotate(90); }, disabled: !canEdit },
            { label: "Rotate current page left", onClick: () => { setOrgSel(new Set([curPage])); void orgRotate(270); }, disabled: !canEdit },
            { label: "Delete current page", onClick: () => { setOrgSel(new Set([curPage])); orgDelete(); }, disabled: !canEdit || numPages <= 1 },
            { divider: true },
            { label: `Split at page ${curPage}`, onClick: () => void orgSplit(), disabled: !canEdit || curPage <= 1 },
            { label: "Extract all pages", onClick: () => { setOrgSel(new Set(Array.from({ length: numPages }, (_, i) => i + 1))); void orgExtract(); }, disabled: !canEdit },
          ]},
        ]},
        { id: "view", label: "View", icon: "👁", groups: [
          { id: "zoom", label: "Zoom", node: <>
            <button className="rb" title="Zoom out" onClick={() => setScale((s) => Math.max(0.4, +(s - 0.2).toFixed(2)))}>−</button>
            <select className="rb-sel" style={{ width: 76 }} value={scale} onChange={(e) => setScale(Number(e.target.value))}>
              {[0.5, 0.75, 1, 1.1, 1.25, 1.5, 2, 3].map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
            </select>
            <button className="rb" title="Zoom in" onClick={() => setScale((s) => Math.min(4, +(s + 0.2).toFixed(2)))}>＋</button>
            <button className="rb" title="Fit width" onClick={() => void fitWidth()}>⇤⇥</button>
            <button className="rb" title="Fit page" onClick={() => void fitPage()}>⛶</button>
            <button className="rb" title="Rotate view (session only)" onClick={() => setViewRot((r) => (r + 90) % 360)}>⟳</button>
          </>},
          { id: "mode", label: "Page View", node: <>
            <button className="rb" title="Reading view: continuous / single / two-page" onClick={() => setViewMode((m) => m === "cont" ? "single" : m === "single" ? "two" : "cont")}>{viewMode === "cont" ? "📜" : viewMode === "single" ? "📄" : "📑"}</button>
            {viewMode === "two" && (
              <button className={`rb ${cover ? "on" : ""}`} title="Two-page cover — show page 1 alone"
                onClick={() => setCover((c) => !c)}>🅲</button>
            )}
            <button className={`rb ${viewMode === "reflow" ? "on" : ""}`} title="Reflow — extract text into a readable column"
              onClick={() => setViewMode((m) => m === "reflow" ? "cont" : "reflow")}>🔤</button>
            <button className={`rb ${dark ? "on" : ""}`} title="Dark render" onClick={() => setDark((d) => !d)}>🌙</button>
            <button className="rb" title="Fullscreen" onClick={() => scrollRef.current?.closest(".editor")?.requestFullscreen?.().catch(() => {})}>⛶</button>
          </>},
          { id: "insp", label: "Inspect", node: <>
            {TOOL_GROUPS[6].tools.map((t) => (
              <button key={t.id} className={`rb ${tool === t.id ? "on" : ""}`} title={t.label}
                onClick={() => pickTool(t.id)}>{t.ico}</button>
            ))}
          </>},
          { id: "vopt", label: "Options", items: [
            { label: "Continuous scroll", checked: viewMode === "cont", onClick: () => setViewMode("cont") },
            { label: "Single page", checked: viewMode === "single", onClick: () => setViewMode("single") },
            { label: "Two pages", checked: viewMode === "two" && !cover, onClick: () => { setViewMode("two"); setCover(false); } },
            { label: "Two-page cover", checked: viewMode === "two" && cover, onClick: () => { setViewMode("two"); setCover(true); } },
            { label: "Reflow text", checked: viewMode === "reflow", onClick: () => setViewMode("reflow") },
            { divider: true },
            { label: "Fit width", onClick: () => void fitWidth() },
            { label: "Fit page", onClick: () => void fitPage() },
            { label: "Fit visible — zoom to content, ignoring margins", onClick: () => void fitVisible() },
            { label: "100%", onClick: () => setScale(1) },
            { divider: true },
            { label: "Rotate view 90°", onClick: () => setViewRot((r) => (r + 90) % 360) },
            { label: "Show annotations", checked: showAnns, onClick: () => setShowAnns((v) => !v) },
            { label: "Highlight form fields", checked: hlFields, onClick: () => setHlFields((v) => !v) },
            { label: "Dark mode", checked: dark, onClick: () => setDark((d) => !d) },
            { label: "Fullscreen", onClick: () => scrollRef.current?.closest(".editor")?.requestFullscreen?.().catch(() => {}) },
            { divider: true },
            { label: "Previous view", shortcut: "Alt+←", onClick: () => navStep(-1), disabled: navHist.current.idx <= 0 },
            { label: "Next view", shortcut: "Alt+→", onClick: () => navStep(1), disabled: navHist.current.idx >= navHist.current.stack.length - 1 },
            { label: "First page", icon: "⏮", onClick: () => scrollToPage(1), disabled: curPage <= 1 },
            { label: "Last page", icon: "⏭", onClick: () => scrollToPage(numPages), disabled: curPage >= numPages },
            { divider: true },
            { label: "Automatically scroll", icon: "⏬", checked: autoScroll > 0,
              onClick: () => { const on = !autoScroll; setAutoScroll(on ? 1.1 : 0); if (on) { setViewMode("cont"); toast("Auto-scrolling — ↑ faster · ↓ slower · Esc stops"); } } },
            { label: "Read mode — hide all toolbars", icon: "📖", shortcut: "Ctrl+H", checked: readMode, onClick: () => setReadMode((v) => !v) },
            { divider: true },
            { label: "Rulers & grids", icon: "📐", submenu: [
              { label: "Rulers — page edges, inches", checked: showRulers, onClick: () => setShowRulers((v) => !v) },
              { label: "Grid — 1in lines over pages", checked: showGrid, onClick: () => setShowGrid((v) => !v) },
            ]},
            { label: "Read aloud", icon: "🔊", submenu: [
              { label: speaking ? "Stop reading" : "Read this page", checked: speaking, onClick: () => void speakPage() },
              { divider: true },
              ...[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => ({ label: `Speed ${r}×`, checked: (tts.rate || 1) === r, onClick: () => setTts((t) => ({ ...t, rate: r })) })),
              { divider: true },
              ...(voices.length ? voices.slice(0, 12).map((v) => ({
                label: v.name.length > 34 ? v.name.slice(0, 33) + "…" : v.name,
                checked: tts.voice === v.voiceURI, onClick: () => setTts((t) => ({ ...t, voice: v.voiceURI })),
              })) : [{ label: "System default voice", onClick: () => setTts((t) => ({ ...t, voice: undefined })) }]),
            ]},
            { divider: true },
            { label: "Keyboard shortcuts", icon: "⌨", shortcut: "?", onClick: () => setShowKeys(true) },
          ]},
        ]},
      ]} />

      {/* tool options — contextual strip shown while an annotating/fill tool is armed */}
      {(MARKUP_TOOLS.has(tool) || tool === "sign" || tool === "cryptosign" || tool === "field") && (
        <div className="ribbon ribbon-toolopts">
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
          {tool === "textbox" && (
            <>
              <select className="rb-sel" value={tbFont} onChange={(e) => setTbFont(e.target.value as typeof tbFont)} title="Textbox font">
                <option value="helv">Helvetica</option><option value="times">Times</option><option value="courier">Courier</option>
              </select>
              <select className="rb-sel" style={{ width: 52 }} value={tbSize} onChange={(e) => setTbSize(Number(e.target.value))} title="Font size">
                {[8, 9, 10, 12, 14, 18, 24].map((s) => <option key={s} value={s}>{s}pt</option>)}
              </select>
            </>
          )}
          {tool === "field" && (
            <>
              <select className="rb-sel" value={fieldKind} onChange={(e) => setFieldKind(e.target.value as FieldKind)} title="Field kind">
                <option value="text">Text field</option>
                <option value="checkbox">Checkbox</option>
                <option value="radio">Radio</option>
                <option value="dropdown">Dropdown</option>
                <option value="list">List box</option>
                <option value="signature">Signature</option>
                <option value="barcode">Barcode</option>
              </select>
              <button className="rb" title="Auto-detect blank fields (underscores, checkbox glyphs)"
                onClick={() => void detectFields()}>⚡ Detect</button>
            </>
          )}
          {MARKUP_TOOLS.has(tool) && tool !== "stamp" && tool !== "whiteout" && tool !== "image" && tool !== "measure" && tool !== "edittext" && tool !== "field" && tool !== "redact" && tool !== "caret" && (
            <div className="rb-colors">
              {MARKUP_COLORS.map((c) => (
                <button key={c} className={`sw ${toolColor === c ? "on" : ""}`} style={{ background: c }} onClick={() => setToolColor(c)} />
              ))}
              <input type="color" className="sw-custom" title="Custom color" value={toolColor}
                onChange={(e) => setToolColor(e.target.value)} />
            </div>
          )}
          {(tool === "check" || tool === "cross") && (
            <div className="rb-size" title="Mark size (points)">
              <button className="rb" onClick={() => setMarkSize((s) => Math.max(8, s - 4))}>−</button>
              <span className="rb-sz">{markSize}</span>
              <button className="rb" onClick={() => setMarkSize((s) => Math.min(96, s + 4))}>+</button>
            </div>
          )}
        </div>
      )}
      <input ref={cmpRef} type="file" accept=".pdf" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void runCompare(f); e.target.value = ""; }} />
      <input ref={openFileRef} type="file" accept=".pdf,application/pdf" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void openFromComputer(f); e.target.value = ""; }} />
      <input ref={mergeRef} type="file" accept=".pdf" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void orgMerge(f); e.target.value = ""; }} />
      <input ref={imgPageRef} type="file" accept="image/png,image/jpeg" multiple hidden
        onChange={(e) => { if (e.target.files?.length) void orgInsertImages(e.target.files); e.target.value = ""; }} />
      <input ref={imgFileRef} type="file" accept="image/png,image/jpeg" hidden
        onChange={(e) => {
          const f = e.target.files?.[0]; const pend = imgPending.current; e.target.value = "";
          if (!f || !pend) return;
          const fr = new FileReader();
          fr.onload = () => addAnn(pend.page, { type: "image", rects: [pend.rect], img: String(fr.result) });
          fr.readAsDataURL(f);
          imgPending.current = null;
        }} />
      <input ref={fdfRef} type="file" accept=".fdf,.xfdf" hidden
        onChange={(e) => {
          const f = e.target.files?.[0]; e.target.value = "";
          if (!f) return;
          void f.text().then((t) => import("./fdf").then(({ parseFdf }) => {
            const imported = parseFdf(t);
            if (!imported.length) { toast("No annotations found in that FDF"); return; }
            mutate((d) => { d.annotations.push(...imported); });
            toast(`Imported ${imported.length} annotation${imported.length === 1 ? "" : "s"}`);
          }));
        }} />

      <div className="work">
        {panel !== "none" && panel !== "comments" && panel !== "versions" && (
          <div className="rail-backdrop" onPointerDown={() => setPanel("none")} />
        )}
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
                <label style={{ display: "flex", gap: 6, fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
                  <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Case sensitive
                  <input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} style={{ marginLeft: 10 }} /> Whole word
                </label>
                <label style={{ display: "flex", gap: 6, fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                  Include:
                  <input type="checkbox" checked={searchBm} onChange={(e) => setSearchBm(e.target.checked)} /> bookmarks
                  <input type="checkbox" checked={searchCm} onChange={(e) => setSearchCm(e.target.checked)} /> comments
                </label>
                <div className="pdf-results">
                  {matches.map((m, i) => (
                    <div key={i} className={`pdf-match ${i === matchIdx ? "on" : ""}`}
                      onClick={() => {
                        setMatchIdx(i);
                        if (m.kind === "bookmark") void resolveDest(m.dest).then((p) => { if (p) scrollToPage(p); });
                        else { scrollToPage(m.page); if (m.kind === "comment" && m.annId) setSelAnn(m.annId); }
                      }}>
                      <b>{m.kind === "bookmark" ? "🔖" : m.kind === "comment" ? "💬" : `p.${m.page}`}</b> {m.snippet.slice(0, 70)}
                    </div>
                  ))}
                  {query && !matches.length && <div className="empty">No matches</div>}
                </div>
              </div>
            )}
            {panel === "layers" && (
              <div className="pdf-annlist">
                <div style={{ fontSize: 11, color: "var(--muted)", padding: "0 2px" }}>Optional content groups in this document</div>
                {ocg.map((g) => (
                  <label key={g.id} className="pdf-annrow" style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                    <input type="checkbox" checked={g.on} onChange={(e) => {
                      ocgCfgRef.current?.setVisibility(g.id, e.target.checked);
                      setOcg(ocg.map((x) => x.id === g.id ? { ...x, on: e.target.checked } : x));
                      setOcgRev((r) => r + 1);
                    }} />
                    <span style={{ fontSize: 12 }}>{g.name}</span>
                  </label>
                ))}
              </div>
            )}
            {panel === "attach" && (
              <div className="pdf-annlist">
                <div style={{ fontSize: 11, color: "var(--muted)", padding: "0 2px" }}>Embedded files</div>
                {canEdit && (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    <button className="btn-ghost btn-sm" onClick={() => attachRef.current?.click()}>Attach file…</button>
                    <button className="btn-ghost btn-sm" title="Attach files + prepend a cover page listing them"
                      onClick={() => portRef.current?.click()}>Make portfolio</button>
                    <input ref={attachRef} type="file" multiple hidden
                      onChange={(e) => { void attachFiles(e.target.files, false); e.target.value = ""; }} />
                    <input ref={portRef} type="file" multiple hidden
                      onChange={(e) => { void attachFiles(e.target.files, true); e.target.value = ""; }} />
                  </div>
                )}
                {!attachments.length && <div style={{ fontSize: 11, color: "var(--muted)" }}>No embedded files</div>}
                {attachments.map((a) => (
                  <div key={a.name} className="pdf-annrow">
                    <div className="pdf-annrow-top">
                      <span className="pdf-annrow-ico">📄</span>
                      <div style={{ flex: 1, minWidth: 0 }}><div className="pdf-annrow-label">{a.name}</div>
                        <div className="pdf-annrow-meta">{(a.content.length / 1024).toFixed(1)} KB</div></div>
                      <button className="btn-ghost btn-sm" title="Download" onClick={() => {
                        const url = URL.createObjectURL(new Blob([a.content.buffer as ArrayBuffer]));
                        const el = document.createElement("a"); el.href = url; el.download = a.name; el.click();
                        setTimeout(() => URL.revokeObjectURL(url), 4000);
                      }}>⤓</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {panel === "access" && (
              <div className="pdf-annlist">
                <div style={{ fontSize: 11, color: "var(--muted)", padding: "0 2px" }}>Accessibility report</div>
                {(accessReport ?? [{ ok: true, label: "Checking…" }]).map((r, i) => (
                  <div key={i} className="pdf-annrow"><div className="pdf-annrow-top">
                    <span className="pdf-annrow-ico" style={{ borderColor: r.ok ? "#4a4" : "#d33" }}>{r.ok ? "✓" : "✗"}</span>
                    <span style={{ fontSize: 12 }}>{r.label}</span>
                  </div></div>
                ))}
                <button className="btn-ghost btn-sm" onClick={() => void runAccessCheck()}>Re-run</button>
              </div>
            )}
            {panel === "compare" && (
              <div className="pdf-annlist">
                <div style={{ fontSize: 11, color: "var(--muted)", padding: "0 2px" }}>Text comparison vs the other PDF</div>
                {!cmp?.length && <div className="empty">Pick another PDF to compare</div>}
                {cmp?.map((r) => (
                  <div key={r.page} className="pdf-annrow" onClick={() => scrollToPage(r.page)}>
                    <div className="pdf-annrow-top">
                      <span className="pdf-annrow-ico" style={{ borderColor: r.st === "identical" ? "#4a4" : r.st === "changed" ? "#e9a13b" : "#d33" }}>
                        {r.st === "identical" ? "✓" : r.st === "changed" ? "Δ" : "✗"}
                      </span>
                      <div style={{ flex: 1 }}><div className="pdf-annrow-label">Page {r.page}</div>
                        <div className="pdf-annrow-meta">{r.st}</div></div>
                    </div>
                    {r.st === "changed" && (
                      <div className="pdf-annrow-detail" onClick={(e) => e.stopPropagation()}>
                        <div className="pdf-annreply"><b>this doc</b> …{r.a}…</div>
                        <div className="pdf-annreply"><b>other</b> …{r.b}…</div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {panel === "sigs" && (
              <div className="pdf-annlist">
                <div style={{ fontSize: 11, color: "var(--muted)", padding: "0 2px" }}>Digital signatures</div>
                {!sigs?.length && <div className="empty">No digital signatures in this document</div>}
                {sigs?.map((s, i) => {
                  const ok = s.digestOk === true && s.sigOk !== false;
                  const bad = s.digestOk === false || s.sigOk === false;
                  return (
                    <div key={`sig${i}`} className="pdf-annrow">
                      <div className="pdf-annrow-top">
                        <span className="pdf-annrow-ico" style={{ borderColor: bad ? "#d33" : ok ? "#4a4" : "#e9a13b" }}>
                          {bad ? "✗" : ok ? "✓" : "?"}
                        </span>
                        <div style={{ flex: 1 }}>
                          <div className="pdf-annrow-label">{s.field || `Signature ${i + 1}`}</div>
                          <div className="pdf-annrow-meta">{s.signer}</div>
                        </div>
                      </div>
                      <div className="pdf-annrow-detail">
                        <div className="pdf-annreply">
                          {s.digestOk === true ? "Document integrity: unchanged since signing"
                            : s.digestOk === false ? "Document integrity: CONTENT CHANGED after signing"
                            : "Document integrity: could not be verified"}
                        </div>
                        {s.sigOk !== null && (
                          <div className="pdf-annreply">Signature value: {s.sigOk ? "cryptographically valid" : "INVALID"}</div>
                        )}
                        <div className="pdf-annreply">Digest: {s.digestAlgo} · Issuer: {s.issuer}</div>
                        {s.signedAt && <div className="pdf-annreply">Signed: {s.signedAt}</div>}
                        {s.trailingBytes && <div className="pdf-annreply">⚠ Data appended after the signed range (incremental update)</div>}
                        <div className="pdf-annreply" style={{ opacity: 0.7 }}>Certificate chain not checked against a trust store</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {panel === "anns" && (
              <div className="pdf-annlist">
                <div style={{ display: "flex", gap: 6, padding: "0 2px" }}>
                  <button className="btn-ghost btn-sm" style={{ flex: 1 }}
                    disabled={!annDoc.annotations.length}
                    onClick={() => import("./fdf").then(({ exportFdf }) => exportFdf(annDoc.annotations, title))}>⇪ Export .fdf</button>
                  <button className="btn-ghost btn-sm" style={{ flex: 1 }} disabled={!canEdit}
                    onClick={() => fdfRef.current?.click()}>⇩ Import .fdf</button>
                </div>
                {/* PDF-12.3 — review filter */}
                <select className="rb-sel" style={{ width: "100%" }} value={annFilter}
                  onChange={(e) => setAnnFilter(e.target.value as typeof annFilter)}>
                  <option value="all">All annotations</option>
                  <option value="open">Open (unresolved)</option>
                  <option value="accepted">Accepted</option>
                  <option value="rejected">Rejected</option>
                  <option value="completed">Completed</option>
                </select>
                {!annDoc.annotations.length && <div className="empty">No annotations yet — draw one with the markup tools</div>}
                {[...annDoc.annotations]
                  .filter((a) => annFilter === "all" ? true : annFilter === "open" ? !a.status || a.status === "none" : a.status === annFilter)
                  .sort((x, y) => x.page - y.page || (x.createdAt ?? "").localeCompare(y.createdAt ?? "")).map((a) => (
                  <AnnRow key={a.id} a={a} sel={selAnn === a.id} canEdit={canEdit} userName={user?.displayName ?? "You"}
                    onPick={() => { setSelAnn(a.id); scrollToPage(a.page); }}
                    onDel={() => delAnn(a.id)}
                    onPatch={(p) => patchAnn(a.id, p)} />
                ))}
              </div>
            )}
          </div>
        )}

        <div className="pdf-doccol">
        {/* Acrobat-style signature status banner */}
        {doc && sigs !== null && sigs.length > 0 && !readMode && (() => {
          const anyBad = sigs.some((s) => s.digestOk === false || s.sigOk === false);
          const anyWarn = sigs.some((s) => s.digestOk === null || s.sigOk === null || s.trailingBytes);
          const cls = anyBad ? "bad" : anyWarn ? "warn" : "ok";
          const msg = anyBad ? "Signed — signature validity problems found"
            : anyWarn ? "Signed — unverified (modified after signing or unsupported algorithm)"
            : "Signed — all signatures verified, document unchanged";
          return (
            <div className={`pdf-sigbanner ${cls}`} onClick={() => setPanel("sigs")} title="Open the Signatures panel">
              <b>🔏 {msg}</b>
              <span>{sigs.length} signature{sigs.length === 1 ? "" : "s"} · open Signature panel →</span>
            </div>
          );
        })()}
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
                  } else if (next.has(p) && orgSel.size > 1) next.delete(p); else next.add(p);
                  setOrgSel(next);
                }}>
                <Thumb doc={doc} page={p} active={p === curPage} onClick={() => scrollToPage(p)} />
              </div>
            ))}
          </div>
        ) : (
        <div className={`pages pdf-pages ${viewMode === "single" || viewMode === "two" ? "paged" : ""} ${hlFields ? "hl-fields" : ""} ${panning ? "panning" : spaceDown ? "space-hold" : ""}`} ref={scrollRef}
          onPointerDownCapture={(e) => {
            const wantPan = spaceDown || tool === "pan";
            if (!wantPan || e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            const el = scrollRef.current!;
            const sx = e.clientX, sy = e.clientY, sl = el.scrollLeft, st = el.scrollTop;
            const mv = (ev: PointerEvent) => { el.scrollLeft = sl - (ev.clientX - sx); el.scrollTop = st - (ev.clientY - sy); };
            const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); setPanning(false); };
            window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
            setPanning(true);
          }}
          onPointerDown={(e) => {
            if (e.pointerType !== "touch") return;
            touchPts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (touchPts.current.size === 2) {
              const [a, b] = [...touchPts.current.values()];
              pinchRef.current = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: scale, last: scale };
            }
          }}
          onPointerMove={(e) => {
            const pinch = pinchRef.current;
            if (e.pointerType !== "touch" || !pinch || !touchPts.current.has(e.pointerId)) return;
            touchPts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            const [a, b] = [...touchPts.current.values()];
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            const ns = Math.min(4, Math.max(0.4, +(pinch.s0 * (d / pinch.d0)).toFixed(3)));
            if (ns === pinch.last) return;
            // keep the gesture midpoint fixed under the fingers while zooming
            const el = scrollRef.current!;
            const r = el.getBoundingClientRect();
            zoomAnchor.current = { fx: (a.x + b.x) / 2 - r.left, fy: (a.y + b.y) / 2 - r.top, ratio: ns / pinch.last, sl: el.scrollLeft, st: el.scrollTop };
            pinch.last = ns;
            setScale(ns);
          }}
          onPointerUp={(e) => { touchPts.current.delete(e.pointerId); if (touchPts.current.size < 2) pinchRef.current = null; }}
          onPointerCancel={(e) => { touchPts.current.delete(e.pointerId); if (touchPts.current.size < 2) pinchRef.current = null; }}
          onScroll={(e) => {
            const el = e.currentTarget;
            const kids = [...el.querySelectorAll<HTMLElement>("[data-page]")];
            const mid = el.scrollTop + el.clientHeight * 0.35;
            const vis = kids.find((k) => k.offsetTop + k.offsetHeight > mid);
            if (vis) {
              const p = Number(vis.dataset.page);
              if (p !== curPage) navPush(curPage);
              setCurPage(p);
            }
          }}>
          {loadErr && <div className="empty" style={{ padding: 60 }}>{loadErr}</div>}
          {!doc && !loadErr && <div className="empty" style={{ padding: 60 }}>Loading PDF…</div>}
          {doc && viewMode === "reflow" && Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
            <ReflowPage key={`r${docGen}:${p}`} doc={doc} pageNum={p} dark={dark} />
          ))}
          {doc && viewMode !== "reflow" && (viewMode === "cont" ? Array.from({ length: numPages }, (_, i) => i + 1)
            : viewMode === "single" ? [curPage]
            : cover && curPage === 1 ? [1]
            : (() => { const s = cover ? (curPage % 2 === 0 ? curPage : curPage - 1) : (curPage % 2 === 0 ? curPage - 1 : curPage); return [s, s + 1].filter((p) => p <= numPages); })()
          ).map((p) => (
            <div key={`${docGen}:${p}`} data-page={p} ref={(el) => { if (el) pageRefs.current.set(p, el); }} className="pdf-page-wrap">
              <PdfPage doc={doc} pageNum={p} scale={scale}
                anns={annDoc.annotations.filter((a) => a.page === p)}
                selAnn={selAnn} setSelAnn={setSelAnn}
                tool={canEdit || VIEW_TOOLS.has(tool) ? tool : "select"} toolColor={toolColor} stampText={stampText} sigImg={sigImg}
                showAnns={showAnns} showGrid={showGrid} showRulers={showRulers}
                markSize={markSize} onDigSign={(x, y) => { if (!digId) { setDigSignDlg(true); return; } void cryptoSignAt(p, x, y); }}
                onNeedSig={() => setSigPadOpen(true)} onInfo={toast}
                onZoomStep={(dir, cx, cy) => {
                  const el = scrollRef.current; if (!el) return;
                  const r = el.getBoundingClientRect();
                  const fx = cx - r.left, fy = cy - r.top;
                  setScale((s) => {
                    const ns = Math.min(4, Math.max(0.4, +(s * (dir > 0 ? 1.25 : 1 / 1.25)).toFixed(3)));
                    if (ns !== s) zoomAnchor.current = { fx, fy, ratio: ns / s, sl: el.scrollLeft, st: el.scrollTop };
                    return ns;
                  });
                }}
                onSnapshot={(ok) => toast(ok ? "Snapshot copied to clipboard" : "Clipboard blocked — snapshot downloaded instead")}
                tbFont={tbFont} tbSize={tbSize} ocrWords={annDoc.ocr?.[String(p)]}
                canEdit={canEdit} viewRot={viewRot} dark={dark}
                searchRects={matches.filter((m, i) => m.page === p && i <= matchIdx + 3).flatMap((m) => m.rects)}
                onAdd={(a) => addAnn(p, a)}
                onMove={moveAnn}
                onPatch={patchAnn}
                focusAnn={focusAnn} setFocusAnn={setFocusAnn}
                onDelAnn={delAnn}
                onZoomTo={zoomToRect}
                ocgCfg={ocgCfgRef.current} ocgRev={ocgRev}
                onPickImage={(r) => { imgPending.current = { page: p, rect: r }; imgFileRef.current?.click(); }}
                fieldApi={{
                  fields: (annDoc.fields ?? []).filter((f) => f.page === p),
                  sel: selField, select: setSelField,
                  add: (r, clicked) => addField(p, r, clicked), move: moveField, patch: patchField,
                  del: delField, checkRadio, reorder: reorderField, signField,
                }} />
            </div>
          ))}
          {(viewMode === "single" || viewMode === "two") && doc && (
            <div className="pdf-vmnav">
              <button className="btn-ghost btn-sm" disabled={curPage <= 1}
                onClick={() => setCurPage((p) => Math.max(1, cover && viewMode === "two" && p <= 3 ? 1 : p - (viewMode === "two" ? 2 : 1)))}>← Prev</button>
              <button className="btn-ghost btn-sm" disabled={curPage >= numPages}
                onClick={() => setCurPage((p) => Math.min(numPages, cover && viewMode === "two" && p === 1 ? 2 : p + (viewMode === "two" ? 2 : 1)))}>Next →</button>
            </div>
          )}
        </div>
        )}
        </div>
      </div>

      {doc && (
        <div className="pdf-status">
          <span>Page {pageLabels?.[curPage - 1] ?? curPage} of {numPages}{pageLabels?.[curPage - 1] && pageLabels[curPage - 1] !== String(curPage) ? ` (${curPage})` : ""}</span>
          {curDims && <span>{(curDims.w / 72).toFixed(1)} × {(curDims.h / 72).toFixed(1)} in</span>}
          <span>{Math.round(scale * 100)}%</span>
          {annDoc.annotations.length > 0 && <span>{annDoc.annotations.length} annotation{annDoc.annotations.length === 1 ? "" : "s"}</span>}
          {(annDoc.fields ?? []).length > 0 && <span>{annDoc.fields!.length} field{annDoc.fields!.length === 1 ? "" : "s"}</span>}
          <span style={{ flex: 1 }} />
          <button className="pdf-status-hint" onClick={() => setShowKeys(true)} title="Keyboard shortcuts (?)" style={{ background: "none", border: 0, cursor: "pointer", font: "inherit", color: "inherit" }}>⌨</button>
          <span className={`save-state ${saveState}`}>{saveLabel}</span>
        </div>
      )}

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
          applyOps={aiApplyOps} onClose={() => setPanel("none")} toast={toast} initialPrompt={aiPrompt} />
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
      {digSignDlg && (
        <div className="dlg-back" onClick={() => setDigSignDlg(false)}>
          <div className="dlg" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
            <h3>Digital signature</h3>
            <p style={{ fontSize: 12, color: "var(--muted)", margin: "4px 0 12px" }}>
              Cryptographically sign this document (CMS/PKCS#7). Choose a digital ID — import a .p12/.pfx
              certificate, or generate a self-signed ID.
            </p>
            <div style={{ display: "flex", gap: 14, marginBottom: 12, fontSize: 12 }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="radio" checked={digMode === "self"} onChange={() => setDigMode("self")} /> Generate self-signed ID
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="radio" checked={digMode === "p12"} onChange={() => setDigMode("p12")} /> Import .p12 / .pfx
              </label>
            </div>
            {digMode === "p12" ? (<>
              <input type="file" ref={digP12Ref} accept=".p12,.pfx" style={{ fontSize: 12, marginBottom: 8 }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void f.arrayBuffer().then((b) => setDigP12(new Uint8Array(b)));
                }} />
              <input type="password" value={digPw} placeholder="Certificate password" autoComplete="off"
                onChange={(e) => setDigPw(e.target.value)}
                style={{ width: "100%", height: 34, border: "1px solid var(--line)", borderRadius: 8, padding: "0 10px", fontSize: 12, marginBottom: 8, boxSizing: "border-box" }} />
              <input value={digName} placeholder="Signer name shown on the signature" onChange={(e) => setDigName(e.target.value)}
                style={{ width: "100%", height: 34, border: "1px solid var(--line)", borderRadius: 8, padding: "0 10px", fontSize: 12, marginBottom: 8, boxSizing: "border-box" }} />
            </>) : (<>
              <input value={digName} placeholder="Your name (required)" onChange={(e) => setDigName(e.target.value)}
                style={{ width: "100%", height: 34, border: "1px solid var(--line)", borderRadius: 8, padding: "0 10px", fontSize: 12, marginBottom: 8, boxSizing: "border-box" }} />
              <input value={digEmail} placeholder="Email (optional)" onChange={(e) => setDigEmail(e.target.value)}
                style={{ width: "100%", height: 34, border: "1px solid var(--line)", borderRadius: 8, padding: "0 10px", fontSize: 12, marginBottom: 8, boxSizing: "border-box" }} />
              <input value={digOrg} placeholder="Organization (optional)" onChange={(e) => setDigOrg(e.target.value)}
                style={{ width: "100%", height: 34, border: "1px solid var(--line)", borderRadius: 8, padding: "0 10px", fontSize: 12, marginBottom: 8, boxSizing: "border-box" }} />
            </>)}
            <input value={digReason} placeholder="Reason (optional, e.g. Approved)" onChange={(e) => setDigReason(e.target.value)}
              style={{ width: "100%", height: 34, border: "1px solid var(--line)", borderRadius: 8, padding: "0 10px", fontSize: 12, marginBottom: 8, boxSizing: "border-box" }} />
            <input value={digLoc} placeholder="Location (optional)" onChange={(e) => setDigLoc(e.target.value)}
              style={{ width: "100%", height: 34, border: "1px solid var(--line)", borderRadius: 8, padding: "0 10px", fontSize: 12, marginBottom: 12, boxSizing: "border-box" }} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn-ghost" onClick={() => setDigSignDlg(false)}>Cancel</button>
              <button className="btn-primary" onClick={() => {
                if (digMode === "p12") {
                  if (!digP12) { toast("Choose a .p12/.pfx certificate file"); return; }
                  setDigId({ name: digName.trim() || "Signer", reason: digReason.trim(), location: digLoc.trim(), cert: { kind: "p12", data: digP12, password: digPw } });
                } else {
                  if (!digName.trim()) { toast("Enter your name for the self-signed ID"); return; }
                  setDigId({ name: digName.trim(), reason: digReason.trim(), location: digLoc.trim(),
                    cert: { kind: "self", name: digName.trim(), email: digEmail.trim() || undefined, org: digOrg.trim() || undefined } });
                }
                setDigSignDlg(false);
                setTool("cryptosign");
                toast("Digital ID ready — click on the page to place the signature");
              }}>Continue</button>
            </div>
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
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, marginBottom: 6 }}>
              <input type="checkbox" checked={pdfOpts.sanitize}
                onChange={(e) => setPdfOpts({ ...pdfOpts, sanitize: e.target.checked })} />
              Sanitize — strip title, author, creator, dates
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, marginBottom: 10 }}>
              <input type="checkbox" checked={pdfOpts.optimize}
                onChange={(e) => setPdfOpts({ ...pdfOpts, optimize: e.target.checked })} />
              Optimize for smaller file size
            </label>
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              <input value={pdfOpts.batesPrefix} placeholder="Bates prefix (e.g. CASE-)" title="Bates numbering — bottom-right, sequential"
                onChange={(e) => setPdfOpts({ ...pdfOpts, batesPrefix: e.target.value })}
                style={{ flex: 1, height: 30, border: "1px solid var(--line)", borderRadius: 8, padding: "0 10px", fontSize: 12 }} />
              <input type="number" min={1} value={pdfOpts.batesStart} title="Starting number" style={{ width: 70, height: 30, border: "1px solid var(--line)", borderRadius: 8, padding: "0 8px", fontSize: 12 }}
                onChange={(e) => setPdfOpts({ ...pdfOpts, batesStart: Math.max(1, Number(e.target.value) || 1) })} />
            </div>
            {annDoc.annotations.some((a) => a.type === "redact") && (
              <p style={{ fontSize: 11, color: "#b23", margin: "0 0 8px" }}>
                Pages with redaction marks will be permanently rasterized — the underlying content is removed, not just covered.
              </p>
            )}
            <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>Also export as:</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className="btn-ghost btn-sm" disabled={!doc} onClick={() => {
                  setExportDlg(false);
                  void import("./exportDocx").then(({ exportPdfToDocx }) => exportPdfToDocx(doc!, title)).catch(() => toast("DOCX export failed"));
                }}>Word (.docx)</button>
                <button className="btn-ghost btn-sm" disabled={!doc} onClick={() => {
                  setExportDlg(false);
                  void import("./convert").then(({ exportPdfToXlsx }) => exportPdfToXlsx(doc!, title)).catch(() => toast("XLSX export failed"));
                }}>Excel (.xlsx)</button>
                <button className="btn-ghost btn-sm" disabled={!doc} onClick={() => {
                  setExportDlg(false); toast("Rendering slides…");
                  void import("./convert").then(({ exportPdfToPptx }) => exportPdfToPptx(doc!, title)).catch(() => toast("PPTX export failed"));
                }}>Slides (.pptx)</button>
                <button className="btn-ghost btn-sm" disabled={!doc} onClick={() => {
                  setExportDlg(false);
                  void import("./convert").then(({ exportPdfToText }) => exportPdfToText(doc!, title, true)).catch(() => toast("HTML export failed"));
                }}>.html</button>
                <button className="btn-ghost btn-sm" disabled={!doc} onClick={() => {
                  setExportDlg(false);
                  void import("./convert").then(({ exportPdfToText }) => exportPdfToText(doc!, title, false)).catch(() => toast("TXT export failed"));
                }}>.txt</button>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn-ghost btn-sm" onClick={() => setExportDlg(false)}>Cancel</button>
              <button className="btn-primary btn-sm" onClick={() => {
                setExportDlg(false);
                if (!pdfDataRef.current) return;
                void (async () => {
                  try {
                    const rasters = await rasterizeRedacted();
                    const { exportFlattenedPdf } = await flattenMod();
                    await exportFlattenedPdf(pdfDataRef.current!, annDoc.annotations, formValues(), doc, title,
                      { pageNumbers: pdfOpts.pageNumbers, watermark: pdfOpts.watermark || undefined,
                        header: pdfOpts.header || undefined, footer: pdfOpts.footer || undefined,
                        sanitize: pdfOpts.sanitize, optimize: pdfOpts.optimize,
                        bates: pdfOpts.batesPrefix ? { prefix: pdfOpts.batesPrefix, start: pdfOpts.batesStart, digits: 5 } : undefined },
                      annDoc.fields ?? [], rasters, annDoc.ocr);
                    if (rasters) toast("Redacted pages permanently removed");
                  } catch { toast("PDF export failed"); }
                })();
              }}>Export</button>
            </div>
          </div>
        </div>
      )}

      {showKeys && (
        <div className="dlg-back" onClick={() => setShowKeys(false)}>
          <div className="dlg" style={{ width: 400 }} onClick={(e) => e.stopPropagation()}>
            <h3>Keyboard shortcuts</h3>
            <div className="keys-list">
              {[
                ["Ctrl+S", "Save — write changes into the PDF"],
                ["Ctrl+O", "Open a PDF from this computer"],
                ["Ctrl+P", "Print"],
                ["Ctrl+F", "Find in document"],
                ["Ctrl+Z / Ctrl+Y", "Undo / redo"],
                ["Ctrl+scroll", "Zoom at cursor"],
                ["Space+drag", "Pan the page"],
                ["Ctrl+D", "Document properties"],
                ["Ctrl+H", "Read mode — hide toolbars"],
                ["Ctrl+V", "Paste image/text/PDF onto the page"],
                ["Alt+← / Alt+→", "Back / forward through visited views"],
                ["Tab / Shift+Tab", "Cycle through form fields"],
                ["Delete", "Remove selected annotation/field"],
                ["Esc", "Deselect / back to Select tool"],
                ["← → ↑ ↓", "Navigate pages (single/two-page view)"],
                ["?", "Toggle this panel"],
              ].map(([k, d]) => (
                <div key={k} className="keys-row"><kbd>{k}</kbd><span>{d}</span></div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button className="btn-primary btn-sm" onClick={() => setShowKeys(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {readMode && (
        <button className="pdf-readmode-exit" onClick={() => setReadMode(false)}
          title="Exit read mode (Ctrl+H or Esc)">✕ Exit read mode</button>
      )}

      {/* Document Properties */}
      {propsOpen && (
        <div className="dlg-back" onClick={() => setPropsOpen(false)}>
          <div className="dlg" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
            <h3>Document properties</h3>
            <div className="keys-list" style={{ maxHeight: 340, overflowY: "auto" }}>
              {(docProps ?? [{ k: "…", v: "Reading…" }]).map((r) => (
                <div key={r.k} className="keys-row" style={{ alignItems: "baseline" }}>
                  <span style={{ minWidth: 120, color: "var(--muted)", fontSize: 12 }}>{r.k}</span>
                  <span style={{ fontSize: 12, wordBreak: "break-word" }}>{r.v}</span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button className="btn-primary btn-sm" onClick={() => setPropsOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {redactDlg && (
        <div className="dlg-back" onClick={() => { setRedactDlg(false); setRedactScan(null); }}>
          <div className="dlg" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
            <h3>Find &amp; redact</h3>
            <p style={{ fontSize: 12, color: "var(--muted)", margin: "4px 0 12px" }}>
              Scan the document for sensitive patterns, review matches, then mark them all for redaction.
              Marks become permanent on Save or Export.
            </p>
            <select value={redactPat} onChange={(e) => { setRedactPat(e.target.value); setRedactScan(null); }}
              style={{ width: "100%", height: 34, border: "1px solid var(--line)", borderRadius: 8, padding: "0 10px", fontSize: 12, marginBottom: 8, boxSizing: "border-box" }}>
              {Object.entries(REDACT_PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            {redactPat === "custom" && (
              <input value={redactCustom} placeholder="Regular expression, e.g. \bINV-\d+\b" autoFocus
                onChange={(e) => setRedactCustom(e.target.value)}
                style={{ width: "100%", height: 34, border: "1px solid var(--line)", borderRadius: 8, padding: "0 10px", fontSize: 12, marginBottom: 8, boxSizing: "border-box", fontFamily: "monospace" }} />
            )}
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, marginBottom: 10 }}>
              <input type="checkbox" checked={redactCase} onChange={(e) => setRedactCase(e.target.checked)} />
              Match case
            </label>
            {redactScan && (
              <div className="keys-list" style={{ maxHeight: 160, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, padding: 8, marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}>{redactScan.length} match{redactScan.length === 1 ? "" : "es"} found{redactScan.length >= 500 ? " (showing first 500)" : ""}</div>
                {[...new Set(redactScan.map((r) => r.text))].slice(0, 12).map((t) => (
                  <div key={t} style={{ fontSize: 11, color: "var(--ink)", padding: "1px 0", fontFamily: "monospace" }}>{t}</div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn-ghost btn-sm" onClick={() => { setRedactDlg(false); setRedactScan(null); }}>Cancel</button>
              <button className="btn-ghost btn-sm" disabled={redactBusy || !doc} onClick={() => void redactRunScan()}>
                {redactBusy ? "Scanning…" : "Scan document"}
              </button>
              <button className="btn-primary btn-sm" disabled={!redactScan?.length} onClick={redactMarkAll}>
                Mark {redactScan?.length ?? 0} for redaction
              </button>
            </div>
          </div>
        </div>
      )}
      {sigPadOpen && (
        <SignPad initial={sigImg} onDone={(img) => {
          if (img) { setSigImg(img); localStorage.setItem(SIG_KEY, img); }
          else { setSigImg(null); localStorage.removeItem(SIG_KEY); }
          if (img && sigFieldRef.current) { patchField(sigFieldRef.current, { value: img }); sigFieldRef.current = null; }
          setSigPadOpen(false);
          setTool("sign");
        }} onClose={() => setSigPadOpen(false)} />
      )}
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
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
          <canvas ref={cvRef} width={W} height={H} className="sig-pad" role="img" aria-label="Signature pad — draw your signature"
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
      <canvas ref={ref} aria-hidden="true" />
      <span>{page}</span>
    </div>
  );
}

// ---------- a single page: canvas + text layer + form layer + annotation overlay ----------
function PdfPage({ doc, pageNum, scale, anns, selAnn, setSelAnn, tool, toolColor, stampText, sigImg, tbFont, tbSize, canEdit, searchRects, viewRot, dark, ocrWords, onAdd, onMove, onPatch, onZoomTo, onZoomStep, onPickImage, onNeedSig, onInfo, fieldApi, ocgCfg, ocgRev, focusAnn, setFocusAnn, onDelAnn, showAnns = true, showGrid = false, showRulers = false, onSnapshot, markSize = 18, onDigSign }: {
  doc: PDFDocumentProxy;
  pageNum: number;
  scale: number;
  anns: PdfAnn[];
  selAnn: string | null;
  setSelAnn: (id: string | null) => void;
  tool: Tool; toolColor: string; stampText: string; sigImg?: string | null;
  tbFont?: "helv" | "times" | "courier"; tbSize?: number;
  canEdit: boolean;
  viewRot?: number; dark?: boolean;
  ocrWords?: OcrWord[];
  searchRects: Rect4[];
  onAdd: (a: Omit<PdfAnn, "id" | "page" | "createdAt">) => string;
  onMove: (id: string, dx: number, dy: number) => void;
  onPatch: (id: string, p: Partial<PdfAnn>, key?: string) => void;
  focusAnn?: string | null;
  setFocusAnn?: (id: string | null) => void;
  onDelAnn?: (id: string) => void;
  showAnns?: boolean;
  showGrid?: boolean;
  showRulers?: boolean;
  markSize?: number;
  onDigSign?: (x: number, y: number) => void;
  onSnapshot?: (ok: boolean) => void;
  onZoomTo?: (r: { x: number; y: number; w: number; h: number }, el: HTMLElement) => void;
  onZoomStep?: (dir: 1 | -1, cx: number, cy: number) => void;
  onPickImage?: (rect: Rect4) => void;
  onNeedSig?: () => void;
  onInfo?: (msg: string) => void;
  ocgCfg?: { getGroups: () => Record<string, { name?: string }>; setVisibility: (id: string, v: boolean) => void } | null;
  ocgRev?: number;
  fieldApi?: {
    fields: PdfField[]; sel: string | null;
    add: (rect: Rect4, clicked?: boolean) => void;
    select: (id: string | null) => void;
    move: (id: string, dx: number, dy: number) => void;
    patch: (id: string, p: Partial<PdfField>, key?: string) => void;
    del: (id: string) => void;
    checkRadio: (f: PdfField) => void;
    reorder?: (id: string, dir: -1 | 1) => void;
    signField?: (id: string) => void;
  };
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<PDFPageProxy | null>(null);
  // state copy of the loaded page — render reads this; pageRef is only for
  // event handlers / the render effect's fetch cache
  const [pageObj, setPageObj] = useState<PDFPageProxy | null>(null);
  const [near, setNear] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [preview, setPreview] = useState<{ x: number; y: number; w: number; h: number; sx?: number; sy?: number; cx?: number; cy?: number } | null>(null);
  const [penPts, setPenPts] = useState<[number, number][]>([]);
  const [plPts, setPlPts] = useState<[number, number][]>([]);   // in-progress polyline vertices (viewport px)
  const [plCur, setPlCur] = useState<[number, number] | null>(null);
  const [readout, setReadout] = useState<string | null>(null); // measure result badge
  const [loupe, setLoupe] = useState<[number, number] | null>(null); // PDF-11.2
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const loupeBusy = useRef(false);
  const [editText, setEditText] = useState<string | null>(null);
  const [selPop, setSelPop] = useState<{ x: number; y: number; rects: Rect4[]; text: string } | null>(null);
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
        setPageObj(page);
        const vp = page.getViewport({ scale, rotation: (page.rotate + (viewRot ?? 0)) % 360 });
        setSize({ w: vp.width, h: vp.height });
        const key = `${pageNum}:${scale}:${viewRot ?? 0}:${ocgRev ?? 0}:${showAnns ? 1 : 0}`;
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
          optionalContentConfigPromise: ocgCfg ? Promise.resolve(ocgCfg as never) : undefined,
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
          // Suppress annots/fields WE embedded into the file — our own overlay
          // renders them (single render, single editing path). Match by stored
          // ref id first, fall back to rect+type matching.
          const hideIds = new Set<string>();
          const hideRects: { t: number; r: number[] }[] = [];
          for (const a of anns ?? []) {
            if (!a.embedded) continue;
            for (const id of pdfjsIdsOf(a.embedded)) hideIds.add(id);
            const sub = a.type === "sign" || a.type === "image" ? "Stamp" : SUBTYPE[a.type];
            const r = annotRectOf(a);
            const t = sub ? PDFJS_TYPE[sub] : undefined;
            if (r && t !== undefined) hideRects.push({ t, r });
          }
          const embFieldNames = new Set((fieldApi?.fields ?? [])
            .flatMap((f) => f.embedded && f.embedded !== "drawn" ? [f.embedded, ...(f.group ? [f.group] : [])] : []));
          const annotations = (await page.getAnnotations()).filter((ja) => {
            const j = ja as { id?: string; fieldName?: string; annotationType?: number; rect?: number[]; fieldType?: string };
            if (!showAnns && !j.fieldType) return false; // comments hidden — form widgets stay visible
            if (j.fieldName && embFieldNames.has(j.fieldName)) return false;
            if (j.id && hideIds.has(j.id)) return false;
            if (j.rect && j.annotationType !== undefined) {
              for (const h of hideRects) {
                if (h.t === j.annotationType &&
                  Math.abs(j.rect[0] - h.r[0]) < 0.75 && Math.abs(j.rect[1] - h.r[1]) < 0.75 &&
                  Math.abs(j.rect[2] - h.r[2]) < 0.75 && Math.abs(j.rect[3] - h.r[3]) < 0.75) return false;
              }
            }
            return true;
          });
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
  // anns/fieldApi.fields intentionally omitted — the page canvas does not
  // re-rasterize per annotation move; the SVG overlay updates live instead
  }, [doc, pageNum, scale, near, viewRot, ocgRev, ocgCfg, showAnns]); // eslint-disable-line react-hooks/exhaustive-deps

  const vp = () => pageObj?.getViewport({ scale }) ?? null;
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
  const finishPolyline = (pts: [number, number][]) => {
    if (pts.length > 1 && vp())
      onAdd({ type: "polyline", points: pts.map(([x, y]) => vp()!.convertToPdfPoint(x, y) as [number, number]), color: toolColor });
    setPlPts([]); setPlCur(null);
  };
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

  // PDF-11.2 — loupe: render the page magnified, translated so the cursor
  // point lands in the loupe's center. Drops frames while a render is running.
  const LOUPE = 200, MAG = 2.4;
  const renderLoupe = (x: number, y: number) => {
    const pg = pageRef.current, c = loupeRef.current;
    if (!pg || !c || loupeBusy.current) return;
    loupeBusy.current = true;
    const dpr = window.devicePixelRatio || 1;
    c.width = LOUPE * dpr; c.height = LOUPE * dpr;
    c.style.width = `${LOUPE}px`; c.style.height = `${LOUPE}px`;
    const vp2 = pg.getViewport({ scale: scale * MAG, rotation: (pg.rotate + (viewRot ?? 0)) % 360 });
    const k = (LOUPE * dpr) / vp2.width;
    void pg.render({
      canvas: c, viewport: vp2,
      transform: [1, 0, 0, 1, (LOUPE * dpr) / 2 - x * MAG * k, (LOUPE * dpr) / 2 - y * MAG * k],
    }).promise.finally(() => { loupeBusy.current = false; });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!canEdit && tool !== "zoombox" && tool !== "snapshot") return;
    if (tool === "select" || tool === "pan") return;
    const b = boxRef.current!.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;
    if (tool === "loupe") return; // viewing tool — moves only
    if (tool === "polyline") {
      // two consecutive clicks on the same spot (≤6px) finish the path
      const last = plPts[plPts.length - 1];
      if (last && Math.abs(last[0] - x) < 6 && Math.abs(last[1] - y) < 6 && plPts.length > 1) finishPolyline(plPts);
      else { setPlPts((p) => [...p, [x, y]]); setPlCur([x, y]); }
      return;
    }
    // text-markup tools rely on native selection — pointer capture would suppress it
    const isTextMarkup = tool === "highlight" || tool === "underline" || tool === "strikeout" || tool === "squiggly" || tool === "replace";
    if (!isTextMarkup) (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    if (tool === "note") {
      const id = onAdd({ type: "note", points: [toPdf(e.clientX, e.clientY)], color: toolColor, text: "" });
      setSelAnn(id); setEditText(id); // open the note editor immediately, like Acrobat
      return;
    }
    if (tool === "stamp") {
      const [px, py] = toPdf(e.clientX, e.clientY);
      onAdd({ type: "stamp", rects: [[px - 60, py - 14, 120, 28]], text: stampText, color: toolColor });
      return;
    }
    if (tool === "sign") {
      if (!sigImg) { onNeedSig?.(); return; } // no signature yet — reopen the pad instead of a silent no-op
      const [px, py] = toPdf(e.clientX, e.clientY);
      onAdd({ type: "sign", rects: [[px - 80, py - 20, 160, 40]], img: sigImg });
      return;
    }
    if (tool === "caret") {
      const id = onAdd({ type: "caret", points: [toPdf(e.clientX, e.clientY)], color: toolColor, text: "" });
      setSelAnn(id); setEditText(id);
      return;
    }
    if (tool === "check" || tool === "cross") {
      const [px, py] = toPdf(e.clientX, e.clientY);
      const s = markSize;
      onAdd({ type: tool, rects: [[px - s / 2, py - s * 0.44, s, s * 0.88]], color: toolColor === "#FFD23F" ? "#1F9D66" : toolColor });
      return;
    }
    if (tool === "cryptosign") {
      const [px, py] = toPdf(e.clientX, e.clientY);
      onDigSign?.(px, py);
      return;
    }
    dragRef.current = { kind: "draw", sx: x, sy: y, x, y };
    if (tool === "freehand") setPenPts([[x, y]]);
    else setPreview({ x, y, w: 0, h: 0, sx: x, sy: y, cx: x, cy: y }); // zoombox/measure preview via the same rect
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const b = boxRef.current!.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;
    if (tool === "loupe") { setLoupe([x, y]); renderLoupe(x, y); }
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === "move") {
      if (Math.abs(x - d.sx) + Math.abs(y - d.sy) > 1) movedFlag.current = true;
      (d.field ? fieldApi?.move : onMove)?.(d.id, (x - d.sx) / scale, (y - d.sy) / scale); d.sx = x; d.sy = y;
      return;
    }
    d.x = x; d.y = y;
    if (tool === "freehand") setPenPts((p) => [...p, [x, y]]);
    else setPreview({ x: Math.min(d.sx, x), y: Math.min(d.sy, y), w: Math.abs(x - d.sx), h: Math.abs(y - d.sy), sx: d.sx, sy: d.sy, cx: x, cy: y });
  };
  // snapshot tool — render the dragged region at 2× and copy it as PNG
  const doSnapshot = async (r: { x: number; y: number; w: number; h: number }) => {
    const pg = pageRef.current;
    if (!pg || r.w < 2 || r.h < 2) return;
    const SUP = 2;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(r.w * SUP));
    c.height = Math.max(1, Math.round(r.h * SUP));
    const vp2 = pg.getViewport({ scale: scale * SUP, rotation: (pg.rotate + (viewRot ?? 0)) % 360 });
    try {
      await pg.render({ canvas: c, viewport: vp2, transform: [1, 0, 0, 1, -r.x * SUP, -r.y * SUP] }).promise;
    } catch { return; }
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
    if (!blob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      onSnapshot?.(true);
    } catch {
      // clipboard blocked — fall back to a PNG download
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `snapshot-p${pageNum}.png`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      onSnapshot?.(false);
    }
  };

  const onPolylineHover = (e: React.PointerEvent) => {
    if (tool !== "polyline" || !plPts.length) return;
    const b = boxRef.current!.getBoundingClientRect();
    setPlCur([e.clientX - b.left, e.clientY - b.top]);
  };
  const onPointerUp = (e: React.PointerEvent) => {
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
    if (w < 4 && h < 4) {
      // click, not drag — several tools have a useful click action
      const [px, py] = vp()!.convertToPdfPoint(d.sx, d.sy) as [number, number];
      if (tool === "textbox") {
        const sz = tbSize ?? 9;
        const bh = sz * 1.9;
        const pw = vp()!.width / scale;
        const id = onAdd({ type: "textbox", rects: [[px, py - bh, Math.max(30, Math.min(200, pw - px - 6)), bh]],
          color: toolColor, text: "", font: tbFont ?? "helv", fontSize: sz });
        setSelAnn(id); setFocusAnn?.(id);
      } else if (tool === "edittext") {
        void editLineAt(px, py).then((hit) => { if (!hit) onInfo?.("No editable text at that point"); });
      } else if (tool === "zoombox") {
        onZoomStep?.(e.altKey ? -1 : 1, e.clientX, e.clientY); // Acrobat: click = step zoom at point
      } else if (tool === "image") {
        onPickImage?.([px - 70, py - 50, 140, 100]); // click = default-size image
      } else if (tool === "field") {
        fieldApi?.add([px, py, 140, 22], true); // click = default-size field, sized per kind
      } else if (tool === "rect") {
        onAdd({ type: "rect", rects: [[px - 40, py - 25, 80, 50]], color: toolColor });
      } else if (tool === "ellipse") {
        onAdd({ type: "ellipse", rects: [[px - 40, py - 25, 80, 50]], color: toolColor });
      } else if (tool === "callout") {
        const id = onAdd({ type: "callout", rects: [[px, py - 46, 140, 36]], points: [[px, py]], color: toolColor, text: "" });
        setSelAnn(id); setFocusAnn?.(id);
      } else if (tool === "cloud") {
        onAdd({ type: "cloud", rects: [[px - 40, py - 25, 80, 50]], color: toolColor });
      } else if (tool === "whiteout") {
        onAdd({ type: "whiteout", rects: [[px - 40, py - 10, 80, 20]] });
      } else if (tool === "redact") {
        onAdd({ type: "redact", rects: [[px - 40, py - 10, 80, 20]] });
      }
      return;
    }
    if (tool === "zoombox") { onZoomTo?.(preview, boxRef.current!); return; }
    if (tool === "snapshot") { void doSnapshot({ x, y, w, h }); return; }
    if (tool === "measure") {
      const pt = Math.hypot(d.x - d.sx, d.y - d.sy) / scale;
      setReadout(`${pt.toFixed(1)} pt · ${(pt / 72).toFixed(2)} in · ${(pt / 72 * 2.54).toFixed(2)} cm`);
      return;
    }
    // text-markup tools: let onMouseUp handle a real text selection instead
    if (tool === "highlight" || tool === "underline" || tool === "strikeout" || tool === "squiggly" || tool === "replace") {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
    }
    const [px0, py0] = vp()!.convertToPdfPoint(x, y) as [number, number];
    const [px1, py1] = vp()!.convertToPdfPoint(x + w, y + h) as [number, number];
    const rect: Rect4 = [Math.min(px0, px1), Math.min(py0, py1), Math.abs(px1 - px0), Math.abs(py1 - py0)];
    if (tool === "callout") {
      // tail tip = the point you dragged from; box sits where you released
      const [tx, ty] = vp()!.convertToPdfPoint(d.sx, d.sy) as [number, number];
      const id = onAdd({ type: "callout", rects: [rect], points: [[tx, ty]], color: toolColor, text: "" });
      setSelAnn(id); setFocusAnn?.(id);
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
      const id = onAdd({ type: tool as AnnType, rects: [rect], color: toolColor,
        text: tool === "textbox" ? "" : undefined,
        font: tool === "textbox" ? (tbFont ?? "helv") : undefined, fontSize: tool === "textbox" ? (tbSize ?? 9) : undefined });
      if (tool === "textbox") { setSelAnn(id); setFocusAnn?.(id); }
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
    const id = onAdd({ type: "textbox", rects: [rect], color: "var(--ink)", text });
    setSelAnn(id); setFocusAnn?.(id);
  };

  // edit-text on a bare click: find the text item under the point, expand to
  // its line, then run the same whiteout+retype flow as a dragged rectangle
  const editLineAt = async (px: number, py: number): Promise<boolean> => {
    const pg = pageRef.current;
    if (!pg) return false;
    try {
      const tc = await pg.getTextContent();
      const vp1 = pg.getViewport({ scale: 1 });
      const items: { x: number; y: number; w: number; h: number }[] = [];
      for (const it of tc.items) {
        if (!("str" in it) || !it.str.trim() || !("transform" in it)) continue;
        const tx = pdfjs.Util.transform(vp1.transform, it.transform);
        const fh = Math.max(2, Math.hypot(tx[2], tx[3]));
        const [ix, iy] = vp1.convertToPdfPoint(tx[4], tx[5]); // baseline origin
        items.push({ x: ix, y: iy, w: it.width, h: fh });
      }
      const hit = items.find((i) => px >= i.x - 1 && px <= i.x + i.w + 1 && py >= i.y - i.h * 0.3 && py <= i.y + i.h);
      if (!hit) return false;
      const row = items.filter((i) => Math.abs(i.y - hit.y) < Math.max(2, hit.h * 0.35));
      const x0 = Math.min(...row.map((i) => i.x));
      const x1 = Math.max(...row.map((i) => i.x + i.w));
      const y0 = Math.min(...row.map((i) => i.y - i.h * 0.3));
      const y1 = Math.max(...row.map((i) => i.y + i.h));
      await editTextAt([x0 - 1, y0 - 1, x1 - x0 + 2, y1 - y0 + 2]);
      return true;
    } catch { return false; /* no text under point */ }
  };

  // text-selection → highlight/underline/strikeout
  const onMouseUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { setSelPop(null); return; }
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
    if (!rects.length) { setSelPop(null); return; }
    if (canEdit && (tool === "highlight" || tool === "underline" || tool === "strikeout" || tool === "squiggly" || tool === "replace")) {
      const id = onAdd({ type: tool, rects, color: toolColor, text: tool === "replace" ? "" : undefined });
      if (tool === "replace") { setSelAnn(id); setEditText(id); } // open the suggestion box right away
      sel.removeAllRanges();
      return;
    }
    // select tool → floating markup popup over the selection
    if (tool === "select") {
      const r0 = sel.getRangeAt(0).getClientRects()[0];
      if (r0) setSelPop({
        x: Math.max(4, Math.min(r0.left - b.left, b.width - 220)),
        y: Math.max(2, r0.top - b.top - 40),
        rects, text: sel.toString(),
      });
    }
  };
  const applySelMarkup = (type: "highlight" | "underline" | "strikeout" | "squiggly") => {
    if (!selPop) return;
    onAdd({ type, rects: selPop.rects, color: toolColor });
    window.getSelection()?.removeAllRanges();
    setSelPop(null);
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
      data-tool={tool}
      style={{ width: size.w || undefined, height: size.h || undefined }}
      onPointerDown={(e) => { setSelPop(null); onPointerDown(e); }} onPointerMove={(e) => { onPointerMove(e); onPolylineHover(e); }} onPointerUp={onPointerUp} onMouseUp={onMouseUp}
      onPointerLeave={() => setLoupe(null)}
      onDoubleClick={() => { if (tool === "polyline" && plPts.length > 1) finishPolyline(plPts.slice(0, -1)); }}>
      <canvas ref={canvasRef} className={`pdf-canvas ${dark ? "dark" : ""}`} role="img" aria-label={`PDF page ${pageNum}`} />
      <div ref={textRef} />
      <div ref={formRef} />
      {/* View ▸ Rulers — inch rulers hanging off the page edges, scale-aware */}
      {showRulers && v && size.w > 0 && (() => {
        const inch = 72 * scale;
        const every = inch >= 48 ? 1 : inch >= 24 ? 2 : inch >= 12 ? 4 : 8;
        const hx: React.ReactNode[] = [], vy: React.ReactNode[] = [];
        for (let i = 0; ; i++) {
          let stop = true;
          for (let q = 0; q < 4; q++) {
            const x = (i + q / 4) * inch;
            if (x <= size.w) { stop = false; hx.push(<line key={`h${i}.${q}`} x1={x} y1={q === 0 ? 3 : 10} x2={x} y2={15} stroke="#8a8378" strokeWidth={0.6} />); }
          }
          if (i % every === 0 && i * inch <= size.w) hx.push(<text key={`hl${i}`} x={i * inch + 2} y={8} fontSize={7} fill="#6b6459">{i}</text>);
          if (stop) break;
        }
        for (let i = 0; ; i++) {
          let stop = true;
          for (let q = 0; q < 4; q++) {
            const y = (i + q / 4) * inch;
            if (y <= size.h) { stop = false; vy.push(<line key={`v${i}.${q}`} x1={q === 0 ? 3 : 10} y1={y} x2={15} y2={y} stroke="#8a8378" strokeWidth={0.6} />); }
          }
          if (i % every === 0 && i * inch <= size.h) vy.push(<text key={`vl${i}`} x={9} y={i * inch - 2} fontSize={7} fill="#6b6459" transform={`rotate(-90 9 ${i * inch - 2})`}>{i}</text>);
          if (stop) break;
        }
        return (<>
          <div className="pdf-ruler pdf-ruler-h" style={{ top: -16, left: 0, width: size.w, height: 16 }}>
            <svg width={size.w} height={16}>{hx}</svg>
          </div>
          <div className="pdf-ruler pdf-ruler-v" style={{ top: 0, left: -16, width: 16, height: size.h }}>
            <svg width={16} height={size.h}>{vy}</svg>
          </div>
          <div className="pdf-ruler pdf-ruler-c" style={{ top: -16, left: -16, width: 16, height: 16 }} />
        </>);
      })()}
      {/* PDF-8.3 — OCR words: invisible but selectable/copyable over scans */}
      {v && ocrWords?.map((w, i) => {
        const [x, y, w2, h2] = vpRect([w.x, w.y, w.w, w.h]);
        return <span key={`oc${i}`} className="pdf-ocrw"
          style={{ left: x, top: y, width: w2, height: h2, fontSize: h2 }}>{w.text}</span>;
      })}
      {/* search match flashes */}
      {v && searchRects.map((r, i) => {
        const [x, y, w2, h2] = vpRect(r);
        return <div key={`m${i}`} className="pdf-searchmark" style={{ left: x, top: y, width: w2, height: h2 }} />;
      })}
      {/* floating markup toolbar on text selection */}
      {selPop && (
        <div className="sel-pop" style={{ left: selPop.x, top: selPop.y }}
          onPointerDown={(e) => e.stopPropagation()} onMouseUp={(e) => e.stopPropagation()}>
          {canEdit && (<>
            <button title="Highlight" onClick={() => applySelMarkup("highlight")}><span style={{ background: toolColor, padding: "0 3px", borderRadius: 2 }}>H</span></button>
            <button title="Underline" onClick={() => applySelMarkup("underline")}><u>U</u></button>
            <button title="Strikeout" onClick={() => applySelMarkup("strikeout")}><s>S</s></button>
            <button title="Squiggly" onClick={() => applySelMarkup("squiggly")}>~</button>
          </>)}
          <button title="Copy" onClick={() => { void navigator.clipboard?.writeText(selPop.text); window.getSelection()?.removeAllRanges(); setSelPop(null); }}>⧉</button>
        </div>
      )}
      {/* annotation overlay */}
      {v && (
        <svg className="ann-layer" width={size.w} height={size.h} style={{ pointerEvents: "none" }}>
          {/* View ▸ Grid — 1in major lines, ¼in minor */}
          {showGrid && (() => {
            const inch = 72 * scale;
            const minor = inch / 4;
            const lines: React.ReactNode[] = [];
            for (let x = 0; x <= size.w + minor; x += minor) lines.push(
              <line key={`gv${x}`} x1={x} y1={0} x2={x} y2={size.h} stroke={x % inch < 1 ? "rgba(80,110,180,.45)" : "rgba(80,110,180,.18)"} strokeWidth={x % inch < 1 ? 1 : 0.5} />);
            for (let y = 0; y <= size.h + minor; y += minor) lines.push(
              <line key={`gh${y}`} x1={0} y1={y} x2={size.w} y2={y} stroke={y % inch < 1 ? "rgba(80,110,180,.45)" : "rgba(80,110,180,.18)"} strokeWidth={y % inch < 1 ? 1 : 0.5} />);
            return <g>{lines}</g>;
          })()}
          {penPts.length > 1 && (
            <polyline points={penPts.map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke={toolColor} strokeWidth={2.2} strokeLinecap="round" />
          )}
          {plPts.length > 0 && (
            <polyline points={[...plPts, ...(plCur ? [plCur] : [])].map(([x, y]) => `${x},${y}`).join(" ")}
              fill="none" stroke={toolColor} strokeWidth={2} strokeLinecap="round" strokeDasharray={plCur ? "0" : undefined} />
          )}
          {plPts.map(([x, y], i) => <circle key={`plv${i}`} cx={x} cy={y} r={2.4} fill={toolColor} />)}
          {preview && tool === "measure" && preview.sx != null && (() => {
            const pt = Math.hypot(preview.cx! - preview.sx!, preview.cy! - preview.sy!) / scale;
            return (
              <g>
                <line x1={preview.sx} y1={preview.sy} x2={preview.cx} y2={preview.cy} stroke="#3578E5" strokeWidth={1.5} strokeDasharray="5 3" />
                <circle cx={preview.sx} cy={preview.sy} r={3} fill="#3578E5" /><circle cx={preview.cx} cy={preview.cy} r={3} fill="#3578E5" />
                <text x={(preview.sx! + preview.cx!) / 2} y={(preview.sy! + preview.cy!) / 2 - 6} textAnchor="middle" fontSize={11} fill="#3578E5"
                  style={{ paintOrder: "stroke", stroke: "#fff", strokeWidth: 3 }}>{pt.toFixed(1)} pt</text>
              </g>
            );
          })()}
          {preview && tool !== "measure" && (
            <rect x={preview.x} y={preview.y} width={preview.w} height={preview.h}
              fill={tool === "highlight" ? toolColor : "none"} fillOpacity={tool === "highlight" ? 0.35 : 0}
              stroke={toolColor} strokeWidth={1.5} strokeDasharray="4 3" />
          )}
          {showAnns && anns.map((a) => (
            <AnnSvg key={a.id} a={a} vpRect={vpRect} toVp={toVp} scale={scale}
              selected={selAnn === a.id} selectable={tool === "select" && canEdit}
              onDown={(e) => startMove(e, a)} />
          ))}
        </svg>
      )}
      {readout && <div className="pdf-measure">📏 {readout}</div>}
      {loupe && tool === "loupe" && (
        <div className="pdf-loupe" style={{ left: loupe[0] + 16, top: loupe[1] + 16, width: LOUPE, height: LOUPE }}>
          <canvas ref={loupeRef} aria-hidden="true" />
        </div>
      )}
      {/* html-rendered anns: notes, textboxes, stamps */}
      {v && showAnns && anns.filter((a) => a.type === "note" || a.type === "textbox" || a.type === "stamp" || a.type === "sign" || a.type === "callout" || a.type === "image" || a.type === "caret" || a.type === "replace" || a.type === "check" || a.type === "cross").map((a) => {
        const sel = selAnn === a.id;
        if (a.type === "check" || a.type === "cross") {
          const [x, y, w2, h2] = vpRect(a.rects![0]);
          return (
            <div key={a.id} className={`ann-mark ${sel ? "sel" : ""}`}
              style={{ left: x, top: y, width: w2, height: h2, fontSize: Math.max(12, h2), color: a.color }}
              onPointerDown={(e) => startMove(e, a)}>{a.type === "check" ? "✔" : "✖"}</div>
          );
        }
        if (a.type === "caret") {
          const [x, y] = toVp(a.points?.[0]?.[0] ?? 0, a.points?.[0]?.[1] ?? 0);
          return (
            <div key={a.id} className={`ann-caret ${sel ? "sel" : ""}`}
              style={{ left: x - 5, top: y - 8 }}
              onPointerDown={(e) => startMove(e, a)}
              onClick={() => { if (!movedFlag.current) setEditText(a.id); }}>⌃
              {editText === a.id && (
                <div className="ann-pop" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
                  <textarea autoFocus value={a.text ?? ""} placeholder="Text to insert here…"
                    onChange={(e) => onPatch(a.id, { text: e.target.value }, `caret:${a.id}`)} />
                  <button className="btn-ghost btn-sm" onClick={() => setEditText(null)}>Done</button>
                </div>
              )}
            </div>
          );
        }
        if (a.type === "replace") {
          const [x, y, w2] = vpRect(a.rects![0]);
          return (
            <div key={a.id} className={`ann-caret ${sel ? "sel" : ""}`}
              style={{ left: x + w2 - 4, top: y - 8 }}
              onPointerDown={(e) => startMove(e, a)}
              onClick={() => { if (!movedFlag.current) setEditText(a.id); }}>⇒
              {editText === a.id && (
                <div className="ann-pop" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
                  <textarea autoFocus value={a.text ?? ""} placeholder="Replacement text…"
                    onChange={(e) => onPatch(a.id, { text: e.target.value }, `rep:${a.id}`)} />
                  <button className="btn-ghost btn-sm" onClick={() => setEditText(null)}>Done</button>
                </div>
              )}
            </div>
          );
        }
        if (a.type === "callout") {
          const [x, y, w2, h2] = vpRect(a.rects![0]);
          return (
            <div key={a.id} className={`ann-callout ${sel ? "sel" : ""}`}
              ref={(el) => { if (el && a.id === focusAnn && !el.dataset.focused) { el.dataset.focused = "1"; el.focus(); setFocusAnn?.(null); } }}
              style={{ left: x, top: y, width: w2, minHeight: h2, borderColor: a.color === "#FFD23F" ? "#F2782E" : a.color }}
              contentEditable={canEdit && sel && (tool === "select" || tool === "callout")} suppressContentEditableWarning
              onPointerDown={(e) => {
                if (tool === "callout") { e.stopPropagation(); setSelAnn(a.id); return; } // edit this one, don't start another
                if (tool === "select" && !sel) startMove(e, a);
              }}
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
        const fontCss = { helv: "Helvetica,Arial,sans-serif", times: "Georgia,'Times New Roman',serif", courier: "'Courier New',monospace" }[a.font ?? "helv"];
        return (
          <div key={a.id} className={`ann-textbox ${sel ? "sel" : ""}`}
            ref={(el) => { if (el && a.id === focusAnn && !el.dataset.focused) { el.dataset.focused = "1"; el.focus(); setFocusAnn?.(null); } }}
            style={{ left: x, top: y, width: w2, minHeight: h2, color: a.color === "#FFD23F" ? "#171717" : a.color,
              fontFamily: fontCss, fontSize: (a.fontSize ?? 9) * scale }}
            contentEditable={canEdit && (tool === "textbox" || (tool === "select" && sel))} suppressContentEditableWarning
            onPointerDown={(e) => {
              if (tool === "textbox") { e.stopPropagation(); setSelAnn(a.id); return; } // edit this box, don't stack a new one
              if (tool === "select" && !sel) startMove(e, a);
            }}
            onBlur={(e) => { const t = (e.target as HTMLElement).innerText; if (!t.trim()) { onDelAnn?.(a.id); if (selAnn === a.id) setSelAnn(null); } else onPatch(a.id, { text: t }, `tb:${a.id}`); }}>{a.text}</div>
        );
      })}
      {/* PDF-6 — authored form fields */}
      {v && (fieldApi?.fields ?? []).filter((f) => f.embedded !== "drawn").map((f) => {
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
            return shell(<input className="pdf-field-in" value={String(f.value ?? f.defaultValue ?? "")}
              pattern={f.pattern} title={f.pattern ? `Must match: ${f.pattern}` : undefined}
              maxLength={f.comb}
              style={f.comb ? { letterSpacing: `${Math.max(0, w2 / f.comb - 8)}px` } : undefined}
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
              onFocus={() => fieldApi?.select(f.id)}
              onChange={(e) => fieldApi?.patch(f.id, { value: e.target.value }, `fv:${f.id}`)} />);
          case "checkbox":
            return shell(<span className="pdf-field-check" tabIndex={0} role="checkbox" aria-checked={!!f.value}
              onClick={(e) => { e.stopPropagation(); fieldApi?.patch(f.id, { value: !f.value }); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); fieldApi?.patch(f.id, { value: !f.value }); } }}
              onFocus={() => fieldApi?.select(f.id)}>
              {f.value ? "✔" : ""}</span>);
          case "radio":
            return shell(<span className={`pdf-field-radio ${f.value ? "on" : ""}`} tabIndex={0} role="radio" aria-checked={!!f.value}
              onClick={(e) => { e.stopPropagation(); fieldApi?.checkRadio(f); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); fieldApi?.checkRadio(f); } }}
              onFocus={() => fieldApi?.select(f.id)} />);
          case "dropdown":
            return shell(<select className="pdf-field-in" value={String(f.value ?? "")}
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
              onFocus={() => fieldApi?.select(f.id)}
              onChange={(e) => fieldApi?.patch(f.id, { value: e.target.value })}>
              <option value=""></option>
              {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>);
          case "list":
            return shell(<select className="pdf-field-in" multiple value={String(f.value ?? "").split("\n").filter(Boolean)}
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
              onFocus={() => fieldApi?.select(f.id)}
              onChange={(e) => fieldApi?.patch(f.id, { value: [...e.target.selectedOptions].map((o) => o.value).join("\n") })}>
              {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>);
          case "signature":
            return shell(<div className="pdf-field-sign" title="Click to sign" tabIndex={0} role="button"
              onClick={(e) => { e.stopPropagation(); fieldApi?.signField?.(f.id); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); fieldApi?.signField?.(f.id); } }}
              onFocus={() => fieldApi?.select(f.id)}>
              {f.value ? <img src={String(f.value)} alt="signature" draggable={false} /> : "✍ Sign here"}
            </div>);
          case "barcode":
            return shell(<div className="pdf-field-barcode" title={String(f.value ?? "")} tabIndex={0}
              onFocus={() => fieldApi?.select(f.id)}
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
              {[...String(f.value ?? "")].map((c, i) => (
                <span key={i} style={{ width: (c.charCodeAt(0) % 3) + 1, background: "#111", marginRight: i % 2 ? 1 : 2 }} />
              ))}
              {!f.value && <span className="pdf-field-barcode-ph">barcode</span>}
            </div>);
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
              <option value="signature">signature</option><option value="barcode">barcode</option>
            </select>
            {(f.kind === "dropdown" || f.kind === "list") && (
              <input value={(f.options ?? []).join(", ")} title="Options (comma-separated)" placeholder="a, b, c"
                onChange={(e) => fieldApi.patch(f.id, { options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) }, `fo:${f.id}`)} />
            )}
            {f.kind === "radio" && (
              <input value={f.group ?? ""} title="Radio group" placeholder="group"
                onChange={(e) => fieldApi.patch(f.id, { group: e.target.value }, `fg:${f.id}`)} />
            )}
            {f.kind === "text" && (
              <>
                <input value={f.pattern ?? ""} title="Validation regex (e.g. ^\\d+$)" placeholder="regex"
                  onChange={(e) => fieldApi.patch(f.id, { pattern: e.target.value || undefined }, `fp:${f.id}`)} />
                <input value={f.calc ?? ""} title="Calculation (sum:name1,name2)" placeholder="sum:a,b"
                  onChange={(e) => fieldApi.patch(f.id, { calc: e.target.value || undefined }, `fc:${f.id}`)} />
                <input value={f.defaultValue ?? ""} title="Default value" placeholder="default"
                  onChange={(e) => fieldApi.patch(f.id, { defaultValue: e.target.value || undefined }, `fd:${f.id}`)} />
                <input type="number" min={0} value={f.comb ?? ""} title="Comb field — N evenly-spaced char boxes" placeholder="comb n"
                  onChange={(e) => fieldApi.patch(f.id, { comb: Number(e.target.value) || undefined }, `fm:${f.id}`)} />
              </>
            )}
            <span style={{ display: "flex", gap: 2, alignItems: "center" }} title="Tab order (array order on export)">
              <button className="btn-ghost btn-sm" disabled={fieldApi.fields.indexOf(f) === 0}
                onClick={() => fieldApi.reorder?.(f.id, -1)}>↑</button>
              <button className="btn-ghost btn-sm" disabled={fieldApi.fields.indexOf(f) === fieldApi.fields.length - 1}
                onClick={() => fieldApi.reorder?.(f.id, 1)}>↓</button>
            </span>
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
    case "replace": // proofing mark — strikethrough means "replace this"
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
    case "redact": {
      return <g>{(a.rects ?? []).map((rr, i) => {
        const [x, y, w, h] = vpRect(rr);
        return <rect key={i} x={x} y={y} width={w} height={h} fill="#171717" stroke="#d33" strokeWidth={1} strokeDasharray="4 3"
          style={{ ...pe, ...selOutline }} onPointerDown={onDown} />;
      })}</g>;
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
          } else if (a.type === "replace") {
            for (const r of a.rects ?? []) {
              const [x, y, w, h] = vpR(r);
              const el = document.createElementNS(svgNS, "line");
              el.setAttribute("x1", `${x}`); el.setAttribute("y1", `${y + h / 2}`);
              el.setAttribute("x2", `${x + w}`); el.setAttribute("y2", `${y + h / 2}`);
              el.setAttribute("stroke", c); el.setAttribute("stroke-width", "1.6");
              svg.appendChild(el);
            }
            if (a.text && a.rects?.length) {
              const last = a.rects[a.rects.length - 1];
              const [x, y, w, h] = vpR(last);
              const t = document.createElementNS(svgNS, "text");
              t.setAttribute("x", `${x + w + 3}`); t.setAttribute("y", `${y + h / 2 + 3}`);
              t.setAttribute("fill", c); t.setAttribute("font-size", "9");
              t.textContent = `→ ${a.text.slice(0, 40)}`;
              svg.appendChild(t);
            }
          } else if (a.type === "caret") {
            const [x, y] = toVp(a.points?.[0]?.[0] ?? 0, a.points?.[0]?.[1] ?? 0);
            const t = document.createElementNS(svgNS, "text");
            t.setAttribute("x", `${x - 3}`); t.setAttribute("y", `${y + 8}`);
            t.setAttribute("fill", c); t.setAttribute("font-size", "12"); t.setAttribute("font-weight", "700");
            t.textContent = "⌃";
            svg.appendChild(t);
            if (a.text) {
              const n = document.createElementNS(svgNS, "text");
              n.setAttribute("x", `${x + 6}`); n.setAttribute("y", `${y + 8}`);
              n.setAttribute("fill", "#595550"); n.setAttribute("font-size", "8");
              n.textContent = `insert: ${a.text.slice(0, 50)}`;
              svg.appendChild(n);
            }
          } else if (a.type === "check" || a.type === "cross") {
            const [x, y, , h] = vpR(a.rects![0]);
            const t = document.createElementNS(svgNS, "text");
            t.setAttribute("x", `${x}`); t.setAttribute("y", `${y + h - 2}`);
            t.setAttribute("fill", c); t.setAttribute("font-size", `${Math.max(10, h)}`); t.setAttribute("font-weight", "700");
            t.textContent = a.type === "check" ? "✔" : "✖";
            svg.appendChild(t);
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
          } else if ((a.type === "whiteout" || a.type === "redact") && a.rects?.length) {
            for (const rr of a.rects) {
              const [x, y, w, h] = vpR(rr);
              const el = document.createElementNS(svgNS, "rect");
              el.setAttribute("x", `${x}`); el.setAttribute("y", `${y}`); el.setAttribute("width", `${w}`); el.setAttribute("height", `${h}`);
              el.setAttribute("fill", a.type === "whiteout" ? "#fff" : "#171717");
              svg.appendChild(el);
            }
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
          if (f.kind === "signature" && f.value) {
            const im = document.createElementNS(svgNS, "image");
            im.setAttribute("x", `${x}`); im.setAttribute("y", `${y}`);
            im.setAttribute("width", `${w}`); im.setAttribute("height", `${h}`);
            im.setAttribute("preserveAspectRatio", "xMidYMid meet");
            im.setAttribute("href", String(f.value));
            svg.appendChild(im);
          }
          if (f.kind === "barcode" && f.value) {
            let bx2 = x + 2;
            for (const c of String(f.value)) {
              const bw = (c.charCodeAt(0) % 3) + 1;
              if (bx2 + bw > x + w - 2) break;
              const bar = document.createElementNS(svgNS, "rect");
              bar.setAttribute("x", `${bx2}`); bar.setAttribute("y", `${y + 2}`);
              bar.setAttribute("width", `${bw}`); bar.setAttribute("height", `${h - 6}`); bar.setAttribute("fill", "#111");
              svg.appendChild(bar);
              bx2 += bw + 1.5;
            }
          }
          const val = f.kind === "checkbox" ? (f.value ? "✔" : "") : f.kind === "radio" ? (f.value ? "●" : "")
            : f.kind === "signature" || f.kind === "barcode" ? "" : String(f.value ?? "");
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
  note: "💬", textbox: "T", stamp: "◈", sign: "✍", image: "🖼", whiteout: "▨",
  redact: "▮", caret: "⌃", replace: "⌁", check: "✔", cross: "✖",
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
            <div key={i} className="pdf-annreply"><b>{r.by}</b>{" "}
              {/* PDF-12.3 — @mentions render as highlighted chips */}
              {r.text.split(/(@[\w.-]+)/g).map((t, j) =>
                t.startsWith("@") ? <span key={j} className="pdf-mention">{t}</span> : t)}
            </div>
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

// ---------- PDF-11.3: reflow page — extracted text as a readable column ----------
function ReflowPage({ doc, pageNum, dark }: { doc: PDFDocumentProxy; pageNum: number; dark?: boolean }) {
  const [lines, setLines] = useState<{ text: string; h: number }[] | null>(null);
  useEffect(() => {
    let dead = false;
    void doc.getPage(pageNum).then(async (pg) => {
      const tc = await pg.getTextContent();
      const buckets = new Map<number, { x: number; s: string; h: number }[]>();
      for (const it of tc.items as { str?: string; transform?: number[] }[]) {
        if (!it.str?.trim() || !it.transform) continue;
        const y = Math.round(it.transform[5]);
        const key = [...buckets.keys()].find((k) => Math.abs(k - y) < 2.5) ?? y;
        const arr = buckets.get(key) ?? [];
        arr.push({ x: it.transform[4], s: it.str, h: Math.hypot(it.transform[2], it.transform[3]) });
        buckets.set(key, arr);
      }
      if (dead) return;
      setLines([...buckets.entries()].sort((a, b) => b[0] - a[0]).map(([, items]) => {
        items.sort((a, b) => a.x - b.x);
        return { text: items.map((i) => i.s).join(" "), h: Math.max(...items.map((i) => i.h)) };
      }));
    }).catch(() => setLines([]));
    return () => { dead = true; };
  }, [doc, pageNum]);
  return (
    <div className={`pdf-reflowpage ${dark ? "dark" : ""}`} data-page={pageNum}>
      <div className="pdf-reflowpage-no">— page {pageNum} —</div>
      {lines === null && <div className="empty">…</div>}
      {(lines ?? []).map((l, i) => (
        <p key={i} style={{ fontSize: Math.min(22, Math.max(11, l.h * 0.85)), fontWeight: l.h > 14 ? 700 : 400 }}>{l.text}</p>
      ))}
      {lines?.length === 0 && <div className="empty">No extractable text on this page</div>}
    </div>
  );
}
