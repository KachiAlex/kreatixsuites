import { lazy, Suspense, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { DriveItem } from "@kreatix/shared";
import { api } from "../lib/api";
import { getDraft, clearDraft, saveContent, type Draft } from "../lib/drafts";
import { KIND_META, timeAgo } from "../lib/format";
import { AppIcon, BrandLockup } from "../components/AppIcon";

// Each editor is a separate chunk — only fetched when its file type opens
// (or when prefetched via pages/editors.ts on Drive list idle / row hover).
import { editorLoaders } from "./editors";
const WriterEditor = lazy(editorLoaders.writer);
const SheetsEditor = lazy(editorLoaders.sheets);
const PresentEditor = lazy(editorLoaders.present);
const PdfEditor = lazy(editorLoaders.pdf);

const Fallback = () => (
  <div className="auth-wrap"><div className="empty">Opening…</div></div>
);

export function Editor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [item, setItem] = useState<DriveItem | null>(null);
  const [content, setContent] = useState<unknown>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const meta = await api.get<{ item: DriveItem & { ownerName?: string } }>(`/api/drive/${id}`);
        setItem(meta.item);
        if (meta.item.kind === "folder") { setReady(true); return; }
        const [c, d] = await Promise.all([
          api.get<{ content: unknown } | Blob>(`/api/files/${id}/content`).catch(() => null),
          getDraft(id!),
        ]);
        // Native binary upload (docx/xlsx/pptx — mime isn't x-kreatix-*):
        // hand the bytes to the editor as a File; it runs its normal import
        // path on mount and the first save flips the item to canonical JSON.
        if (c instanceof Blob) {
          setSourceFile(new File([c], meta.item.name, { type: meta.item.mimeType }));
        } else {
          setContent(c?.content ?? null);
        }
        // A staged draft newer than the last server save = unsaved work
        // (crash or offline close). Offer to restore it.
        if (d && d.savedAt > Date.parse(meta.item.updatedAt)) setDraft(d);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not open file");
      } finally {
        setReady(true);
      }
    })();
  }, [id]);

  // tab title follows the open file (restored by App's TitleSync on nav)
  useEffect(() => {
    if (item?.name) {
      const app = ({ writer: "Writer", sheets: "Sheets", present: "Present", pdf: "PDF" } as Record<string, string>)[item.kind] ?? "";
      document.title = app ? `${item.name} — ${app} · Kreatix Suites` : `${item.name} · Kreatix Suites`;
    }
    return () => { document.title = "Kreatix Suites"; };
  }, [item?.name, item?.kind]);

  const restoreDraft = async () => {
    if (!draft || !item) return;
    const restored = JSON.parse(draft.content) as unknown;
    setContent(restored);
    setDraft(null);
    const ok = await saveContent(item.id, restored, false);
    if (!ok) setDraft(draft); // still offline — keep the draft + banner
  };

  if (error) {
    return (
      <div className="auth-wrap">
        <div className="auth-card" style={{ textAlign: "center" }}>
          <BrandLockup size={44} style={{ margin: "0 auto 14px", width: "fit-content" }} />
          <h1>Cannot open file</h1>
          <p>{error}</p>
          <button className="btn-primary" onClick={() => navigate("/home")}>Back to home</button>
        </div>
      </div>
    );
  }
  if (!item || !ready) return <Fallback />;

  const banner = draft && (
    <div className="draft-banner" role="alert">
      <span>Unsaved changes recovered from {timeAgo(new Date(draft.savedAt).toISOString())}</span>
      <button className="btn-primary" onClick={() => void restoreDraft()}>Restore</button>
      <button className="btn-ghost" onClick={() => { void clearDraft(item.id); setDraft(null); }}>Discard</button>
    </div>
  );

  const inner = (() => {
    if (item.kind === "writer") {
      return <WriterEditor item={item} initialDoc={content} sourceFile={sourceFile} permission={item.permission ?? "owner"} />;
    }
    if (item.kind === "sheets") {
      return <SheetsEditor item={item} initialDoc={content} sourceFile={sourceFile} permission={item.permission ?? "owner"} />;
    }
    if (item.kind === "present") {
      return <PresentEditor item={item} initialDoc={content} sourceFile={sourceFile} permission={item.permission ?? "owner"} />;
    }
    if (item.kind === "pdf") {
      return <PdfEditor item={item} initialDoc={content} permission={item.permission ?? "owner"} />;
    }

    const meta = KIND_META[item.kind] ?? KIND_META.file;
    return (
      <div className="auth-wrap">
        <div className="auth-card" style={{ textAlign: "center" }}>
          <div className={`brand-mark ${meta.cls}`} style={{ background: undefined }}>
            <AppIcon kind={item.kind} size={48} />
          </div>
          <h1>{item.name}</h1>
          <p>{meta.label} editor is on the roadmap — file is safely stored in Kreatix Drive.</p>
          <button className="btn-ghost" onClick={() => navigate(-1)}>Back</button>
        </div>
      </div>
    );
  })();

  return (
    <>
      {banner}
      <Suspense fallback={<Fallback />}>{inner}</Suspense>
    </>
  );
}
