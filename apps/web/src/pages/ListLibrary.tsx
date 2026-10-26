import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Library, LibraryColumn, ListRow, Site, TermSet } from "@kreatix/shared";
import { api } from "../lib/api";
import { useToast } from "../lib/hooks";
import { timeAgo } from "../lib/format";
import { ColumnsDialog } from "../components/LibraryDialogs";

/** A 'list' library (Microsoft Lists) — structured rows with the library's
 *  custom columns, edited in a data grid. Same columns/views backend as
 *  document libraries. */
export function ListLibraryPage() {
  const { siteId = "", libId = "" } = useParams();
  const { msg, toast } = useToast();
  const [site, setSite] = useState<Site | null>(null);
  const [lib, setLib] = useState<Library | null>(null);
  const [columns, setColumns] = useState<LibraryColumn[]>([]);
  const [rows, setRows] = useState<ListRow[]>([]);
  const [query, setQuery] = useState("");
  const [sortCol, setSortCol] = useState<string>(""); // "title" | "updated" | columnId
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [terms, setTerms] = useState<TermSet[]>([]);
  const [colsOpen, setColsOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  const libBase = `/api/sites/${siteId}/libraries/${libId}`;

  const refresh = async () => {
    try {
      const r = await api.get<{ rows: ListRow[] }>(`${libBase}/rows`);
      setRows(r.rows);
    } catch (e) { toast(e instanceof Error ? e.message : "Load failed"); }
  };

  useEffect(() => {
    void api.get<{ site: Site; libraries: Library[] }>(`/api/sites/${siteId}`)
      .then((r) => { setSite(r.site); setLib(r.libraries.find((l) => l.id === libId) ?? null); })
      .catch(() => toast("Could not load site"));
    void api.get<{ columns: LibraryColumn[] }>(`${libBase}/columns`)
      .then((r) => setColumns(r.columns)).catch(() => {});
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, libId]);

  useEffect(() => {
    if (columns.some((c) => c.type === "managed")) {
      void api.get<{ termSets: TermSet[] }>("/api/termsets").then((r) => setTerms(r.termSets)).catch(() => {});
    }
  }, [columns]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuFor(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const canWrite = site?.myRole === "owner" || site?.myRole === "member";
  const canManage = site?.myRole === "owner";

  const shown = useMemo(() => {
    let out = rows;
    if (query.trim()) {
      const ql = query.toLowerCase();
      out = out.filter((r) => r.title.toLowerCase().includes(ql)
        || Object.values(r.data).some((v) => v?.toLowerCase().includes(ql)));
    }
    if (sortCol) {
      const numeric = columns.find((c) => c.id === sortCol)?.type === "number";
      const val = (r: ListRow) =>
        sortCol === "title" ? r.title
        : sortCol === "updated" ? r.updatedAt
        : r.data[sortCol] ?? "";
      out = [...out].sort((a, b) => {
        const av = val(a), bv = val(b);
        const cmp = numeric ? (Number(av) || 0) - (Number(bv) || 0) : String(av).localeCompare(String(bv));
        return cmp * sortDir;
      });
    }
    return out;
  }, [rows, query, sortCol, sortDir, columns]);

  const patchRow = async (row: ListRow, body: { title?: string; data?: Record<string, string | null> }) => {
    try {
      await api.patch(`${libBase}/rows/${row.id}`, body);
      await refresh();
    } catch (e) { toast(e instanceof Error ? e.message : "Save failed"); }
  };

  const delRow = async (row: ListRow) => {
    setMenuFor(null);
    if (!confirm(`Delete "${row.title}"?`)) return;
    try {
      await api.del(`${libBase}/rows/${row.id}`);
      setRows((l) => l.filter((r) => r.id !== row.id));
      toast("Row deleted");
    } catch (e) { toast(e instanceof Error ? e.message : "Delete failed"); }
  };

  const createRow = async () => {
    if (!newTitle.trim() || creating) return;
    setCreating(true);
    try {
      const r = await api.post<{ row: ListRow }>(`${libBase}/rows`, { title: newTitle.trim() });
      setRows((l) => [...l, r.row]);
      setNewTitle("");
      toast("Row added");
    } catch (e) { toast(e instanceof Error ? e.message : "Create failed"); }
    setCreating(false);
  };

  const sortBy = (key: string) => {
    if (sortCol === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortCol(key); setSortDir(1); }
  };
  const arrow = (key: string) => (sortCol === key ? (sortDir === 1 ? " ▲" : " ▼") : "");

  const gridTemplate = `minmax(0,1.6fr) ${columns.map(() => "minmax(0,1fr)").join(" ")} 110px 34px`;

  if (!lib) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="crumbs">
        <Link to="/home">Home</Link> <span>/</span> <Link to="/sites">Sites</Link> <span>/</span>
        <Link to={`/sites/${siteId}`}>{site?.name ?? "Site"}</Link> <span>/</span> <b>{lib.name}</b>
      </div>

      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>{lib.name} <span className="perm-badge" style={{ marginLeft: 8 }}>list</span></h2>
      </div>

      <div className="lib-bar">
        <input className="lib-search" placeholder="Filter rows…" value={query}
          onChange={(e) => setQuery(e.target.value)} />
        {canManage && <button className="btn-ghost btn-sm" onClick={() => setColsOpen(true)}>☷ Columns</button>}
        <span className="d-sub" style={{ marginLeft: "auto" }}>{shown.length} row{shown.length === 1 ? "" : "s"}</span>
      </div>

      <div className="panel grid-wrap" style={{ padding: 0 }}>
        <div className="grid-row grid-head" style={{ gridTemplateColumns: gridTemplate }}>
          <button className="grid-cell grid-hd" onClick={() => sortBy("title")}>Title{arrow("title")}</button>
          {columns.map((c) => (
            <button key={c.id} className="grid-cell grid-hd" onClick={() => sortBy(c.id)}
              title={`${c.type}${c.required ? " · required" : ""}`}>
              {c.name}{c.required ? " *" : ""}{arrow(c.id)}
            </button>
          ))}
          <button className="grid-cell grid-hd" onClick={() => sortBy("updated")}>Modified{arrow("updated")}</button>
          <span className="grid-cell" />
        </div>

        {shown.map((row) => (
          <div className="grid-row" key={row.id} style={{ gridTemplateColumns: gridTemplate }}>
            <span className="grid-cell" style={{ fontWeight: 600 }}>
              <TitleCell row={row} canWrite={canWrite} onSave={(t) => void patchRow(row, { title: t })} />
            </span>
            {columns.map((c) => (
              <span className="grid-cell" key={c.id}>
                <RowCell row={row} col={c} terms={terms} canWrite={canWrite}
                  onSave={(v) => void patchRow(row, { data: { [c.id]: v } })} />
              </span>
            ))}
            <span className="grid-cell grid-mod">{timeAgo(row.updatedAt)}</span>
            <span className="grid-cell grid-act" style={{ position: "relative" }} ref={menuFor === row.id ? menuRef : undefined}>
              {canWrite && (
                <>
                  <button className="kebab" aria-label={`Actions for ${row.title}`}
                    onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === row.id ? null : row.id); }}>•••</button>
                  {menuFor === row.id && (
                    <div className="file-menu" style={{ right: 4, top: 30 }}>
                      <button className="danger" onClick={() => void delRow(row)}>Delete row</button>
                    </div>
                  )}
                </>
              )}
            </span>
          </div>
        ))}

        {shown.length === 0 && (
          <div className="empty">{query ? "No rows match." : "No rows yet — add the first one below."}</div>
        )}

        {canWrite && (
          <div className="grid-row" style={{ gridTemplateColumns: gridTemplate, borderBottom: 0 }}>
            <span className="grid-cell" style={{ gridColumn: "1 / -2", display: "flex", gap: 8 }}>
              <input className="grid-cell-edit" style={{ border: "1px solid var(--line)" }}
                placeholder="＋ New row…" value={newTitle} disabled={creating}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void createRow()} />
              <button className="btn-ghost btn-sm" disabled={!newTitle.trim() || creating}
                onClick={() => void createRow()}>{creating ? "Adding…" : "Add"}</button>
            </span>
            <span className="grid-cell" />
          </div>
        )}
      </div>

      {colsOpen && <ColumnsDialog siteId={siteId} libId={libId} columns={columns}
        onClose={() => setColsOpen(false)} onChange={setColumns} toast={toast} />}
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </>
  );
}

