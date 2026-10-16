import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useToast } from "../lib/hooks";
import { sanitizeHtml } from "../lib/sanitize";
import { timeAgo } from "../lib/format";
import { Modal } from "../components/Modal";

// Kreatix Mail — webmail inside the suite. Data flows through the API's
// /api/mail/* proxy to the kreatix-mail service (SSO bridge mints the mail
// JWT server-side; this page only ever talks to the suite API).

interface Folder {
  id: number; name: string; type: string; icon?: string; color?: string;
  unread_count?: number; total_count?: number;
}
interface MailLabel { id: number; name: string; color: string }
interface MailListItem {
  id: number; from_address: string; from_name: string; to_address: string;
  subject: string; snippet: string; is_read: number; is_starred: number;
  has_attachments: number; direction?: string; received_at?: string; sent_at?: string;
  labels?: MailLabel[];
}
interface MailAttachment { id: number; filename: string; mime_type: string; size: number }
interface MailDetail extends MailListItem {
  html?: string | null; text?: string | null; cc_address?: string;
  attachments?: MailAttachment[];
}
interface Draft {
  id: number; to_address?: string; cc_address?: string; bcc_address?: string;
  subject?: string; text?: string; html?: string; updated_at?: string;
}

type Virtual = { kind: "folder"; id: number } | { kind: "starred" } | { kind: "unread" } | { kind: "drafts" };

const fmtWhen = (iso?: string) => (iso ? timeAgo(iso) : "");

const FOLDER_ORDER = ["inbox", "sent", "drafts", "spam", "trash", "archive"];
const FOLDER_ICON: Record<string, string> = {
  inbox: "📥", sent: "📤", drafts: "📝", spam: "⚠", trash: "🗑", archive: "🗄",
};

