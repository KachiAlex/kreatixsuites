import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, mediaUrl } from "../lib/api";
import { useToast } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { Modal } from "../components/Modal";

// Kreatix Meet — video meetings inside the suite, Teams-style. The API mints
// per-join Jitsi JWTs; the room itself is embedded via JitsiMeetExternalAPI
// from the self-hosted jitsi stack.

interface Meeting {
  id: string; code: string; title: string; status: string;
  scheduledAt: string | null; createdBy: string; createdByName: string | null;
  createdAt: string; endedAt: string | null; recordings: number; channelId: string | null;
  summary: string | null; personal?: boolean;
}
interface Rec {
  id: string; size: number | null; durationSec: number | null; createdAt: string; name: string;
  clipStart: number | null; clipEnd: number | null; hasTranscript: boolean;
}
interface JoinInfo { base: string; room: string; jwt: string; displayName: string; meetingId: string; channelId: string | null; dialIn: string | null; moderator?: boolean }
interface ChatMsg { id: string; body: string; author: { id: string; name: string; initials: string }; createdAt: string }

declare global {
  interface Window {
    JitsiMeetExternalAPI?: new (domain: string, opts: Record<string, unknown>) => {
      dispose: () => void;
      addListeners?: (m: Record<string, () => void>) => void;
      addListener?: (e: string, f: () => void) => void;
    }
  }
}