/** Editable title cell — click to edit, Enter/blur saves. */
function TitleCell({ row, canWrite, onSave }: {
  row: ListRow; canWrite: boolean; onSave: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(row.title);
  useEffect(() => setV(row.title), [row.title]);
  if (!canWrite) return <>{row.title}</>;
  if (editing) return (
    <input className="grid-cell-edit" autoFocus value={v} style={{ border: "1px solid var(--k-orange)", background: "var(--surface)" }}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { setEditing(false); if (v.trim() && v !== row.title) onSave(v.trim()); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") { setV(row.title); setEditing(false); }
      }} />
  );
  return <span onClick={(e) => { e.stopPropagation(); setEditing(true); }} style={{ cursor: "text" }}>{row.title}</span>;
}

/** Editable list-row value cell — same column types as the document grid. */
function RowCell({ row, col, terms, canWrite, onSave }: {
  row: ListRow; col: LibraryColumn; terms: TermSet[];
  canWrite: boolean; onSave: (v: string) => void;
}) {
  const [v, setV] = useState(row.data[col.id] ?? "");
  useEffect(() => setV(row.data[col.id] ?? ""), [row.data, col.id]);
  if (!canWrite) return <>{row.data[col.id] ?? "—"}</>;

  const sel = (opts: { value: string; label: string }[]) => (
    <select className="grid-cell-edit" value={v}
      onChange={(e) => { setV(e.target.value); onSave(e.target.value); }}>
      <option value="">—</option>
      {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );

  if (col.type === "yesno") return sel([{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]);
  if (col.type === "choice") return sel((col.choices ?? []).map((ch) => ({ value: ch, label: ch })));
  if (col.type === "managed") {
    const list = terms.find((s) => s.id === col.termSetId)?.terms ?? [];
    return sel(list.map((t) => ({ value: t.name, label: t.name })));
  }
  return (
    <input className="grid-cell-edit"
      type={col.type === "number" ? "number" : col.type === "date" ? "date" : "text"}
      value={v} placeholder="—"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v !== (row.data[col.id] ?? "")) onSave(v); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setV(row.data[col.id] ?? "");
      }} />
  );
}