export function Mail() {
  const { msg, toast } = useToast();
  const [status, setStatus] = useState<{ enabled: boolean; address?: string } | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [view, setView] = useState<Virtual | null>(null);
  const [emails, setEmails] = useState<MailListItem[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<MailDetail | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [compose, setCompose] = useState<null | {
    draftId?: number; to: string; cc: string; bcc: string; subject: string; body: string; replyToId?: number;
  }>(null);
  const [mobilePane, setMobilePane] = useState<"folders" | "list" | "read">("list");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadFolders = useCallback(async () => {
    const r = await api.get<{ folders: Folder[] }>("/api/mail/folders");
    setFolders(r.folders);
    return r.folders;
  }, []);

  const loadList = useCallback(async (v: Virtual, p: number, q: string) => {
    setListBusy(true);
    try {
      if (v.kind === "drafts") {
        const r = await api.get<{ drafts: Draft[] }>("/api/mail/drafts");
        setDrafts(r.drafts); setEmails([]); setTotal(r.drafts.length);
      } else {
        const params = new URLSearchParams({ page: String(p), limit: "50" });
        if (v.kind === "folder") params.set("folder_id", String(v.id));
        if (v.kind === "starred") params.set("starred", "true");
        if (v.kind === "unread") params.set("unread", "true");
        if (q) params.set("search", q);
        const r = await api.get<{ emails: MailListItem[]; pagination: { total: number } }>(
          `/api/mail/emails?${params}`);
        setEmails(r.emails); setTotal(r.pagination.total); setDrafts([]);
      }
    } finally { setListBusy(false); }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const s = await api.get<{ enabled: boolean; address?: string }>("/api/mail/status");
        setStatus(s);
        if (!s.enabled) return;
        const fs = await loadFolders();
        const inbox = fs.find((f) => f.type === "inbox") ?? fs[0];
        if (inbox) { const v: Virtual = { kind: "folder", id: inbox.id }; setView(v); void loadList(v, 1, ""); }
      } catch { setStatus({ enabled: false }); }
    })();
  }, [loadFolders, loadList]);

  const pickView = (v: Virtual) => {
    setView(v); setPage(1); setSelected(null); setMobilePane("list");
    void loadList(v, 1, search);
  };

  const onSearch = (q: string) => {
    setSearch(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { if (view) { setPage(1); void loadList(view, 1, q); } }, 300);
  };

  const openEmail = async (id: number) => {
    setBusyId(id);
    try {
      const d = await api.get<MailDetail>(`/api/mail/emails/${id}`);
      setSelected(d); setMobilePane("read");
      if (view) {
        setEmails((es) => es.map((e) => (e.id === id ? { ...e, is_read: 1 } : e)));
        void loadFolders();
      }
    } catch (e) { toast(e instanceof Error ? e.message : "Could not open email"); }
    setBusyId(null);
  };

  const toggleStar = async (e: MailListItem, ev?: React.MouseEvent) => {
    ev?.stopPropagation();
    await api.post(`/api/mail/emails/${e.id}/star`, { starred: !e.is_starred }).catch(() => {});
    setEmails((es) => es.map((x) => (x.id === e.id ? { ...x, is_starred: e.is_starred ? 0 : 1 } : x)));
    if (selected?.id === e.id) setSelected({ ...selected, is_starred: e.is_starred ? 0 : 1 });
  };

  const toggleRead = async (e: MailListItem) => {
    await api.post(`/api/mail/emails/${e.id}/${e.is_read ? "unread" : "read"}`, {}).catch(() => {});
    if (view) void loadList(view, page, search);
    void loadFolders();
  };

  const removeEmail = async (e: MailListItem) => {
    await api.del(`/api/mail/emails/${e.id}`).catch((err) => toast((err as Error).message));
    if (selected?.id === e.id) setSelected(null);
    if (view) void loadList(view, page, search);
    void loadFolders();
  };

  const saveDraft = async () => {
    if (!compose) return;
    const payload = {
      to_address: compose.to, cc_address: compose.cc, bcc_address: compose.bcc,
      subject: compose.subject, text: compose.body,
    };
    try {
      if (compose.draftId) await api.put(`/api/mail/drafts/${compose.draftId}`, payload);
      else await api.post("/api/mail/drafts", payload);
      toast("Draft saved");
    } catch { toast("Could not save draft"); }
  };

  const send = async (files: File[]) => {
    if (!compose) return;
    const attachments = await Promise.all(files.map(async (f) => ({
      filename: f.name,
      content: btoa([...new Uint8Array(await f.arrayBuffer())].map((b) => String.fromCharCode(b)).join("")),
    })));
    try {
      await api.post("/api/mail/send", {
        to: compose.to, cc: compose.cc || undefined, bcc: compose.bcc || undefined,
        subject: compose.subject, body: compose.body,
        replyToId: compose.replyToId,
        attachments: attachments.length ? attachments : undefined,
      });
      toast("Sent");
      if (compose.draftId) await api.del(`/api/mail/drafts/${compose.draftId}`).catch(() => {});
      setCompose(null);
      if (view) void loadList(view, page, search);
      void loadFolders();
    } catch (e) { toast(e instanceof Error ? e.message : "Send failed"); }
  };

  const downloadAttachment = async (a: MailAttachment) => {
    try {
      const blob = await api.get<Blob>(`/api/mail/attachments/${a.id}`);
      const url = URL.createObjectURL(blob);
      const el = document.createElement("a");
      el.href = url; el.download = a.filename; el.click();
      URL.revokeObjectURL(url);
    } catch { toast("Download failed"); }
  };

  if (status === null) return <div className="empty">Loading mail…</div>;
  if (!status.enabled) return (
    <>
      <div className="crumbs"><b>Mail</b></div>
      <div className="panel"><div className="empty">Kreatix Mail isn't configured on this server.</div></div>
    </>
  );

  const folderByType = (t: string) => folders.find((f) => f.type === t);
  const systemFolders = FOLDER_ORDER.map((t) => folderByType(t)).filter((f): f is Folder => !!f && f.type !== "drafts");
  const customFolders = folders.filter((f) => f.type === "custom");
  const draftsFolder = folderByType("drafts");
  const viewActive = (v: Virtual) =>
    view?.kind === v.kind && (v.kind !== "folder" || (view as { id: number }).id === v.id);
  const senderLabel = (e: MailListItem) =>
    (e.direction === "outbound" || e.direction === "sent" ? `To: ${e.to_address}` : e.from_name || e.from_address) ?? "";
  const pages = Math.max(1, Math.ceil(total / 50));

  return (
    <div className="mail-page">
      <div className="crumbs">
        <b>Mail</b>
        {status.address && <span className="d-sub" style={{ marginLeft: 8 }}>{status.address}</span>}
        <button className="btn-primary btn-sm" style={{ marginLeft: "auto" }}
          onClick={() => setCompose({ to: "", cc: "", bcc: "", subject: "", body: "" })}>✉ Compose</button>
      </div>

      <div className="mail-layout">
        {/* folders rail */}
        <aside className={`mail-folders ${mobilePane === "folders" ? "show" : ""}`}>
          {systemFolders.map((f) => (
            <button key={f.id} className={`mail-folder ${viewActive({ kind: "folder", id: f.id }) ? "active" : ""}`}
              onClick={() => pickView({ kind: "folder", id: f.id })}>
              <span>{FOLDER_ICON[f.type] ?? "📁"} {f.name}</span>
              {!!f.unread_count && <span className="mail-count">{f.unread_count}</span>}
            </button>
          ))}
          <button className={`mail-folder ${viewActive({ kind: "starred" }) ? "active" : ""}`}
            onClick={() => pickView({ kind: "starred" })}><span>★ Starred</span></button>
          <button className={`mail-folder ${viewActive({ kind: "unread" }) ? "active" : ""}`}
            onClick={() => pickView({ kind: "unread" })}><span>● Unread</span></button>
          {draftsFolder && (
            <button className={`mail-folder ${viewActive({ kind: "drafts" }) ? "active" : ""}`}
              onClick={() => pickView({ kind: "drafts" })}><span>📝 {draftsFolder.name}</span></button>
          )}
          {customFolders.length > 0 && <div className="mail-folder-sep">Folders</div>}
          {customFolders.map((f) => (
            <button key={f.id} className={`mail-folder ${viewActive({ kind: "folder", id: f.id }) ? "active" : ""}`}
              onClick={() => pickView({ kind: "folder", id: f.id })}>
              <span>{f.icon === "folder" ? "📁" : (f.icon ?? "📁")} {f.name}</span>
              {!!f.unread_count && <span className="mail-count">{f.unread_count}</span>}
            </button>
          ))}
        </aside>

        {/* message list */}
        <div className={`mail-list ${mobilePane === "list" ? "show" : ""}`}>
          <div className="mail-toolbar">
            <button className="iconbtn mail-only-mobile" onClick={() => setMobilePane("folders")} title="Folders">☰</button>
            <input className="mail-search" placeholder="Search mail…" value={search} onChange={(e) => onSearch(e.target.value)} />
          </div>
          {listBusy && <div className="empty">Loading…</div>}
          {!listBusy && view?.kind === "drafts" && drafts.map((d) => (
            <button key={d.id} className="mail-row"
              onClick={() => setCompose({
                draftId: d.id, to: d.to_address ?? "", cc: d.cc_address ?? "", bcc: d.bcc_address ?? "",
                subject: d.subject ?? "", body: d.text ?? "",
              })}>
              <span className="mail-row-head">
                <b className="mail-row-who">{(d.to_address || "Draft").slice(0, 42)}</b>
                <span className="mail-row-time">{d.updated_at ? fmtWhen(d.updated_at) : ""}</span>
              </span>
              <span className="mail-row-subj">{d.subject || "(no subject)"}</span>
              <span className="mail-row-snip">{(d.text ?? "").slice(0, 80)}</span>
            </button>
          ))}
          {!listBusy && view?.kind !== "drafts" && emails.map((e) => (
            <button key={e.id} className={`mail-row ${e.is_read ? "" : "unread"} ${selected?.id === e.id ? "sel" : ""}`}
              onClick={() => void openEmail(e.id)} disabled={busyId === e.id}>
              <span className="mail-row-head">
                <b className="mail-row-who">{senderLabel(e)}</b>
                <span className="mail-row-time">{fmtWhen(e.received_at ?? e.sent_at)}</span>
              </span>
              <span className="mail-row-subj">
                {e.has_attachments ? "📎 " : ""}{e.subject || "(no subject)"}
              </span>
              <span className="mail-row-snip">{e.snippet}</span>
              {(e.labels ?? []).map((l) => (
                <span key={l.id} className="mail-label" style={{ background: l.color }}>{l.name}</span>
              ))}
              <span className="mail-row-actions">
                <i role="button" tabIndex={0} title="Star"
                  onClick={(ev) => void toggleStar(e, ev)}
                  onKeyDown={(ev) => ev.key === "Enter" && void toggleStar(e)}>{e.is_starred ? "★" : "☆"}</i>
                <i role="button" tabIndex={0} title={e.is_read ? "Mark unread" : "Mark read"}
                  onClick={(ev) => { ev.stopPropagation(); void toggleRead(e); }}
                  onKeyDown={(ev) => ev.key === "Enter" && void toggleRead(e)}>{e.is_read ? "◌" : "●"}</i>
                <i role="button" tabIndex={0} title="Delete"
                  onClick={(ev) => { ev.stopPropagation(); void removeEmail(e); }}
                  onKeyDown={(ev) => ev.key === "Enter" && void removeEmail(e)}>🗑</i>
              </span>
            </button>
          ))}
          {!listBusy && view?.kind !== "drafts" && !emails.length && <div className="empty">Nothing here.</div>}
          {pages > 1 && (
            <div className="mail-pager">
              <button className="btn-ghost btn-sm" disabled={page <= 1}
                onClick={() => { setPage(page - 1); if (view) void loadList(view, page - 1, search); }}>‹ Prev</button>
              <span>{page} / {pages}</span>
              <button className="btn-ghost btn-sm" disabled={page >= pages}
                onClick={() => { setPage(page + 1); if (view) void loadList(view, page + 1, search); }}>Next ›</button>
            </div>
          )}
        </div>

        {/* reader */}
        <div className={`mail-reader ${mobilePane === "read" ? "show" : ""}`}>
          {!selected ? (
            <div className="empty">Select an email to read.</div>
          ) : (
            <>
              <div className="mail-reader-head">
                <button className="iconbtn mail-only-mobile" onClick={() => setMobilePane("list")} title="Back">←</button>
                <h3>{selected.subject || "(no subject)"}</h3>
                <div className="mail-reader-meta">
                  <b>{selected.from_name || selected.from_address}</b> &lt;{selected.from_address}&gt;
                  <span className="d-sub"> → {selected.to_address}{selected.cc_address ? `, cc ${selected.cc_address}` : ""}</span>
                  <span className="d-sub"> · {fmtWhen(selected.received_at ?? selected.sent_at)}</span>
                </div>
                <div className="mail-reader-actions">
                  <button className="btn-ghost btn-sm" onClick={() => setCompose({
                    to: selected.from_address, cc: "", bcc: "",
                    subject: selected.subject?.startsWith("Re:") ? selected.subject : `Re: ${selected.subject ?? ""}`,
                    body: `\n\n— ${selected.from_name || selected.from_address} wrote:\n${(selected.text ?? "").split("\n").map((l) => `> ${l}`).join("\n")}`,
                    replyToId: selected.id,
                  })}>↩ Reply</button>
                  <button className="btn-ghost btn-sm" onClick={() => setCompose({
                    to: "", cc: "", bcc: "",
                    subject: selected.subject?.startsWith("Fwd:") ? selected.subject : `Fwd: ${selected.subject ?? ""}`,
                    body: `\n\n— Forwarded message —\nFrom: ${selected.from_address}\nSubject: ${selected.subject ?? ""}\n\n${selected.text ?? ""}`,
                  })}>⇒ Forward</button>
                  <button className="btn-ghost btn-sm" onClick={() => void removeEmail(selected)}>🗑 Delete</button>
                </div>
              </div>
              {!!selected.attachments?.length && (
                <div className="mail-atts">
                  {selected.attachments.map((a) => (
                    <button key={a.id} className="mail-att" onClick={() => void downloadAttachment(a)}>
                      📎 {a.filename} <span className="d-sub">{Math.round(a.size / 1024)} KB</span>
                    </button>
                  ))}
                </div>
              )}
              {selected.html ? (
                <div className="mail-body" dangerouslySetInnerHTML={{ __html: sanitizeHtml(selected.html) }} />
              ) : (
                <pre className="mail-body mail-body-text">{selected.text ?? ""}</pre>
              )}
            </>
          )}
        </div>
      </div>

      {compose && <ComposeModal value={compose} onChange={setCompose} onSaveDraft={saveDraft} onSend={send} onClose={() => setCompose(null)} />}
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </div>
  );
}

