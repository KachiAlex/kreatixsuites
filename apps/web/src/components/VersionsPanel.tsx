import { useEffect, useState } from "react";
import type { DriveItem, FileVersion } from "@kreatix/shared";
import { api } from "../lib/api";
import { fileSize, timeAgo } from "../lib/format";

export function VersionsPanel({ item, onClose, onRestore, toast }: {
  item: DriveItem;
  onClose: () => void;
  onRestore?: () => void;
  toast: (m: string) => void;
}) {
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [label, setLabel] = useState("");

  const load = () => {
    api.get<{ versions: FileVersion[] }>(`/api/files/${item.id}/versions`)
      .then((r) => setVersions(r.versions))
      .catch((e) => toast(e.message));
  };
  useEffect(load, [item.id]);

  const restore = async (v: FileVersion) => {
    if (!confirm(`Restore version ${v.number}? Current content is preserved as a new version.`)) return;
    await api.post(`/api/files/${item.id}/versions/${v.number}/restore`);
    toast(`Restored version ${v.number}`);
    onRestore?.();
    onClose();
  };

  const saveLabel = async (v: FileVersion) => {
    try {
      await api.patch(`/api/files/${item.id}/versions/${v.number}`, { label: label.trim() || null });
      setRenaming(null);
      load();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div className="side-panel">
      <div className="sp-head">
        <h3>Version history</h3>
        <button className="sp-close" onClick={onClose}>✕</button>
      </div>
      <div className="sp-body">
        {versions.map((v) => (
          <div className="version-row" key={v.id}>
            <div className="v-tag">v{v.number}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {renaming === v.number ? (
                <div style={{ display: "flex", gap: 6 }}>
                  <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void saveLabel(v); if (e.key === "Escape") setRenaming(null); }}
                    style={{ flex: 1, minWidth: 0, border: "1px solid var(--line)", borderRadius: 7, padding: "3px 8px", fontSize: 12 }} />
                  <button className="btn-ghost btn-sm" onClick={() => void saveLabel(v)}>✓</button>
                </div>
              ) : (
                <>
                  <b>{v.label ?? `Version ${v.number}`}</b>
                  <span>{v.createdBy} · {timeAgo(v.createdAt)} · {fileSize(v.size)}</span>
                </>
              )}
            </div>
            {renaming !== v.number && (
              <button className="btn-ghost btn-sm" title="Name this version"
                onClick={() => { setRenaming(v.number); setLabel(v.label ?? ""); }}>✎</button>
            )}
            {v.number !== versions[0]?.number && renaming !== v.number && (
              <button className="btn-ghost btn-sm" onClick={() => restore(v)}>Restore</button>
            )}
            {v.number === versions[0]?.number && <span className="perm-badge">current</span>}
          </div>
        ))}
        {!versions.length && <div className="empty">No versions yet</div>}
      </div>
    </div>
  );
}
