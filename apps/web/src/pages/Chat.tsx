import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
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
  description: string | null; topic: string | null; unread: number;
  members?: { id: string; displayName: string; initials: string }[];
  lastMessage: string | null; lastAt: string;
}
interface Reaction { emoji: string; count: number; mine: boolean }
interface Message {
  id: string; channelId: string;
  author: { id: string; displayName: string | null; initials: string | null };
  body: string; replyTo: string | null; editedAt: string | null; createdAt: string;
  pinnedAt: string | null; replyCount: number; reactions: Reaction[];
  parent: { id: string; author: string; body: string } | null;
  file: { id: string; name: string; kind: string } | null;
}
interface Person { id: string; displayName: string; email: string; initials: string }

/** handle a mention resolves to: first word of the display name or the
 *  email localpart (mirrors the server's mentionedUsers matching). */
const handle = (p: Person) =>
  (p.displayName.split(/\s+/)[0] || p.email.split("@")[0]).toLowerCase();

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
  const [summary, setSummary] = useState<string | null>(null);
  const [sumBusy, setSumBusy] = useState(false);
  const [attach, setAttach] = useState<{ id: string; name: string } | null>(null);
  const [mentionQ, setMentionQ] = useState<string | null>(null);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [typing, setTyping] = useState<Record<string, string>>({});  // userId → name (active channel)
  const [thread, setThread] = useState<Message | null>(null);       // open thread parent
  const [threadMsgs, setThreadMsgs] = useState<Message[]>([]);
  const [threadDraft, setThreadDraft] = useState("");
  const [pinsOpen, setPinsOpen] = useState(false);
  const [pins, setPins] = useState<Message[]>([]);
  const [topicEdit, setTopicEdit] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");
  const [reactFor, setReactFor] = useState<string | null>(null);    // message id w/ picker open
  const typingSent = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();
  const msgsRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(null);
  const threadRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  activeRef.current = active?.id ?? null;
  threadRef.current = thread?.id ?? null;

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
    setThread(null); setThreadMsgs([]); setPinsOpen(false); setTopicEdit(false);
    setTyping({}); setReactFor(null);
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
            | { t: "reaction"; channelId: string; messageId: string; emoji: string; userId: string; added: boolean }
            | { t: "pin"; channelId: string; messageId: string; pinned: boolean }
            | { t: "typing"; channelId: string; userId: string; name: string }
            | { t: "presence"; userId: string; online: boolean }
            | { t: "ready"; online?: string[] };
          if (e.t === "ready") { setOnline(new Set(e.online ?? [])); return; }
          if (e.t === "presence") {
            setOnline((s) => { const n = new Set(s); e.online ? n.add(e.userId) : n.delete(e.userId); return n; });
            return;
          }
          if (e.t === "channel") { void loadChannels(); return; }
          if (e.t === "message") {
            // thread replies bump the parent's count + refresh the open thread
            if (e.message.replyTo) {
              setMessages((m) => m.map((x) => x.id === e.message.replyTo
                ? { ...x, replyCount: x.replyCount + 1 } : x));
              setThreadMsgs((tm) => (threadRef.current === e.message.replyTo
                && !tm.some((x) => x.id === e.message.id) ? [...tm, e.message] : tm));
            }
            if (e.channelId === activeRef.current) {
              setMessages((m) => (m.some((x) => x.id === e.message.id) || e.message.replyTo ? m : [...m, e.message]));
              void api.post(`/api/chat/${e.channelId}/read`, {}).catch(() => {});
            }
            void loadChannels();
            return;
          }
          if (e.t === "message:update") {
            setMessages((m) => m.map((x) => (x.id === e.messageId ? { ...x, body: e.body, editedAt: e.editedAt } : x)));
            setThreadMsgs((m) => m.map((x) => (x.id === e.messageId ? { ...x, body: e.body, editedAt: e.editedAt } : x)));
            return;
          }
          if (e.t === "message:delete") {
            setMessages((m) => m.filter((x) => x.id !== e.messageId));
            setThreadMsgs((m) => m.filter((x) => x.id !== e.messageId));
            return;
          }
          if (e.t === "reaction") {
            const apply = (x: Message): Message => {
              if (x.id !== e.messageId) return x;
              let rx = x.reactions.map((r) => ({ ...r }));
              const hit = rx.find((r) => r.emoji === e.emoji);
              if (e.added) {
                if (hit) { hit.count++; if (e.userId === user?.id) hit.mine = true; }
                else rx.push({ emoji: e.emoji, count: 1, mine: e.userId === user?.id });
              } else if (hit) {
                hit.count--;
                if (e.userId === user?.id) hit.mine = false;
                if (hit.count <= 0) rx = rx.filter((r) => r !== hit);
              }
              return { ...x, reactions: rx };
            };
            setMessages((m) => m.map(apply));
            setThreadMsgs((m) => m.map(apply));
            return;
          }
          if (e.t === "pin") {
            setMessages((m) => m.map((x) => x.id === e.messageId
              ? { ...x, pinnedAt: e.pinned ? new Date().toISOString() : null } : x));
            return;
          }
          if (e.t === "typing") {
            if (e.channelId !== activeRef.current || e.userId === user?.id) return;
            setTyping((t) => ({ ...t, [e.userId]: e.name }));
            setTimeout(() => setTyping((t) => {
              const n = { ...t }; delete n[e.userId]; return n;
            }), 3500);
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
    if (!text && !attach) return;
    const file = attach;
    setDraft(""); setAttach(null); setMentionQ(null);
    try {
      if (editing) {
        await api.patch(`/api/chat/messages/${editing.id}`, { body: text });
        setMessages((m) => m.map((x) => (x.id === editing.id ? { ...x, body: text, editedAt: new Date().toISOString() } : x)));
        setEditing(null);
      } else {
        const r = await api.post<{ message: Message }>(`/api/chat/${active.id}/messages`,
          { body: text, replyTo: replyTo?.id ?? null, fileId: file?.id ?? null });
        setMessages((m) => (m.some((x) => x.id === r.message.id) ? m : [...m, r.message]));
        setReplyTo(null);
      }
      void loadChannels();
    } catch (e) {
      setDraft(text); setAttach(file);
      toast((e as Error).message);
    }
  };

  /** Attach from this computer: upload straight into Drive, then post the
   *  returned item id on the message. */
  const attachFile = async (f: File) => {
    try {
      const r = await api.upload<{ item: { id: string; name: string } }>(
        `/api/drive/upload?name=${encodeURIComponent(f.name)}`, f);
      setAttach({ id: r.item.id, name: r.item.name });
      draftRef.current?.focus();
    } catch (e) { toast((e as Error).message); }
  };

  /** @-autocomplete: while the caret trails `@word`, offer org people.
   *  Picking inserts `@handle ` which the server resolves to a bell ping. */
  const mentionMatches = mentionQ !== null
    ? people.filter((p) => handle(p).startsWith(mentionQ)
        || p.displayName.toLowerCase().includes(mentionQ)).slice(0, 6)
    : [];

  const onDraft = (v: string) => {
    setDraft(v);
    // typing ping — throttled to one frame per 2.5s, fire-and-forget
    if (v && active && Date.now() - typingSent.current > 2500
        && wsRef.current?.readyState === WebSocket.OPEN) {
      typingSent.current = Date.now();
      wsRef.current.send(JSON.stringify({ t: "typing", channelId: active.id }));
    }
    const caret = draftRef.current?.selectionStart ?? v.length;
    const before = v.slice(0, caret);
    const m = before.match(/@([a-zA-Z0-9._-]*)$/);
    if (m) {
      if (!people.length) void loadPeople();
      setMentionQ(m[1].toLowerCase());
    } else setMentionQ(null);
  };

  const pickMention = (p: Person) => {
    const caret = draftRef.current?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret).replace(/@[a-zA-Z0-9._-]*$/, `@${handle(p)} `);
    setDraft(before + draft.slice(caret));
    setMentionQ(null);
    draftRef.current?.focus();
  };

  const summarize = async () => {
    if (!active || !messages.length) return;
    setSumBusy(true);
    try {
      const transcript = messages.slice(-60)
        .map((m) => `${m.author.displayName ?? "Unknown"}: ${m.body}`)
        .join("\n").slice(-20000);
      const r = await api.post<{ text: string }>("/api/ai/compose", {
        task: "chat-summary",
        context: transcript,
        instruction: `Conversation: ${active.name ?? "chat"}`,
      });
      setSummary(r.text);
    } catch (e) { toast((e as Error).message); }
    setSumBusy(false);
  };

  const del = async (m: Message) => {
    try {
      await api.del(`/api/chat/messages/${m.id}`);
      setMessages((ms) => ms.filter((x) => x.id !== m.id));
      setThreadMsgs((ms) => ms.filter((x) => x.id !== m.id));
    } catch (e) { toast((e as Error).message); }
  };

  const REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "😢", "🙏", "🔥"];

  const react = async (m: Message, emoji: string) => {
    setReactFor(null);
    try {
      const r = await api.post<{ added: boolean }>(`/api/chat/messages/${m.id}/reactions`, { emoji });
      // optimistic patch (the ws echo also lands — same reducer, idempotent-ish)
      const apply = (x: Message): Message => {
        if (x.id !== m.id) return x;
        let rx = x.reactions.map((e) => ({ ...e }));
        const hit = rx.find((e) => e.emoji === emoji);
        if (r.added) {
          if (hit) { hit.count++; hit.mine = true; }
          else rx.push({ emoji, count: 1, mine: true });
        } else if (hit) {
          hit.count--; hit.mine = false;
          if (hit.count <= 0) rx = rx.filter((e) => e !== hit);
        }
        return { ...x, reactions: rx };
      };
      setMessages((ms) => ms.map(apply));
      setThreadMsgs((ms) => ms.map(apply));
    } catch (e) { toast((e as Error).message); }
  };

  const togglePin = async (m: Message) => {
    try {
      const r = await api.post<{ pinned: boolean }>(`/api/chat/messages/${m.id}/pin`, {});
      setMessages((ms) => ms.map((x) => x.id === m.id
        ? { ...x, pinnedAt: r.pinned ? new Date().toISOString() : null } : x));
      toast(r.pinned ? "Pinned" : "Unpinned");
    } catch (e) { toast((e as Error).message); }
  };

  const openThread = async (m: Message) => {
    setThread(m); setThreadDraft("");
    try {
      const r = await api.get<{ parent: Message; replies: Message[] }>(`/api/chat/messages/${m.id}/thread`);
      setThreadMsgs(r.replies);
    } catch (e) { toast((e as Error).message); }
  };

  const sendThread = async () => {
    const text = threadDraft.trim();
    if (!text || !active || !thread) return;
    setThreadDraft("");
    try {
      const r = await api.post<{ message: Message }>(`/api/chat/${active.id}/messages`,
        { body: text, replyTo: thread.id });
      setThreadMsgs((tm) => [...tm, r.message]);
      setMessages((ms) => ms.map((x) => x.id === thread.id ? { ...x, replyCount: x.replyCount + 1 } : x));
      setThread((t) => t ? { ...t, replyCount: t.replyCount + 1 } : t);
    } catch (e) { setThreadDraft(text); toast((e as Error).message); }
  };

  const openPins = async () => {
    if (!active) return;
    if (pinsOpen) { setPinsOpen(false); return; }
    try {
      const r = await api.get<{ pins: Message[] }>(`/api/chat/${active.id}/pins`);
      setPins(r.pins); setPinsOpen(true);
    } catch (e) { toast((e as Error).message); }
  };

  const saveTopic = async () => {
    if (!active) return;
    try {
      await api.patch(`/api/chat/${active.id}`, { topic: topicDraft });
      setActive((a) => a ? { ...a, topic: topicDraft || null } : a);
      setTopicEdit(false);
      void loadChannels();
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
  const topLevel = messages.filter((m) => !m.replyTo);
  const replySource = replyTo && (messages.find((m) => m.id === replyTo.id)
    ?? threadMsgs.find((m) => m.id === replyTo.id) ?? (thread?.id === replyTo.id ? thread : null));

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
        {dmList.map((c) => {
          const other = c.members?.filter((m) => m.id !== user?.id)[0];
          return (
          <button key={c.id} className={`chat-item${active?.id === c.id ? " active" : ""}`} onClick={() => void open(c)}>
            <span className="chat-avatar chat-avatar-wrap">{other?.initials ?? "?"}
              {other && <span className={`chat-dot${online.has(other.id) ? " on" : ""}`} />}</span>
            <span className="chat-item-main">
              <b className={c.unread ? "unread" : ""}>{c.name}</b>
              {c.lastMessage && <span className="chat-item-prev">{c.lastMessage.slice(0, 48)}</span>}
            </span>
            <span className="chat-item-side">
              <span className="chat-item-time">{fmtDay(c.lastAt)}</span>
              {c.unread > 0 && <span className="chat-badge">{c.unread > 99 ? "99+" : c.unread}</span>}
            </span>
          </button>
          );
        })}
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
              {active.kind === "channel" && !topicEdit && (
                <button className="chat-topic" title="Edit topic"
                  onClick={() => { setTopicDraft(active.topic ?? ""); setTopicEdit(true); }}>
                  {active.topic || <span className="d-sub">Add a topic</span>}
                </button>
              )}
              {topicEdit && (
                <span className="chat-topic-edit">
                  <input value={topicDraft} autoFocus maxLength={200}
                    onChange={(e) => setTopicDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void saveTopic(); if (e.key === "Escape") setTopicEdit(false); }} />
                  <button className="iconbtn" onClick={() => void saveTopic()}>✓</button>
                </span>
              )}
              <button className="btn-ghost btn-sm" style={{ marginLeft: "auto" }}
                title="Pinned messages" onClick={() => void openPins()}>📌</button>
              <button className="btn-ghost btn-sm" disabled={sumBusy || !messages.length}
                title="Summarize the loaded conversation with Kreatix AI"
                onClick={() => void summarize()}>{sumBusy ? "Summarizing…" : "✨ Summary"}</button>
            </div>
            {pinsOpen && (
              <div className="chat-pins">
                {!pins.length && <span className="d-sub">Nothing pinned yet — hover a message → 📌.</span>}
                {pins.map((p) => (
                  <div key={p.id} className="chat-pin">
                    <b>{p.author.displayName}</b>
                    <span className="chat-pin-body">{p.body.slice(0, 140)}</span>
                    <button className="iconbtn" title="Unpin" onClick={() => void togglePin(p)
                      .then(() => api.get<{ pins: Message[] }>(`/api/chat/${active.id}/pins`))
                      .then((r) => setPins(r.pins))}>✕</button>
                  </div>
                ))}
              </div>
            )}
            <div className="chat-msgs" ref={msgsRef}>
              {hasMore && messages.length > 0 && (
                <button className="chat-more" onClick={() => void loadMessages(active, messages[0].createdAt)}>Load earlier</button>
              )}
              {topLevel.map((m, i) => {
                const prev = topLevel[i - 1];
                const sameAuthor = prev && prev.author.id === m.author.id
                  && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
                const mine = m.author.id === user?.id;
                return (
                  <div key={m.id} className={`chat-msg${sameAuthor ? " cont" : ""}${m.pinnedAt ? " pinned" : ""}`}>
                    {!sameAuthor && <span className="chat-avatar">{m.author.initials ?? "?"}</span>}
                    <div className="chat-msg-body">
                      {!sameAuthor && (
                        <div className="chat-msg-meta">
                          <b>{m.author.displayName ?? "Unknown"}</b>
                          <span className="chat-item-time">{fmtTime(m.createdAt)}</span>
                          {m.pinnedAt && <span className="chat-pinned-tag" title="Pinned">📌</span>}
                        </div>
                      )}
                      <div className="chat-msg-text">
                        {m.body}
                        {m.editedAt && <span className="chat-edited">(edited)</span>}
                      </div>
                      {m.file && (
                        <button className="chat-file" title="Open in Drive"
                          onClick={() => navigate(m.file!.kind === "folder" ? `/drive/folder/${m.file!.id}` : `/edit/${m.file!.id}`)}>
                          📄 {m.file.name}
                        </button>
                      )}
                      {m.reactions.length > 0 && (
                        <div className="chat-rxns">
                          {m.reactions.map((r) => (
                            <button key={r.emoji} className={`chat-rxn${r.mine ? " mine" : ""}`}
                              onClick={() => void react(m, r.emoji)}>
                              {r.emoji} {r.count}
                            </button>
                          ))}
                        </div>
                      )}
                      {m.replyCount > 0 && (
                        <button className="chat-thread-link" onClick={() => void openThread(m)}>
                          💬 {m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}
                        </button>
                      )}
                      <div className="chat-msg-actions">
                        <button title="React" onClick={() => setReactFor(reactFor === m.id ? null : m.id)}>☺</button>
                        <button title="Reply inline" onClick={() => { setReplyTo(m); setEditing(null); }}>↩</button>
                        <button title="Reply in thread" onClick={() => void openThread(m)}>🧵</button>
                        <button title={m.pinnedAt ? "Unpin" : "Pin"} onClick={() => void togglePin(m)}>📌</button>
                        {mine && <button title="Edit" onClick={() => { setEditing(m); setDraft(m.body); setReplyTo(null); }}>✎</button>}
                        {(mine || user?.role === "owner" || user?.role === "admin") && (
                          <button title="Delete" onClick={() => void del(m)}>🗑</button>
                        )}
                      </div>
                      {reactFor === m.id && (
                        <div className="chat-emoji-pop">
                          {REACTIONS.map((e) => (
                            <button key={e} onClick={() => void react(m, e)}>{e}</button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {!topLevel.length && <div className="empty" style={{ padding: 24 }}>No messages yet — say hello.</div>}
            </div>
            {Object.keys(typing).length > 0 && (
              <div className="chat-typing">{Object.values(typing).join(", ")} {Object.keys(typing).length === 1 ? "is" : "are"} typing…</div>
            )}
            {(replyTo || editing || attach) && (
              <div className="chat-context">
                {attach
                  ? <>📎 {attach.name}<button className="iconbtn" onClick={() => setAttach(null)}>✕</button></>
                  : <>{editing ? "Editing message" : `Replying to ${replySource?.author.displayName ?? "message"}`}
                    <button className="iconbtn" onClick={() => { setReplyTo(null); setEditing(null); setDraft(""); }}>✕</button></>}
              </div>
            )}
            <div className="chat-compose">
              {mentionMatches.length > 0 && (
                <div className="chat-mentions">
                  {mentionMatches.map((p) => (
                    <button key={p.id} className="chat-person" onMouseDown={(e) => { e.preventDefault(); pickMention(p); }}>
                      <span className="chat-avatar">{p.initials}</span>
                      <span className="chat-item-main"><b>{p.displayName}</b><span className="d-sub">@{handle(p)}</span></span>
                    </button>
                  ))}
                </div>
              )}
              <input ref={fileRef} type="file" hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void attachFile(f); e.target.value = ""; }} />
              <button className="iconbtn" title="Attach file" onClick={() => fileRef.current?.click()}>📎</button>
              <textarea
                ref={draftRef}
                value={draft} rows={1}
                placeholder={editing ? "Edit message…" : `Message ${active.kind === "channel" ? "#" : ""}${active.name ?? ""}`}
                onChange={(e) => onDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !mentionMatches.length) { e.preventDefault(); void send(); }
                  if (e.key === "Escape") {
                    if (mentionQ !== null) setMentionQ(null);
                    else { setReplyTo(null); setEditing(null); setDraft(""); }
                  }
                }} />
              <button className="btn-primary btn-sm" disabled={!draft.trim() && !attach} onClick={() => void send()}>
                {editing ? "Save" : "Send"}
              </button>
            </div>
          </>
        )}
      </section>

      {thread && (
        <aside className="chat-thread">
          <div className="chat-thread-h">
            <b>Thread</b>
            <button className="iconbtn" onClick={() => { setThread(null); setThreadMsgs([]); }}>✕</button>
          </div>
          <div className="chat-thread-parent">
            <span className="chat-avatar">{thread.author.initials ?? "?"}</span>
            <div>
              <div className="chat-msg-meta"><b>{thread.author.displayName ?? "Unknown"}</b>
                <span className="chat-item-time">{fmtTime(thread.createdAt)}</span></div>
              <div className="chat-msg-text">{thread.body}</div>
            </div>
          </div>
          <div className="chat-thread-msgs">
            {threadMsgs.map((m) => (
              <div key={m.id} className="chat-msg">
                <span className="chat-avatar">{m.author.initials ?? "?"}</span>
                <div className="chat-msg-body">
                  <div className="chat-msg-meta"><b>{m.author.displayName ?? "Unknown"}</b>
                    <span className="chat-item-time">{fmtTime(m.createdAt)}</span></div>
                  <div className="chat-msg-text">{m.body}
                    {m.editedAt && <span className="chat-edited">(edited)</span>}</div>
                  {m.reactions.length > 0 && (
                    <div className="chat-rxns">
                      {m.reactions.map((r) => (
                        <button key={r.emoji} className={`chat-rxn${r.mine ? " mine" : ""}`}
                          onClick={() => void react(m, r.emoji)}>{r.emoji} {r.count}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {!threadMsgs.length && <div className="chat-empty-side">No replies yet.</div>}
          </div>
          <div className="chat-compose">
            <textarea value={threadDraft} rows={1} placeholder={`Reply to ${thread.author.displayName ?? "thread"}…`}
              onChange={(e) => setThreadDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendThread(); }
                if (e.key === "Escape") { setThread(null); setThreadMsgs([]); }
              }} />
            <button className="btn-primary btn-sm" disabled={!threadDraft.trim()} onClick={() => void sendThread()}>Send</button>
          </div>
        </aside>
      )}

      {summary && (
        <Modal label="Conversation summary" onClose={() => setSummary(null)} style={{ width: 480 }}>
          <div className="ob-body"><p style={{ whiteSpace: "pre-wrap" }}>{summary}</p></div>
        </Modal>
      )}

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
