import { useEffect, useMemo, useState } from "react";
import type { DriveItem, LibraryColumn, TermSet, ViewConfig } from "@kreatix/shared";
import { KIND_META, timeAgo } from "../lib/format";
import { api } from "../lib/api";
import { prefetchEditor } from "../pages/editors";
import { AppIcon } from "./AppIcon";

const LABELS = [
  { id: "internal", name: "Internal" },
  { id: "public", name: "Public" },
  { id: "confidential", name: "Confidential" },
  { id: "restricted", name: "Restricted" },
];

/** Inline editor for one metadata cell — saves on commit, SharePoint
 *  "edit in grid view" style. */
function MetaCell({ item, col, terms, onSaved, toast }: {
  item: DriveItem; col: LibraryColumn; terms: TermSet[];
  onSaved: () => void; toast: (m: string) => void;
}) {
  const [v, setV] = useState(item.metadata?.[col.id] ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => setV(item.metadata?.[col.id] ?? ""), [item.metadata, col.id]);

  const save = async (nv: string) => {
    if (nv === (item.metadata?.[col.id] ?? "")) return;
    setBusy(true);
    try {
      await api.patch(`/api/drive/${item.id}/metadata`, { values: { [col.id]: nv || null } });
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed");
      setV(item.metadata?.[col.id] ?? "");
    }
    setBusy(false);
  };

  const cls = `grid-cell-edit${busy ? " busy" : ""}`;
  if (col.type === "yesno") return (
    <select className={cls} value={v} disabled={busy} onChange={(e) => { setV(e.target.value); void save(e.target.value); }}>
      <option value="">—</option><option value="yes">Yes</option><option value="no">No</option>
    </select>
  );
  if (col.type === "choice") return (
    <select className={cls} value={v} disabled={busy} onChange={(e) => { setV(e.target.value); void save(e.target.value); }}>
      <option value="">—</option>
      {(col.choices ?? []).map((ch) => <option key={ch} value={ch}>{ch}</option>)}
    </select>
  );
  if (col.type === "managed") {
    const list = terms.find((s) => s.id === col.termSetId)?.terms ?? [];
    return (
      <select className={cls} value={v} disabled={busy} onChange={(e) => { setV(e.target.value); void save(e.target.value); }}>
        <option value="">—</option>
        {list.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
      </select>
    );
  }
  return (
    <input className={cls}
      type={col.type === "number" ? "number" : col.type === "date" ? "date" : "text"}
      value={v} disabled={busy} placeholder="—"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => void save(v)}
      onKeyDown={(e) => { if (e.key === "Enter") void save(v); if (e.key === "Escape") setV(item.metadata?.[col.id] ?? ""); }} />
  );
}

interface Props {
  items: DriveItem[];
  columns: LibraryColumn[];
  ctNames?: Map<string, string>;
  filter: ViewConfig;
  onSort: (sort: ViewConfig["sort"], columnId?: string) => void;
  onOpen: (item: DriveItem) => void;
  onSelect: (item: DriveItem) => void;
  onRefresh: () => void;
  onShare: (item: DriveItem) => void;
  onVersions: (item: DriveItem) => void;
  onCheckin?: (item: DriveItem) => void;
  toast: (msg: string) => void;
  isAdmin: boolean;
}

/** SharePoint-style data grid: column headers, inline metadata editing,
 *  grouped views, multi-select bulk actions. */