function ComposeModal({ value, onChange, onSaveDraft, onSend, onClose }: {
  value: { draftId?: number; to: string; cc: string; bcc: string; subject: string; body: string; replyToId?: number };
  onChange: (v: { to: string; cc: string; bcc: string; subject: string; body: string; draftId?: number; replyToId?: number }) => void;
  onSaveDraft: () => void;
  onSend: (files: File[]) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  return (
    <Modal label={value.draftId ? "Edit draft" : "New message"} onClose={onClose} style={{ width: 640, maxWidth: "94vw" }}>
      <div className="mail-compose">
        <input placeholder="To" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} autoFocus />
        <input placeholder="Cc" value={value.cc} onChange={(e) => onChange({ ...value, cc: e.target.value })} />
        <input placeholder="Bcc" value={value.bcc} onChange={(e) => onChange({ ...value, bcc: e.target.value })} />
        <input placeholder="Subject" value={value.subject} onChange={(e) => onChange({ ...value, subject: e.target.value })} />
        <textarea placeholder="Write your message…" rows={12} value={value.body}
          onChange={(e) => onChange({ ...value, body: e.target.value })} />
        <div className="mail-compose-files">
          {files.map((f, i) => (
            <span key={i} className="mail-att">📎 {f.name}
              <i role="button" tabIndex={0} onClick={() => setFiles(files.filter((_, j) => j !== i))}
                onKeyDown={(e) => e.key === "Enter" && setFiles(files.filter((_, j) => j !== i))}>✕</i>
            </span>
          ))}
          <label className="btn-ghost btn-sm">Attach
            <input type="file" multiple hidden onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} />
          </label>
        </div>
        <div className="dlg-actions">
          <button className="btn-ghost" onClick={onSaveDraft}>Save draft</button>
          <button className="btn-primary" disabled={sending || !value.to.trim() || !value.subject.trim()}
            onClick={async () => { setSending(true); await onSend(files); setSending(false); }}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
