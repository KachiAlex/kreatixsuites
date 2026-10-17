import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
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
  createdBy: string; createdAt: string; rrule?: string | null; occurrenceOf?: string;
  occurrenceKey?: string; resourceId?: string | null; reminderMins?: number | null;
  attendees: { id: string; displayName: string; initials: string; status: string }[];
}
interface Person { id: string; displayName: string; email: string; initials: string }
interface Resource { id: string; name: string; kind: string; capacity: number | null }
interface Delegate { id: string; canEdit: boolean; displayName: string; email: string }

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
  const [fRrule, setFRrule] = useState("");
  const [fReminder, setFReminder] = useState("15");
  const [fResource, setFResource] = useState("");
  const [view, setView] = useState<"month" | "week">("month");
  const [fScope, setFScope] = useState<"series" | "occurrence">("series");
  const [resources, setResources] = useState<Resource[]>([]);
  const [freebusy, setFreebusy] = useState<Record<string, { startsAt: string; endsAt: string }[]>>({});
  const [delegates, setDelegates] = useState<Delegate[]>([]);
  const [sharedWithMe, setSharedWithMe] = useState<Delegate[]>([]);
  const [asId, setAsId] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [resOpen, setResOpen] = useState(false);
  const [resName, setResName] = useState("");
  const [resKind, setResKind] = useState("room");
  const [resCap, setResCap] = useState("");

  const range = useMemo(() => {
    const from = new Date(cursor.getFullYear(), cursor.getMonth(), 1 - 14);
    const to = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 15);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [cursor]);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ events: CalEvent[] }>(
        `/api/calendar?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}${asId ? `&as=${asId}` : ""}`);
      setEvents(r.events);
    } catch (e) { toast((e as Error).message); }
  }, [range, toast, asId]);

  useEffect(() => { void load(); }, [load]);

  // resources + delegate lists load once — resources for the room picker,
  // sharedWithMe for the "viewing as" switcher, delegates for the share dialog
  useEffect(() => {
    void api.get<{ resources: Resource[] }>("/api/calendar/resources")
      .then((r) => setResources(r.resources)).catch(() => {});
    void api.get<{ delegates: Delegate[]; sharedWithMe: Delegate[] }>("/api/calendar/delegates")
      .then((r) => { setDelegates(r.delegates); setSharedWithMe(r.sharedWithMe); }).catch(() => {});
  }, []);

  // free/busy: re-fetch attendees' busy spans whenever the picked people or
  // the time window changes (1s debounce — the datetime input fires per key)
  useEffect(() => {
    if (!editOpen || !fAtt.size || !fStart || !fEnd) { setFreebusy({}); return; }
    const t = setTimeout(() => {
      const q = `/api/calendar/freebusy?users=${[...fAtt].join(",")}` +
        `&from=${encodeURIComponent(new Date(fStart).toISOString())}` +
        `&to=${encodeURIComponent(new Date(fEnd).toISOString())}`;
      void api.get<{ busy: Record<string, { startsAt: string; endsAt: string }[]> }>(q)
        .then((r) => setFreebusy(r.busy)).catch(() => setFreebusy({}));
    }, 1000);
    return () => clearTimeout(t);
  }, [editOpen, fAtt, fStart, fEnd]);

  const isBusy = (id: string) => {
    if (!fStart || !fEnd) return false;
    const s = new Date(fStart).getTime(), e = new Date(fEnd).getTime();
    return (freebusy[id] ?? []).some((b) =>
      new Date(b.startsAt).getTime() < e && new Date(b.endsAt).getTime() > s);
  };

  // deep link — /calendar?e=<eventId> selects the day + opens the detail
  const [search, setSearch] = useSearchParams();
  useEffect(() => {
    const eid = search.get("e");
    if (!eid) return;
    (async () => {
      // not necessarily in the loaded range — fetch it directly
      const hit = events.find((e) => e.id === eid)
        ?? (await api.get<{ event: CalEvent }>(`/api/calendar/${eid}`).then((r) => r.event).catch(() => null));
      if (hit) {
        const d = new Date(hit.startsAt);
        setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
        setSelected(dayKey(d));
        setDetail(hit);
      }
      setSearch({}, { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

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

  // week view: the Mon–Sun span containing the selected day
  const weekDays = useMemo(() => {
    const mon = new Date(selDay);
    mon.setDate(selDay.getDate() - ((selDay.getDay() + 6) % 7));
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(mon); d.setDate(mon.getDate() + i); return d;
    });
  }, [selDay]);

  const navWeek = (dir: number) => {
    const d = new Date(selDay); d.setDate(d.getDate() + dir * 7);
    setSelected(dayKey(d));
    setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
  };

  const openNew = (day?: Date) => {
    const base = day ?? selDay;
    const s = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 10, 0);
    const e = new Date(s.getTime() + 30 * 60_000);
    setEditing(null);
    setFTitle(""); setFLoc(""); setFDesc(""); setFMeet(true); setFRrule("");
    setFAllDay(false); setFAtt(new Set()); setFResource(""); setFScope("series"); setFReminder("15");
    setFStart(toLocalInput(s.toISOString())); setFEnd(toLocalInput(e.toISOString()));
    setEditOpen(true);
    if (!people.length) void api.get<{ people: Person[] }>("/api/chat/people").then((r) => setPeople(r.people)).catch(() => {});
  };

  const openEdit = (e: CalEvent) => {
    setEditing(e);
    setFTitle(e.title ?? ""); setFLoc(e.location ?? ""); setFDesc(e.description ?? "");
    setFAllDay(e.allDay); setFMeet(!!e.meetingId); setFRrule(e.rrule ?? "");
    setFAtt(new Set(e.attendees.map((a) => a.id)));
    setFResource(e.resourceId ?? ""); setFScope("series");
    setFReminder(e.reminderMins != null ? String(e.reminderMins) : "");
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
        rrule: fRrule || null, resourceId: fResource || null,
        reminderMins: fReminder === "" ? null : Number(fReminder),
        // browser tz — stored so recurrence expands in wall-clock (DST-safe)
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
      };
      if (editing && editing.occurrenceOf && fScope === "occurrence") {
        // edit just this occurrence — series keeps its pattern
        await api.patch(`/api/calendar/${editing.id}/occurrence`, {
          occurrenceStart: editing.occurrenceKey ?? editing.startsAt,
          startsAt: body.startsAt, endsAt: body.endsAt,
          title: body.title !== (editing.title ?? "") ? body.title : undefined,
          location: fLoc.trim() !== (editing.location ?? "") ? fLoc.trim() : undefined,
        });
      } else if (editing) await api.patch(`/api/calendar/${editing.id}`, body);
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
  const copyFeed = async () => {
    try {
      const r = await api.get<{ url: string }>("/api/calendar/feed-url");
      try {
        await navigator.clipboard.writeText(r.url);
        toast("Feed link copied — add it in Outlook/Google as “subscribe from web”");
      } catch { window.prompt("Copy your calendar feed link:", r.url); }
    } catch (err) { toast((err as Error).message); }
  };
  const exportIcs = async (e: CalEvent) => {
    try {
      const t = await api.get<Blob>(`/api/calendar/${e.id}/ics`);
      const url = URL.createObjectURL(t);
      const a = document.createElement("a");
      a.href = url; a.download = `${(e.title ?? "event").replace(/[^\w-]+/g, "_")}.ics`;
      a.click(); URL.revokeObjectURL(url);
    } catch (err) { toast((err as Error).message); }
  };
  const importIcs = async (file: File) => {
    try {
      const ics = await file.text();
      const r = await api.post<{ imported: number }>("/api/calendar/import", { ics });
      toast(`Imported ${r.imported} event${r.imported === 1 ? "" : "s"}`);
      void load();
    } catch (err) { toast((err as Error).message); }
  };
  const delEvent = async (e: CalEvent) => {
    try { await api.del(`/api/calendar/${e.id}`); setDetail(null); void load(); }
    catch (err) { toast((err as Error).message); }
  };
  const cancelOccurrence = async (e: CalEvent) => {
    try {
      await api.patch(`/api/calendar/${e.id}/occurrence`, {
        occurrenceStart: e.occurrenceKey ?? e.startsAt, cancel: true,
      });
      setDetail(null); toast("Occurrence cancelled"); void load();
    } catch (err) { toast((err as Error).message); }
  };
  const reloadDelegates = () =>
    api.get<{ delegates: Delegate[]; sharedWithMe: Delegate[] }>("/api/calendar/delegates")
      .then((r) => { setDelegates(r.delegates); setSharedWithMe(r.sharedWithMe); }).catch(() => {});
  const addDelegate = async (id: string, canEdit: boolean) => {
    try { await api.post("/api/calendar/delegates", { delegateId: id, canEdit }); void reloadDelegates(); }
    catch (err) { toast((err as Error).message); }
  };
  const removeDelegate = async (id: string) => {
    try { await api.del(`/api/calendar/delegates/${id}`); void reloadDelegates(); }
    catch (err) { toast((err as Error).message); }
  };
  const addResource = async () => {
    if (!resName.trim()) return;
    try {
      await api.post("/api/calendar/resources", {
        name: resName.trim(), kind: resKind, capacity: resCap ? Number(resCap) : undefined,
      });
      setResName(""); setResCap("");
      const r = await api.get<{ resources: Resource[] }>("/api/calendar/resources");
      setResources(r.resources);
      toast("Resource added");
    } catch (err) { toast((err as Error).message); }
  };
  const delResource = async (id: string) => {
    try {
      await api.del(`/api/calendar/resources/${id}`);
      const r = await api.get<{ resources: Resource[] }>("/api/calendar/resources");
      setResources(r.resources);
    } catch (err) { toast((err as Error).message); }
  };

  const RSVP_COLORS: Record<string, string> = { accepted: "#3a7d44", declined: "#b3261e", tentative: "#b26a00", pending: "#6b6b6b" };

  return (
    <>
      <div className="crumbs">
        <b>Calendar</b>
        <span className="d-sub" style={{ marginLeft: 8 }}>
          {cursor.toLocaleString(undefined, { month: "long", year: "numeric" })}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {sharedWithMe.length > 0 && (
            <select className="btn-ghost btn-sm" value={asId} onChange={(e) => setAsId(e.target.value)}
              title="View another calendar">
              <option value="">My calendar</option>
              {sharedWithMe.map((d) => (
                <option key={d.id} value={d.id}>{d.displayName}{d.canEdit ? " (can edit)" : ""}</option>
              ))}
            </select>
          )}
          <button className={`btn-sm ${view === "month" ? "btn-primary" : "btn-ghost"}`} onClick={() => setView("month")}>Month</button>
          <button className={`btn-sm ${view === "week" ? "btn-primary" : "btn-ghost"}`} onClick={() => setView("week")}>Week</button>
          <button className="btn-ghost btn-sm" onClick={() => setShareOpen(true)}>Share</button>
          <button className="btn-ghost btn-sm" onClick={() => setResOpen(true)}>Rooms</button>
          <button className="btn-ghost btn-sm" onClick={() => void copyFeed()}>Feed</button>
          <button className="btn-ghost btn-sm" onClick={() => { const d = new Date(); setSelected(dayKey(d)); setCursor(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Today</button>
          <button className="btn-ghost btn-sm" onClick={() => view === "week" ? navWeek(-1) : setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>‹</button>
          <button className="btn-ghost btn-sm" onClick={() => view === "week" ? navWeek(1) : setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>›</button>
          <label className="btn-ghost btn-sm" style={{ cursor: "pointer" }}>
            Import .ics
            <input type="file" accept=".ics,text/calendar" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void importIcs(f); e.target.value = ""; }} />
          </label>
          <button className="btn-primary btn-sm" onClick={() => openNew()}>＋ New event</button>
        </div>
      </div>

      <div className="cal">
        {view === "month" ? (
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
                    <span key={e.id + e.startsAt} className={`cal-chip${e.meetingId ? " meet" : ""}`}>{e.title}</span>
                  ))}
                  {evs.length > 3 && <span className="cal-more">+{evs.length - 3}</span>}
                </span>
              </button>
            );
          })}
        </div>
        ) : (
        <div className="cal-week">
          {weekDays.map((d) => {
            const evs = eventsOn(d).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
            const k = dayKey(d);
            return (
              <div key={k} className={`cal-wday${k === todayKey ? " today" : ""}${k === selected ? " sel" : ""}`}
                onClick={() => setSelected(k)} onDoubleClick={() => openNew(d)}>
                <div className="cal-wday-h">{d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</div>
                {evs.map((e) => (
                  <button key={e.id + e.startsAt} className={`cal-chip${e.meetingId ? " meet" : ""}`}
                    onClick={(ev) => { ev.stopPropagation(); setDetail(e); }}>
                    <b>{e.title}</b>
                    {!e.allDay && <span>{fmtTime(e.startsAt)} – {fmtTime(e.endsAt)}</span>}
                  </button>
                ))}
                {!evs.length && <span className="cal-wday-none">—</span>}
              </div>
            );
          })}
        </div>
        )}

        <aside className="cal-side">
          <div className="cal-side-h">
            {selDay.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          </div>
          {!selEvents.length && <div className="chat-empty-side">Nothing here — double-click a day or hit New event.</div>}
          {selEvents.map((e) => (
            <button key={e.id + e.startsAt} className="cal-ev" onClick={() => setDetail(e)}>
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
            {detail.rrule && <p className="d-sub">🔁 Repeats ({detail.rrule.replace(/^RRULE:/i, "").toLowerCase().replace(/;/g, ", ")})</p>}
            {detail.resourceId && (
              <p className="d-sub">🚪 {resources.find((r) => r.id === detail.resourceId)?.name ?? "Resource booked"}</p>
            )}
            <div className="dlg-actions" style={{ justifyContent: "flex-start" }}>
              {detail.meetingId && <button className="btn-primary btn-sm" onClick={() => joinMeet(detail)}>▶ Join Meet</button>}
              <button className="btn-ghost btn-sm" onClick={() => void exportIcs(detail)}>Export .ics</button>
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
                  {detail.occurrenceOf && (
                    <button className="btn-ghost btn-sm" onClick={() => void cancelOccurrence(detail)}>Cancel this occurrence</button>
                  )}
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
            {editing?.occurrenceOf && (
              <div className="cal-formrow" style={{ marginBottom: 10 }}>
                <label>Edit scope
                  <select value={fScope} onChange={(e) => setFScope(e.target.value as "series" | "occurrence")}>
                    <option value="series">This and all occurrences</option>
                    <option value="occurrence">This occurrence only</option>
                  </select>
                </label>
              </div>
            )}
            <div className="cal-formrow">
              <label>Start<input type="datetime-local" value={fStart} onChange={(e) => setFStart(e.target.value)} /></label>
              <label>End<input type="datetime-local" value={fEnd} onChange={(e) => setFEnd(e.target.value)} /></label>
            </div>
            {resources.length > 0 && fScope === "series" && (
              <div className="cal-formrow" style={{ marginBottom: 10 }}>
                <label>Room / resource
                  <select value={fResource} onChange={(e) => setFResource(e.target.value)}>
                    <option value="">None</option>
                    {resources.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}{r.capacity ? ` (seats ${r.capacity})` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <input placeholder="Location (optional)" value={fLoc} onChange={(e) => setFLoc(e.target.value)}
              style={{ width: "100%", marginBottom: 10 }} />
            <textarea placeholder="Description (optional)" value={fDesc} onChange={(e) => setFDesc(e.target.value)}
              rows={2} style={{ width: "100%", marginBottom: 10 }} />
            <label className="cal-check"><input type="checkbox" checked={fAllDay} onChange={(e) => setFAllDay(e.target.checked)} /> All day</label>
            <div className="cal-formrow">
              <label>Repeat
                <select value={fRrule} onChange={(e) => setFRrule(e.target.value)}>
                  <option value="">Does not repeat</option>
                  <option value="FREQ=DAILY">Daily</option>
                  <option value="FREQ=WEEKLY">Weekly</option>
                  <option value="FREQ=WEEKLY;INTERVAL=2">Every 2 weeks</option>
                  <option value="FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR">Every weekday</option>
                  <option value="FREQ=MONTHLY">Monthly</option>
                  <option value="FREQ=YEARLY">Yearly</option>
                </select>
              </label>
              <label>Reminder
                <select value={fReminder} onChange={(e) => setFReminder(e.target.value)}>
                  <option value="">None</option>
                  <option value="0">At start time</option>
                  <option value="5">5 minutes before</option>
                  <option value="15">15 minutes before</option>
                  <option value="30">30 minutes before</option>
                  <option value="60">1 hour before</option>
                  <option value="1440">1 day before</option>
                </select>
              </label>
            </div>
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
                    {fAtt.has(p.id) && isBusy(p.id) && (
                      <span className="d-sub" title="Has another event in this window">busy</span>
                    )}
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
      {shareOpen && (
        <Modal label="Share your calendar" onClose={() => setShareOpen(false)} style={{ width: 460 }}>
          <div className="ob-body">
            <p className="d-sub" style={{ marginTop: 0 }}>
              Delegates can view your calendar — "can edit" also lets them manage events on your behalf.
            </p>
            {delegates.map((d) => (
              <div key={d.id} className="chat-person" style={{ cursor: "default" }}>
                <span className="chat-item-main"><b>{d.displayName}</b><span className="d-sub">{d.email}</span></span>
                <label className="cal-check" style={{ margin: 0 }}>
                  <input type="checkbox" checked={d.canEdit}
                    onChange={(e) => void addDelegate(d.id, e.target.checked)} /> can edit
                </label>
                <button className="btn-ghost btn-sm" onClick={() => void removeDelegate(d.id)}>✕</button>
              </div>
            ))}
            {!delegates.length && <p className="d-sub">No delegates yet.</p>}
            <div className="cal-formrow" style={{ marginTop: 12 }}>
              <label style={{ flex: 1 }}>Add delegate
                <select defaultValue="" onChange={(e) => { if (e.target.value) { void addDelegate(e.target.value, false); e.target.value = ""; } }}>
                  <option value="" disabled>Pick a person…</option>
                  {people.filter((p) => p.id !== user?.id && !delegates.some((d) => d.id === p.id))
                    .map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                </select>
              </label>
            </div>
            {!people.length && (
              <button className="btn-ghost btn-sm" onClick={() =>
                void api.get<{ people: Person[] }>("/api/chat/people").then((r) => setPeople(r.people)).catch(() => {})}>
                Load people…
              </button>
            )}
          </div>
        </Modal>
      )}

      {resOpen && (
        <Modal label="Rooms &amp; resources" onClose={() => setResOpen(false)} style={{ width: 460 }}>
          <div className="ob-body">
            <p className="d-sub" style={{ marginTop: 0 }}>
              Bookable rooms and equipment — events that pick one get conflict-checked.
            </p>
            {resources.map((r) => (
              <div key={r.id} className="chat-person" style={{ cursor: "default" }}>
                <span className="chat-item-main">
                  <b>{r.name}</b>
                  <span className="d-sub">{r.kind}{r.capacity ? ` · seats ${r.capacity}` : ""}</span>
                </span>
                <button className="btn-ghost btn-sm" onClick={() => void delResource(r.id)}>✕</button>
              </div>
            ))}
            {!resources.length && <p className="d-sub">No resources defined.</p>}
            <div className="cal-formrow" style={{ marginTop: 12, alignItems: "flex-end" }}>
              <label style={{ flex: 2 }}>Name
                <input value={resName} onChange={(e) => setResName(e.target.value)} placeholder="Boardroom A" />
              </label>
              <label>Kind
                <select value={resKind} onChange={(e) => setResKind(e.target.value)}>
                  <option value="room">Room</option>
                  <option value="equipment">Equipment</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label style={{ width: 80 }}>Capacity
                <input type="number" min="0" value={resCap} onChange={(e) => setResCap(e.target.value)} />
              </label>
              <button className="btn-primary btn-sm" disabled={!resName.trim()} onClick={() => void addResource()}>Add</button>
            </div>
            <p className="d-sub" style={{ marginTop: 8 }}>Adding/removing requires the owner or admin role.</p>
          </div>
        </Modal>
      )}

      {msg && <div className="toast" role="status">{msg}</div>}
    </>
  );
}
