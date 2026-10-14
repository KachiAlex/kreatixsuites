import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { DriveItem, FileKind, Library, Site } from "@kreatix/shared";
import { api } from "../lib/api";
import { useFiles, useItemActions } from "../lib/hooks";
import { FileList } from "../components/FileList";
import { ShareDialog } from "../components/ShareDialog";
import { VersionsPanel } from "../components/VersionsPanel";
import { prefetchEditorsFor } from "./editors";
import { kindForPath } from "../lib/offline/openLocal";

/** A document library inside a site — SharePoint-style: every file here is
 *  visible to site members; the toolbar creates/uploads straight into it. */
export function LibraryPage() {
  const { siteId = "", libId = "", folderId } = useParams();
  const navigate = useNavigate();
  const { items, refresh } = useFiles("", folderId, folderId ? undefined : libId);
  const { sharing, setSharing, versions, setVersions, msg, toast } = useItemActions(refresh);
  const [site, setSite] = useState<Site | null>(null);
  const [lib, setLib] = useState<Library | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const newRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.get<{ site: Site; libraries: Library[] }>(`/api/sites/${siteId}`)
      .then((r) => { setSite(r.site); setLib(r.libraries.find((l) => l.id === libId) ?? null); })
      .catch(() => toast("Could not load site"));
  }, [siteId, libId, toast]);

  useEffect(() => {
    if (!folderId) { setFolderName(null); return; }
    void api.get<{ item: DriveItem }>(`/api/drive/${folderId}`)
      .then((r) => setFolderName(r.item.name))
      .catch(() => setFolderName("Folder"));
  }, [folderId]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (newRef.current && !newRef.current.contains(e.target as Node)) setNewOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => { prefetchEditorsFor(items.map((i) => i.kind)); }, [items]);

  const open = (it: DriveItem) =>
    navigate(it.kind === "folder" ? `/sites/${siteId}/library/${libId}/folder/${it.id}` : `/edit/${it.id}`);

  const createIn = async (kind: FileKind) => {
    setNewOpen(false);
    setCreating(true);
    const names: Record<string, string> = {
      writer: "Untitled document", sheets: "Untitled workbook",
      present: "Untitled presentation", folder: "New folder",
    };
    try {
      const r = await api.post<{ item: DriveItem }>("/api/drive", {
        name: names[kind] ?? "Untitled", kind,
        parentId: folderId ?? null, libraryId: folderId ? undefined : libId,
      });
      if (kind === "folder") refresh();
      else navigate(`/edit/${r.item.id}`);
    } catch (e) { toast(e instanceof Error ? e.message : "Create failed"); }
    setCreating(false);
  };

  const uploadTo = async (f: File) => {
    const kind = (kindForPath(f.name) ?? (f.type === "application/pdf" ? "pdf" : "file")) as FileKind;
    try {
      await api.upload(
        `/api/drive/upload?name=${encodeURIComponent(f.name)}&kind=${kind}${folderId ? `&parent=${folderId}` : `&library=${libId}`}`, f);
      refresh();
      toast("Uploaded");
    } catch (e) { toast(e instanceof Error ? e.message : "Upload failed"); }
  };

  return (
    <>
      <div className="crumbs">
        <Link to="/home">Home</Link> <span>/</span> <Link to="/sites">Sites</Link> <span>/</span>
        <Link to={`/sites/${siteId}`}>{site?.name ?? "Site"}</Link> <span>/</span>
        {folderId ? (
          <><Link to={`/sites/${siteId}/library/${libId}`}>{lib?.name ?? "Library"}</Link> <span>/</span> <b>{folderName ?? "Folder"}</b></>
        ) : <b>{lib?.name ?? "Library"}</b>}
      </div>

      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>{folderId ? folderName ?? "Folder" : lib?.name ?? "Library"}</h2>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, position: "relative" }} ref={newRef}>
          <button className="btn-primary btn-sm" disabled={creating} onClick={() => setNewOpen((v) => !v)}>
            ＋ New
          </button>
          <button className="btn-ghost btn-sm" onClick={() => fileInput.current?.click()}>⭱ Upload</button>
          {newOpen && (
            <div className="create-menu" style={{ top: "100%", left: "auto", right: 0 }}>
              <button onClick={() => void createIn("folder")}>📁 Folder</button>
              <button onClick={() => void createIn("writer")}>📄 Writer document</button>
              <button onClick={() => void createIn("sheets")}>📊 Sheets workbook</button>
              <button onClick={() => void createIn("present")}>📽 Present deck</button>
            </div>
          )}
        </div>
      </div>

      <FileList items={items} onOpen={open} onRefresh={refresh} onShare={setSharing} onVersions={setVersions} toast={toast} />

      <input ref={fileInput} type="file" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadTo(f); e.target.value = ""; }} />
      {sharing && <ShareDialog item={sharing} onClose={() => setSharing(null)} toast={toast} />}
      {versions && <VersionsPanel item={versions} onClose={() => setVersions(null)} onRestore={refresh} toast={toast} />}
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </>
  );
}
