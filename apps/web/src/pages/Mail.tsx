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
interface MailRule {
  id: number; name: string; condition_field: string; condition_op: string;
  condition_value: string; action: string; action_value: string | null;
  priority: number; is_active: number;
}
interface MailAlias { id: number; alias_email: string; forward_to: string; created_at?: string }
interface MailSettings {
  vacation_enabled?: number; vacation_subject?: string; vacation_body?: string;
  vacation_start?: string | null; vacation_end?: string | null;
  forward_to_address?: string | null; reply_to_address?: string | null;
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newFolder, setNewFolder] = useState("");
  const [sharedWith, setSharedWith] = useState<{ ownerId: string; name: string; address: string | null }[]>([]);
  const [asUser, setAsUser] = useState<{ ownerId: string; name: string; address: string | null } | null>(null);
  const [triage, setTriage] = useState<Record<string, { priority: string; reason: string }>>({});
  const [triageBusy, setTriageBusy] = useState(false);
  const asRef = useRef<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  asRef.current = asUser?.ownerId ?? null;
  /** mail path helper — shared mailboxes proxy through /api/mail/as/:owner */
  const mp = useCallback((p: string) =>
    asRef.current ? `/api/mail/as/${asRef.current}${p}` : `/api/mail${p}`, []);

  const loadFolders = useCallback(async () => {
    const r = await api.get<{ folders: Folder[] }>(mp("/folders"));
    setFolders(r.folders);
    return r.folders;
  }, [mp]);

  const loadList = useCallback(async (v: Virtual, p: number, q: string) => {
    setListBusy(true);
    try {
      if (v.kind === "drafts") {
        const r = await api.get<{ drafts: Draft[] }>(mp("/drafts"));
        setDrafts(r.drafts); setEmails([]); setTotal(r.drafts.length);
      } else {
        const params = new URLSearchParams({ page: String(p), limit: "50" });
        if (v.kind === "folder") params.set("folder_id", String(v.id));
        if (v.kind === "starred") params.set("starred", "true");
        if (v.kind === "unread") params.set("unread", "true");
        if (q) params.set("search", q);
        const r = await api.get<{ emails: MailListItem[]; pagination: { total: number } }>(
          mp(`/emails?${params}`));
        setEmails(r.emails); setTotal(r.pagination.total); setDrafts([]);
        // merge stored triage annotations for the visible ids
        void api.post<{ triage: { id: string; priority: string; reason: string }[] }>(
          "/api/ai/mail-triage/lookup", { ids: r.emails.map((e) => String(e.id)) })
          .then((t) => setTriage((cur) => ({ ...cur, ...Object.fromEntries(t.triage.map((x) => [x.id, x])) })))
          .catch(() => {});
      }
    } finally { setListBusy(false); }
  }, [mp]);

  const switchMailbox = useCallback(async (who: typeof asUser) => {
    setAsUser(who);
    setView(null); setSelected(null); setEmails([]); setFolders([]);
    setListBusy(true);
    try {
      const r = await api.get<{ folders: Folder[] }>(
        who ? `/api/mail/as/${who.ownerId}/folders` : "/api/mail/folders");
      setFolders(r.folders);
      const inbox = r.folders.find((f) => f.type === "inbox") ?? r.folders[0];
      if (inbox) {
        const v: Virtual = { kind: "folder", id: inbox.id };
        setView(v);
        const params = new URLSearchParams({ page: "1", limit: "50", folder_id: String(inbox.id) });
        const l = await api.get<{ emails: MailListItem[]; pagination: { total: number } }>(
          who ? `/api/mail/as/${who.ownerId}/emails?${params}` : `/api/mail/emails?${params}`);
        setEmails(l.emails); setTotal(l.pagination.total);
      }
    } catch (e) { toast((e as Error).message); }
    setListBusy(false);
  }, [toast]);

  useEffect(() => {
    (async () => {
      try {
        const s = await api.get<{ enabled: boolean; address?: string }>("/api/mail/status");
        setStatus(s);
        if (!s.enabled) return;
        void api.get<{ sharedWithMe: typeof sharedWith }>("/api/mail/shares")
          .then((r) => setSharedWith(r.sharedWithMe ?? [])).catch(() => {});
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
      const d = await api.get<MailDetail>(mp(`/emails/${id}`));
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
    await api.post(mp(`/emails/${e.id}/star`), { starred: !e.is_starred }).catch(() => {});
    setEmails((es) => es.map((x) => (x.id === e.id ? { ...x, is_starred: e.is_starred ? 0 : 1 } : x)));
    if (selected?.id === e.id) setSelected({ ...selected, is_starred: e.is_starred ? 0 : 1 });
  };

  const toggleRead = async (e: MailListItem) => {
    await api.post(mp(`/emails/${e.id}/${e.is_read ? "unread" : "read"}`), {}).catch(() => {});
    if (view) void loadList(view, page, search);
    void loadFolders();
  };

  const removeEmail = async (e: MailListItem) => {
    await api.del(mp(`/emails/${e.id}`)).catch((err) => toast((err as Error).message));
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
      if (compose.draftId) await api.put(mp(`/drafts/${compose.draftId}`), payload);
      else await api.post(mp("/drafts"), payload);
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
      await api.post(mp("/send"), {
        to: compose.to, cc: compose.cc || undefined, bcc: compose.bcc || undefined,
        subject: compose.subject, body: compose.body,
        replyToId: compose.replyToId,
        attachments: attachments.length ? attachments : undefined,
      });
      toast("Sent");
      if (compose.draftId) await api.del(mp(`/drafts/${compose.draftId}`)).catch(() => {});
      setCompose(null);
      if (view) void loadList(view, page, search);
      void loadFolders();
    } catch (e) { toast(e instanceof Error ? e.message : "Send failed"); }
  };

  const addFolder = async () => {
    const name = newFolder.trim();
    if (!name) return;
    try {
      await api.post(mp("/folders"), { name });
      setNewFolder("");
      void loadFolders();
    } catch (e) { toast((e as Error).message); }
  };

  const renameFolder = async (f: Folder) => {
    const name = prompt("Rename folder", f.name)?.trim();
    if (!name || name === f.name) return;
    try {
      await api.patch(mp(`/folders/${f.id}`), { name });
      void loadFolders();
    } catch (e) { toast((e as Error).message); }
  };

  const deleteFolder = async (f: Folder) => {
    if (!confirm(`Delete folder "${f.name}"? Emails inside move to Trash.`)) return;
    try {
      await api.del(mp(`/folders/${f.id}`));
      if (view?.kind === "folder" && view.id === f.id) setView(null);
      void loadFolders();
    } catch (e) { toast((e as Error).message); }
  };

  const downloadAttachment = async (a: MailAttachment) => {
    try {
      const blob = await api.get<Blob>(mp(`/attachments/${a.id}`));
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
        {sharedWith.length > 0 && (
          <select className="mail-mbox" value={asUser?.ownerId ?? ""}
            onChange={(e) => void switchMailbox(sharedWith.find((s) => s.ownerId === e.target.value) ?? null)}>
            <option value="">{status.address ?? "My mailbox"}</option>
            {sharedWith.map((s) => (
              <option key={s.ownerId} value={s.ownerId}>{s.address ?? s.name} (shared)</option>
            ))}
          </select>
        )}
        {sharedWith.length === 0 && status.address && <span className="d-sub" style={{ marginLeft: 8 }}>{status.address}</span>}
        <button className="btn-ghost btn-sm" style={{ marginLeft: "auto" }} title="Mail settings"
          onClick={() => setSettingsOpen(true)}>⚙</button>
        <button className="btn-primary btn-sm"
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
            <div key={f.id} className={`mail-folder mail-folder-row ${viewActive({ kind: "folder", id: f.id }) ? "active" : ""}`}
              role="button" tabIndex={0}
              onClick={() => pickView({ kind: "folder", id: f.id })}
              onKeyDown={(e) => e.key === "Enter" && pickView({ kind: "folder", id: f.id })}>
              <span className="mail-folder-name">{f.icon === "folder" ? "📁" : (f.icon ?? "📁")} {f.name}</span>
              {!!f.unread_count && <span className="mail-count">{f.unread_count}</span>}
              <span className="mail-folder-tools">
                <i role="button" tabIndex={0} title="Rename"
                  onClick={(e) => { e.stopPropagation(); renameFolder(f); }}
                  onKeyDown={(e) => e.key === "Enter" && renameFolder(f)}>✎</i>
                <i role="button" tabIndex={0} title="Delete"
                  onClick={(e) => { e.stopPropagation(); void deleteFolder(f); }}
                  onKeyDown={(e) => e.key === "Enter" && void deleteFolder(f)}>✕</i>
              </span>
            </div>
          ))}
          <div className="mail-newfolder">
            <input placeholder="New folder…" value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void addFolder()} />
            <button className="iconbtn" title="Create folder" disabled={!newFolder.trim()}
              onClick={() => void addFolder()}>＋</button>
          </div>
        </aside>

        {/* message list */}
        <div className={`mail-list ${mobilePane === "list" ? "show" : ""}`}>
          <div className="mail-toolbar">
            <button className="iconbtn mail-only-mobile" onClick={() => setMobilePane("folders")} title="Folders">☰</button>
            <input className="mail-search" placeholder="Search mail…" value={search} onChange={(e) => onSearch(e.target.value)} />
            {!asUser && emails.length > 0 && (
              <button className="btn-ghost btn-sm" disabled={triageBusy} title="AI priority triage on the visible list"
                onClick={async () => {
                  setTriageBusy(true);
                  try {
                    const r = await api.post<{ triage: { id: string; priority: string; reason: string }[] }>(
                      "/api/ai/mail-triage", {
                        messages: emails.slice(0, 40).map((e) => ({
                          id: String(e.id), from: e.from_name || e.from_address,
                          subject: e.subject ?? "", snippet: e.snippet ?? "",
                        })),
                      });
                    setTriage((cur) => ({ ...cur, ...Object.fromEntries(r.triage.map((x) => [x.id, x])) }));
                    toast(`Triaged ${r.triage.length} messages`);
                  } catch (e) { toast((e as Error).message); }
                  setTriageBusy(false);
                }}>{triageBusy ? "…" : "✨ Triage"}</button>
            )}
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
                {triage[String(e.id)]?.priority === "high" && (
                  <span className="mail-pri high" title={triage[String(e.id)].reason}>▲</span>
                )}
                {triage[String(e.id)]?.priority === "low" && (
                  <span className="mail-pri low" title={triage[String(e.id)].reason}>▽</span>
                )}
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
      {settingsOpen && (
        <MailSettingsModal folders={folders} onClose={() => setSettingsOpen(false)} onToast={toast} />
      )}
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
  const [aiHint, setAiHint] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const { toast } = useToast();
  const aiDraft = async () => {
    setAiBusy(true);
    try {
      // quoted thread ("> " lines / "wrote:" marker) becomes reply context
      const quoted = value.body.match(/(\n\n—[\s\S]*)$/)?.[1] ?? "";
      const r = await api.post<{ text: string }>("/api/ai/compose", {
        task: value.replyToId ? "mail-reply" : "mail-draft",
        context: value.replyToId ? quoted.slice(0, 12000) : value.body.slice(0, 8000),
        instruction: [aiHint.trim(), value.subject ? `Subject: ${value.subject}` : ""].filter(Boolean).join("\n") || undefined,
      });
      const own = value.body.replace(/(\n\n—[\s\S]*)$/, "");
      onChange({ ...value, body: `${own ? `${own}\n\n` : ""}${r.text.trim()}${quoted}` });
    } catch (e) { toast((e as Error).message); }
    setAiBusy(false);
  };
  return (
    <Modal label={value.draftId ? "Edit draft" : "New message"} onClose={onClose} style={{ width: 640, maxWidth: "94vw" }}>
      <div className="mail-compose">
        <input placeholder="To" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} autoFocus />
        <input placeholder="Cc" value={value.cc} onChange={(e) => onChange({ ...value, cc: e.target.value })} />
        <input placeholder="Bcc" value={value.bcc} onChange={(e) => onChange({ ...value, bcc: e.target.value })} />
        <input placeholder="Subject" value={value.subject} onChange={(e) => onChange({ ...value, subject: e.target.value })} />
        <div className="mail-ai-row">
          <input placeholder="Tell AI what to write… (optional)" value={aiHint} onChange={(e) => setAiHint(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void aiDraft()} />
          <button className="btn-ghost btn-sm" disabled={aiBusy} onClick={() => void aiDraft()}>
            {aiBusy ? "Drafting…" : "✨ AI draft"}
          </button>
        </div>
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

// ── Mail settings: filters, aliases, vacation responder, forwarding ──────
// All proxied through /api/mail/* to the mail service's own endpoints.

const RULE_FIELDS = [
  { v: "from", label: "From" }, { v: "to", label: "To" },
  { v: "subject", label: "Subject" }, { v: "body", label: "Body" },
];
const RULE_OPS = [
  { v: "contains", label: "contains" }, { v: "equals", label: "equals" },
  { v: "starts_with", label: "starts with" }, { v: "ends_with", label: "ends with" },
];
const RULE_ACTIONS = [
  { v: "move_to_folder", label: "Move to folder" },
  { v: "mark_read", label: "Mark as read" },
  { v: "mark_star", label: "Star" },
  { v: "delete", label: "Delete" },
  { v: "block_sender", label: "Block sender" },
];

function MailSettingsModal({ folders, onClose, onToast }: {
  folders: Folder[]; onClose: () => void; onToast: (m: string) => void;
}) {
  const [tab, setTab] = useState<"rules" | "aliases" | "vacation" | "forwarding" | "sharing">("rules");
  const [rules, setRules] = useState<MailRule[]>([]);
  const [aliases, setAliases] = useState<MailAlias[]>([]);
  const [settings, setSettings] = useState<MailSettings>({});
  const [shares, setShares] = useState<{ id: string; userId: string; name: string; email: string }[]>([]);
  const [people, setPeople] = useState<{ id: string; displayName: string; email: string }[]>([]);
  const [sharePick, setSharePick] = useState("");
  const [rule, setRule] = useState({ name: "", field: "from", op: "contains", value: "", action: "move_to_folder", actionValue: "" });
  const [alias, setAlias] = useState({ email: "", forward: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<{ rules: MailRule[] }>("/api/mail/rules").then((r) => setRules(r.rules ?? [])).catch(() => {});
    void api.get<{ aliases: MailAlias[] }>("/api/mail/aliases").then((r) => setAliases(r.aliases ?? [])).catch(() => {});
    void api.get<MailSettings>("/api/mail/settings").then(setSettings).catch(() => {});
    void api.get<{ granted: typeof shares }>("/api/mail/shares").then((r) => setShares(r.granted ?? [])).catch(() => {});
    void api.get<{ people: typeof people }>("/api/chat/people").then((r) => setPeople(r.people ?? [])).catch(() => {});
  }, []);

  const addShare = async () => {
    if (!sharePick) return;
    setBusy(true);
    try {
      await api.post("/api/mail/shares", { userId: sharePick });
      const r = await api.get<{ granted: typeof shares }>("/api/mail/shares");
      setShares(r.granted ?? []);
      setSharePick("");
    } catch (e) { onToast((e as Error).message); }
    setBusy(false);
  };

  const delShare = async (id: string) => {
    await api.del(`/api/mail/shares/${id}`).catch((e) => onToast((e as Error).message));
    setShares((ss) => ss.filter((s) => s.id !== id));
  };

  const saveSettings = async (patch: Partial<MailSettings>) => {
    setBusy(true);
    try {
      await api.put("/api/mail/settings", patch);
      setSettings((s) => ({ ...s, ...patch }));
      onToast("Saved");
    } catch (e) { onToast((e as Error).message); }
    setBusy(false);
  };

  const addRule = async () => {
    if (!rule.name.trim() || !rule.value.trim()) return;
    setBusy(true);
    try {
      await api.post("/api/mail/rules", {
        name: rule.name.trim(), condition_field: rule.field, condition_op: rule.op,
        condition_value: rule.value.trim(), action: rule.action,
        action_value: rule.action === "move_to_folder" ? rule.actionValue : null,
      });
      const r = await api.get<{ rules: MailRule[] }>("/api/mail/rules");
      setRules(r.rules ?? []);
      setRule({ name: "", field: "from", op: "contains", value: "", action: "move_to_folder", actionValue: "" });
    } catch (e) { onToast((e as Error).message); }
    setBusy(false);
  };

  const delRule = async (id: number) => {
    await api.del(`/api/mail/rules/${id}`).catch((e) => onToast((e as Error).message));
    setRules((rs) => rs.filter((r) => r.id !== id));
  };

  const toggleRule = async (r: MailRule) => {
    try {
      await api.put(`/api/mail/rules/${r.id}`, {
        name: r.name, condition_field: r.condition_field, condition_op: r.condition_op,
        condition_value: r.condition_value, action: r.action, action_value: r.action_value,
        priority: r.priority, is_active: r.is_active ? 0 : 1,
      });
      setRules((rs) => rs.map((x) => x.id === r.id ? { ...x, is_active: r.is_active ? 0 : 1 } : x));
    } catch (e) { onToast((e as Error).message); }
  };

  const addAlias = async () => {
    if (!alias.email.trim() || !alias.forward.trim()) return;
    setBusy(true);
    try {
      await api.post("/api/mail/aliases", { alias_email: alias.email.trim(), forward_to: alias.forward.trim() });
      const r = await api.get<{ aliases: MailAlias[] }>("/api/mail/aliases");
      setAliases(r.aliases ?? []);
      setAlias({ email: "", forward: "" });
    } catch (e) { onToast((e as Error).message); }
    setBusy(false);
  };

  const delAlias = async (id: number) => {
    await api.del(`/api/mail/aliases/${id}`).catch((e) => onToast((e as Error).message));
    setAliases((as) => as.filter((a) => a.id !== id));
  };

  const tabs = [
    { k: "rules" as const, label: "Filters" }, { k: "aliases" as const, label: "Aliases" },
    { k: "vacation" as const, label: "Vacation" }, { k: "forwarding" as const, label: "Forwarding" },
    { k: "sharing" as const, label: "Sharing" },
  ];

  return (
    <Modal label="Mail settings" onClose={onClose} style={{ width: 620, maxWidth: "94vw" }}>
      <div className="mail-set-tabs">
        {tabs.map((t) => (
          <button key={t.k} className={`mail-set-tab${tab === t.k ? " active" : ""}`} onClick={() => setTab(t.k)}>{t.label}</button>
        ))}
      </div>

      {tab === "rules" && (
        <div className="ob-body">
          <p className="d-sub" style={{ marginTop: 0 }}>Incoming mail matching a filter is filed automatically — first match wins.</p>
          {rules.map((r) => (
            <div key={r.id} className="mail-set-row">
              <button className={`mail-toggle${r.is_active ? " on" : ""}`} onClick={() => void toggleRule(r)} />
              <div className="mail-set-main">
                <b>{r.name}</b>
                <span className="d-sub">
                  if {RULE_FIELDS.find((f) => f.v === r.condition_field)?.label ?? r.condition_field}{" "}
                  {RULE_OPS.find((o) => o.v === r.condition_op)?.label ?? r.condition_op} “{r.condition_value}”
                  → {RULE_ACTIONS.find((a) => a.v === r.action)?.label ?? r.action}
                  {r.action === "move_to_folder" && r.action_value
                    ? ` (${folders.find((f) => String(f.id) === r.action_value)?.name ?? "?"})` : ""}
                </span>
              </div>
              <button className="iconbtn" title="Delete filter" onClick={() => void delRule(r.id)}>✕</button>
            </div>
          ))}
          {!rules.length && <div className="d-sub" style={{ padding: "6px 0" }}>No filters yet.</div>}
          <div className="mail-set-form">
            <input placeholder="Filter name" value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} />
            <div className="mail-set-grid">
              <select value={rule.field} onChange={(e) => setRule({ ...rule, field: e.target.value })}>
                {RULE_FIELDS.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
              </select>
              <select value={rule.op} onChange={(e) => setRule({ ...rule, op: e.target.value })}>
                {RULE_OPS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
              </select>
              <input placeholder="value — e.g. invoices@" value={rule.value} onChange={(e) => setRule({ ...rule, value: e.target.value })} />
            </div>
            <div className="mail-set-grid">
              <select value={rule.action} onChange={(e) => setRule({ ...rule, action: e.target.value })}>
                {RULE_ACTIONS.map((a) => <option key={a.v} value={a.v}>{a.label}</option>)}
              </select>
              {rule.action === "move_to_folder" && (
                <select value={rule.actionValue} onChange={(e) => setRule({ ...rule, actionValue: e.target.value })}>
                  <option value="">Pick folder…</option>
                  {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              )}
              <button className="btn-primary btn-sm" disabled={busy || !rule.name.trim() || !rule.value.trim()}
                onClick={() => void addRule()}>Add filter</button>
            </div>
          </div>
        </div>
      )}

      {tab === "aliases" && (
        <div className="ob-body">
          <p className="d-sub" style={{ marginTop: 0 }}>Alias addresses deliver to your mailbox; each can forward a copy elsewhere.</p>
          {aliases.map((a) => (
            <div key={a.id} className="mail-set-row">
              <div className="mail-set-main">
                <b>{a.alias_email}</b>
                <span className="d-sub">forwards a copy to {a.forward_to}</span>
              </div>
              <button className="iconbtn" title="Delete alias" onClick={() => void delAlias(a.id)}>✕</button>
            </div>
          ))}
          {!aliases.length && <div className="d-sub" style={{ padding: "6px 0" }}>No aliases.</div>}
          <div className="mail-set-form">
            <input placeholder="alias@yourdomain.com" value={alias.email} onChange={(e) => setAlias({ ...alias, email: e.target.value })} />
            <div className="mail-set-grid">
              <input placeholder="forward copy to" value={alias.forward}
                onChange={(e) => setAlias({ ...alias, forward: e.target.value })} />
              <button className="btn-primary btn-sm" disabled={busy || !alias.email.trim() || !alias.forward.trim()}
                onClick={() => void addAlias()}>Add alias</button>
            </div>
          </div>
        </div>
      )}

      {tab === "vacation" && (
        <div className="ob-body">
          <label className="mail-set-check">
            <input type="checkbox" checked={!!settings.vacation_enabled}
              onChange={(e) => void saveSettings({ vacation_enabled: e.target.checked ? 1 : 0 })} />
            <b>Send automatic replies</b>
          </label>
          <input placeholder="Subject — e.g. Out of office" value={settings.vacation_subject ?? ""}
            onChange={(e) => setSettings({ ...settings, vacation_subject: e.target.value })}
            onBlur={() => void saveSettings({ vacation_subject: settings.vacation_subject })} />
          <textarea rows={5} placeholder="Reply body…" value={settings.vacation_body ?? ""}
            onChange={(e) => setSettings({ ...settings, vacation_body: e.target.value })}
            onBlur={() => void saveSettings({ vacation_body: settings.vacation_body })} />
          <div className="mail-set-grid">
            <label className="d-sub">From <input type="date" value={settings.vacation_start ?? ""}
              onChange={(e) => void saveSettings({ vacation_start: e.target.value || null })} /></label>
            <label className="d-sub">Until <input type="date" value={settings.vacation_end ?? ""}
              onChange={(e) => void saveSettings({ vacation_end: e.target.value || null })} /></label>
          </div>
        </div>
      )}

      {tab === "forwarding" && (
        <div className="ob-body">
          <p className="d-sub" style={{ marginTop: 0 }}>Forward a copy of every incoming message to another address.</p>
          <div className="mail-set-grid">
            <input placeholder="forward@elsewhere.com" value={settings.forward_to_address ?? ""}
              onChange={(e) => setSettings({ ...settings, forward_to_address: e.target.value })} />
            <button className="btn-primary btn-sm" disabled={busy}
              onClick={() => void saveSettings({ forward_to_address: settings.forward_to_address || null })}>Save</button>
          </div>
          <p className="d-sub" style={{ marginTop: 14 }}>Replies you send can come from a different address:</p>
          <div className="mail-set-grid">
            <input placeholder="reply-to@yourdomain.com" value={settings.reply_to_address ?? ""}
              onChange={(e) => setSettings({ ...settings, reply_to_address: e.target.value })} />
            <button className="btn-primary btn-sm" disabled={busy}
              onClick={() => void saveSettings({ reply_to_address: settings.reply_to_address || null })}>Save</button>
          </div>
        </div>
      )}

      {tab === "sharing" && (
        <div className="ob-body">
          <p className="d-sub" style={{ marginTop: 0 }}>
            Give a teammate full access to your mailbox — they read and send as you (send-on-behalf).
            Access is logged.
          </p>
          {shares.map((s) => (
            <div key={s.id} className="mail-set-row">
              <div className="mail-set-main">
                <b>{s.name}</b>
                <span className="d-sub">{s.email} — full access</span>
              </div>
              <button className="iconbtn" title="Revoke" onClick={() => void delShare(s.id)}>✕</button>
            </div>
          ))}
          {!shares.length && <div className="d-sub" style={{ padding: "6px 0" }}>Not shared with anyone.</div>}
          <div className="mail-set-grid" style={{ marginTop: 10 }}>
            <select value={sharePick} onChange={(e) => setSharePick(e.target.value)}>
              <option value="">Pick a member…</option>
              {people.filter((p) => !shares.some((s) => s.userId === p.id)).map((p) => (
                <option key={p.id} value={p.id}>{p.displayName} — {p.email}</option>
              ))}
            </select>
            <button className="btn-primary btn-sm" disabled={busy || !sharePick} onClick={() => void addShare()}>Share</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
