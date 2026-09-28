import { useEffect, useRef, useState } from "react";
import type { Comment } from "@kreatix/shared";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";

interface MentionUser { id: string; email: string; displayName: string; initials: string }

/** Text input with @mention autocomplete — inserts "@First" tokens that the
 *  server-side mention resolver matches against display names/emails. */
function MentionField({ value, onChange, onSubmit, placeholder, users, textarea, autoFocus }: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  placeholder: string;
  users: MentionUser[];
  textarea?: boolean;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const [sugg, setSugg] = useState<MentionUser[] | null>(null);
  const [sel, setSel] = useState(0);

  const detect = (el: HTMLTextAreaElement | HTMLInputElement) => {
    const before = el.value.slice(0, el.selectionStart ?? el.value.length);
    const m = before.match(/@([\w.+-]*)$/);
    if (!m) { setSugg(null); return; }
    const ql = m[1].toLowerCase();
    const list = users.filter((u) =>
      u.displayName.toLowerCase().includes(ql) || u.email.toLowerCase().startsWith(ql)).slice(0, 6);
    setSugg(list.length ? list : null);
    setSel(0);
  };

  const pick = (u: MentionUser) => {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const m = before.match(/@([\w.+-]*)$/);
    const start = m?.index ?? caret;
    // first name is what the server-side resolver matches (display_name LIKE 'tok%')
    const token = u.displayName.split(/\s+/)[0];
    const next = value.slice(0, start) + "@" + token + " " + value.slice(caret);
    onChange(next);
    setSugg(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length + 2, start + token.length + 2);
    });
  };

  const keyDown = (e: React.KeyboardEvent) => {
    if (sugg?.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % sugg.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + sugg.length) % sugg.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(sugg[sel]); return; }
      if (e.key === "Escape") { setSugg(null); return; }
    }
    if (e.key === "Enter" && !textarea) onSubmit?.();
  };

  const shared = {
    ref,
    value,
    placeholder,
    autoFocus,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement & HTMLInputElement>) => { onChange(e.target.value); detect(e.target); },
    onKeyDown: keyDown,
    onClick: () => detect(ref.current!),
    onBlur: () => setTimeout(() => setSugg(null), 200),
  };

  return (
    <div style={{ position: "relative", flex: textarea ? undefined : 1 }}>
      {textarea
        ? <textarea {...shared} style={{ width: "100%", border: 0, outline: 0, resize: "none", fontSize: 12, height: 60 }} />
        : <input {...shared} style={{ width: "100%", flex: 1, border: "1px solid var(--line)", borderRadius: 9, padding: "6px 9px", fontSize: 12 }} />}
      {sugg && (
        <div className="mention-drop" role="listbox">
          {sugg.map((u, i) => (
            <button key={u.id} role="option" aria-selected={i === sel}
              className={`mention-item ${i === sel ? "on" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); pick(u); }}
              onMouseEnter={() => setSel(i)}>
              <span className="c-av" style={{ width: 20, height: 20, fontSize: 9 }}>{u.initials}</span>
              <span>{u.displayName}</span>
              <span className="mention-mail">{u.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function CommentsPanel({ fileId, comments, canComment, onReload, onAnchorClick, onNewComment, newCommentOpen, onCancelNew, toast }: {
  fileId: string;
  comments: Comment[];
  canComment: boolean;
  onReload: () => void;
  onAnchorClick?: (anchor: string) => void;
  onNewComment?: (body: string) => Promise<void>;
  newCommentOpen?: boolean;
  onCancelNew?: () => void;
  toast: (m: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const [mentionables, setMentionables] = useState<MentionUser[]>([]);

  useEffect(() => {
    void api.get<{ users: MentionUser[] }>(`/api/files/${fileId}/mentionable`)
      .then((r) => setMentionables(r.users))
      .catch(() => {});
  }, [fileId]);

  const roots = comments.filter((c) => !c.parentId && (showResolved || !c.resolved));
  const replies = (id: string) => comments.filter((c) => c.parentId === id);

  const submitReply = async (parentId: string) => {
    if (!replyDraft.trim()) return;
    await api.post(`/api/files/${fileId}/comments`, { body: replyDraft, parentId });
    setReplyDraft("");
    setReplyTo(null);
    onReload();
  };

  const toggleResolve = async (c: Comment) => {
    await api.patch(`/api/comments/${c.id}`, { resolved: !c.resolved });
    onReload();
  };

  const remove = async (c: Comment) => {
    await api.del(`/api/comments/${c.id}`);
    toast("Comment deleted");
    onReload();
  };

  const render = (c: Comment, isReply = false) => (
    <div className={`comment ${c.resolved ? "resolved" : ""}`} key={c.id} style={isReply ? { marginLeft: 18 } : undefined}>
      <div className="c-head">
        <div className="c-av">{c.author?.initials}</div>
        <b>{c.author?.displayName}</b>
        <span>{timeAgo(c.createdAt)}</span>
      </div>
      <div className="c-body" onClick={() => c.anchor && onAnchorClick?.(c.anchor)} style={c.anchor ? { cursor: "pointer" } : undefined}>
        {c.body.split(/(@[\w.+-]+)/g).map((part, i) =>
          part.startsWith("@") ? <b key={i} className="mention-token">{part}</b> : part)}
      </div>
      <div className="c-actions">
        {canComment && !isReply && <button onClick={() => setReplyTo(replyTo === c.id ? null : c.id)}>Reply</button>}
        {canComment && <button onClick={() => toggleResolve(c)}>{c.resolved ? "Reopen" : "Resolve"}</button>}
        {canComment && <button onClick={() => remove(c)}>Delete</button>}
      </div>
      {replyTo === c.id && (
        <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
          <MentionField value={replyDraft} onChange={setReplyDraft} onSubmit={() => submitReply(c.id)}
            placeholder="Reply… (use @ to mention)" users={mentionables} autoFocus />
          <button className="btn-primary btn-sm" onClick={() => submitReply(c.id)}>↗</button>
        </div>
      )}
    </div>
  );

  return (
    <div className="side-panel">
      <div className="sp-head">
        <h3>Comments</h3>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 10, color: "var(--muted)", display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> resolved
          </label>
          <button className="sp-close" onClick={onCancelNew}>✕</button>
        </div>
      </div>
      <div className="sp-body">
        {newCommentOpen && (
          <div className="comment">
            <MentionField value={draft} onChange={setDraft} placeholder="Add a comment on the selection… (use @ to mention)"
              users={mentionables} textarea autoFocus />
            <div className="c-actions">
              <button onClick={async () => { if (draft.trim()) { await onNewComment?.(draft); setDraft(""); } }}
                style={{ background: "var(--k-orange)", color: "#fff" }}>Comment</button>
              <button onClick={onCancelNew}>Cancel</button>
            </div>
          </div>
        )}
        {roots.map((c) => (
          <div key={c.id}>
            {render(c)}
            {replies(c.id).map((r) => render(r, true))}
          </div>
        ))}
        {!roots.length && !newCommentOpen && (
          <div className="empty">No comments yet.<br />Select text and press 💬 to comment.</div>
        )}
      </div>
    </div>
  );
}
