import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type * as pdfjsTypes from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import type { DriveItem, Comment } from "@kreatix/shared";
import { api } from "../lib/api";
import { ShareDialog } from "../components/ShareDialog";
import { VersionsPanel } from "../components/VersionsPanel";
import { CommentsPanel } from "../components/CommentsPanel";
import { useToast } from "../pages/Home";
import type { PdfAnn, PdfDoc, AnnType } from "./model";
import { emptyPdfDoc, STAMPS } from "./model";
const flattenMod = () => import("./flatten");

// pdf.js is heavy (~430KB) — lazy-loaded only when a PDF is actually opened
let pdfjs!: typeof pdfjsTypes;
let pdfjsReady: Promise<void> | null = null;
const ensurePdfjs = () => (pdfjsReady ??= import("pdfjs-dist").then((m) => {
  pdfjs = m;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
}));

type SaveState = "saved" | "saving" | "unsaved" | "error";
type Tool = "select" | AnnType | "pan";
type Panel = "none" | "thumbs" | "outline" | "search" | "comments" | "versions";
type Rect4 = [number, number, number, number];

const TOOLS: { id: Tool; ico: string; label: string }[] = [
  { id: "select", ico: "➤", label: "Select / move annotations" },
  { id: "highlight", ico: "🖍", label: "Highlight text (select text, or drag a region)" },
  { id: "underline", ico: "U̲", label: "Underline text" },
  { id: "strikeout", ico: "S̶", label: "Strikeout text" },
  { id: "freehand", ico: "✏", label: "Freehand draw" },
  { id: "rect", ico: "▭", label: "Rectangle" },
  { id: "ellipse", ico: "◯", label: "Ellipse" },
  { id: "line", ico: "╱", label: "Line" },
  { id: "arrow", ico: "↗", label: "Arrow" },
  { id: "note", ico: "💬", label: "Sticky note" },
  { id: "textbox", ico: "T", label: "Text box" },
  { id: "stamp", ico: "✅", label: "Stamp" },
];
const MARKUP_COLORS = ["#FFD23F", "#F2782E", "#D84B57", "#1F9D66", "#3578E5", "#8E6BC8"];
const MARKUP_TOOLS = new Set<Tool>(["highlight", "underline", "strikeout", "freehand", "rect", "ellipse", "line", "arrow", "note", "textbox", "stamp"]);

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
  const [selAnn, setSelAnn] = useState<string | null>(null);
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  const [printing, setPrinting] = useState(false);

  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [matches, setMatches] = useState<{ page: number; snippet: string; rects: Rect4[] }[]>([]);
  const [matchIdx, setMatchIdx] = useState(-1);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoStack = useRef<PdfDoc[]>([]);
  const redoStack = useRef<PdfDoc[]>([]);
  const lastAction = useRef<string | null>(null);
  const pdfDataRef = useRef<ArrayBuffer | null>(null);
  const [pwPrompt, setPwPrompt] = useState<{ wrong: boolean } | null>(null);
  const [pwValue, setPwValue] = useState("");
  const pwCbRef = useRef<((pw: string) => void) | null>(null);
  const loadTaskRef = useRef<{ destroy: () => void } | null>(null);

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
    try {
      const form = formValues();
      await api.put(`/api/files/${item.id}/content`, {
        content: { ...annDoc, form: Object.keys(form).length ? form : annDoc.form },
      });
      setSaveState("saved");
    } catch { setSaveState("error"); }
  }, [annDoc, formValues, item.id]);

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
        undoStack.current.push(prev);
        if (undoStack.current.length > 80) undoStack.current.shift();
        lastAction.current = actionKey ?? null;
      }
      redoStack.current = [];
      return next;
    });
    scheduleSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    lastAction.current = null;
    redoStack.current.push(annDoc);
    setAnnDoc(prev); scheduleSave();
  }, [annDoc]); // eslint-disable-line react-hooks/exhaustive-deps
  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    lastAction.current = null;
    undoStack.current.push(annDoc);
    setAnnDoc(next); scheduleSave();
  }, [annDoc]); // eslint-disable-line react-hooks/exhaustive-deps

  const addAnn = (page: number, a: Omit<PdfAnn, "id" | "page" | "createdAt">) => {
    mutate((d) => d.annotations.push({ ...a, id: crypto.randomUUID().slice(0, 8), page, createdAt: new Date().toISOString() }));
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
    pageRefs.current.get(p)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setCurPage(p);
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
      else if (e.key === "Escape") setSelAnn(null);
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
        <button className="btn-ghost btn-sm" onClick={() => setSharing(true)}>Share</button>
        <button className="btn-ghost btn-sm" disabled={!pdfDataRef.current}
          onClick={() => {
            if (!pdfDataRef.current) return;
            flattenMod()
              .then(({ exportFlattenedPdf }) => exportFlattenedPdf(pdfDataRef.current!, annDoc.annotations, formValues(), doc, title))
              .catch(() => toast("PDF export failed"));
          }}>Export PDF</button>
        <button className="btn-ghost btn-sm" onClick={() => setPrinting(true)}>Print</button>
      </div>

      <div className="ribbon">
        <button className={`rb ${panel === "thumbs" ? "on" : ""}`} title="Page thumbnails" onClick={() => setPanel(panel === "thumbs" ? "none" : "thumbs")}>▦</button>
        <button className={`rb ${panel === "outline" ? "on" : ""}`} title="Bookmarks" onClick={() => setPanel(panel === "outline" ? "none" : "outline")}>🔖</button>
        <button className={`rb ${panel === "search" ? "on" : ""}`} title="Search" onClick={() => setPanel(panel === "search" ? "none" : "search")}>🔍</button>
        <div className="rb-sep" />
        {TOOLS.map((t) => (
          <button key={t.id} className={`rb ${tool === t.id ? "on" : ""}`} title={t.label} disabled={!canEdit && t.id !== "select"}
            onClick={() => setTool(t.id)}>{t.ico}</button>
        ))}
        {tool === "stamp" && (
          <select className="rb-sel" value={stampText} onChange={(e) => setStampText(e.target.value)} title="Stamp text">
            {STAMPS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        {MARKUP_TOOLS.has(tool) && tool !== "stamp" && (
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
        <span className="rb-info">Page <input className="pg-in" type="number" min={1} max={numPages} value={curPage}
          onChange={(e) => scrollToPage(Math.max(1, Math.min(numPages, Number(e.target.value) || 1)))} /> / {numPages}</span>
        <div className="rb-sep" />
        <button className="rb" title="Add comment" onClick={() => { setPanel("comments"); }}>💬+</button>
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
          </div>
        )}

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
          {doc && Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
            <div key={p} data-page={p} ref={(el) => { if (el) pageRefs.current.set(p, el); }} className="pdf-page-wrap">
              <PdfPage doc={doc} pageNum={p} scale={scale}
                anns={annDoc.annotations.filter((a) => a.page === p)}
                selAnn={selAnn} setSelAnn={setSelAnn}
                tool={canEdit ? tool : "select"} toolColor={toolColor} stampText={stampText}
                canEdit={canEdit}
                searchRects={matches.filter((m, i) => m.page === p && i <= matchIdx + 3).flatMap((m) => m.rects)}
                onAdd={(a) => addAnn(p, a)}
                onMove={moveAnn}
                onPatch={patchAnn} />
            </div>
          ))}
        </div>
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
      {printing && <PrintDeck doc={doc} anns={annDoc.annotations} onDone={() => setPrinting(false)} />}
      {msg && <div className="toast">{msg}</div>}
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
function PdfPage({ doc, pageNum, scale, anns, selAnn, setSelAnn, tool, toolColor, stampText, canEdit, searchRects, onAdd, onMove, onPatch }: {
  doc: PDFDocumentProxy;
  pageNum: number;
  scale: number;
  anns: PdfAnn[];
  selAnn: string | null;
  setSelAnn: (id: string | null) => void;
  tool: Tool; toolColor: string; stampText: string;
  canEdit: boolean;
  searchRects: Rect4[];
  onAdd: (a: Omit<PdfAnn, "id" | "page" | "createdAt">) => void;
  onMove: (id: string, dx: number, dy: number) => void;
  onPatch: (id: string, p: Partial<PdfAnn>, key?: string) => void;
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
  const [editText, setEditText] = useState<string | null>(null);
  const dragRef = useRef<{ kind: "draw"; sx: number; sy: number; x: number; y: number } | { kind: "move"; id: string; sx: number; sy: number } | null>(null);
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
        const vp = page.getViewport({ scale });
        setSize({ w: vp.width, h: vp.height });
        const key = `${pageNum}:${scale}`;
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
  }, [doc, pageNum, scale, near]);

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
  const onPointerDown = (e: React.PointerEvent) => {
    if (!canEdit) return;
    if (tool === "select" || tool === "pan") return;
    const b = boxRef.current!.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;
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
    dragRef.current = { kind: "draw", sx: x, sy: y, x, y };
    if (tool === "freehand") setPenPts([[x, y]]);
    else setPreview({ x, y, w: 0, h: 0 });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const b = boxRef.current!.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;
    if (d.kind === "move") {
      if (Math.abs(x - d.sx) + Math.abs(y - d.sy) > 1) movedFlag.current = true;
      onMove(d.id, (x - d.sx) / scale, (y - d.sy) / scale); d.sx = x; d.sy = y;
      return;
    }
    d.x = x; d.y = y;
    if (tool === "freehand") setPenPts((p) => [...p, [x, y]]);
    else setPreview({ x: Math.min(d.sx, x), y: Math.min(d.sy, y), w: Math.abs(x - d.sx), h: Math.abs(y - d.sy) });
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
    // text-markup tools: let onMouseUp handle a real text selection instead
    if (tool === "highlight" || tool === "underline" || tool === "strikeout") {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
    }
    const [px0, py0] = vp()!.convertToPdfPoint(x, y) as [number, number];
    const [px1, py1] = vp()!.convertToPdfPoint(x + w, y + h) as [number, number];
    const rect: Rect4 = [Math.min(px0, px1), Math.min(py0, py1), Math.abs(px1 - px0), Math.abs(py1 - py0)];
    if (tool === "line" || tool === "arrow") {
      const [ax, ay] = vp()!.convertToPdfPoint(d.sx, d.sy) as [number, number];
      const [bx, by] = vp()!.convertToPdfPoint(d.x, d.y) as [number, number];
      onAdd({ type: tool, points: [[ax, ay], [bx, by]], color: toolColor });
    } else {
      onAdd({ type: tool as AnnType, rects: [rect], color: toolColor, text: tool === "textbox" ? "" : undefined });
    }
  };

  // text-selection → highlight/underline/strikeout
  const onMouseUp = () => {
    if (!canEdit || (tool !== "highlight" && tool !== "underline" && tool !== "strikeout")) return;
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

  const v = vp();

  return (
    <div ref={boxRef} className={`pdf-page ${tool !== "select" ? "draw" : ""}`}
      style={{ width: size.w || undefined, height: size.h || undefined }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onMouseUp={onMouseUp}>
      <canvas ref={canvasRef} className="pdf-canvas" />
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
          {preview && (
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
      {/* html-rendered anns: notes, textboxes, stamps */}
      {v && anns.filter((a) => a.type === "note" || a.type === "textbox" || a.type === "stamp").map((a) => {
        const sel = selAnn === a.id;
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
    case "freehand":
      return <polyline points={(a.points ?? []).map(([px, py]) => { const [x, y] = toVp(px, py); return `${x},${y}`; }).join(" ")}
        fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" style={{ ...pe, ...selOutline }} onPointerDown={onDown} />;
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
function PrintDeck({ doc, anns, onDone }: { doc: PDFDocumentProxy | null; anns: PdfAnn[]; onDone: () => void }) {
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
          } else if (a.type === "freehand" && a.points?.length) {
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
