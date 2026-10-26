import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { DriveItem, Library, Site, SiteBlock, SitePage } from "@kreatix/shared";
import { api } from "../lib/api";
import { useToast } from "../lib/hooks";
import { KIND_META, timeAgo } from "../lib/format";
import { AppIcon } from "../components/AppIcon";

interface SiteEvent {
  id: string; action: string; detail: string | null;
  actor: { displayName: string; initials: string }; createdAt: string;
}

/** A site page — block-composed (SharePoint modern page) where each block is
 *  a live object: library rollups, files, links, activity. Members edit. */
export function SitePageView() {
  const { siteId = "", pageId = "" } = useParams();
  const navigate = useNavigate();
  const { msg, toast } = useToast();
  const [site, setSite] = useState<Site | null>(null);
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [page, setPage] = useState<SitePage | null>(null);
  const [draft, setDraft] = useState<SiteBlock[] | null>(null); // edit mode
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ site: Site; libraries: Library[] }>(`/api/sites/${siteId}`);
      setSite(r.site);
      setLibraries(r.libraries);
      const p = await api.get<{ pages: SitePage[] }>(`/api/sites/${siteId}/pages`);
      setPage(p.pages.find((x) => x.id === pageId) ?? null);
      if (!p.pages.some((x) => x.id === pageId)) setNotFound(true);
    } catch { setNotFound(true); }
  }, [siteId, pageId]);
  useEffect(() => { void load(); }, [load]);

  const canWrite = site?.myRole === "owner" || site?.myRole === "member";
  const canManage = site?.myRole === "owner";

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const r = await api.patch<{ page: SitePage }>(`/api/sites/${siteId}/pages/${pageId}`, { blocks: draft });
      setPage(r.page);
      setDraft(null);
      toast("Page saved");
    } catch (e) { toast(e instanceof Error ? e.message : "Save failed"); }
    setSaving(false);
  };

  const setHome = async () => {
    try {
      const r = await api.patch<{ page: SitePage }>(`/api/sites/${siteId}/pages/${pageId}`, { isHome: true });
      setPage(r.page);
      toast("Set as site home");
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  const del = async () => {
    if (!confirm(`Delete page "${page?.title}"?`)) return;
    try {
      await api.del(`/api/sites/${siteId}/pages/${pageId}`);
      navigate(`/sites/${siteId}`);
    } catch (e) { toast(e instanceof Error ? e.message : "Delete failed"); }
  };

  const move = (i: number, dir: -1 | 1) => setDraft((d) => {
    if (!d) return d;
    const j = i + dir;
    if (j < 0 || j >= d.length) return d;
    const n = [...d];
    [n[i], n[j]] = [n[j], n[i]];
    return n;
  });
  const update = (i: number, b: SiteBlock) => setDraft((d) => d ? d.map((x, j) => j === i ? b : x) : d);
  const remove = (i: number) => setDraft((d) => d ? d.filter((_, j) => j !== i) : d);
  const add = (b: SiteBlock) => setDraft((d) => d ? [...d, b] : d);

  if (notFound) return <div className="panel"><div className="empty">Page not found.</div></div>;
  if (!site || !page) return <div className="empty">Loading…</div>;

  const blocks = draft ?? page.blocks;

  return (
    <>
      <div className="crumbs">
        <Link to="/home">Home</Link> <span>/</span> <Link to="/sites">Sites</Link> <span>/</span>
        <Link to={`/sites/${siteId}`}>{site.name}</Link> <span>/</span> <b>{page.title}</b>
      </div>

      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>{page.title}{page.isHome && <span className="perm-badge" style={{ marginLeft: 8 }}>site home</span>}</h2>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {canWrite && !draft && <button className="btn-ghost btn-sm" onClick={() => setDraft([...page.blocks])}>✎ Edit page</button>}
          {canManage && !page.isHome && <button className="btn-ghost btn-sm" onClick={() => void setHome()}>Set as site home</button>}
          {canWrite && <button className="btn-ghost btn-sm" style={{ color: "var(--danger)" }} onClick={() => void del()}>Delete</button>}
          {draft && (
            <>
              <button className="btn-ghost btn-sm" onClick={() => setDraft(null)}>Cancel</button>
              <button className="btn-primary btn-sm" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
            </>
          )}
        </div>
      </div>

      <div className="page-canvas">
        {!blocks.length && !draft && (
          <div className="panel"><div className="empty">Empty page{canWrite ? " — Edit page to add blocks." : "."}</div></div>
        )}
        {blocks.map((b, i) => (
          <div className="page-block" key={i}>
            {draft && (
              <div className="page-block-tools">
                <button onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                <button onClick={() => move(i, 1)} disabled={i === blocks.length - 1}>↓</button>
                <button onClick={() => remove(i)}>✕</button>
              </div>
            )}
            <Block b={b} i={i} siteId={siteId} libraries={libraries} edit={draft !== null}
              onChange={(nb) => update(i, nb)} navigate={navigate} />
          </div>
        ))}
        {draft && (
          <div className="page-add">
            <span style={{ fontSize: 12, color: "var(--muted)" }}>Add block:</span>
            <button className="btn-ghost btn-sm" onClick={() => add({ type: "heading", text: "Section" })}>Heading</button>
            <button className="btn-ghost btn-sm" onClick={() => add({ type: "text", text: "" })}>Text</button>
            <button className="btn-ghost btn-sm" onClick={() => add({ type: "links", title: "Quick links", links: [{ label: "Link", url: "https://" }] })}>Links</button>
            <button className="btn-ghost btn-sm" onClick={() => add({ type: "library", libraryId: libraries[0]?.id ?? "", limit: 5 })} disabled={!libraries.length}>Library roll-up</button>
            <button className="btn-ghost btn-sm" onClick={() => add({ type: "activity", limit: 5 })}>Activity</button>
          </div>
        )}
      </div>
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </>
  );
}

export function Block({ b, siteId, libraries, edit, onChange, navigate }: {
  b: SiteBlock; i: number; siteId: string; libraries: Library[]; edit: boolean;
  onChange: (b: SiteBlock) => void; navigate: (p: string) => void;
}) {
  switch (b.type) {
    case "heading":
      return edit ? (
        <input className="page-hd-edit" value={b.text} placeholder="Section heading"
          onChange={(e) => onChange({ ...b, text: e.target.value })} />
      ) : <h3 className="page-heading">{b.text}</h3>;
    case "text":
      return edit ? (
        <textarea className="page-text-edit" value={b.text} rows={Math.max(2, Math.ceil(b.text.length / 90))}
          placeholder="Write something…" onChange={(e) => onChange({ ...b, text: e.target.value })} />
      ) : <p className="page-text">{b.text}</p>;
    case "links":
      return <LinksBlock b={b} edit={edit} onChange={onChange} />;
    case "library":
      return <LibraryBlock b={b} siteId={siteId} libraries={libraries} edit={edit} onChange={onChange} navigate={navigate} />;
    case "files":
      return <FilesBlock b={b} edit={edit} onChange={onChange} navigate={navigate} />;
    case "activity":
      return <ActivityBlock b={b} siteId={siteId} edit={edit} onChange={onChange} />;
  }
}

function LinksBlock({ b, edit, onChange }: {
  b: Extract<SiteBlock, { type: "links" }>; edit: boolean; onChange: (b: SiteBlock) => void;
}) {
  if (edit) return (
    <div className="panel" style={{ padding: 12 }}>
      <input value={b.title ?? ""} placeholder="Section title" style={{ fontWeight: 700, marginBottom: 8, width: "100%" }}
        onChange={(e) => onChange({ ...b, title: e.target.value })} />
      {b.links.map((l, i) => (
        <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <input value={l.label} placeholder="Label" style={{ flex: "0 0 30%" }}
            onChange={(e) => onChange({ ...b, links: b.links.map((x, j) => j === i ? { ...x, label: e.target.value } : x) })} />
          <input value={l.url} placeholder="https://…" style={{ flex: 1 }}
            onChange={(e) => onChange({ ...b, links: b.links.map((x, j) => j === i ? { ...x, url: e.target.value } : x) })} />
          <button className="x" onClick={() => onChange({ ...b, links: b.links.filter((_, j) => j !== i) })}>✕</button>
        </div>
      ))}
      <button className="btn-ghost btn-sm" disabled={b.links.length >= 30}
        onClick={() => onChange({ ...b, links: [...b.links, { label: "", url: "https://" }] })}>＋ Add link</button>
    </div>
  );
  return (
    <div className="panel" style={{ padding: 12 }}>
      {b.title && <h3 className="page-heading" style={{ fontSize: 14 }}>{b.title}</h3>}
      <div className="page-links">
        {b.links.map((l, i) => (
          <a key={i} href={l.url} target="_blank" rel="noreferrer">↗ {l.label || l.url}</a>
        ))}
      </div>
    </div>
  );
}

function LibraryBlock({ b, siteId, libraries, edit, onChange, navigate }: {
  b: Extract<SiteBlock, { type: "library" }>; siteId: string; libraries: Library[]; edit: boolean;
  onChange: (b: SiteBlock) => void; navigate: (p: string) => void;
}) {
  const [items, setItems] = useState<DriveItem[]>([]);
  const lib = libraries.find((l) => l.id === b.libraryId);
  useEffect(() => {
    if (edit || !b.libraryId) return;
    void api.get<{ items: DriveItem[] }>(`/api/drive?library=${b.libraryId}`)
      .then((r) => setItems(r.items.slice(0, b.limit ?? 5))).catch(() => {});
  }, [b.libraryId, b.limit, edit]);

  if (edit) return (
    <div className="panel" style={{ padding: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>Library roll-up:</label>
        <select value={b.libraryId} onChange={(e) => onChange({ ...b, libraryId: e.target.value })}>
          {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>Show</label>
        <input type="number" min={1} max={20} value={b.limit ?? 5} style={{ width: 56 }}
          onChange={(e) => onChange({ ...b, limit: Number(e.target.value) || 5 })} />
      </div>
    </div>
  );
  return (
    <div className="panel" style={{ padding: 12 }}>
      <h3 className="page-heading" style={{ fontSize: 14, display: "flex", justifyContent: "space-between" }}>
        {lib?.name ?? "Library"}
        <button className="btn-ghost btn-sm" onClick={() => navigate(`/sites/${siteId}/library/${b.libraryId}`)}>Open →</button>
      </h3>
      {!items.length && <p className="d-sub" style={{ margin: "4px 0" }}>No items yet.</p>}
      {items.map((it) => {
        const meta = KIND_META[it.kind] ?? KIND_META.file;
        return (
          <button key={it.id} className="page-item-row"
            onClick={() => navigate(it.kind === "folder" ? `/sites/${siteId}/library/${b.libraryId}/folder/${it.id}` : `/edit/${it.id}`)}>
            <span className={`thumb sm ${meta.cls}`}><AppIcon kind={it.kind} /></span>
            <b>{it.name}</b>
            <span style={{ marginLeft: "auto" }}>{timeAgo(it.updatedAt)}</span>
          </button>
        );
      })}
    </div>
  );
}

function FilesBlock({ b, edit, onChange, navigate }: {
  b: Extract<SiteBlock, { type: "files" }>; edit: boolean;
  onChange: (b: SiteBlock) => void; navigate: (p: string) => void;
}) {
  const [items, setItems] = useState<DriveItem[]>([]);
  const [addId, setAddId] = useState("");
  useEffect(() => {
    void (async () => {
      const out: DriveItem[] = [];
      for (const id of b.itemIds) {
        try { const r = await api.get<{ item: DriveItem }>(`/api/drive/${id}`); out.push(r.item); } catch { /* gone */ }
      }
      setItems(out);
    })();
  }, [b.itemIds]);

  if (edit) return (
    <div className="panel" style={{ padding: 12 }}>
      <label style={{ fontSize: 12, color: "var(--muted)" }}>Pinned files (item ids)</label>
      {items.map((it) => (
        <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
          <b style={{ flex: 1, fontSize: 12.5 }}>{it.name}</b>
          <button className="x" onClick={() => onChange({ ...b, itemIds: b.itemIds.filter((x) => x !== it.id) })}>✕</button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <input value={addId} placeholder="Item id (from the file's URL)" style={{ flex: 1 }}
          onChange={(e) => setAddId(e.target.value)} />
        <button className="btn-ghost btn-sm" disabled={!addId.trim() || b.itemIds.length >= 12}
          onClick={() => { onChange({ ...b, itemIds: [...b.itemIds, addId.trim()] }); setAddId(""); }}>Add</button>
      </div>
    </div>
  );
  return (
    <div className="panel" style={{ padding: 12 }}>
      {!items.length && <p className="d-sub" style={{ margin: 0 }}>No pinned files.</p>}
      <div className="page-file-grid">
        {items.map((it) => {
          const meta = KIND_META[it.kind] ?? KIND_META.file;
          return (
            <button key={it.id} className="page-file-card" onClick={() => navigate(`/edit/${it.id}`)}>
              <span className={`thumb ${meta.cls}`}><AppIcon kind={it.kind} /></span>
              <b>{it.name}</b>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ActivityBlock({ b, siteId, edit, onChange }: {
  b: Extract<SiteBlock, { type: "activity" }>; siteId: string; edit: boolean;
  onChange: (b: SiteBlock) => void;
}) {
  const [events, setEvents] = useState<SiteEvent[]>([]);
  useEffect(() => {
    if (edit) return;
    void api.get<{ events: SiteEvent[] }>(`/api/sites/${siteId}/activity`)
      .then((r) => setEvents(r.events.slice(0, b.limit ?? 5))).catch(() => {});
  }, [siteId, b.limit, edit]);

  if (edit) return (
    <div className="panel" style={{ padding: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>Activity feed — show</label>
        <input type="number" min={1} max={20} value={b.limit ?? 5} style={{ width: 56 }}
          onChange={(e) => onChange({ ...b, limit: Number(e.target.value) || 5 })} />
        <span style={{ fontSize: 12, color: "var(--muted)" }}>events</span>
      </div>
    </div>
  );
  return (
    <div className="panel" style={{ padding: 12 }}>
      <h3 className="page-heading" style={{ fontSize: 14 }}>Site activity</h3>
      {!events.length && <p className="d-sub" style={{ margin: "4px 0" }}>Nothing yet.</p>}
      {events.map((e) => (
        <div key={e.id} className="site-home-row">
          <b><span className="c-av" style={{ marginRight: 6, display: "inline-grid" }}>{e.actor.initials}</span>
            {e.actor.displayName}</b>
          <span>{e.action}{e.detail ? ` · ${e.detail}` : ""} · {timeAgo(e.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}
