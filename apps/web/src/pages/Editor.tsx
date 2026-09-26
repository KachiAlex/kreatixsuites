import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { DriveItem } from "@kreatix/shared";
import { api } from "../lib/api";
import { WriterEditor } from "../writer/WriterEditor";
import { SheetsEditor } from "../sheets/SheetsEditor";
import { PresentEditor } from "../present/PresentEditor";
import { PdfEditor } from "../pdf/PdfEditor";
import { KIND_META } from "../lib/format";

export function Editor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [item, setItem] = useState<DriveItem | null>(null);
  const [content, setContent] = useState<unknown>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const meta = await api.get<{ item: DriveItem & { ownerName?: string } }>(`/api/drive/${id}`);
        setItem(meta.item);
        if (meta.item.kind !== "folder") {
          const c = await api.get<{ content: unknown }>(`/api/files/${id}/content`).catch(() => null);
          setContent(c?.content ?? null);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not open file");
      }
    })();
  }, [id]);

  if (error) {
    return (
      <div className="auth-wrap">
        <div className="auth-card" style={{ textAlign: "center" }}>
          <div className="brand-mark">K</div>
          <h1>Cannot open file</h1>
          <p>{error}</p>
          <button className="btn-primary" onClick={() => navigate("/")}>Back to home</button>
        </div>
      </div>
    );
  }
  if (!item) return <div className="auth-wrap"><div className="empty">Opening…</div></div>;

  if (item.kind === "writer") {
    return <WriterEditor item={item} initialDoc={content} permission={item.permission ?? "owner"} />;
  }
  if (item.kind === "sheets") {
    return <SheetsEditor item={item} initialDoc={content} permission={item.permission ?? "owner"} />;
  }
  if (item.kind === "present") {
    return <PresentEditor item={item} initialDoc={content} permission={item.permission ?? "owner"} />;
  }
  if (item.kind === "pdf") {
    return <PdfEditor item={item} initialDoc={content} permission={item.permission ?? "owner"} />;
  }

  const meta = KIND_META[item.kind] ?? KIND_META.file;
  return (
    <div className="auth-wrap">
      <div className="auth-card" style={{ textAlign: "center" }}>
        <div className={`brand-mark ${meta.cls}`} style={{ background: undefined }}>
          <span className={`app-ico ${meta.cls}`} style={{ width: 48, height: 48, borderRadius: 15 }}>{meta.short}</span>
        </div>
        <h1>{item.name}</h1>
        <p>{meta.label} editor is on the roadmap — file is safely stored in Kreatix Drive.</p>
        <button className="btn-ghost" onClick={() => navigate(-1)}>Back</button>
      </div>
    </div>
  );
}
