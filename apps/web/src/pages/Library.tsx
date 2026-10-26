import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { ContentType, DriveItem, FileKind, Library, LibraryColumn, LibraryView, Site, ViewConfig } from "@kreatix/shared";
import { api } from "../lib/api";
import { useFiles, useItemActions } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { LibraryGrid } from "../components/LibraryGrid";
import { ItemDetailsPane } from "../components/ItemDetailsPane";
import { ShareDialog } from "../components/ShareDialog";
import { VersionsPanel } from "../components/VersionsPanel";
import { CheckInDialog } from "../components/CheckInDialog";
import { ChainDialog, ColumnsDialog, ContentTypeDialog, PermsDialog, PresetDialog, presetFor } from "../components/LibraryDialogs";
import { prefetchEditorsFor } from "./editors";
import { kindForPath } from "../lib/offline/openLocal";

const PRESET_LABEL: Record<string, string> = {
  collab: "Collaboration", managed: "Managed documents", records: "Records",
};

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
  const [permsOpen, setPermsOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [ctOpen, setCtOpen] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [contentTypes, setContentTypes] = useState<ContentType[]>([]);
  const [viewMenu, setViewMenu] = useState(false);
  const [checkin, setCheckin] = useState<DriveItem | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const newRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const { user } = useAuth();
  const isAdmin = user?.role === "owner" || user?.role === "admin";

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
    void api.get<{ contentTypes: ContentType[] }>(`${libBase}/content-types`)
      .then((r) => setContentTypes(r.contentTypes)).catch(() => {});
    void api.get<{ subscribed: boolean }>(`${libBase}/alert`)
      .then((r) => setSubscribed(r.subscribed)).catch(() => {});
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

  const createIn = async (kind: FileKind, contentTypeId?: string) => {
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
        contentTypeId,
      });
      if (kind === "folder") refresh();
      else navigate(`/edit/${r.item.id}`);
    } catch (e) { toast(e instanceof Error ? e.message : "Create failed"); }
    setCreating(false);
  };

  const uploadTo = async (f: File) => {
    const kind = (kindForPath(f.name) ?? (f.type === "application/pdf" ? "pdf" : "file")) as FileKind;
    await api.upload(
      `/api/drive/upload?name=${encodeURIComponent(f.name)}&kind=${kind}${folderId ? `&parent=${folderId}` : `&library=${libId}`}`, f);
    refresh();
  };

  const uploadMany = async (files: File[]) => {
    if (!files.length) return;
    let failed = 0;
    for (const [i, f] of files.entries()) {
      setUploading(`${i + 1}/${files.length} · ${f.name}`);
      try {
        await uploadTo(f);
      } catch (e) {
        failed++;
        toast(e instanceof Error ? e.message : "Upload failed");
      }
    }
    setUploading(null);
    if (files.length > 1) toast(`Uploaded ${files.length - failed}/${files.length} files`);
    else if (!failed) toast("Uploaded");
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void uploadMany(Array.from(e.dataTransfer?.files ?? []));
  };

  // ---- saved views ----
  const applyView = (id: string) => {
    setActiveView(id);
    setFilter(id === "" ? {}
      : id === "__pending" ? { pending: true }
      : views.find((v) => v.id === id)?.config ?? {});
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

  const toggleApproval = async () => {
    if (!lib) return;
    try {
      const r = await api.patch<{ library: Library }>(`${libBase}`, { approval: !lib.approval });
      setLib(r.library);
      toast(r.library.approval
        ? "Content approval on — member publishes need an owner"
        : "Content approval off");
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
    setViewMenu(false);
  };

  const setRetention = async () => {
    if (!lib) return;
    const cur = lib.retentionDays ?? 0;
    const raw = prompt(
      "Auto-trash items untouched for this many days (0 = off):",
      cur ? String(cur) : "365");
    if (raw === null) return;
    const days = parseInt(raw, 10);
    if (!Number.isFinite(days) || days < 0 || days > 36500) { toast("Enter 0–36500 days"); return; }
    try {
      const r = await api.patch<{ library: Library }>(`${libBase}`, { retentionDays: days });
      setLib(r.library);
      toast(days > 0 ? `Auto-trash after ${days} days of inactivity` : "Retention off");
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
    setViewMenu(false);
  };

  // ---- client-side view application ----
  const shown = useMemo(() => {
    let out = items;
    if (filter.pending) out = out.filter((i) => i.pendingApproval);
    if (filter.query) out = out.filter((i) => i.name.toLowerCase().includes(filter.query!.toLowerCase()));
    if (filter.kind) out = out.filter((i) => i.kind === filter.kind);
    if (filter.label) out = out.filter((i) => i.label === filter.label);
    for (const [cid, val] of Object.entries(filter.columnFilters ?? {})) {
      if (val) out = out.filter((i) => (i.metadata?.[cid] ?? "") === val);
    }
    const dir = filter.dir === "asc" ? 1 : -1;
    if (filter.sortColumnId) {
      const cid = filter.sortColumnId;
      const numeric = columns.find((c) => c.id === cid)?.type === "number";
      out = [...out].sort((a, b) => {
        const av = a.metadata?.[cid] ?? "";
        const bv = b.metadata?.[cid] ?? "";
        const cmp = numeric ? (Number(av) || 0) - (Number(bv) || 0) : String(av).localeCompare(String(bv));
        return cmp * dir;
      });
    }
    else if (filter.sort === "name") out = [...out].sort((a, b) => a.name.localeCompare(b.name) * dir);
    else if (filter.sort === "size") out = [...out].sort((a, b) => (a.size - b.size) * dir);
    else if (filter.sort === "updated") out = [...out].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) * -dir);
    return out;
  }, [items, filter, columns]);

  /** Column-header sort (SharePoint-style): click toggles direction on the
   *  same column, or switches to ascending on a new one. */
  const onSort = (sort: ViewConfig["sort"], columnId?: string) => {
    setFilter((f) => {
      const sameCol = columnId ? f.sortColumnId === columnId : !f.sortColumnId && f.sort === sort;
      return {
        ...f,
        sort,
        sortColumnId: columnId,
        dir: sameCol ? (f.dir === "asc" ? "desc" : "asc") : "asc",
      };
    });
  };

  const details = detailsId ? items.find((i) => i.id === detailsId) ?? null : null;

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
          {lib?.approval && <span className="perm-badge" style={{ marginLeft: 8 }}>approval required</span>}
          {lib?.inheritPermissions === false && <span className="perm-badge" style={{ marginLeft: 8 }}>🔒 unique permissions</span>}
          {lib?.retentionDays ? <span className="perm-badge" style={{ marginLeft: 8 }}>🗑 {lib.retentionDays}d retention</span> : null}
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
              {contentTypes.length > 0 && (
                <>
                  <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
                  {contentTypes.map((ct) => (
                    <button key={ct.id}
                      onClick={() => void createIn(ct.docSet ? "folder" : ct.allowedKinds[0] ?? "writer", ct.id)}>
                      {ct.docSet ? "🗂" : "📋"} {ct.name}{ct.docSet ? " (set)" : ""}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* views + filter bar (library root only) */}
      {!folderId && (
        <div className="lib-bar">
          <div style={{ position: "relative" }} ref={viewRef}>
            <button className="btn-ghost btn-sm" onClick={() => setViewMenu((v) => !v)}>
              ▾ {activeView === "__pending" ? "Pending approval"
                : activeView ? views.find((v) => v.id === activeView)?.name ?? "View" : "All documents"}
            </button>
            {viewMenu && (
              <div className="create-menu" style={{ top: "100%", left: 0 }}>
                <button onClick={() => { applyView(""); setViewMenu(false); }}>All documents</button>
                {lib?.approval && (
                  <button onClick={() => { applyView("__pending"); setViewMenu(false); }}>
                    ⏳ Pending approval
                  </button>
                )}
                {views.map((v) => (
                  <button key={v.id} onClick={() => { applyView(v.id); setViewMenu(false); }}
                    style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span>{v.name}</span>
                    <span className="danger" onClick={(e) => { e.stopPropagation(); void deleteView(v.id); }}>✕</span>
                  </button>
                ))}
                <hr style={{ border: "none", borderTop: "1px solid var(--line)", margin: "4px 0" }} />
                <button onClick={() => void saveView()}>＋ Save current view</button>
                {canManage && lib && (
                  <button onClick={() => { setViewMenu(false); setPresetOpen(true); }}>
                    ⚙ Policy preset: {presetFor(lib)
                      ? PRESET_LABEL[presetFor(lib)!] : "custom"}
                  </button>
                )}
                {canManage && (
                  <button onClick={() => void toggleVersioning()}>
                    {lib?.versioning === "minor" ? "Switch to major-only versioning" : "Enable minor (draft) versioning"}
                  </button>
                )}
                {canManage && (
                  <button onClick={() => void toggleApproval()}>
                    {lib?.approval ? "Turn off content approval" : "Require content approval"}
                  </button>
                )}
                {canManage && lib?.approval && (
                  <button onClick={() => { setViewMenu(false); setChainOpen(true); }}>
                    ⛓ Approval chain{lib.approvalChain?.length ? `: ${lib.approvalChain.length} steps` : ""}
                  </button>
                )}
                {canManage && (
                  <button onClick={() => void setRetention()}>
                    {lib?.retentionDays ? `Retention: ${lib.retentionDays} days` : "Set retention…"}
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
          <select value={filter.sortColumnId ? "custom" : `${filter.sort ?? "updated"}:${filter.dir ?? "desc"}`}
            onChange={(e) => {
              if (e.target.value === "custom") return;
              const [sort, dir] = e.target.value.split(":") as [ViewConfig["sort"], ViewConfig["dir"]];
              setFilter((f) => ({ ...f, sort, dir, sortColumnId: undefined }));
            }}>
            {filter.sortColumnId && <option value="custom">Custom</option>}
            <option value="updated:desc">Newest</option>
            <option value="updated:asc">Oldest</option>
            <option value="name:asc">Name A→Z</option>
            <option value="name:desc">Name Z→A</option>
            <option value="size:desc">Largest</option>
          </select>
          <select value={filter.groupBy ?? ""} aria-label="Group by"
            onChange={(e) => setFilter((f) => ({ ...f, groupBy: e.target.value || undefined }))}>
            <option value="">Group by: none</option>
            <option value="kind">Kind</option>
            <option value="label">Label</option>
            <option value="contentType">Content type</option>
            {columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
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
          {canManage && (
            <button className="btn-ghost btn-sm" onClick={() => setPermsOpen(true)}>🔒 Permissions</button>
          )}
          {canManage && (
            <button className="btn-ghost btn-sm" onClick={() => setCtOpen(true)}>📋 Content types</button>
          )}
          <button className="btn-ghost btn-sm" title="Get notified when files change in this library"
            onClick={() => void api.put<{ subscribed: boolean }>(`${libBase}/alert`, { on: !subscribed })
              .then((r) => { setSubscribed(r.subscribed); toast(r.subscribed ? "Alerts on" : "Alerts off"); })
              .catch((e) => toast(e instanceof Error ? e.message : "Failed"))}>
            {subscribed ? "🔔 Alerts on" : "🔕 Alert me"}
          </button>
        </div>
      )}

      <div className="lib-drop"
        onDragEnter={(e) => {
          if (!e.dataTransfer?.types.includes("Files")) return;
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }}
        onDragOver={(e) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); }}
        onDragLeave={(e) => {
          if (!e.dataTransfer?.types.includes("Files")) return;
          if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); }
        }}
        onDrop={onDrop}>
        <div className="lib-layout">
          <LibraryGrid items={shown} columns={columns}
            ctNames={new Map(contentTypes.map((c) => [c.id, c.name]))}
            filter={filter} onSort={onSort}
            onOpen={open} onSelect={(it) => setDetailsId(it.id)} onRefresh={refresh}
            onShare={setSharing} onVersions={setVersions} onCheckin={setCheckin}
            toast={toast} isAdmin={isAdmin} />
          {details && (
            <ItemDetailsPane item={details} columns={columns}
              ctColumns={details.contentTypeId
                ? contentTypes.find((c) => c.id === details.contentTypeId)?.columns
                : undefined}
              contentTypeName={details.contentTypeId
                ? contentTypes.find((c) => c.id === details.contentTypeId)?.name
                : undefined}
              onClose={() => setDetailsId(null)} onRefresh={refresh}
              onShare={setSharing} onVersions={setVersions} onOpen={open} toast={toast} />
          )}
        </div>
        {dragging && <div className="lib-drop-overlay">Drop files to upload</div>}
      </div>

      {uploading && <div className="upload-status" role="status">⭱ {uploading}</div>}

      <input ref={fileInput} type="file" hidden multiple
        onChange={(e) => { void uploadMany(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      {sharing && <ShareDialog item={sharing} onClose={() => setSharing(null)} toast={toast} />}
      {versions && <VersionsPanel item={versions} onClose={() => setVersions(null)} onRestore={refresh} toast={toast} />}
      {checkin && <CheckInDialog item={checkin} onClose={() => setCheckin(null)} onDone={refresh} toast={toast} />}
      {colsOpen && <ColumnsDialog siteId={siteId} libId={libId} columns={columns}
        onClose={() => setColsOpen(false)} onChange={setColumns} toast={toast} />}
      {permsOpen && lib && <PermsDialog siteId={siteId} lib={lib}
        onClose={() => setPermsOpen(false)} onChange={setLib} toast={toast} />}
      {presetOpen && lib && <PresetDialog siteId={siteId} lib={lib}
        onClose={() => setPresetOpen(false)} onChange={setLib} toast={toast} />}
      {chainOpen && lib && <ChainDialog siteId={siteId} lib={lib}
        onClose={() => setChainOpen(false)} onChange={setLib} toast={toast} />}
      {ctOpen && <ContentTypeDialog siteId={siteId} libraryId={libId} columns={columns}
        onClose={() => { setCtOpen(false); void api.get<{ contentTypes: ContentType[] }>(`${libBase}/content-types`).then((r) => setContentTypes(r.contentTypes)); }} toast={toast} />}
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </>
  );
}
