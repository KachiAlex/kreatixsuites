import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useToast, useMeetEnabled } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { Modal } from "../components/Modal";

// Kreatix Calendar — month grid + day agenda + event composer. Events are
// org-scoped and visible to creator + attendees; "Add Meet" creates a linked
// meetings row so Join buttons mint a Jitsi token on click.

interface CalEvent {
  id: string; title: string | null; description: string | null; location: string | null;
  startsAt: string; endsAt: string; allDay: boolean; meetingId: string | null;
  createdBy: string; createdAt: string;
  attendees: { id: string; displayName: string; initials: string; status: string }[];
}
interface Person { id: string; displayName: string; email: string; initials: string }

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const fmtRange = (e: CalEvent) =>
  e.allDay ? "All day" : `${fmtTime(e.startsAt)} – ${fmtTime(e.endsAt)}`;
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function Calendar() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { msg, toast } = useToast();
  const meetOn = useMeetEnabled();
  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [selected, setSelected] = useState(() => dayKey(new Date()));
  const [detail, setDetail] = useState<CalEvent | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<CalEvent | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [busy, setBusy] = useState(false);
  // form state
  const [fTitle, setFTitle] = useState("");
  const [fStart, setFStart] = useState("");
  const [fEnd, setFEnd] = useState("");
  const [fAllDay, setFAllDay] = useState(false);
  const [fLoc, setFLoc] = useState("");
  const [fDesc, setFDesc] = useState("");
  const [fMeet, setFMeet] = useState(true);
  const [fAtt, setFAtt] = useState<Set<string>>(new Set());

  const range = useMemo(() => {
    const from = new Date(cursor.getFullYear(), cursor.getMonth(), 1 - 14);
    const to = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 15);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [cursor]);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ events: CalEvent[] }>(
        `/api/calendar?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`);
      setEvents(r.events);
    } catch (e) { toast((e as Error).message); }
  }, [range, toast]);

  useEffect(() => { void load(); }, [load]);

  // weeks: Mon-first grid covering the cursor month
  const weeks = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = new Date(first);
    start.setDate(first.getDate() - ((first.getDay() + 6) % 7)); // back to Monday
    const out: Date[][] = [];
    const d = new Date(start);
    while (d.getMonth() === cursor.getMonth() || out.length < 6 || d.getDay() !== 1) {
      const week: Date[] = [];
      for (let i = 0; i < 7; i++) { week.push(new Date(d)); d.setDate(d.getDate() + 1); }
      out.push(week);
      if (d.getMonth() !== cursor.getMonth() && out.length >= 5) break;
    }
    return out;
  }, [cursor]);

  const eventsOn = useCallback((d: Date) => {
    const lo = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const hi = lo + 864e5;
    return events.filter((e) => {
      const s = new Date(e.startsAt).getTime(), en = new Date(e.endsAt).getTime();
      return s < hi && en > lo;
    });
  }, [events]);

  const selDay = useMemo(() => {
    const [y, m, dd] = selected.split("-").map(Number);
    return new Date(y, m, dd);
  }, [selected]);
  const selEvents = eventsOn(selDay);
  const todayKey = dayKey(new Date());

  const openNew = (day?: Date) => {
    const base = day ?? selDay;
    const s = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 10, 0);
    const e = new Date(s.getTime() + 30 * 60_000);
    setEditing(null);
    setFTitle(""); setFLoc(""); setFDesc(""); setFMeet(true);
    setFAllDay(false); setFAtt(new Set());
    setFStart(toLocalInput(s.toISOString())); setFEnd(toLocalInput(e.toISOString()));
    setEditOpen(true);
    if (!people.length) void api.get<{ people: Person[] }>("/api/chat/people").then((r) => setPeople(r.people)).catch(() => {});
  };

  const openEdit = (e: CalEvent) => {
    setEditing(e);
    setFTitle(e.title ?? ""); setFLoc(e.location ?? ""); setFDesc(e.description ?? "");
    setFAllDay(e.allDay); setFMeet(!!e.meetingId);
    setFAtt(new Set(e.attendees.map((a) => a.id)));
    setFStart(toLocalInput(e.startsAt)); setFEnd(toLocalInput(e.endsAt));
    setDetail(null); setEditOpen(true);
    if (!people.length) void api.get<{ people: Person[] }>("/api/chat/people").then((r) => setPeople(r.people)).catch(() => {});
  };

  const save = async () => {
    if (!fTitle.trim() || !fStart || !fEnd) return;
    setBusy(true);
    try {
      const body = {
        title: fTitle.trim(), description: fDesc.trim() || undefined, location: fLoc.trim() || undefined,
        startsAt: new Date(fStart).toISOString(), endsAt: new Date(fEnd).toISOString(),
        allDay: fAllDay, attendeeIds: [...fAtt], meet: meetOn && fMeet,
      };
      if (editing) await api.patch(`/api/calendar/${editing.id}`, body);
      else await api.post("/api/calendar", body);
      setEditOpen(false);
      toast(editing ? "Event updated" : "Event created");
      void load();
    } catch (e) { toast((e as Error).message); }
    setBusy(false);
  };

  const rsvp = async (e: CalEvent, status: string) => {
    try {
      await api.post(`/api/calendar/${e.id}/rsvp`, { status });
      void load();
      setDetail((d) => (d && d.id === e.id
        ? { ...d, attendees: d.attendees.map((a) => (a.id === user?.id ? { ...a, status } : a)) }
        : d));
    } catch (err) { toast((err as Error).message); }
  };

  const joinMeet = (e: CalEvent) => { if (e.meetingId) navigate(`/meet?join=${e.meetingId}`); };
  const delEvent = async (e: CalEvent) => {
    try { await api.del(`/api/calendar/${e.id}`); setDetail(null); void load(); }
    catch (err) { toast((err as Error).message); }
  };

  const RSVP_COLORS: Record<string, string> = { accepted: "#3a7d44", declined: "#b3261e", tentative: "#b26a00", pending: "#6b6b6b" };

  return (
    <>
      <div className="crumbs">
        <b>Calendar</b>
        <span className="d-sub" style={{ marginLeft: 8 }}>
          {cursor.toLocaleString(undefined, { month: "long", year: "numeric" })}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn-ghost btn-sm" onClick={() => setCursor(new Date())}>Today</button>
          <button className="btn-ghost btn-sm" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>‹</button>
          <button className="btn-ghost btn-sm" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>›</button>
          <button className="btn-primary btn-sm" onClick={() => openNew()}>＋ New event</button>
        </div>
      </div>

      <div className="cal">
        <div className="cal-grid">
          {DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}
          {weeks.flat().map((d, i) => {
            const evs = eventsOn(d);
            const k = dayKey(d);
            return (
              <button key={i}
                className={`cal-day${d.getMonth() !== cursor.getMonth() ? " dim" : ""}${k === selected ? " sel" : ""}${k === todayKey ? " today" : ""}`}
                onClick={() => setSelected(k)} onDoubleClick={() => openNew(d)}>
                <span className="cal-daynum">{d.getDate()}</span>
                <span className="cal-chips">
                  {evs.slice(0, 3).map((e) => (
                    <span key={e.id} className={`cal-chip${e.meetingId ? " meet" : ""}`}>{e.title}</span>
                  ))}
                  {evs.length > 3 && <span className="cal-more">+{evs.length - 3}</span>}
                </span>
              </button>
            );
          })}
        </div>

        <aside className="cal-side">
          <div className="cal-side-h">
            {selDay.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          </div>
          {!selEvents.length && <div className="chat-empty-side">Nothing here — double-click a day or hit New event.</div>}
          {selEvents.map((e) => (
            <button key={e.id} className="cal-ev" onClick={() => setDetail(e)}>
              <b>{e.title}</b>
              <span className="d-sub">{fmtRange(e)}{e.location ? ` · ${e.location}` : ""}</span>
              <span className="cal-ev-tags">
                {e.meetingId && <span className="cal-tag meet">Meet</span>}
                {e.attendees.length > 0 && <span className="cal-tag">{e.attendees.length} invited</span>}
              </span>
            </button>
          ))}
        </aside>
      </div>

      {detail && (
        <Modal label={detail.title ?? "Event"} onClose={() => setDetail(null)} style={{ width: 440 }}>
          <div className="ob-body">
            <p><b>{new Date(detail.startsAt).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</b> · {fmtRange(detail)}</p>
            {detail.location && <p>📍 {detail.location}</p>}
            {detail.description && <p>{detail.description}</p>}
            {detail.attendees.length > 0 && (
              <p className="cal-attlist">
                {detail.attendees.map((a) => (
                  <span key={a.id} className="cal-att" style={{ borderColor: RSVP_COLORS[a.status] ?? "#999" }}>
                    {a.initials} {a.displayName} · {a.status}
                  </span>
                ))}
              </p>
            )}
            <div className="dlg-actions" style={{ justifyContent: "flex-start" }}>
              {detail.meetingId && <button className="btn-primary btn-sm" onClick={() => joinMeet(detail)}>▶ Join Meet</button>}
              {detail.attendees.some((a) => a.id === user?.id) && (
                <>
                  <button className="btn-ghost btn-sm" onClick={() => void rsvp(detail, "accepted")}>Accept</button>
                  <button className="btn-ghost btn-sm" onClick={() => void rsvp(detail, "tentative")}>Maybe</button>
                  <button className="btn-ghost btn-sm" onClick={() => void rsvp(detail, "declined")}>Decline</button>
                </>
              )}
              {detail.createdBy === user?.id && (
                <>
                  <button className="btn-ghost btn-sm" onClick={() => openEdit(detail)}>Edit</button>
                  <button className="btn-ghost btn-sm" onClick={() => void delEvent(detail)}>Delete</button>
                </>
              )}
            </div>
          </div>
        </Modal>
      )}

      {editOpen && (
        <Modal label={editing ? "Edit event" : "New event"} onClose={() => setEditOpen(false)} style={{ width: 480 }}>
          <div className="ob-body">
            <input placeholder="Title" value={fTitle} onChange={(e) => setFTitle(e.target.value)}
              style={{ width: "100%", marginBottom: 10 }} autoFocus />
            <div className="cal-formrow">
              <label>Start<input type="datetime-local" value={fStart} onChange={(e) => setFStart(e.target.value)} /></label>
              <label>End<input type="datetime-local" value={fEnd} onChange={(e) => setFEnd(e.target.value)} /></label>
            </div>
            <input placeholder="Location (optional)" value={fLoc} onChange={(e) => setFLoc(e.target.value)}
              style={{ width: "100%", marginBottom: 10 }} />
            <textarea placeholder="Description (optional)" value={fDesc} onChange={(e) => setFDesc(e.target.value)}
              rows={2} style={{ width: "100%", marginBottom: 10 }} />
            <label className="cal-check"><input type="checkbox" checked={fAllDay} onChange={(e) => setFAllDay(e.target.checked)} /> All day</label>
            {meetOn && !editing?.meetingId && (
              <label className="cal-check"><input type="checkbox" checked={fMeet} onChange={(e) => setFMeet(e.target.checked)} /> Add a Kreatix Meet call</label>
            )}
            {people.length > 0 && (
              <div className="chat-people" style={{ marginTop: 8 }}>
                {people.map((p) => (
                  <button key={p.id} type="button" className={`chat-person${fAtt.has(p.id) ? " picked" : ""}`}
                    onClick={() => setFAtt((s) => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })}>
                    <span className="chat-avatar">{p.initials}</span>
                    <span className="chat-item-main"><b>{p.displayName}</b><span className="d-sub">{p.email}</span></span>
                    {fAtt.has(p.id) && <span>✓</span>}
                  </button>
                ))}
              </div>
            )}
            <div className="dlg-actions">
              <button className="btn-ghost" onClick={() => setEditOpen(false)}>Cancel</button>
              <button className="btn-primary" disabled={busy || !fTitle.trim() || !fStart || !fEnd} onClick={() => void save()}>
                {editing ? "Save" : "Create"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {msg && <div className="toast" role="status">{msg}</div>}
    </>
  );
}
