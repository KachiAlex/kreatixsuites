import { useState } from "react";
import type { DriveItem } from "@kreatix/shared";
import { KIND_META, timeAgo } from "../lib/format";
import { api } from "../lib/api";

interface Props {
  items: DriveItem[];
  onOpen: (item: DriveItem) => void;
  onRefresh: () => void;
  onShare: (item: DriveItem) => void;
  onVersions: (item: DriveItem) => void;
  toast: (msg: string) => void;
}

export function FileList({ items, onOpen, onRefresh, onShare, onVersions, toast }: Props) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  if (!items.length) return <div className="panel"><div className="empty">Nothing here yet.</div></div>;

  const patch = async (item: DriveItem, body: Record<string, unknown>) => {
    await api.patch(`/api/drive/${item.id}`, body);
    onRefresh();
  };

  const act = async (item: DriveItem, action: string) => {
    setMenuFor(null);
    try {
      if (action === "star") await patch(item, { starred: !item.starred });
      if (action === "rename") { setRenaming(item.id); setNewName(item.name); }
      if (action === "share") onShare(item);
      if (action === "versions") onVersions(item);
      if (action === "trash") { await api.del(`/api/drive/${item.id}`); toast("Moved to recycle bin"); onRefresh(); }
      if (action === "restore") { await api.post(`/api/drive/${item.id}/restore`); toast("Restored"); onRefresh(); }
      if (action === "delete") {
        if (confirm(`Permanently delete "${item.name}"? This cannot be undone.`)) {
          await api.del(`/api/drive/${item.id}?permanent=true`);
          toast("Permanently deleted");
          onRefresh();
        }
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Action failed");
    }
  };

  const submitRename = async (item: DriveItem) => {
    if (newName.trim() && newName !== item.name) await patch(item, { name: newName.trim() });
    setRenaming(null);
  };

  return (
    <div className="panel">
      {items.map((it) => {
        const meta = KIND_META[it.kind] ?? KIND_META.file;
        return (
          <div className="file" key={it.id} style={{ position: "relative" }}>
            <div className={`thumb ${meta.cls}`} onClick={() => onOpen(it)}>{meta.short}</div>
            <div onClick={() => onOpen(it)}>
              {renaming === it.id ? (
                <input
                  autoFocus value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onBlur={() => submitRename(it)}
                  onKeyDown={(e) => { if (e.key === "Enter") submitRename(it); if (e.key === "Escape") setRenaming(null); }}
                  style={{ fontSize: 12, border: "1px solid var(--line)", borderRadius: 8, padding: "4px 8px", width: "90%" }}
                />
              ) : (
                <>
                  <h4>{it.name} {it.starred && <span style={{ color: "var(--k-orange)" }}>★</span>}</h4>
                  <p>{meta.label}{it.permission && it.permission !== "owner" ? ` · ${it.permission}` : " · Owned by you"}</p>
                </>
              )}
            </div>
            <div className="meta">{timeAgo(it.updatedAt)}</div>
            <div className="people">
              {(it.collaborators ?? []).map((c, i) => <span key={i} title={c.displayName}>{c.initials}</span>)}
            </div>
            <button className="kebab" onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === it.id ? null : it.id); }}>•••</button>
            {menuFor === it.id && (
              <div className="file-menu" style={{ right: 8, top: 40 }}>
                {!it.trashed && (
                  <>
                    <button onClick={() => act(it, "rename")}>Rename</button>
                    <button onClick={() => act(it, "star")}>{it.starred ? "Unstar" : "Star"}</button>
                    <button onClick={() => act(it, "share")}>Share…</button>
                    {it.kind !== "folder" && <button onClick={() => act(it, "versions")}>Version history</button>}
                    <button className="danger" onClick={() => act(it, "trash")}>Move to recycle bin</button>
                  </>
                )}
                {it.trashed && (
                  <>
                    <button onClick={() => act(it, "restore")}>Restore</button>
                    <button className="danger" onClick={() => act(it, "delete")}>Delete permanently</button>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
