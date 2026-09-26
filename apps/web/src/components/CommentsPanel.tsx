import { useState } from "react";
import type { Comment } from "@kreatix/shared";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";

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
        {c.body}
      </div>
      <div className="c-actions">
        {canComment && !isReply && <button onClick={() => setReplyTo(replyTo === c.id ? null : c.id)}>Reply</button>}
        {canComment && <button onClick={() => toggleResolve(c)}>{c.resolved ? "Reopen" : "Resolve"}</button>}
        {canComment && <button onClick={() => remove(c)}>Delete</button>}
      </div>
      {replyTo === c.id && (
        <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
          <input value={replyDraft} onChange={(e) => setReplyDraft(e.target.value)} placeholder="Reply…" autoFocus
            onKeyDown={(e) => e.key === "Enter" && submitReply(c.id)}
            style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 9, padding: "6px 9px", fontSize: 12 }} />
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
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a comment on the selection…" autoFocus
              style={{ width: "100%", border: 0, outline: 0, resize: "none", fontSize: 12, height: 60 }} />
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
