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

  useEffect(() => {
    api.get<{ versions: FileVersion[] }>(`/api/files/${item.id}/versions`)
      .then((r) => setVersions(r.versions))
      .catch((e) => toast(e.message));
  }, [item.id]);

  const restore = async (v: FileVersion) => {
    if (!confirm(`Restore version ${v.number}? Current content is preserved as a new version.`)) return;
    await api.post(`/api/files/${item.id}/versions/${v.number}/restore`);
    toast(`Restored version ${v.number}`);
    onRestore?.();
    onClose();
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
            <div style={{ flex: 1 }}>
              <b>{v.label ?? `Version ${v.number}`}</b>
              <span>{v.createdBy} · {timeAgo(v.createdAt)} · {fileSize(v.size)}</span>
            </div>
            {v.number !== versions[0]?.number && (
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
