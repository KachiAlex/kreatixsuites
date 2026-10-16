import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, getToken } from "../lib/api";
import { API_BASE } from "../lib/platform";
import { useToast } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { useIsMobile } from "../lib/mobile";
import { Modal } from "../components/Modal";

// Kreatix Chat — Teams-style channels + DMs. Delivery is a per-user
// websocket (/api/chat/stream) with a polling fallback; the server
// fan-outs per org (channels) or per member list (dm/group).

interface Channel {
  id: string; kind: "channel" | "dm" | "group"; name: string | null;
  description: string | null; unread: number;
  members?: { id: string; displayName: string; initials: string }[];
  lastMessage: string | null; lastAt: string;
}
interface Message {
  id: string; channelId: string;
  author: { id: string; displayName: string | null; initials: string | null };
  body: string; replyTo: string | null; editedAt: string | null; createdAt: string;
}
interface Person { id: string; displayName: string; email: string; initials: string }

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const fmtDay = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? fmtTime(iso)
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export function Chat() {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const { msg, toast } = useToast();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [active, setActive] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [newChannel, setNewChannel] = useState(false);
  const [newChat, setNewChat] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [peopleQuery, setPeopleQuery] = useState("");
  const [chName, setChName] = useState("");
  const [chDesc, setChDesc] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const msgsRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  activeRef.current = active?.id ?? null;

  const loadChannels = useCallback(async () => {
    try {
      const r = await api.get<{ channels: Channel[] }>("/api/chat");
      setChannels(r.channels);
      setActive((a) => (a ? r.channels.find((c) => c.id === a.id) ?? a : a));
    } catch { /* listed on next tick */ }
  }, []);

  const loadMessages = useCallback(async (ch: Channel, before?: string) => {
    const r = await api.get<{ messages: Message[] }>(
      `/api/chat/${ch.id}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`);
    if (before) setMessages((m) => [...r.messages, ...m]);
    else {
      setMessages(r.messages);
      setHasMore(r.messages.length >= 50);
    }
    return r.messages;
  }, []);

  const open = useCallback(async (ch: Channel) => {
    setActive(ch); setReplyTo(null); setEditing(null); setDraft("");
    setMessages([]);
    try { await loadMessages(ch); } catch (e) { toast((e as Error).message); }
    void api.post(`/api/chat/${ch.id}/read`, {}).then(() => {
      setChannels((cs) => cs.map((c) => (c.id === ch.id ? { ...c, unread: 0 } : c)));
    }).catch(() => {});
  }, [loadMessages, toast]);

  // initial load + realtime stream
  useEffect(() => {
    void loadChannels();
    let dead = false, retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (dead) return;
      const t = getToken();
      if (!t) return;
      const wsProto = API_BASE ? API_BASE.replace(/^http/, "ws") : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
      const ws = new WebSocket(`${wsProto}/api/chat/stream?t=${encodeURIComponent(t)}`);
      wsRef.current = ws;
      ws.onmessage = (ev) => {
        try {
          const e = JSON.parse(ev.data as string) as
            | { t: "message"; channelId: string; message: Message }
            | { t: "channel"; channelId: string }
            | { t: "message:update"; channelId: string; messageId: string; body: string; editedAt: string }
            | { t: "message:delete"; channelId: string; messageId: string }
            | { t: "ready" };
          if (e.t === "channel") { void loadChannels(); return; }
          if (e.t === "message") {
            if (e.channelId === activeRef.current) {
              setMessages((m) => (m.some((x) => x.id === e.message.id) ? m : [...m, e.message]));
              void api.post(`/api/chat/${e.channelId}/read`, {}).catch(() => {});
            }
            void loadChannels();
            return;
          }
          if (e.t === "message:update") {
            setMessages((m) => m.map((x) => (x.id === e.messageId ? { ...x, body: e.body, editedAt: e.editedAt } : x)));
            return;
          }
          if (e.t === "message:delete") {
            setMessages((m) => m.filter((x) => x.id !== e.messageId));
            return;
          }
        } catch { /* malformed frame */ }
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (!dead) retry = setTimeout(connect, 4000);
      };
    };
    connect();
    // polling fallback — covers a dead socket between reconnects
    pollRef.current = setInterval(() => { if (!wsRef.current) void loadChannels(); }, 20_000);
    return () => {
      dead = true;
      if (retry) clearTimeout(retry);
      if (pollRef.current) clearInterval(pollRef.current);
      wsRef.current?.close();
    };
  }, [loadChannels]);

  // keep scrolled to the newest message
  useEffect(() => {
    const el = msgsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, active?.id]);

  const send = async () => {
    if (!active) return;
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    try {
      if (editing) {
        await api.patch(`/api/chat/messages/${editing.id}`, { body: text });
        setMessages((m) => m.map((x) => (x.id === editing.id ? { ...x, body: text, editedAt: new Date().toISOString() } : x)));
        setEditing(null);
      } else {
        const r = await api.post<{ message: Message }>(`/api/chat/${active.id}/messages`,
          { body: text, replyTo: replyTo?.id ?? null });
        setMessages((m) => (m.some((x) => x.id === r.message.id) ? m : [...m, r.message]));
        setReplyTo(null);
      }
      void loadChannels();
    } catch (e) {
      setDraft(text);
      toast((e as Error).message);
    }
  };

  const del = async (m: Message) => {
    try {
      await api.del(`/api/chat/messages/${m.id}`);
      setMessages((ms) => ms.filter((x) => x.id !== m.id));
    } catch (e) { toast((e as Error).message); }
  };

  const createChannel = async () => {
    if (!chName.trim()) return;
    try {
      const r = await api.post<{ channel: Channel }>("/api/chat/channels", { name: chName.trim(), description: chDesc.trim() || undefined });
      setNewChannel(false); setChName(""); setChDesc("");
      await loadChannels();
      const created = (await api.get<{ channels: Channel[] }>("/api/chat")).channels.find((c) => c.id === r.channel.id);
      if (created) void open(created);
    } catch (e) { toast((e as Error).message); }
  };

  const startDm = async () => {
    if (!picked.size) return;
    try {
      const r = await api.post<{ channel: { id: string } }>("/api/chat/dm", { userIds: [...picked] });
      setNewChat(false); setPicked(new Set()); setPeopleQuery("");
      await loadChannels();
      const created = (await api.get<{ channels: Channel[] }>("/api/chat")).channels.find((c) => c.id === r.channel.id);
      if (created) void open(created);
    } catch (e) { toast((e as Error).message); }
  };

  const loadPeople = async () => {
    try {
      const r = await api.get<{ people: Person[] }>("/api/chat/people");
      setPeople(r.people);
    } catch (e) { toast((e as Error).message); }
  };

  // deep links — /chat?c=<channelId> (search result) or /chat?dm=<userId> (person)
  const [search, setSearch] = useSearchParams();
  useEffect(() => {
    const cid = search.get("c"), dm = search.get("dm");
    if (!cid && !dm) return;
    const go = async () => {
      try {
        let target = cid;
        if (dm) {
          const r = await api.post<{ channel: { id: string } }>("/api/chat/dm", { userIds: [dm] });
          target = r.channel.id;
        }
        const r = await api.get<{ channels: Channel[] }>("/api/chat");
        setChannels(r.channels);
        const ch = r.channels.find((c) => c.id === target);
        if (ch) void open(ch);
      } catch { /* conversation may not exist yet */ }
      setSearch({}, { replace: true });
    };
    void go();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const chanList = channels.filter((c) => c.kind === "channel");
  const dmList = channels.filter((c) => c.kind !== "channel");
  const replySource = replyTo && messages.find((m) => m.id === replyTo.id);

  return (
    <div className="chat">
      <aside className={`chat-list${isMobile && active ? " hidden" : ""}`}>
        <div className="chat-list-h">
          <b>Chat</b>
          <div className="chat-list-actions">
            <button className="iconbtn" title="New chat" onClick={() => { setNewChat(true); void loadPeople(); }}>✎</button>
            <button className="iconbtn" title="New channel" onClick={() => setNewChannel(true)}>＋</button>
          </div>
        </div>
        <div className="chat-list-sec">Channels</div>
        {chanList.map((c) => (
          <button key={c.id} className={`chat-item${active?.id === c.id ? " active" : ""}`} onClick={() => void open(c)}>
            <span className="chat-hash">#</span>
            <span className="chat-item-main">
              <b className={c.unread ? "unread" : ""}>{c.name}</b>
              {c.lastMessage && <span className="chat-item-prev">{c.lastMessage.slice(0, 48)}</span>}
            </span>
            <span className="chat-item-side">
              <span className="chat-item-time">{fmtDay(c.lastAt)}</span>
              {c.unread > 0 && <span className="chat-badge">{c.unread > 99 ? "99+" : c.unread}</span>}
            </span>
          </button>
        ))}
        <div className="chat-list-sec">Direct messages</div>
        {dmList.map((c) => (
          <button key={c.id} className={`chat-item${active?.id === c.id ? " active" : ""}`} onClick={() => void open(c)}>
            <span className="chat-avatar">{c.members?.filter((m) => m.id !== user?.id)[0]?.initials ?? "?"}</span>
            <span className="chat-item-main">
              <b className={c.unread ? "unread" : ""}>{c.name}</b>
              {c.lastMessage && <span className="chat-item-prev">{c.lastMessage.slice(0, 48)}</span>}
            </span>
            <span className="chat-item-side">
              <span className="chat-item-time">{fmtDay(c.lastAt)}</span>
              {c.unread > 0 && <span className="chat-badge">{c.unread > 99 ? "99+" : c.unread}</span>}
            </span>
          </button>
        ))}
        {!dmList.length && <div className="chat-empty-side">No direct messages yet — hit ✎ to start one.</div>}
      </aside>

      <section className={`chat-pane${isMobile && !active ? " hidden" : ""}`}>
        {!active ? (
          <div className="chat-placeholder">
            <div className="empty">Pick a conversation, or start a new one.</div>
          </div>
        ) : (
          <>
            <div className="chat-pane-h">
              {isMobile && <button className="iconbtn" onClick={() => setActive(null)}>←</button>}
              {active.kind === "channel" ? <span className="chat-hash">#</span> : null}
              <b>{active.name}</b>
              {active.description && <span className="d-sub">— {active.description}</span>}
            </div>
            <div className="chat-msgs" ref={msgsRef}>
              {hasMore && messages.length > 0 && (
                <button className="chat-more" onClick={() => void loadMessages(active, messages[0].createdAt)}>Load earlier</button>
              )}
              {messages.map((m, i) => {
                const prev = messages[i - 1];
                const sameAuthor = prev && prev.author.id === m.author.id
                  && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
                const mine = m.author.id === user?.id;
                const quoted = m.replyTo ? messages.find((x) => x.id === m.replyTo) : null;
                return (
                  <div key={m.id} className={`chat-msg${sameAuthor ? " cont" : ""}`}>
                    {!sameAuthor && <span className="chat-avatar">{m.author.initials ?? "?"}</span>}
                    <div className="chat-msg-body">
                      {!sameAuthor && (
                        <div className="chat-msg-meta">
                          <b>{m.author.displayName ?? "Unknown"}</b>
                          <span className="chat-item-time">{fmtTime(m.createdAt)}</span>
                        </div>
                      )}
                      {quoted && <div className="chat-quote"><b>{quoted.author.displayName}</b> {quoted.body.slice(0, 90)}</div>}
                      <div className="chat-msg-text">
                        {m.body}
                        {m.editedAt && <span className="chat-edited">(edited)</span>}
                      </div>
                      <div className="chat-msg-actions">
                        <button title="Reply" onClick={() => { setReplyTo(m); setEditing(null); }}>↩</button>
                        {mine && <button title="Edit" onClick={() => { setEditing(m); setDraft(m.body); setReplyTo(null); }}>✎</button>}
                        {(mine || user?.role === "owner" || user?.role === "admin") && (
                          <button title="Delete" onClick={() => void del(m)}>🗑</button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {!messages.length && <div className="empty" style={{ padding: 24 }}>No messages yet — say hello.</div>}
            </div>
            {(replyTo || editing) && (
              <div className="chat-context">
                {editing ? `Editing message` : `Replying to ${replySource?.author.displayName ?? "message"}`}
                <button className="iconbtn" onClick={() => { setReplyTo(null); setEditing(null); setDraft(""); }}>✕</button>
              </div>
            )}
            <div className="chat-compose">
              <textarea
                value={draft} rows={1}
                placeholder={editing ? "Edit message…" : `Message ${active.kind === "channel" ? "#" : ""}${active.name ?? ""}`}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
                  if (e.key === "Escape") { setReplyTo(null); setEditing(null); setDraft(""); }
                }} />
              <button className="btn-primary btn-sm" disabled={!draft.trim()} onClick={() => void send()}>
                {editing ? "Save" : "Send"}
              </button>
            </div>
          </>
        )}
      </section>

      {newChannel && (
        <Modal label="New channel" onClose={() => setNewChannel(false)} style={{ width: 420 }}>
          <div className="ob-body">
            <input placeholder="Channel name — e.g. marketing" value={chName}
              onChange={(e) => setChName(e.target.value)} style={{ width: "100%", marginBottom: 10 }}
              onKeyDown={(e) => e.key === "Enter" && void createChannel()} autoFocus />
            <input placeholder="Description (optional)" value={chDesc}
              onChange={(e) => setChDesc(e.target.value)} style={{ width: "100%" }} />
            <div className="dlg-actions">
              <button className="btn-ghost" onClick={() => setNewChannel(false)}>Cancel</button>
              <button className="btn-primary" disabled={!chName.trim()} onClick={() => void createChannel()}>Create</button>
            </div>
          </div>
        </Modal>
      )}

      {newChat && (
        <Modal label="New chat" onClose={() => setNewChat(false)} style={{ width: 420 }}>
          <div className="ob-body">
            <input placeholder="Search people…" value={peopleQuery}
              onChange={(e) => setPeopleQuery(e.target.value)} style={{ width: "100%", marginBottom: 10 }} autoFocus />
            <div className="chat-people">
              {people
                .filter((p) => !peopleQuery || p.displayName.toLowerCase().includes(peopleQuery.toLowerCase()) || p.email.toLowerCase().includes(peopleQuery.toLowerCase()))
                .map((p) => (
                  <button key={p.id} className={`chat-person${picked.has(p.id) ? " picked" : ""}`}
                    onClick={() => setPicked((s) => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })}>
                    <span className="chat-avatar">{p.initials}</span>
                    <span className="chat-item-main"><b>{p.displayName}</b><span className="d-sub">{p.email}</span></span>
                    {picked.has(p.id) && <span>✓</span>}
                  </button>
                ))}
              {!people.length && <div className="chat-empty-side">No other members in this org yet.</div>}
            </div>
            <div className="dlg-actions">
              <button className="btn-ghost" onClick={() => setNewChat(false)}>Cancel</button>
              <button className="btn-primary" disabled={!picked.size} onClick={() => void startDm()}>
                Start{picked.size > 1 ? " group" : ""} chat
              </button>
            </div>
          </div>
        </Modal>
      )}
      {msg && <div className="toast" role="status">{msg}</div>}
    </div>
  );
}