export function LibraryGrid({ items, columns, ctNames, filter, onSort, onOpen, onSelect,
  onRefresh, onShare, onVersions, onCheckin, toast, isAdmin }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [labelFor, setLabelFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [terms, setTerms] = useState<TermSet[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [bulkCol, setBulkCol] = useState("");

  useEffect(() => {
    if (columns.some((c) => c.type === "managed")) {
      void api.get<{ termSets: TermSet[] }>("/api/termsets").then((r) => setTerms(r.termSets)).catch(() => {});
    }
  }, [columns]);

  const patch = async (item: DriveItem, body: Record<string, unknown>) => {
    await api.patch(`/api/drive/${item.id}`, body);
    onRefresh();
  };

  const act = async (item: DriveItem, action: string) => {
    setMenuFor(null);
    try {
      if (action === "star") await patch(item, { starred: !item.starred });
      if (action === "rename") { setRenaming(item.id); setNewName(item.name); }
      if (action === "label") { setMenuFor(item.id); setLabelFor(item.id); return; }
      if (action === "share") onShare(item);
      if (action === "versions") onVersions(item);
      if (action === "properties") onSelect(item);
      if (action === "checkout") {
        await api.post(`/api/drive/${item.id}/checkout`);
        toast("Checked out — only you can edit until check-in");
        onRefresh();
      }
      if (action === "checkin") onCheckin?.(item);
      if (action === "discard-checkout") {
        if (confirm(`Discard the check-out on "${item.name}"?`)) {
          await api.post(`/api/drive/${item.id}/checkout/discard`);
          toast("Check-out discarded");
          onRefresh();
        }
      }
      if (action === "publish") {
        const r = await api.post<{ ok: boolean; pending?: boolean }>(`/api/files/${item.id}/publish`);
        toast(r.pending ? "Submitted for owner approval" : "Published as a major version");
        onRefresh();
      }
      if (action === "approve") {
        const r = await api.post<{ ok: boolean; major?: number }>(`/api/drive/${item.id}/approve`);
        toast(`Approved — published as v${r.major ?? ""}.0`);
        onRefresh();
      }
      if (action === "reject") {
        const comment = prompt("Rejection reason (optional):") ?? "";
        await api.post(`/api/drive/${item.id}/reject`, { comment: comment.trim() || undefined });
        toast("Rejected — sent back to draft");
        onRefresh();
      }
      if (action === "hold") {
        await api.patch(`/api/admin/holds/item/${item.id}`, { hold: !item.legalHold });
        toast(item.legalHold ? "Legal hold released" : "Legal hold applied — can't be deleted or purged");
        onRefresh();
      }
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

  const toggleSel = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const selItems = items.filter((i) => selected.has(i.id));
  const allSelected = items.length > 0 && selected.size === items.length;

  const bulk = async (fn: (it: DriveItem) => Promise<unknown>, msg: string) => {
    try {
      for (const it of selItems) await fn(it);
      toast(msg);
      setSelected(new Set());
      onRefresh();
    } catch (e) { toast(e instanceof Error ? e.message : "Bulk action failed"); }
  };

  // grouping: partition the already-filtered/sorted list under named headers
  const groups = useMemo(() => {
    const key = filter.groupBy;
    if (!key) return [{ name: "", items }];
    const col = columns.find((c) => c.id === key);
    const labelOf = (it: DriveItem): string => {
      if (key === "label") return LABELS.find((l) => l.id === (it.label ?? "internal"))?.name ?? "Internal";
      if (key === "kind") return KIND_META[it.kind]?.label ?? it.kind;
      if (key === "contentType") return (it.contentTypeId && ctNames?.get(it.contentTypeId)) ?? "No content type";
      return it.metadata?.[key] || `No ${col?.name ?? "value"}`;
    };
    const out = new Map<string, DriveItem[]>();
    for (const it of items) {
      const g = labelOf(it);
      if (!out.has(g)) out.set(g, []);
      out.get(g)!.push(it);
    }
    return [...out.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([name, list]) => ({ name, items: list }));
  }, [items, filter.groupBy, columns, ctNames]);

  const sortArrow = (sys: ViewConfig["sort"], colId?: string) => {
    const active = colId ? filter.sortColumnId === colId : !filter.sortColumnId && filter.sort === sys;
    return active ? (filter.dir === "asc" ? " ▲" : " ▼") : "";
  };

  if (!items.length && !filter.groupBy) {
    return <div className="panel"><div className="empty">Nothing here yet — drag files in or use ＋ New.</div></div>;
  }

  const gridTemplate = `28px minmax(0,2.4fr) 110px 72px ${columns.map(() => "minmax(0,1fr)").join(" ")} 70px 34px`;

  const renderRow = (it: DriveItem) => {
    const meta = KIND_META[it.kind] ?? KIND_META.file;
    return (
      <div className={`grid-row${selected.has(it.id) ? " sel" : ""}`} key={it.id}
        style={{ gridTemplateColumns: gridTemplate }}
        onClick={() => onSelect(it)}
        onMouseEnter={() => prefetchEditor(it.kind)} onFocus={() => prefetchEditor(it.kind)}>
        <span className="grid-cell grid-check" onClick={(e) => { e.stopPropagation(); toggleSel(it.id); }}>
          <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggleSel(it.id)}
            aria-label={`Select ${it.name}`} onClick={(e) => e.stopPropagation()} />
        </span>
        <div className="grid-cell grid-name" onClick={(e) => { e.stopPropagation(); onOpen(it); }}
          role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter") onOpen(it); }}>
          <span className={`thumb sm ${meta.cls}`}><AppIcon kind={it.kind} /></span>
          {renaming === it.id ? (
            <input autoFocus value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={async () => {
                if (newName.trim() && newName !== it.name) await patch(it, { name: newName.trim() });
                setRenaming(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(null);
              }} />
          ) : (
            <span className="grid-name-text">
              <b>{it.name}</b>
              {it.starred && <span style={{ color: "var(--k-orange)" }}> ★</span>}
              {it.checkedOut && <span className="lock-badge" title={`Checked out by ${it.checkedOut.name}`}> 🔒</span>}
              {it.pendingApproval && <span className="perm-badge" title="Awaiting owner approval"> ⏳</span>}
              {it.legalHold && <span className="perm-badge" title="Under legal hold"> ⚖</span>}
              {it.dlpFlagged && <span className="perm-badge" title="Flagged by org DLP policy"> ⚑</span>}
            </span>
          )}
        </div>
        <span className="grid-cell grid-mod">{timeAgo(it.updatedAt)}</span>
        <span className="grid-cell grid-size">{it.kind === "folder" ? "—" : fmtSize(it.size)}</span>
        {columns.map((c) => (
          <span className="grid-cell" key={c.id} onClick={(e) => e.stopPropagation()}>
            <MetaCell item={it} col={c} terms={terms} onSaved={onRefresh} toast={toast} />
          </span>
        ))}
        <span className="grid-cell grid-people">
          <span className="people">
            {(it.collaborators ?? []).slice(0, 3).map((c, i) => <span key={i} title={c.displayName}>{c.initials}</span>)}
          </span>
        </span>
        <span className="grid-cell grid-act" style={{ position: "relative" }}>
          <button className="kebab" aria-label={`Actions for ${it.name}`} aria-haspopup="menu"
            onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === it.id ? null : it.id); setLabelFor(null); }}>•••</button>
          {menuFor === it.id && (
            <div className="file-menu" role="menu" style={{ right: 4, top: 30 }} onMouseLeave={() => setLabelFor(null)}>
              {labelFor === it.id ? (
                <>
                  <div className="menu-title">Sensitivity label</div>
                  {LABELS.map((l) => (
                    <button key={l.id} onClick={async () => {
                      setLabelFor(null);
                      await patch(it, { label: l.id }).catch((e) => toast(e instanceof Error ? e.message : "Label failed"));
                    }}>
                      {(it.label ?? "internal") === l.id ? "● " : "○ "}{l.name}
                    </button>
                  ))}
                </>
              ) : (
                <>
                  {!it.trashed && (
                    <>
                      <button onClick={() => { setMenuFor(null); onOpen(it); }}>Open</button>
                      <button onClick={() => act(it, "properties")}>Details…</button>
                      <button onClick={() => act(it, "rename")}>Rename</button>
                      <button onClick={() => act(it, "star")}>{it.starred ? "Unstar" : "Star"}</button>
                      <button onClick={() => act(it, "label")}>Set label…</button>
                      <button onClick={() => act(it, "share")}>Share…</button>
                      {it.kind !== "folder" && <button onClick={() => act(it, "versions")}>Version history</button>}
                      {it.kind !== "folder" && (
                        it.checkedOut ? (
                          <>
                            <button onClick={() => act(it, "checkin")}>Check in…</button>
                            <button onClick={() => act(it, "discard-checkout")}>Discard check-out</button>
                          </>
                        ) : <button onClick={() => act(it, "checkout")}>Check out</button>
                      )}
                      {it.kind !== "folder" && !it.checkedOut && !it.pendingApproval && (
                        <button onClick={() => act(it, "publish")}>Publish major version</button>
                      )}
                      {it.pendingApproval && it.canApprove && (
                        <>
                          <button onClick={() => act(it, "approve")}>Approve ✓</button>
                          <button className="danger" onClick={() => act(it, "reject")}>Reject…</button>
                        </>
                      )}
                      {isAdmin && (
                        <button onClick={() => act(it, "hold")}>{it.legalHold ? "Release legal hold" : "⚖ Legal hold"}</button>
                      )}
                      <button className="danger" onClick={() => act(it, "trash")}>Move to recycle bin</button>
                    </>
                  )}
                  {it.trashed && (
                    <>
                      <button onClick={() => act(it, "restore")}>Restore</button>
                      <button className="danger" onClick={() => act(it, "delete")}>Delete permanently</button>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="panel grid-wrap" style={{ padding: 0 }}>
      {/* header */}
      <div className="grid-row grid-head" style={{ gridTemplateColumns: gridTemplate }}>
        <span className="grid-cell grid-check">
          <input type="checkbox" checked={allSelected} aria-label="Select all"
            onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))} />
        </span>
        <button className="grid-cell grid-hd" onClick={() => onSort("name")}>Name{sortArrow("name")}</button>
        <button className="grid-cell grid-hd" onClick={() => onSort("updated")}>Modified{sortArrow("updated")}</button>
        <button className="grid-cell grid-hd" onClick={() => onSort("size")}>Size{sortArrow("size")}</button>
        {columns.map((c) => (
          <button key={c.id} className="grid-cell grid-hd" onClick={() => onSort("name", c.id)}
            title={`${c.type}${c.required ? " · required" : ""}`}>
            {c.name}{c.required ? " *" : ""}{sortArrow("name", c.id)}
          </button>
        ))}
        <span className="grid-cell grid-hd" style={{ cursor: "default" }}>Shared</span>
        <span className="grid-cell" />
      </div>

      {groups.map((g) => (
        <div key={g.name || "__all"}>
          {filter.groupBy && (
            <button className="grid-group" onClick={() => setCollapsed((s) => {
              const n = new Set(s);
              if (n.has(g.name)) n.delete(g.name); else n.add(g.name);
              return n;
            })}>
              <span style={{ transform: collapsed.has(g.name) ? "rotate(-90deg)" : "none", display: "inline-block", transition: "transform .15s" }}>▾</span>
              {" "}{g.name} <span style={{ color: "var(--muted)", fontWeight: 400 }}>({g.items.length})</span>
            </button>
          )}
          {!collapsed.has(g.name) && g.items.map(renderRow)}
        </div>
      ))}

      {/* bulk action bar */}
      {selected.size > 0 && (
        <div className="bulk-bar">
          <b>{selected.size} selected</b>
          <button className="btn-ghost btn-sm"
            onClick={() => void bulk((it) => patch(it, { starred: true }), "Starred")}>★ Star</button>
          <button className="btn-ghost btn-sm"
            onClick={() => void bulk((it) => patch(it, { label: "confidential" }), "Labeled Confidential")}>🏷 Confidential</button>
          {columns.length > 0 && (
            <>
              <select value={bulkCol || columns[0].id} aria-label="Column to set"
                onChange={(e) => setBulkCol(e.target.value)}
                style={{ background: "transparent", color: "inherit", border: "1px solid rgba(128,128,128,.4)", borderRadius: 8, height: 28, fontSize: 12 }}>
                {columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button className="btn-ghost btn-sm" disabled={!selItems.every((i) => i.libraryId)}
                onClick={() => {
                  const cid = bulkCol || columns[0].id;
                  const col = columns.find((c) => c.id === cid);
                  if (!col) return;
                  const v = prompt(`Set "${col.name}" on ${selected.size} items:`);
                  if (v === null) return;
                  void bulk((it) => api.patch(`/api/drive/${it.id}/metadata`, { values: { [cid]: v || null } }), `Set ${col.name}`);
                }}>☷ Set value</button>
            </>
          )}
          <button className="btn-ghost btn-sm danger"
            onClick={() => {
              if (confirm(`Move ${selected.size} items to the recycle bin?`))
                void bulk((it) => api.del(`/api/drive/${it.id}`), "Moved to recycle bin");
            }}>🗑 Delete</button>
          <button className="btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
