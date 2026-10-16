import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useToast } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { useIsMobile } from "../lib/mobile";
import { sanitizeHtml } from "../lib/sanitize";

// Kreatix Notes — org wiki (OneNote-lite). Two-pane page list + editor with
// an md-lite preview. Every member can read/write; creator or admin deletes.

interface Page {
  id: string; title: string | null; body?: string | null;
  createdBy: string; createdByName: string | null;
  updatedByName: string | null; updatedAt: string;
}

/** Minimal markdown → html for the preview pane (headers, bold/italic, code,
 *  lists, links, paragraphs). Sanitized before render. */
const mdLite = (src: string): string => {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*]+)\*/g, "<i>$1</i>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out: string[] = [];
  let inList = false;
  for (const raw of src.split("\n")) {
    const line = raw.trimEnd();
    const li = /^[-*] (.+)/.exec(line);
    if (li) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) { out.push("</ul>"); inList = false; }
    const h = /^(#{1,3}) (.+)/.exec(line);
    if (h) { out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }
    if (line === "") { out.push(""); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
};

const fmtWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function Notes() {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const { msg, toast } = useToast();
  const [pages, setPages] = useState<Page[]>([]);
  const [active, setActive] = useState<Page | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    try { setPages((await api.get<{ pages: Page[] }>("/api/notes")).pages); }
    catch (e) { toast((e as Error).message); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const open = async (p: Page) => {
    try {
      const full = (await api.get<{ page: Page }>(`/api/notes/${p.id}`)).page;
      setActive(full); setTitle(full.title ?? ""); setBody(full.body ?? "");
      setPreview(true); setDirty(false);
    } catch (e) { toast((e as Error).message); }
  };

  const openNew = () => {
    setActive(null); setTitle(""); setBody(""); setPreview(false); setDirty(true);
  };

  const save = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      if (active) {
        const r = await api.patch<{ page: Page }>(`/api/notes/${active.id}`, { title: title.trim(), body });
        setActive(r.page);
      } else {
        const r = await api.post<{ page: Page }>(`/api/notes`, { title: title.trim(), body });
        setActive(r.page);
      }
      setDirty(false); setPreview(true);
      void load();
    } catch (e) { toast((e as Error).message); }
    setBusy(false);
  };

  const del = async () => {
    if (!active) return;
    try { await api.del(`/api/notes/${active.id}`); setActive(null); void load(); }
    catch (e) { toast((e as Error).message); }
  };

  const canDelete = active && (active.createdBy === user?.id || user?.role === "owner" || user?.role === "admin");

  return (
    <>
      <div className="crumbs">
        <b>Notes</b><span className="d-sub" style={{ marginLeft: 8 }}>org wiki</span>
        <button className="btn-primary btn-sm" style={{ marginLeft: "auto" }} onClick={openNew}>＋ New page</button>
      </div>

      <div className="chat" style={{ minHeight: 0, flex: 1 }}>
        <aside className={`chat-list${isMobile && (active || dirty) ? " hidden" : ""}`}>
          <div className="chat-list-h"><b>Pages</b></div>
          {pages.map((p) => (
            <button key={p.id} className={`chat-item${active?.id === p.id ? " active" : ""}`} onClick={() => void open(p)}>
              <span className="chat-avatar">📝</span>
              <span className="chat-item-main">
                <b>{p.title}</b>
                <span className="d-sub">{fmtWhen(p.updatedAt)}{p.updatedByName ? ` · ${p.updatedByName}` : ""}</span>
              </span>
            </button>
          ))}
          {!pages.length && <div className="empty" style={{ padding: 16 }}>No pages yet.</div>}
        </aside>

        <section className={`chat-pane${isMobile && !active && !dirty ? " hidden" : ""}`}>
          {!active && !dirty && !title ? (
            <div className="chat-placeholder"><div className="empty">Pick a page, or start a new one.</div></div>
          ) : (
            <>
              <div className="chat-pane-h">
                {isMobile && <button className="iconbtn" onClick={() => { setActive(null); setDirty(false); }}>←</button>}
                <input className="note-title" placeholder="Page title" value={title}
                  onChange={(e) => { setTitle(e.target.value); setDirty(true); }} />
                <button className="btn-ghost btn-sm" style={{ marginLeft: "auto" }}
                  onClick={() => setPreview((p) => !p)}>{preview ? "Edit" : "Preview"}</button>
                <button className="btn-primary btn-sm" disabled={busy || !title.trim()}
                  onClick={() => void save()}>Save</button>
                {canDelete && <button className="btn-ghost btn-sm" onClick={() => void del()}>Delete</button>}
              </div>
              {preview ? (
                <div className="note-preview"
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(mdLite(body)) }} />
              ) : (
                <textarea className="note-body" placeholder="Write… (supports # headings, **bold**, *italic*, - lists, `code`, [links](url))"
                  value={body} onChange={(e) => { setBody(e.target.value); setDirty(true); }} />
              )}
            </>
          )}
        </section>
      </div>
      {msg && <div className="toast" role="status">{msg}</div>}
    </>
  );
}