// Injects external_api.js once; prefetched on page mount so joining is instant.
// The element removes itself on load failure so a later join re-injects it.
const ensureMeetClient = (base: string, onload?: () => void, onerror?: () => void) => {
  if (window.JitsiMeetExternalAPI) { onload?.(); return; }
  let s = document.querySelector<HTMLScriptElement>("script[data-kx-meet]");
  if (!s) {
    s = document.createElement("script");
    s.src = `${base}/external_api.js`;
    s.dataset.kxMeet = "1";
    s.addEventListener("error", () => s?.remove(), { once: true });
    document.head.appendChild(s);
  }
  if (onload) s.addEventListener("load", onload, { once: true });
  if (onerror) s.addEventListener("error", onerror, { once: true });
};

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function Meet() {
  const { user } = useAuth();
  const { msg, toast } = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [joinCode, setJoinCode] = useState("");
  const [schedOpen, setSchedOpen] = useState(false);
  const [schedTitle, setSchedTitle] = useState("");
  const [schedAt, setSchedAt] = useState("");
  const [call, setCall] = useState<JoinInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [recOn, setRecOn] = useState(false);
  const [dialIn, setDialIn] = useState<string | null>(null);
  const [recFor, setRecFor] = useState<string | null>(null);      // meeting id w/ open list
  const [recs, setRecs] = useState<Rec[]>([]);
  const [attFor, setAttFor] = useState<string | null>(null);
  const [attendees, setAttendees] = useState<{ userId: string; name: string; joinedAt: string; leftAt: string | null }[]>([]);
  const [meetChat, setMeetChat] = useState<ChatMsg[]>([]);
  const [roster, setRoster] = useState<{ name: string; leftAt: string | null }[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const chatRef = useRef<HTMLDivElement>(null);
  const recVideoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const frameHost = useRef<HTMLDivElement>(null);
  const apiRef = useRef<{ dispose: () => void } | null>(null);

  const load = useCallback(async () => {
    const r = await api.get<{ enabled: boolean; base?: string; recording?: boolean; dialIn?: string | null; meetings?: Meeting[] }>("/api/meet");
    setEnabled(r.enabled);
    setRecOn(!!r.recording);
    setDialIn(r.dialIn ?? null);
    setMeetings(r.meetings ?? []);
    if (r.enabled && r.base) ensureMeetClient(r.base);
  }, []);

  useEffect(() => { load().catch(() => setEnabled(false)); }, [load]);

  // ?join=<meetingId> — deep link from Calendar event Join buttons
  const [search] = useSearchParams();
  const joinParam = search.get("join");
  useEffect(() => {
    if (!joinParam) return;
    api.get<{ join: JoinInfo }>(`/api/meet/${joinParam}/join`)
      .then((r) => setCall(r.join))
      .catch(() => toast("Could not join that meeting"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinParam]);

  // mount the Jitsi iframe when a join is active
  useEffect(() => {
    if (!call || !frameHost.current) return;
    let cancelled = false;
    const host = frameHost.current;
    const domain = call.base.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const boot = () => {
      if (cancelled || !window.JitsiMeetExternalAPI || !host.isConnected) return;
      const inst = new window.JitsiMeetExternalAPI(domain, {
        roomName: call.room,
        jwt: call.jwt,
        parentNode: host,
        width: "100%",
        height: "100%",
        userInfo: { displayName: call.displayName, email: user?.email },
        configOverwrite: {
          disableDeepLinking: true,
          prejoinConfig: { enabled: false },           // straight into the call — name/mic controls live in-call
          disableThirdPartyRequests: true,             // no gravatar/callstats/etc fetches
          disableInviteFunctions: true,                // sharing goes through suite links
          localRecording: { disable: true },           // recording is server-side (Jibri)
          channelLastN: 8,                             // cap rendered remote videos
          enableLayerSuspension: true,                 // pause decode for offscreen tiles
          resolution: 720,
          constraints: { video: { height: { ideal: 720, max: 720, min: 240 } } },
          p2p: { enabled: true },                      // 1:1 calls bypass the bridge
          enableWelcomePage: false,
          disablePolls: false,                         // in-call polls (Zoom parity)
          enableNoisyMicDetection: true,
          // Breakout rooms: host creates/auto-assigns; everyone can join when sent.
          breakoutRooms: {
            hideAddRoomButton: !call.moderator,
            hideAutoAssignButton: !call.moderator,
            hideJoinRoomButton: false,
          },
          toolbarButtons: [
            "microphone", "camera", "desktop", "closedcaptions", "participants-pane",
            "tileview", "raisehand", "reactions", "polls", "speakerstats",
            "select-background", "videoquality", "settings", "fullscreen",
            "whiteboard", "recording", "security", "shortcuts", "stats",
            "mute-everyone", "mute-video-everyone", "hangup",
          ].filter((b) => call.moderator ||
            // Jitsi auto-hides moderator-only actions anyway; keep the bar clean
            !["recording", "security", "mute-everyone", "mute-video-everyone"].includes(b)),
        },
        interfaceConfigOverwrite: {
          APP_NAME: "Kreatix Meet",
          PROVIDER_NAME: "Kreatix Meet",
          SHOW_JITSI_WATERMARK: false,
          SHOW_WATERMARK_FOR_GUESTS: false,
          SHOW_BRAND_WATERMARK: false,
          JITSI_WATERMARK_LINK: "",
          BRAND_WATERMARK_LINK: "",
          TOOLBAR_ALWAYS_VISIBLE: true,
          GENERATE_ROOMNAMES_ON_WELCOME_PAGE: false,
          HIDE_INVITE_MORE_HEADER: true,
          MOBILE_APP_PROMO: false,
          DEFAULT_REMOTE_DISPLAY_NAME: "Guest",
        },
      });
      const listeners = { videoConferenceLeft: () => setCall(null), readyToClose: () => setCall(null) };
      if (typeof inst.addListeners === "function") inst.addListeners(listeners);
      else {
        inst.addListener?.("videoConferenceLeft", listeners.videoConferenceLeft);
        inst.addListener?.("readyToClose", listeners.readyToClose);
      }
      apiRef.current = inst;
    };
    ensureMeetClient(call.base, boot, () => {
      toast("Couldn't load the meeting client — check that the Meet service is reachable");
      setCall(null);
    });
    return () => { cancelled = true; apiRef.current?.dispose(); apiRef.current = null; host.innerHTML = ""; };
  }, [call, user?.email]);

  const personalRoom = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ join: JoinInfo }>("/api/meet/personal", {});
      setCall(r.join);
      void load();
    } catch (e) { toast(e instanceof Error ? e.message : "Could not open your room"); }
    setBusy(false);
  };

  const copyInvite = async (meetingId: string) => {
    try {
      const r = await api.get<{ text: string }>(`/api/meet/${meetingId}/invite`);
      await navigator.clipboard.writeText(r.text);
      toast("Invite copied — guests wait in the lobby for the host");
    } catch (e) { toast((e as Error).message); }
  };

  const meetNow = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ join: JoinInfo }>("/api/meet", { startNow: true });
      setCall(r.join);
      void load();
    } catch (e) { toast(e instanceof Error ? e.message : "Could not start meeting"); }
    setBusy(false);
  };

  const schedule = async () => {
    if (!schedAt) return;
    setBusy(true);
    try {
      await api.post("/api/meet", { title: schedTitle || undefined, scheduledAt: new Date(schedAt).toISOString() });
      setSchedOpen(false); setSchedTitle(""); setSchedAt("");
      toast("Meeting scheduled");
      void load();
    } catch (e) { toast(e instanceof Error ? e.message : "Could not schedule"); }
    setBusy(false);
  };

  const join = async (m: Meeting) => {
    setBusy(true);
    try {
      const r = await api.get<{ join: JoinInfo }>(`/api/meet/${m.id}/join`);
      setCall(r.join);
    } catch (e) { toast(e instanceof Error ? e.message : "Could not join"); }
    setBusy(false);
  };

  const joinByCode = async () => {
    const code = joinCode.trim();
    if (!code) return;
    setBusy(true);
    try {
      const r = await api.post<{ join: JoinInfo }>("/api/meet/join-code", { code });
      setCall(r.join);
    } catch (e) { toast(e instanceof Error ? e.message : "No meeting with that code"); }
    setBusy(false);
  };

  const endMeeting = async (m: Meeting) => {
    await api.post(`/api/meet/${m.id}/end`, {}).catch((e) => toast((e as Error).message));
    void load();
  };

  const openRecs = async (m: Meeting) => {
    if (recFor === m.id) { setRecFor(null); return; }
    try {
      const r = await api.get<{ recordings: Rec[] }>(`/api/meet/${m.id}/recordings`);
      setRecs(r.recordings); setRecFor(m.id);
    } catch (e) { toast((e as Error).message); }
  };

  const openAtt = async (m: Meeting) => {
    if (attFor === m.id) { setAttFor(null); return; }
    try {
      const r = await api.get<{ attendees: typeof attendees }>(`/api/meet/${m.id}/attendance`);
      setAttendees(r.attendees); setAttFor(m.id);
    } catch (e) { toast((e as Error).message); }
  };

  // Live roster — suite members who joined (attendance marks on join); poll
  // while in-call. Guests aren't tracked here — they show in Jitsi's own pane.
  useEffect(() => {
    if (!call) { setRoster([]); return; }
    let dead = false;
    const pull = async () => {
      try {
        const r = await api.get<{ attendees: { name: string; leftAt: string | null }[] }>(
          `/api/meet/${call.meetingId}/attendance`);
        if (!dead) setRoster(r.attendees);
      } catch { /* transient */ }
    };
    void pull();
    const t = setInterval(() => void pull(), 10_000);
    return () => { dead = true; clearInterval(t); };
  }, [call]);

  // Meeting chat — the linked channel persists after the call ends; poll while in-call.
  useEffect(() => {
    if (!call?.channelId) { setMeetChat([]); return; }
    let dead = false;
    const pull = async () => {
      try {
        const r = await api.get<{ messages: ChatMsg[] }>(`/api/chat/${call.channelId}/messages`);
        if (!dead) setMeetChat(r.messages);
      } catch { /* transient */ }
    };
    void pull();
    const t = setInterval(() => void pull(), 4000);
    return () => { dead = true; clearInterval(t); };
  }, [call?.channelId]);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [meetChat.length]);

  const sendMeetChat = async () => {
    const body = chatDraft.trim();
    if (!body || !call?.channelId) return;
    setChatDraft("");
    try {
      const r = await api.post<{ message: ChatMsg }>(`/api/chat/${call.channelId}/messages`, { body });
      setMeetChat((cur) => [...cur, r.message]);
    } catch (e) { toast((e as Error).message); }
  };

  const setClip = async (recId: string, clipStart: number | null, clipEnd: number | null) => {
    try {
      await api.patch(`/api/meet/recordings/${recId}`, { clipStart, clipEnd });
      setRecs((cur) => cur.map((r) => r.id === recId ? { ...r, clipStart, clipEnd } : r));
      toast(clipStart != null || clipEnd != null ? "Clip range saved" : "Clip cleared");
    } catch (e) { toast((e as Error).message); }
  };

  const clipFromVideo = async (recId: string, el: HTMLVideoElement | null, which: "start" | "end") => {
    if (!el) return;
    const t = Math.floor(el.currentTime);
    const rec = recs.find((r) => r.id === recId);
    if (!rec) return;
    await setClip(recId, which === "start" ? t : rec.clipStart, which === "end" ? t : rec.clipEnd);
  };

  const transcribe = async (recId: string) => {
    try {
      await api.post(`/api/meet/recordings/${recId}/transcribe`, {});
      setRecs((cur) => cur.map((r) => r.id === recId ? { ...r, hasTranscript: true } : r));
      toast("Transcript ready");
    } catch (e) { toast((e as Error).message); }
  };

  const viewTranscript = async (recId: string) => {
    try {
      const r = await api.get<{ transcript: string }>(`/api/meet/recordings/${recId}/transcript`);
      setTranscriptText(r.transcript);
    } catch (e) { toast((e as Error).message); }
  };

  const [transcriptText, setTranscriptText] = useState<string | null>(null);
  const [sumFor, setSumFor] = useState<string | null>(null);
  const [sumBusy, setSumBusy] = useState<string | null>(null);

  const summarize = async (m: Meeting) => {
    if (sumFor === m.id && m.summary) { setSumFor(null); return; }
    if (!m.summary) {
      setSumBusy(m.id);
      try {
        const r = await api.post<{ summary: string }>("/api/ai/meeting-summary", { meetingId: m.id });
        m.summary = r.summary;
        setSumFor(m.id);
      } catch (e) { toast((e as Error).message); }
      setSumBusy(null);
      return;
    }
    setSumFor(m.id);
  };

  if (enabled === null) return <div className="empty">Loading Meet…</div>;
  if (!enabled) return (
    <>
      <div className="crumbs"><b>Meet</b></div>
      <div className="panel"><div className="empty">Kreatix Meet isn't configured on this server.</div></div>
    </>
  );

  if (call) return (
    <div className="meet-call">
      <div className="meet-call-bar">
        <button className="btn-ghost btn-sm" onClick={() => setCall(null)}>← Back to meetings</button>
        <button className="btn-ghost btn-sm" onClick={() => void copyInvite(call.meetingId)}>📋 Copy invite</button>
        {call.dialIn && <span className="d-sub" style={{ marginLeft: 12 }}>📞 Dial-in: {call.dialIn}</span>}
        {recOn && call.moderator && (
          <span className="d-sub" style={{ marginLeft: "auto" }}>
            Host tools: recording · breakout rooms · lobby & passcode in the toolbar
          </span>
        )}
      </div>
      <div className="meet-call-body">
        <div ref={frameHost} className="meet-frame" />
        {(call.channelId || roster.length > 0) && (
          <div className="meet-chat">
            {roster.length > 0 && (
              <div className="meet-roster">
                <div className="meet-chat-h">Participants <span className="d-sub">— suite members</span></div>
                <div className="meet-roster-list">
                  {roster.map((p, i) => (
                    <span key={i} className={`meet-roster-chip${p.leftAt ? " left" : ""}`}>{p.name}</span>
                  ))}
                </div>
              </div>
            )}
            {call.channelId && (
            <>
            <div className="meet-chat-h">Meeting chat <span className="d-sub">— saved to Chat</span></div>
            <div className="meet-chat-msgs" ref={chatRef}>
              {meetChat.length === 0 && <span className="d-sub" style={{ padding: 8 }}>Messages here persist after the meeting.</span>}
              {meetChat.map((m) => (
                <div key={m.id} className="meet-chat-msg">
                  <span className="avatar" style={{ width: 20, height: 20, fontSize: 9 }}>{m.author.initials}</span>
                  <div><b>{m.author.name}</b><div className="meet-chat-body">{m.body}</div></div>
                </div>
              ))}
            </div>
            <div className="meet-chat-in">
              <input placeholder="Message…" value={chatDraft}
                onChange={(e) => setChatDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void sendMeetChat()} />
              <button className="btn-primary btn-sm" onClick={() => void sendMeetChat()}>Send</button>
            </div>
            </>
            )}
          </div>
        )}
      </div>
    </div>
  );

  const live = meetings.filter((m) => m.status === "live");
  const upcoming = meetings.filter((m) => m.status === "scheduled");
  const ended = meetings.filter((m) => m.status === "ended").slice(0, 5);

  const Row = ({ m }: { m: Meeting }) => (
    <div className="meet-row">
      <span className={`meet-status ${m.status}`}>{m.status === "live" ? "● live" : m.status === "scheduled" ? "scheduled" : "ended"}</span>
      <div className="meet-row-main">
        <b>{m.title}</b>
        <span className="d-sub">
          {m.scheduledAt ? fmtWhen(m.scheduledAt) : fmtWhen(m.createdAt)}
          {m.createdByName ? ` · ${m.createdByName}` : ""} · <code>{m.code}</code>
          {m.personal && <span className="meet-pbadge">personal</span>}
        </span>
        {recFor === m.id && (
          <div className="meet-recs">
            {!recs.length && <span className="d-sub">No recordings yet.</span>}
            {recs.map((r) => {
              const isHost = m.createdBy === user?.id || user?.role === "owner" || user?.role === "admin";
              return (
                <div key={r.id} className="meet-rec">
                  <video controls preload="metadata" ref={(el) => { recVideoRefs.current[r.id] = el; }}
                    src={mediaUrl(`/api/meet/recordings/${r.id}/stream`)}
                    onLoadedMetadata={(e) => { if (r.clipStart != null) e.currentTarget.currentTime = r.clipStart; }}
                    onTimeUpdate={(e) => { if (r.clipEnd != null && e.currentTarget.currentTime >= r.clipEnd) e.currentTarget.pause(); }} />
                  <span className="d-sub">
                    {r.name} · {fmtWhen(r.createdAt)}{r.size ? ` · ${Math.round(r.size / 1048576)} MB` : ""}
                    {r.clipStart != null || r.clipEnd != null
                      ? ` · clip ${r.clipStart ?? 0}s–${r.clipEnd != null ? `${r.clipEnd}s` : "end"}` : ""}
                  </span>
                  <div className="meet-rec-tools">
                    {isHost && (
                      <>
                        <button className="btn-ghost btn-sm" title="Mark clip start at playhead"
                          onClick={() => void clipFromVideo(r.id, recVideoRefs.current[r.id], "start")}>⏮ start</button>
                        <button className="btn-ghost btn-sm" title="Mark clip end at playhead"
                          onClick={() => void clipFromVideo(r.id, recVideoRefs.current[r.id], "end")}>⏭ end</button>
                        {(r.clipStart != null || r.clipEnd != null) && (
                          <button className="btn-ghost btn-sm" onClick={() => void setClip(r.id, null, null)}>clear</button>
                        )}
                        <button className="btn-ghost btn-sm" onClick={() => void transcribe(r.id)}>
                          {r.hasTranscript ? "↻ transcript" : "⧉ transcribe"}
                        </button>
                      </>
                    )}
                    {r.hasTranscript && (
                      <button className="btn-ghost btn-sm" onClick={() => void viewTranscript(r.id)}>📄 transcript</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {sumFor === m.id && m.summary && (
          <div className="meet-recs">
            <div className="meet-summary">{m.summary}</div>
          </div>
        )}
        {attFor === m.id && (
          <div className="meet-recs">
            {!attendees.length && <span className="d-sub">No joins recorded.</span>}
            {attendees.map((a) => (
              <div key={a.userId + a.joinedAt} className="meet-att">
                <b>{a.name}</b>
                <span className="d-sub">
                  {fmtWhen(a.joinedAt)} → {a.leftAt ? fmtWhen(a.leftAt) : "still in"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {m.recordings > 0 && (
        <button className="btn-ghost btn-sm" onClick={() => void openRecs(m)}>▶ {m.recordings}</button>
      )}
      <button className="btn-ghost btn-sm" title="Attendance" onClick={() => void openAtt(m)}>👥</button>
      {(m.recordings > 0 || m.channelId || m.summary) && (
        <button className="btn-ghost btn-sm" title="AI meeting summary" disabled={sumBusy === m.id}
          onClick={() => void summarize(m)}>
          {sumBusy === m.id ? "…" : "✨"} {m.summary ? "summary" : ""}
        </button>
      )}
      {m.status !== "ended" && (
        <>
          <button className="btn-primary btn-sm" disabled={busy} onClick={() => void join(m)}>Join</button>
          <button className="btn-ghost btn-sm" title="Copy invite (link + code)" onClick={() => void copyInvite(m.id)}>�</button>
          {(m.createdBy === user?.id || user?.role === "owner" || user?.role === "admin") && (
            <button className="btn-ghost btn-sm" title="End meeting" onClick={() => void endMeeting(m)}>End</button>
          )}
        </>
      )}
    </div>
  );

  return (
    <>
      <div className="crumbs"><b>Meet</b><span className="d-sub" style={{ marginLeft: 8 }}>video meetings</span></div>

      <div className="meet-hero">
        <div className="meet-actions">
          <button className="btn-primary" disabled={busy} onClick={() => void meetNow()}>▶ Meet now</button>
          <button className="btn-secondary" onClick={() => setSchedOpen(true)}>📅 Schedule</button>
          <button className="btn-secondary" disabled={busy} title="Your permanent room — same link every time"
            onClick={() => void personalRoom()}>🏠 Personal room</button>
          <div className="meet-joincode">
            <input placeholder="Enter a code — kx-…" value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void joinByCode()} />
            <button className="btn-ghost" disabled={busy || !joinCode.trim()} onClick={() => void joinByCode()}>Join</button>
          </div>
        </div>
        {dialIn && <div className="d-sub" style={{ marginTop: 8 }}>📞 Dial in: <code>{dialIn}</code></div>}
      </div>

      {live.length > 0 && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <div className="panel-h">Happening now</div>
          {live.map((m) => <Row key={m.id} m={m} />)}
        </div>
      )}

      <div className="panel">
        <div className="panel-h">Upcoming</div>
        {upcoming.length === 0 && <div className="empty" style={{ padding: 18 }}>Nothing scheduled — hit "Meet now" to start instantly.</div>}
        {upcoming.map((m) => <Row key={m.id} m={m} />)}
        {ended.length > 0 && (
          <>
            <div className="panel-h" style={{ marginTop: 10 }}>Recent</div>
            {ended.map((m) => <Row key={m.id} m={m} />)}
          </>
        )}
      </div>

      {schedOpen && (
        <Modal label="Schedule a meeting" onClose={() => setSchedOpen(false)} style={{ width: 440 }}>
          <div className="ob-body">
            <input placeholder="Meeting title (optional)" value={schedTitle}
              onChange={(e) => setSchedTitle(e.target.value)} style={{ width: "100%", marginBottom: 10 }} />
            <input type="datetime-local" value={schedAt}
              onChange={(e) => setSchedAt(e.target.value)} style={{ width: "100%" }} />
            <div className="dlg-actions">
              <button className="btn-ghost" onClick={() => setSchedOpen(false)}>Cancel</button>
              <button className="btn-primary" disabled={busy || !schedAt} onClick={() => void schedule()}>Schedule</button>
            </div>
          </div>
        </Modal>
      )}

      {transcriptText != null && (
        <Modal label="Transcript" onClose={() => setTranscriptText(null)} style={{ width: 560 }}>
          <pre className="meet-transcript">{transcriptText}</pre>
        </Modal>
      )}
      {msg && <div className="toast" role="status">{msg}</div>}
    </>
  );
}
