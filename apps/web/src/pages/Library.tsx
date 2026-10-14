import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { DriveItem, FileKind, Library, LibraryColumn, LibraryView, Site, ViewConfig } from "@kreatix/shared";
import { api } from "../lib/api";
import { useFiles, useItemActions } from "../lib/hooks";
import { FileList } from "../components/FileList";
import { ShareDialog } from "../components/ShareDialog";
import { VersionsPanel } from "../components/VersionsPanel";
import { CheckInDialog } from "../components/CheckInDialog";
import { ColumnsDialog, PropertiesDialog } from "../components/LibraryDialogs";
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
  const [columns, setColumns] = useState<LibraryColumn[]>([]);
  const [views, setViews] = useState<LibraryView[]>([]);
  const [activeView, setActiveView] = useState<string>("");
  const [filter, setFilter] = useState<ViewConfig>({});
  const [folderName, setFolderName] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [viewMenu, setViewMenu] = useState(false);
  const [checkin, setCheckin] = useState<DriveItem | null>(null);
  const [propsFor, setPropsFor] = useState<DriveItem | null>(null);
  const [creating, setCreating] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const newRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);

  const libBase = `/api/sites/${siteId}/libraries/${libId}`;

  useEffect(() => {
    void api.get<{ site: Site; libraries: Library[] }>(`/api/sites/${siteId}`)
      .then((r) => { setSite(r.site); setLib(r.libraries.find((l) => l.id === libId) ?? null); })
      .catch(() => toast("Could not load site"));
  }, [siteId, libId, toast]);

  useEffect(() => {
    void api.get<{ columns: LibraryColumn[] }>(`${libBase}/columns`)
      .then((r) => setColumns(r.columns)).catch(() => {});
    void api.get<{ views: LibraryView[] }>(`${libBase}/views`)
      .then((r) => setViews(r.views)).catch(() => {});
  }, [libBase]);

  useEffect(() => {
    if (!folderId) { setFolderName(null); return; }
    void api.get<{ item: DriveItem }>(`/api/drive/${folderId}`)
      .then((r) => setFolderName(r.item.name))
      .catch(() => setFolderName("Folder"));
  }, [folderId]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (newRef.current && !newRef.current.contains(e.target as Node)) setNewOpen(false);
      if (viewRef.current && !viewRef.current.contains(e.target as Node)) setViewMenu(false);
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

  // ---- saved views ----
  const applyView = (id: string) => {
    setActiveView(id);
    setFilter(id === "" ? {} : views.find((v) => v.id === id)?.config ?? {});
  };

  const saveView = async () => {
    const name = prompt("Name this view:", "My view")?.trim();
    if (!name) return;
    try {
      const r = await api.post<{ view: LibraryView }>(`${libBase}/views`, { name, config: filter });
      setViews((v) => [...v, r.view]);
      setActiveView(r.view.id);
      toast("View saved");
    } catch (e) { toast(e instanceof Error ? e.message : "Save failed"); }
    setViewMenu(false);
  };

  const deleteView = async (id: string) => {
    try {
      await api.del(`${libBase}/views/${id}`);
      setViews((v) => v.filter((x) => x.id !== id));
      if (activeView === id) applyView("");
    } catch (e) { toast(e instanceof Error ? e.message : "Delete failed"); }
  };

  const toggleVersioning = async () => {
    if (!lib) return;
    const next = lib.versioning === "minor" ? "major" : "minor";
    try {
      const r = await api.patch<{ library: Library }>(`${libBase}`, { versioning: next });
      setLib(r.library);
      toast(next === "minor" ? "Minor (draft) versioning enabled" : "Major-only versioning enabled");
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
    setViewMenu(false);
  };

  // ---- client-side view application ----
  const shown = useMemo(() => {
    let out = items;
    if (filter.query) out = out.filter((i) => i.name.toLowerCase().includes(filter.query!.toLowerCase()));
    if (filter.kind) out = out.filter((i) => i.kind === filter.kind);
    if (filter.label) out = out.filter((i) => i.label === filter.label);
    for (const [cid, val] of Object.entries(filter.columnFilters ?? {})) {
      if (val) out = out.filter((i) => (i.metadata?.[cid] ?? "") === val);
    }
    const dir = filter.dir === "asc" ? 1 : -1;
    if (filter.sort === "name") out = [...out].sort((a, b) => a.name.localeCompare(b.name) * dir);
    else if (filter.sort === "size") out = [...out].sort((a, b) => (a.size - b.size) * dir);
    else if (filter.sort === "updated") out = [...out].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) * -dir);
    return out;
  }, [items, filter]);

  const canManage = site?.myRole === "owner";

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
        <h2>{folderId ? folderName ?? "Folder" : lib?.name ?? "Library"}
          {lib?.versioning === "minor" && <span className="perm-badge" style={{ marginLeft: 8 }}>minor versioning</span>}
        </h2>
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

      {/* views + filter bar (library root only) */}
      {!folderId && (
        <div className="lib-bar">
          <div style={{ position: "relative" }} ref={viewRef}>
            <button className="btn-ghost btn-sm" onClick={() => setViewMenu((v) => !v)}>
              ▾ {activeView ? views.find((v) => v.id === activeView)?.name ?? "View" : "All documents"}
            </button>
            {viewMenu && (
              <div className="create-menu" style={{ top: "100%", left: 0 }}>
                <button onClick={() => { applyView(""); setViewMenu(false); }}>All documents</button>
                {views.map((v) => (
                  <button key={v.id} onClick={() => { applyView(v.id); setViewMenu(false); }}
                    style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span>{v.name}</span>
                    <span className="danger" onClick={(e) => { e.stopPropagation(); void deleteView(v.id); }}>✕</span>
                  </button>
                ))}
                <hr style={{ border: "none", borderTop: "1px solid var(--line)", margin: "4px 0" }} />
                <button onClick={() => void saveView()}>＋ Save current view</button>
                {canManage && (
                  <button onClick={() => void toggleVersioning()}>
                    {lib?.versioning === "minor" ? "Switch to major-only versioning" : "Enable minor (draft) versioning"}
                  </button>
                )}
              </div>
            )}
          </div>
          <input className="lib-search" placeholder="Filter…" value={filter.query ?? ""}
            onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))} />
          <select value={filter.kind ?? ""} onChange={(e) => setFilter((f) => ({ ...f, kind: e.target.value as FileKind | "" }))}>
            <option value="">All types</option>
            <option value="folder">Folders</option><option value="writer">Writer</option>
            <option value="sheets">Sheets</option><option value="present">Present</option>
            <option value="pdf">PDF</option><option value="file">Files</option>
          </select>
          <select value={`${filter.sort ?? "updated"}:${filter.dir ?? "desc"}`}
            onChange={(e) => {
              const [sort, dir] = e.target.value.split(":") as [ViewConfig["sort"], ViewConfig["dir"]];
              setFilter((f) => ({ ...f, sort, dir }));
            }}>
            <option value="updated:desc">Newest</option>
            <option value="updated:asc">Oldest</option>
            <option value="name:asc">Name A→Z</option>
            <option value="name:desc">Name Z→A</option>
            <option value="size:desc">Largest</option>
          </select>
          {columns.filter((c) => c.type === "choice").map((c) => (
            <select key={c.id} value={filter.columnFilters?.[c.id] ?? ""}
              onChange={(e) => setFilter((f) => ({
                ...f, columnFilters: { ...(f.columnFilters ?? {}), [c.id]: e.target.value },
              }))}>
              <option value="">{c.name}: all</option>
              {(c.choices ?? []).map((ch) => <option key={ch} value={ch}>{ch}</option>)}
            </select>
          ))}
          {canManage && (
            <button className="btn-ghost btn-sm" onClick={() => setColsOpen(true)}>☷ Columns</button>
          )}
        </div>
      )}

      <FileList items={shown} onOpen={open} onRefresh={refresh} onShare={setSharing} onVersions={setVersions}
        toast={toast} onCheckin={setCheckin} onProperties={setPropsFor} />

      <input ref={fileInput} type="file" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadTo(f); e.target.value = ""; }} />
      {sharing && <ShareDialog item={sharing} onClose={() => setSharing(null)} toast={toast} />}
      {versions && <VersionsPanel item={versions} onClose={() => setVersions(null)} onRestore={refresh} toast={toast} />}
      {checkin && <CheckInDialog item={checkin} onClose={() => setCheckin(null)} onDone={refresh} toast={toast} />}
      {propsFor && <PropertiesDialog item={propsFor} siteId={siteId} libId={libId} columns={columns}
        onClose={() => setPropsFor(null)} onDone={refresh} toast={toast} />}
      {colsOpen && <ColumnsDialog siteId={siteId} libId={libId} columns={columns}
        onClose={() => setColsOpen(false)} onChange={setColumns} toast={toast} />}
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </>
  );
}
