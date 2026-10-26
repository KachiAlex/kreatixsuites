import { useEffect, useState } from "react";
import type { DriveItem, LibraryColumn, TermSet } from "@kreatix/shared";
import { KIND_META, timeAgo } from "../lib/format";
import { api } from "../lib/api";
import { AppIcon } from "./AppIcon";

/** Right-hand details panel for a library item (SharePoint's information
 *  pane): shows the item's badges/permissions and lets you edit every
 *  metadata column in place — values save as you commit each field. */
export function ItemDetailsPane({ item, columns, ctColumns, contentTypeName, onClose, onRefresh, onShare, onVersions, onOpen, toast }: {
  item: DriveItem;
  columns: LibraryColumn[];
  /** bound columns of the item's content type — merges into required flags */
  ctColumns?: { columnId: string; required: boolean }[];
  contentTypeName?: string;
  onClose: () => void;
  onRefresh: () => void;
  onShare: (item: DriveItem) => void;
  onVersions: (item: DriveItem) => void;
  onOpen: (item: DriveItem) => void;
  toast: (m: string) => void;
}) {
  const meta = KIND_META[item.kind] ?? KIND_META.file;
  const [termSets, setTermSets] = useState<TermSet[]>([]);
  useEffect(() => {
    if (columns.some((c) => c.type === "managed")) {
      void api.get<{ termSets: TermSet[] }>("/api/termsets").then((r) => setTermSets(r.termSets)).catch(() => {});
    }
  }, [columns]);

  const saveField = async (col: LibraryColumn, v: string) => {
    try {
      await api.patch(`/api/drive/${item.id}/metadata`, { values: { [col.id]: v || null } });
      onRefresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed");
    }
  };

  return (
    <aside className="details-pane" aria-label={`Details for ${item.name}`}>
      <div className="details-pane-head">
        <span className={`thumb ${meta.cls}`}><AppIcon kind={item.kind} /></span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <b style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</b>
          <span className="d-sub">
            {meta.label} · {item.kind === "folder" ? "—" : fmtSize(item.size)} · {timeAgo(item.updatedAt)}
          </span>
        </div>
        <button className="kebab" aria-label="Close details" onClick={onClose}>✕</button>
      </div>

      {(item.checkedOut || item.pendingApproval || item.legalHold || item.dlpFlagged || (item.label && item.label !== "internal") || contentTypeName) && (
        <div className="details-pane-badges">
          {contentTypeName && <span className="perm-badge">📋 {contentTypeName}</span>}
          {item.checkedOut && <span className="perm-badge">🔒 checked out by {item.checkedOut.name}</span>}
          {item.pendingApproval && <span className="perm-badge">⏳ pending approval</span>}
          {item.legalHold && <span className="perm-badge">⚖ legal hold</span>}
          {item.dlpFlagged && <span className="perm-badge">⚑ DLP flagged</span>}
          {item.label && item.label !== "internal" && <span className={`label-badge ${item.label}`}>{item.label}</span>}
        </div>
      )}

      <div className="details-pane-actions">
        <button className="btn-ghost btn-sm" onClick={() => onOpen(item)}>Open</button>
        <button className="btn-ghost btn-sm" onClick={() => onShare(item)}>Share…</button>
        {item.kind !== "folder" && (
          <button className="btn-ghost btn-sm" onClick={() => onVersions(item)}>Version history</button>
        )}
      </div>

      {item.permission && (
        <div className="d-sub" style={{ fontSize: 11 }}>
          {item.permission === "owner" ? "Owned by you" : `You can ${item.permission === "viewer" ? "view" : "edit"}`}
        </div>
      )}

      {columns.length > 0 && (
        <div className="details-pane-cols">
          <div className="d-sub" style={{ marginBottom: 4 }}>Properties</div>
          {columns.map((c) => {
            const required = c.required || ctColumns?.some((b) => b.columnId === c.id && b.required);
            return (
              <div className="details-pane-field" key={c.id}>
                <label>{c.name}{required ? " *" : ""}</label>
                <PaneField item={item} col={c} terms={termSets} onCommit={saveField} />
              </div>
            );
          })}
        </div>
      )}

      {(item.collaborators?.length ?? 0) > 0 && (
        <div className="people" style={{ marginTop: 8 }}>
          {(item.collaborators ?? []).map((c, i) => <span key={i} title={c.displayName}>{c.initials}</span>)}
        </div>
      )}
    </aside>
  );
}

function PaneField({ item, col, terms, onCommit }: {
  item: DriveItem; col: LibraryColumn; terms: TermSet[];
  onCommit: (col: LibraryColumn, v: string) => void;
}) {
  const [v, setV] = useState(item.metadata?.[col.id] ?? "");
  useEffect(() => setV(item.metadata?.[col.id] ?? ""), [item.metadata, col.id]);

  const select = (options: { value: string; label: string }[]) => (
    <select value={v} onChange={(e) => { setV(e.target.value); onCommit(col, e.target.value); }}>
      <option value="">—</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );

  if (col.type === "yesno") return select([{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]);
  if (col.type === "choice") return select((col.choices ?? []).map((ch) => ({ value: ch, label: ch })));
  if (col.type === "managed") {
    const list = terms.find((s) => s.id === col.termSetId)?.terms ?? [];
    return select(list.map((t) => ({ value: t.name, label: t.name })));
  }
  return (
    <input
      type={col.type === "number" ? "number" : col.type === "date" ? "date" : "text"}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onCommit(col, v)}
      onKeyDown={(e) => { if (e.key === "Enter") onCommit(col, v); if (e.key === "Escape") setV(item.metadata?.[col.id] ?? ""); }} />
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
