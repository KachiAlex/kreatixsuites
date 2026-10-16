import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useToast } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { Modal } from "../components/Modal";

// Kreatix Meet — video meetings inside the suite, Teams-style. The API mints
// per-join Jitsi JWTs; the room itself is embedded via JitsiMeetExternalAPI
// from the self-hosted jitsi stack.

interface Meeting {
  id: string; code: string; title: string; status: string;
  scheduledAt: string | null; createdBy: string; createdByName: string | null;
  createdAt: string; endedAt: string | null;
}
interface JoinInfo { base: string; room: string; jwt: string; displayName: string }

declare global {
  interface Window { JitsiMeetExternalAPI?: new (domain: string, opts: Record<string, unknown>) => { dispose: () => void; addListener: (m: Record<string, () => void>) => void } }
}

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
  const frameHost = useRef<HTMLDivElement>(null);
  const apiRef = useRef<{ dispose: () => void; addListener: (m: Record<string, () => void>) => void } | null>(null);

  const load = useCallback(async () => {
    const r = await api.get<{ enabled: boolean; meetings?: Meeting[] }>("/api/meet");
    setEnabled(r.enabled);
    setMeetings(r.meetings ?? []);
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
        configOverwrite: { disableDeepLinking: true },
      });
      inst.addListener({ videoConferenceLeft: () => setCall(null), readyToClose: () => setCall(null) });
      apiRef.current = inst;
    };
    if (window.JitsiMeetExternalAPI) boot();
    else {
      const s = document.createElement("script");
      s.src = `${call.base}/external_api.js`;
      s.onload = boot;
      document.head.appendChild(s);
    }
    return () => { cancelled = true; apiRef.current?.dispose(); apiRef.current = null; host.innerHTML = ""; };
  }, [call, user?.email]);

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

  const copyGuestLink = async (m: Meeting) => {
    try {
      const r = await api.post<{ url: string }>(`/api/meet/${m.id}/guest-link`, {});
      await navigator.clipboard.writeText(r.url);
      toast("Guest link copied — anyone with it can join");
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  const endMeeting = async (m: Meeting) => {
    await api.post(`/api/meet/${m.id}/end`, {}).catch((e) => toast((e as Error).message));
    void load();
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
      </div>
      <div ref={frameHost} className="meet-frame" />
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
        </span>
      </div>
      {m.status !== "ended" && (
        <>
          <button className="btn-primary btn-sm" disabled={busy} onClick={() => void join(m)}>Join</button>
          <button className="btn-ghost btn-sm" title="Copy guest link" onClick={() => void copyGuestLink(m)}>🔗</button>
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
          <div className="meet-joincode">
            <input placeholder="Enter a code — kx-…" value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void joinByCode()} />
            <button className="btn-ghost" disabled={busy || !joinCode.trim()} onClick={() => void joinByCode()}>Join</button>
          </div>
        </div>
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
      {msg && <div className="toast" role="status">{msg}</div>}
    </>
  );
}
