// Kreatix Calendar — org events with attendee RSVP. Visibility is creator +
// attendees (Outlook model); toggling "Add Meet" creates a meetings row and
// stores its id so the event can hand out a Jitsi join payload.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { q, one, run } from "../db.js";
import { encryptField, decryptField } from "../crypto.js";
import { meetEnabled } from "../meetBridge.js";
import { parseRRule, expandOccurrences, parseIcs, buildIcs, buildIcsFeed, validTz, type RRule } from "../recurrence.js";
import { sendMailSafe, tpl, publicUrl } from "../email.js";

interface EventRow {
  id: string; org_id: string; title: string; description: string | null;
  location: string | null; starts_at: string; ends_at: string; all_day: boolean;
  meeting_id: string | null; created_by: string; created_at: string; updated_at: string;
  rrule: string | null; resource_id: string | null; reminder_mins: number | null;
  tz: string | null;
}
interface ExceptionRow {
  event_id: string; occurrence_start: string; cancelled: boolean;
  title: string | null; location: string | null;
  starts_at: string | null; ends_at: string | null;
}
interface AttRow { user_id: string; status: string; display_name: string; initials: string }

const eventSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional(),
  location: z.string().trim().max(200).optional(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  allDay: z.boolean().optional(),
  attendeeIds: z.array(z.string().max(64)).max(50).optional(),
  meet: z.boolean().optional(),
  rrule: z.string().trim().max(300).nullish(),
  resourceId: z.string().max(64).nullish(),
  reminderMins: z.number().int().min(0).max(40320).nullish(),
  tz: z.string().trim().max(64).nullish(),
});

const enc = (v: string | null | undefined) => (v ? encryptField(v) ?? v : null);
const dec = (v: string | null | undefined) => (v ? decryptField(v) ?? v : null);

/** HMAC-signed RSVP tokens: <eidhex-uidhex>.<sig16> — compact (~87 chars)
 *  because find-my-way's default maxParamLength is 100. Keyed by the JWT
 *  secret — rotating it just invalidates outstanding invite links. */
const rsvpKey = () => process.env.JWT_SECRET ?? "kreatix-dev-secret-change-in-production";
const hexToUuid = (h: string) =>
  `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
const rsvpToken = (eventId: string, userId: string) => {
  const payload = `${eventId.replace(/-/g, "")}_${userId.replace(/-/g, "")}`;
  const sig = createHmac("sha256", rsvpKey()).update(payload).digest("base64url").slice(0, 22);
  return `${payload}.${sig}`;
};
const verifyRsvpToken = (token: string): { eventId: string; userId: string } | null => {
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !/^[0-9a-f]{64}$/i.test(payload.replace("_", ""))) return null;
  const want = createHmac("sha256", rsvpKey()).update(payload).digest("base64url").slice(0, 22);
  if (sig !== want) return null;
  const [e, u] = payload.split("_");
  return { eventId: hexToUuid(e), userId: hexToUuid(u) };
};

/** Personal calendar-feed tokens — <uidhex>.<sig>, domain-separated from
 *  RSVP tokens so an invite link can't be recycled as a feed URL. Rotating
 *  JWT_SECRET revokes all outstanding feed subscriptions. */
const feedToken = (userId: string) => {
  const payload = userId.replace(/-/g, "");
  const sig = createHmac("sha256", rsvpKey()).update(`feed:${payload}`).digest("base64url").slice(0, 22);
  return `${payload}.${sig}`;
};
const verifyFeedToken = (token: string): string | null => {
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !/^[0-9a-f]{32}$/i.test(payload)) return null;
  const want = createHmac("sha256", rsvpKey()).update(`feed:${payload}`).digest("base64url").slice(0, 22);
  return sig === want ? hexToUuid(payload) : null;
};

const eventOut = (r: EventRow, attendees: AttRow[] = [],
  occ?: { startsAt: Date; endsAt: Date; key?: Date }) => ({
  id: r.id, title: dec(r.title), description: dec(r.description), location: dec(r.location),
  startsAt: occ ? occ.startsAt.toISOString() : r.starts_at,
  endsAt: occ ? occ.endsAt.toISOString() : r.ends_at,
  allDay: r.all_day, rrule: r.rrule,
  occurrenceOf: occ && r.rrule ? r.starts_at : undefined,
  occurrenceKey: occ && r.rrule ? (occ.key ?? occ.startsAt).toISOString() : undefined,
  meetingId: r.meeting_id, createdBy: r.created_by, createdAt: r.created_at,
  resourceId: r.resource_id ?? null, reminderMins: r.reminder_mins ?? null,
  tz: r.tz,
  attendees: attendees.map((a) => ({ id: a.user_id, displayName: a.display_name, initials: a.initials, status: a.status })),
});

export function calendarRoutes(app: FastifyInstance) {

  /* ── Public RSVP links — the HMAC token is the credential; no session
   *  needed (recipients click from email, often logged out). GET only renders
   *  a confirm button — mail scanners prefetch GETs and must not record a
   *  response; the POST does. ── */
  const rsvpPage = (title: string, body: string) =>
    `<!doctype html><html><head><meta name="robots" content="noindex"><title>${title}</title></head>` +
    `<body style="font-family:sans-serif;text-align:center;padding:4rem;max-width:420px;margin:auto">${body}</body></html>`;
  const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const RSVP_LABEL: Record<string, string> = { accepted: "Accept", tentative: "Maybe", declined: "Decline" };

  app.get("/api/calendar/rsvp-link/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const { s } = req.query as { s?: string };
    const payload = verifyRsvpToken(token);
    if (!payload || !["accepted", "declined", "tentative"].includes(s ?? ""))
      return reply.code(400).header("content-type", "text/html; charset=utf-8")
        .send(rsvpPage("Invalid link", "<h2>Invalid or expired link</h2>"));
    const ev = await one<{ title: string }>(
      "SELECT title FROM calendar_events WHERE id = $1", [payload.eventId]);
    const title = escHtml(ev ? (dec(ev.title) ?? "Event") : "Event");
    return reply.header("content-type", "text/html; charset=utf-8").send(rsvpPage("RSVP",
      `<h2>${title}</h2>
       <form method="post" action="/api/calendar/rsvp-link/${encodeURIComponent(token)}?s=${encodeURIComponent(s!)}">
         <button type="submit" style="font-size:1.1rem;padding:.7rem 2.2rem;border-radius:8px;border:0;background:#F2782E;color:#fff;cursor:pointer">${RSVP_LABEL[s!]}</button>
       </form>`));
  });

  app.post("/api/calendar/rsvp-link/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const { s } = req.query as { s?: string };
    if (!["accepted", "declined", "tentative"].includes(s ?? ""))
      return reply.code(400).header("content-type", "text/html; charset=utf-8")
        .send(rsvpPage("Invalid link", "<h2>Invalid link</h2>"));
    const payload = verifyRsvpToken(token);
    if (!payload)
      return reply.code(403).header("content-type", "text/html; charset=utf-8")
        .send(rsvpPage("Invalid link", "<h2>Invalid or expired link</h2>"));
    const n = await run(
      "UPDATE calendar_attendees SET status = $1 WHERE event_id = $2 AND user_id = $3",
      [s, payload.eventId, payload.userId]);
    if (!n)
      return reply.code(404).header("content-type", "text/html; charset=utf-8")
        .send(rsvpPage("Not found", "<h2>Invitation not found</h2>"));
    // ping the organizer — responses shouldn't be invisible
    const ev = await one<EventRow>("SELECT * FROM calendar_events WHERE id = $1", [payload.eventId]);
    if (ev && ev.created_by !== payload.userId) {
      const who = await one<{ display_name: string }>(
        "SELECT display_name FROM users WHERE id = $1", [payload.userId]);
      void run(
        `INSERT INTO notifications (id, user_id, kind, actor_id, message)
         VALUES ($1,$2,'calendar',$3,$4)`,
        [randomUUID(), ev.created_by, payload.userId,
         enc(`${who?.display_name ?? "An attendee"} ${s}: ${dec(ev.title) ?? "event"}`)]);
    }
    return reply.header("content-type", "text/html; charset=utf-8")
      .send(rsvpPage("Response recorded",
        `<h2>Response recorded</h2><p>You ${s} this event. You can close this tab.</p>`));
  });

  /** Personal .ics feed — subscribe from Outlook/Apple/Google. Token-bound:
   *  serves everything that user can see (owns or attends). */
  app.get("/api/calendar/feed/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const userId = verifyFeedToken(token);
    if (!userId) return reply.code(403).send({ error: "forbidden", message: "Bad feed link" });
    const u = await one<{ org_id: string; email: string }>(
      "SELECT org_id, email FROM users WHERE id = $1 AND NOT disabled", [userId]);
    if (!u) return reply.code(404).send({ error: "not_found" });
    const rows = await q<EventRow>(
      `SELECT e.* FROM calendar_events e
       WHERE e.org_id = $1 AND (e.created_by = $2 OR EXISTS (
         SELECT 1 FROM calendar_attendees a WHERE a.event_id = e.id AND a.user_id = $2))
       ORDER BY e.starts_at LIMIT 2000`, [u.org_id, userId]);
    const recIds = rows.filter((r) => r.rrule).map((r) => r.id);
    const excRows = recIds.length
      ? await q<ExceptionRow>(
          "SELECT * FROM calendar_exceptions WHERE event_id = ANY($1)",
          [recIds])
      : [];
    const exBy = new Map<string, Date[]>();   // cancelled → EXDATE
    const ovBy = new Map<string, ExceptionRow[]>(); // moved/retitled → RECURRENCE-ID vevents
    for (const x of excRows) {
      if (x.cancelled) {
        const arr = exBy.get(x.event_id) ?? [];
        arr.push(new Date(x.occurrence_start)); exBy.set(x.event_id, arr);
      } else {
        const arr = ovBy.get(x.event_id) ?? [];
        arr.push(x); ovBy.set(x.event_id, arr);
      }
    }
    const seq = (r: EventRow) => Math.floor(new Date(r.updated_at).getTime() / 1000);
    const ics = buildIcsFeed(rows.flatMap((r) => {
      const base = {
        uid: `${r.id}@kreatix`, summary: dec(r.title) ?? "Event",
        description: dec(r.description) ?? undefined, location: dec(r.location) ?? undefined,
        startsAt: new Date(r.starts_at), endsAt: new Date(r.ends_at),
        allDay: r.all_day, rrule: r.rrule ?? undefined,
        sequence: seq(r), exdates: exBy.get(r.id),
        tz: r.tz ?? undefined,
      };
      const dur = new Date(r.ends_at).getTime() - new Date(r.starts_at).getTime();
      const overrides = (ovBy.get(r.id) ?? []).map((x) => ({
        ...base,
        summary: dec(x.title) ?? base.summary,
        location: x.location ? dec(x.location) ?? undefined : base.location,
        startsAt: x.starts_at ? new Date(x.starts_at) : new Date(x.occurrence_start),
        endsAt: x.ends_at ? new Date(x.ends_at) : new Date(new Date(x.occurrence_start).getTime() + dur),
        rrule: undefined, exdates: undefined,
        recurrenceId: new Date(x.occurrence_start),
      }));
      return [base, ...overrides];
    }), u.email);
    return reply
      .header("content-type", "text/calendar; charset=utf-8")
      .header("cache-control", "no-cache")
      .send(ics);
  });

  app.register(async (app) => {
  app.addHook("preHandler", requireAuth);

  const attendeesOf = async (eventIds: string[]) =>
    eventIds.length
      ? q<AttRow & { event_id: string }>(
          `SELECT ca.event_id, ca.user_id, ca.status, u.display_name, u.initials
           FROM calendar_attendees ca JOIN users u ON u.id = ca.user_id
           WHERE ca.event_id = ANY($1)`, [eventIds])
      : [];

  const getEvent = async (id: string, orgId: string) =>
    one<EventRow>("SELECT * FROM calendar_events WHERE id = $1 AND org_id = $2", [id, orgId]);

  const canSee = async (e: EventRow, userId: string) =>
    e.created_by === userId ||
    !!(await one("SELECT 1 AS x FROM calendar_attendees WHERE event_id = $1 AND user_id = $2", [e.id, userId]));

  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: "not_found", message: "Event not found" });

  /** Organizer, tenant admin, or a delegate with can_edit on the organizer. */
  const canManage = async (e: EventRow, user: AuthedRequest["user"]) => {
    if (e.created_by === user.id || user.role === "owner" || user.role === "admin") return true;
    return !!(await one(
      "SELECT 1 AS x FROM calendar_delegates WHERE owner_id = $1 AND delegate_id = $2 AND can_edit",
      [e.created_by, user.id]));
  };

  /** Room/resource conflict check — recurring bookers collide if ANY
   *  occurrence overlaps an existing booking's span. */
  const resourceConflict = async (
    orgId: string, resourceId: string, startsAt: string, endsAt: string,
    rrule: string | null, excludeEventId: string | null, tz: string | null,
  ): Promise<{ title: string } | "missing" | null> => {
    const res = await one<{ id: string; name: string }>(
      "SELECT id, name FROM calendar_resources WHERE id = $1 AND org_id = $2", [resourceId, orgId]);
    if (!res) return "missing";
    // recurring bookings conflict over the series horizon (~1y), not just the
    // first days — otherwise next week's occurrence double-books the room
    const loD = new Date(Date.parse(startsAt) - 24 * 3600_000);
    const hiD = new Date(Date.parse(endsAt) + (rrule ? 370 : 1) * 864e5);
    const dur = Date.parse(endsAt) - Date.parse(startsAt);
    const expand = (st: string, rule: RRule | null, d: number, z: string | null) =>
      rule
        ? expandOccurrences(new Date(st), rule, loD, hiD, 400, z ?? "UTC")
            .map((o) => ({ s: o.getTime(), e: o.getTime() + d }))
        : [{ s: Date.parse(st), e: Date.parse(st) + d }];
    let want = expand(startsAt, rrule ? parseRRule(rrule) : null, dur, tz);
    if (!want.length) want = [{ s: Date.parse(startsAt), e: Date.parse(endsAt) }];
    const maxE = new Date(Math.max(...want.map((w) => w.e))).toISOString();
    const minS = new Date(Math.min(...want.map((w) => w.s))).toISOString();
    const have = await q<{ id: string; starts_at: string; ends_at: string; rrule: string | null; title: string; tz: string | null }>(
      `SELECT id, starts_at, ends_at, rrule, title, tz FROM calendar_events
       WHERE org_id = $1 AND resource_id = $2 ${excludeEventId ? "AND id <> $5" : ""}
         AND (rrule IS NOT NULL OR (starts_at < $3::timestamptz AND ends_at > $4::timestamptz))`,
      excludeEventId ? [orgId, resourceId, maxE, minS, excludeEventId] : [orgId, resourceId, maxE, minS]);
    // exception rows cancel/re-time occurrences — a cancelled slot frees the room
    const excIds = [...new Set([...have.map((h) => h.id), ...(excludeEventId ? [excludeEventId] : [])])];
    const excRows = excIds.length
      ? await q<ExceptionRow>(
          "SELECT * FROM calendar_exceptions WHERE event_id = ANY($1) AND occurrence_start >= $2 AND occurrence_start <= $3",
          [excIds, loD.toISOString(), hiD.toISOString()])
      : [];
    const excBy = new Map<string, Map<string, ExceptionRow>>();
    for (const x of excRows) {
      if (!excBy.has(x.event_id)) excBy.set(x.event_id, new Map());
      excBy.get(x.event_id)!.set(new Date(x.occurrence_start).toISOString(), x);
    }
    const applyExc = (eventId: string, spans: { s: number; e: number }[]) => {
      const m = excBy.get(eventId);
      if (!m) return spans;
      const out: { s: number; e: number }[] = [];
      for (const sp of spans) {
        const x = m.get(new Date(sp.s).toISOString());
        if (x?.cancelled) continue;
        out.push(x?.starts_at && x?.ends_at
          ? { s: Date.parse(x.starts_at), e: Date.parse(x.ends_at) } : sp);
      }
      return out;
    };
    want = applyExc(excludeEventId ?? "", want);
    for (const h of have) {
      const hdur = Date.parse(h.ends_at) - Date.parse(h.starts_at);
      const spans = applyExc(h.id, expand(h.starts_at, h.rrule ? parseRRule(h.rrule) : null, hdur, h.tz));
      for (const w of want)
        for (const sp of spans)
          if (w.s < sp.e && w.e > sp.s) return { title: dec(h.title) ?? "Another event" };
    }
    return null;
  };

  /** Email each attendee a text/calendar invite (REQUEST) or cancel notice
   *  (CANCEL) with a .ics attachment — Outlook/Apple/Google pick it up
   *  directly; fire-and-forget so a mail outage never blocks the event. */
  const mailInvite = (e: EventRow, attendeeIds: string[], organizer: { id: string; email: string; displayName: string }, cancelled: boolean) => {
    if (!attendeeIds.length) return;
    const when = e.all_day
      ? new Date(e.starts_at).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) + " (all day)"
      : `${new Date(e.starts_at).toLocaleString()} – ${new Date(e.ends_at).toLocaleTimeString()}`;
    const ics = buildIcs({
      uid: `${e.id}@kreatix`, summary: dec(e.title) ?? "Event",
      description: dec(e.description) ?? undefined, location: dec(e.location) ?? undefined,
      startsAt: new Date(e.starts_at), endsAt: new Date(e.ends_at),
      allDay: e.all_day, rrule: e.rrule ?? undefined,
      sequence: Math.floor(new Date(e.updated_at).getTime() / 1000),
      tz: e.tz ?? undefined,
    }, organizer.email, cancelled ? "CANCEL" : "REQUEST");
    void q<{ id: string; email: string; display_name: string }>(
      "SELECT id, email, display_name FROM users WHERE id = ANY($1) AND NOT disabled", [attendeeIds])
      .then((recips) => {
        for (const r of recips) {
          // per-recipient one-click RSVP links
          const tok = rsvpToken(e.id, r.id);
          const yes = `${publicUrl()}/api/calendar/rsvp-link/${tok}?s=accepted`;
          const no = `${publicUrl()}/api/calendar/rsvp-link/${tok}?s=declined`;
          const maybe = `${publicUrl()}/api/calendar/rsvp-link/${tok}?s=tentative`;
          const t = tpl.meetingInvite(organizer.displayName, dec(e.title) ?? "Event",
            when, dec(e.location), !!e.meeting_id, cancelled,
            { accept: yes, maybe, decline: no });
          sendMailSafe(app.log, {
            to: r.email, toName: r.display_name, ...t,
            attachment: [{ name: "invite.ics", content: Buffer.from(ics).toString("base64") }],
          });
        }
      })
      .catch((err) => app.log.warn({ err: String(err) }, "invite recipient lookup failed"));
  };

  /** As-whose calendar? Delegates can pass ?as=<ownerId> to read/act for
   *  the owner (send-on-behalf: event still records real creator). */
  const actingAs = async (req: FastifyRequest): Promise<{ id: string; owner: string | null; canEdit: boolean }> => {
    const { user } = req as AuthedRequest;
    const as = (req.query as { as?: string }).as;
    if (!as || as === user.id) return { id: user.id, owner: null, canEdit: true };
    const grant = await one<{ can_edit: boolean }>(
      "SELECT can_edit FROM calendar_delegates WHERE owner_id = $1 AND delegate_id = $2 AND org_id = $3",
      [as, user.id, user.orgId]);
    if (!grant) return { id: user.id, owner: null, canEdit: true }; // no grant → own calendar
    return { id: as, owner: as, canEdit: grant.can_edit };
  };

  /** Expand a recurring event into occurrences inside [lo,hi], merged with
   *  its exception rows (cancel = drop; field overrides = patch). Sync —
   *  callers batch-fetch exceptions across all recurring rows once. */
  const expandWithExceptions = (r: EventRow, loD: Date, hiD: Date, exc: ExceptionRow[]):
    { startsAt: Date; endsAt: Date; key: Date; exc?: ExceptionRow }[] => {
    const rr = parseRRule(r.rrule);
    if (!rr) return [{ startsAt: new Date(r.starts_at), endsAt: new Date(r.ends_at), key: new Date(r.starts_at) }];
    const st = new Date(r.starts_at), en = new Date(r.ends_at);
    const dur = en.getTime() - st.getTime();
    const occs = expandOccurrences(st, rr, loD, hiD, 400, r.tz ?? "UTC")
      .map((o) => ({ startsAt: o, endsAt: new Date(o.getTime() + dur) }));
    const byStart = new Map(exc.map((x) => [new Date(x.occurrence_start).toISOString(), x]));
    const out: { startsAt: Date; endsAt: Date; key: Date; exc?: ExceptionRow }[] = [];
    for (const o of occs) {
      const x = byStart.get(o.startsAt.toISOString());
      if (x?.cancelled) continue;
      if (x) {
        out.push({
          startsAt: x.starts_at ? new Date(x.starts_at) : o.startsAt,
          endsAt: x.ends_at ? new Date(x.ends_at) : o.endsAt,
          key: o.startsAt, // series time — re-edits must key on this, not the moved time
          exc: x,
        });
      } else out.push({ ...o, key: o.startsAt });
    }
    return out;
  };

  /** Exception rows for a set of recurring events in one query — returns a
   *  per-event map for expandWithExceptions. */
  const exceptionsFor = async (eventIds: string[], loD: Date, hiD: Date) => {
    const rows = eventIds.length
      ? await q<ExceptionRow>(
          `SELECT * FROM calendar_exceptions
           WHERE event_id = ANY($1) AND occurrence_start >= $2 AND occurrence_start <= $3`,
          [eventIds, loD.toISOString(), hiD.toISOString()])
      : [];
    const byEvent = new Map<string, ExceptionRow[]>();
    for (const x of rows) {
      const arr = byEvent.get(x.event_id) ?? [];
      arr.push(x); byEvent.set(x.event_id, arr);
    }
    return byEvent;
  };

  /** Events overlapping [from,to] that I created or attend. */
  app.get("/api/calendar", async (req) => {
    const { user } = req as AuthedRequest;
    const { from, to } = req.query as { from?: string; to?: string };
    const lo = from && !isNaN(Date.parse(from)) ? from : new Date(Date.now() - 32 * 864e5).toISOString();
    const hi = to && !isNaN(Date.parse(to)) ? to : new Date(Date.now() + 62 * 864e5).toISOString();
    const act = await actingAs(req);
    const rows = await q<EventRow>(
      `SELECT e.* FROM calendar_events e
       WHERE e.org_id = $1 AND e.starts_at < $3
         AND (e.ends_at > $2 OR e.rrule IS NOT NULL)
         AND (e.created_by = $4 OR EXISTS (
           SELECT 1 FROM calendar_attendees a WHERE a.event_id = e.id AND a.user_id = $4))
       ORDER BY e.starts_at`, [user.orgId, lo, hi, act.id]);
    const atts = await attendeesOf(rows.map((r) => r.id));
    const loD = new Date(lo), hiD = new Date(hi);
    const excByEvent = await exceptionsFor(rows.filter((r) => r.rrule).map((r) => r.id), loD, hiD);
    const events: ReturnType<typeof eventOut>[] = [];
    for (const r of rows) {
      const ra = atts.filter((a) => a.event_id === r.id);
      for (const occ of expandWithExceptions(r, loD, hiD, excByEvent.get(r.id) ?? [])) {
        const out = eventOut(r, ra, occ);
        if (occ.exc?.title) out.title = dec(occ.exc.title);
        if (occ.exc?.location) out.location = dec(occ.exc.location);
        events.push(out);
      }
    }
    return { events, as: act.owner };
  });

  app.get("/api/calendar/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const e = await getEvent((req.params as { id: string }).id, user.orgId);
    if (!e || !(await canSee(e, user.id))) return notFound(reply);
    const atts = await attendeesOf([e.id]);
    return { event: eventOut(e, atts) };
  });

  app.post("/api/calendar", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const parsed = eventSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid event" });
    const d = parsed.data;
    if (Date.parse(d.endsAt) <= Date.parse(d.startsAt))
      return reply.code(400).send({ error: "invalid", message: "End must be after start" });
    if (d.rrule && !parseRRule(d.rrule))
      return reply.code(400).send({ error: "invalid", message: "Unsupported recurrence rule" });
    if (d.tz && !validTz(d.tz))
      return reply.code(400).send({ error: "invalid", message: "Unknown timezone" });
    const act = await actingAs(req);
    if (act.owner && !act.canEdit)
      return reply.code(403).send({ error: "forbidden", message: "View-only delegate" });
    const attendeeIds = [...new Set((d.attendeeIds ?? []).filter((i) => i !== act.id))];
    if (attendeeIds.length) {
      const okCount = await q<{ id: string }>(
        "SELECT id FROM users WHERE org_id = $1 AND disabled = false AND id = ANY($2)",
        [user.orgId, attendeeIds]);
      if (okCount.length !== attendeeIds.length)
        return reply.code(400).send({ error: "invalid", message: "Unknown attendee" });
    }
    // resource booking — the room must exist in this org and be free
    if (d.resourceId) {
      const conflict = await resourceConflict(user.orgId, d.resourceId, d.startsAt, d.endsAt, d.rrule ?? null, null, d.tz ?? null);
      if (conflict === "missing")
        return reply.code(400).send({ error: "invalid", message: "Unknown resource" });
      if (conflict)
        return reply.code(409).send({ error: "conflict", message: `${conflict.title} already booked for that time` });
    }
    let meetingId: string | null = null;
    if (d.meet && meetEnabled()) {
      meetingId = randomUUID();
      await run(
        `INSERT INTO meetings (id, org_id, code, title, created_by, scheduled_at, status)
         VALUES ($1,$2,$3,$4,$5,$6,'scheduled')`,
        [meetingId, user.orgId, `kx-${randomBytes(5).toString("hex")}`, d.title, user.id, d.startsAt]);
    }
    const id = randomUUID();
    const row = await one<EventRow>(
      `INSERT INTO calendar_events (id, org_id, title, description, location, starts_at, ends_at, all_day, meeting_id, created_by, rrule, resource_id, reminder_mins, tz)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [id, user.orgId, enc(d.title), enc(d.description), enc(d.location),
       d.startsAt, d.endsAt, !!d.allDay, meetingId, act.id, d.rrule ?? null,
       d.resourceId ?? null, d.reminderMins ?? null, d.tz ?? null]);
    for (const uid of attendeeIds) {
      await run("INSERT INTO calendar_attendees (event_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, uid]);
      void run(
        `INSERT INTO notifications (id, user_id, kind, actor_id, message)
         VALUES ($1,$2,'calendar',$3,$4)`,
        [randomUUID(), uid, user.id,
         enc(`${user.displayName} invited you: ${d.title}`)]);
    }
    const atts = await attendeesOf([id]);
    mailInvite(row!, attendeeIds, { id: user.id, email: user.email, displayName: user.displayName }, false);
    return reply.code(201).send({ event: eventOut(row!, atts) });
  });

  app.patch("/api/calendar/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const e = await getEvent((req.params as { id: string }).id, user.orgId);
    if (!e || (!(await canSee(e, user.id)) && !(await canManage(e, user)))) return notFound(reply);
    if (!(await canManage(e, user))) return reply.code(403).send({ error: "forbidden", message: "Only the organizer or a delegate can edit" });
    const parsed = eventSchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid event" });
    const d = parsed.data;
    if (d.rrule && !parseRRule(d.rrule))
      return reply.code(400).send({ error: "invalid", message: "Unsupported recurrence rule" });
    if (d.tz && !validTz(d.tz))
      return reply.code(400).send({ error: "invalid", message: "Unknown timezone" });
    if (Date.parse(d.endsAt ?? e.ends_at) <= Date.parse(d.startsAt ?? e.starts_at))
      return reply.code(400).send({ error: "invalid", message: "End must be after start" });
    const nextRes = d.resourceId !== undefined ? d.resourceId : e.resource_id;
    if (nextRes) {
      const conflict = await resourceConflict(user.orgId, nextRes,
        d.startsAt ?? e.starts_at, d.endsAt ?? e.ends_at,
        d.rrule !== undefined ? d.rrule : e.rrule, e.id,
        d.tz !== undefined ? d.tz : e.tz);
      if (conflict === "missing")
        return reply.code(400).send({ error: "invalid", message: "Unknown resource" });
      if (conflict)
        return reply.code(409).send({ error: "conflict", message: `${conflict.title} already booked for that time` });
    }
    const row = await one<EventRow>(
      `UPDATE calendar_events SET
         title = COALESCE($2, title), description = COALESCE($3, description),
         location = COALESCE($4, location), starts_at = COALESCE($5, starts_at),
         ends_at = COALESCE($6, ends_at), all_day = COALESCE($7, all_day),
         rrule = CASE WHEN $8::boolean THEN $9 ELSE rrule END,
         resource_id = CASE WHEN $10::boolean THEN $11 ELSE resource_id END,
         reminder_mins = CASE WHEN $12::boolean THEN $13 ELSE reminder_mins END,
         tz = CASE WHEN $14::boolean THEN $15 ELSE tz END,
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [e.id, d.title ? enc(d.title) : null, d.description !== undefined ? enc(d.description) : null,
       d.location !== undefined ? enc(d.location) : null, d.startsAt ?? null, d.endsAt ?? null,
       d.allDay ?? null, d.rrule !== undefined, d.rrule ?? null,
       d.resourceId !== undefined, d.resourceId ?? null,
       d.reminderMins !== undefined, d.reminderMins ?? null,
       d.tz !== undefined, d.tz ?? null]);
    // attendee edits are wholesale-replace when provided
    if (d.attendeeIds) {
      const keep = [...new Set(d.attendeeIds.filter((i) => i !== user.id))];
      const before = await attendeesOf([e.id]);
      await run("DELETE FROM calendar_attendees WHERE event_id = $1 AND NOT (user_id = ANY($2))", [e.id, keep]);
      for (const uid of keep)
        await run("INSERT INTO calendar_attendees (event_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [e.id, uid]);
      // removed attendees get a CANCEL notice — otherwise the event just vanishes
      const removed = before.filter((a) => !keep.includes(a.user_id)).map((a) => a.user_id);
      if (removed.length)
        mailInvite(e, removed, { id: user.id, email: user.email, displayName: user.displayName }, true);
    }
    const atts = await attendeesOf([e.id]);
    // re-invite everyone when the schedule/details changed
    if (d.title || d.startsAt || d.endsAt || d.location !== undefined || d.allDay !== undefined)
      mailInvite(row!, atts.map((a) => a.user_id), { id: user.id, email: user.email, displayName: user.displayName }, false);
    return { event: eventOut(row!, atts) };
  });

  app.delete("/api/calendar/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const e = await getEvent((req.params as { id: string }).id, user.orgId);
    if (!e || (!(await canSee(e, user.id)) && !(await canManage(e, user)))) return notFound(reply);
    if (!(await canManage(e, user)))
      return reply.code(403).send({ error: "forbidden", message: "Only the organizer or a delegate can delete" });
    if (e.meeting_id) await run("UPDATE meetings SET status = 'ended', ended_at = now() WHERE id = $1", [e.meeting_id]);
    const atts = await attendeesOf([e.id]);
    mailInvite(e, atts.map((a) => a.user_id), { id: user.id, email: user.email, displayName: user.displayName }, true);
    await run("DELETE FROM calendar_events WHERE id = $1", [e.id]);
    return { ok: true };
  });

  /** Attendee RSVP. */
  app.post("/api/calendar/:id/rsvp", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { status } = (req.body ?? {}) as { status?: string };
    if (!["accepted", "declined", "tentative"].includes(status ?? ""))
      return reply.code(400).send({ error: "invalid", message: "Status must be accepted|declined|tentative" });
    const e = await getEvent((req.params as { id: string }).id, user.orgId);
    if (!e || !(await canSee(e, user.id))) return notFound(reply);
    const n = await run(
      "UPDATE calendar_attendees SET status = $1 WHERE event_id = $2 AND user_id = $3",
      [status, e.id, user.id]);
    if (!n) return reply.code(403).send({ error: "forbidden", message: "You are not an attendee" });
    if (e.created_by !== user.id)
      void run(
        `INSERT INTO notifications (id, user_id, kind, actor_id, message)
         VALUES ($1,$2,'calendar',$3,$4)`,
        [randomUUID(), e.created_by, user.id,
         enc(`${user.displayName} ${status}: ${dec(e.title) ?? "event"}`)]);
    return { ok: true };
  });

  /* ── Free/busy ─────────────────────────────────────────── */

  /** Busy spans for org users in [from,to] — attendee-picker shading.
   *  Times only (no titles) to keep event details private. */
  app.get("/api/calendar/freebusy", async (req) => {
    const { user } = req as AuthedRequest;
    const { users: usersCsv, from, to } = req.query as { users?: string; from?: string; to?: string };
    const ids = [...new Set((usersCsv ?? "").split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 30);
    const lo = from && !isNaN(Date.parse(from)) ? new Date(from) : new Date(Date.now() - 864e5);
    const hi = to && !isNaN(Date.parse(to)) ? new Date(to) : new Date(Date.now() + 7 * 864e5);
    const okIds = (await q<{ id: string }>(
      "SELECT id FROM users WHERE org_id = $1 AND NOT disabled AND id = ANY($2)", [user.orgId, ids])).map((u) => u.id);
    const busy: Record<string, { startsAt: string; endsAt: string }[]> = Object.fromEntries(okIds.map((i) => [i, []]));
    const rows = await q<EventRow & { att: string }>(
      `SELECT e.*, a.user_id AS att FROM calendar_events e
       JOIN calendar_attendees a ON a.event_id = e.id AND a.user_id = ANY($2) AND a.status <> 'declined'
       WHERE e.org_id = $1 AND e.starts_at < $4 AND (e.ends_at > $3 OR e.rrule IS NOT NULL)
       UNION
       SELECT e.*, e.created_by AS att FROM calendar_events e
       WHERE e.org_id = $1 AND e.created_by = ANY($2) AND e.starts_at < $4
         AND (e.ends_at > $3 OR e.rrule IS NOT NULL)`,
      [user.orgId, okIds, lo.toISOString(), hi.toISOString()]);
    const excByEvent = await exceptionsFor(rows.filter((r) => r.rrule).map((r) => r.id), lo, hi);
    for (const r of rows)
      for (const occ of expandWithExceptions(r, lo, hi, excByEvent.get(r.id) ?? []))
        busy[r.att].push({ startsAt: occ.startsAt.toISOString(), endsAt: occ.endsAt.toISOString() });
    return { busy };
  });

  /* ── Rooms / resources ─────────────────────────────────── */

  app.get("/api/calendar/resources", async (req) => {
    const { user } = req as AuthedRequest;
    const rows = await q<{ id: string; name: string; kind: string; capacity: number | null }>(
      "SELECT id, name, kind, capacity FROM calendar_resources WHERE org_id = $1 ORDER BY name", [user.orgId]);
    return { resources: rows };
  });

  const resSchema = z.object({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(["room", "equipment", "other"]).default("room"),
    capacity: z.number().int().min(0).max(100000).optional(),
  });

  app.post("/api/calendar/resources", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (user.role !== "owner" && user.role !== "admin")
      return reply.code(403).send({ error: "forbidden", message: "Admin only" });
    const d = resSchema.parse(req.body);
    const row = await one<{ id: string }>(
      "INSERT INTO calendar_resources (id, org_id, name, kind, capacity) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [randomUUID(), user.orgId, d.name, d.kind, d.capacity ?? null]);
    return reply.code(201).send({ resource: { id: row!.id, name: d.name, kind: d.kind, capacity: d.capacity ?? null } });
  });

  app.patch("/api/calendar/resources/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (user.role !== "owner" && user.role !== "admin")
      return reply.code(403).send({ error: "forbidden", message: "Admin only" });
    const d = resSchema.partial().parse(req.body);
    const { id } = req.params as { id: string };
    const row = await one<{ id: string }>(
      `UPDATE calendar_resources SET name = COALESCE($2, name), kind = COALESCE($3, kind),
         capacity = COALESCE($4, capacity) WHERE id = $1 AND org_id = $5 RETURNING id`,
      [id, d.name ?? null, d.kind ?? null, d.capacity ?? null, user.orgId]);
    if (!row) return reply.code(404).send({ error: "not_found", message: "Resource not found" });
    return { ok: true };
  });

  app.delete("/api/calendar/resources/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (user.role !== "owner" && user.role !== "admin")
      return reply.code(403).send({ error: "forbidden", message: "Admin only" });
    const { id } = req.params as { id: string };
    await run("UPDATE calendar_events SET resource_id = NULL WHERE resource_id = $1 AND org_id = $2", [id, user.orgId]);
    const n = await run("DELETE FROM calendar_resources WHERE id = $1 AND org_id = $2", [id, user.orgId]);
    if (!n) return reply.code(404).send({ error: "not_found", message: "Resource not found" });
    return { ok: true };
  });

  /* ── Recurring-event exceptions ────────────────────────── */

  /** Edit or cancel ONE occurrence of a recurring event. occurrenceStart is
   *  the occurrence's original start; {cancel:true} drops it, otherwise the
   *  given fields override just that occurrence. */
  app.patch("/api/calendar/:id/occurrence", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { id } = req.params as { id: string };
    const d = z.object({
      occurrenceStart: z.string().datetime({ offset: true }),
      startsAt: z.string().datetime({ offset: true }).optional(),
      endsAt: z.string().datetime({ offset: true }).optional(),
      title: z.string().trim().min(1).max(200).optional(),
      location: z.string().trim().max(200).optional(),
      cancel: z.boolean().optional(),
    }).parse(req.body);
    const e = await getEvent(id, user.orgId);
    const manager = e ? await canManage(e, user) : false;
    if (!e || (!(await canSee(e, user.id)) && !manager)) return notFound(reply);
    if (!manager) return reply.code(403).send({ error: "forbidden", message: "Only the organizer or a delegate can edit occurrences" });
    if (!e.rrule) return reply.code(400).send({ error: "invalid", message: "Not a recurring event" });
    await run(
      `INSERT INTO calendar_exceptions (event_id, occurrence_start, cancelled, starts_at, ends_at, title, location, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (event_id, occurrence_start) DO UPDATE SET
         cancelled = EXCLUDED.cancelled, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
         title = EXCLUDED.title, location = EXCLUDED.location`,
      [e.id, d.occurrenceStart, !!d.cancel, d.startsAt ?? null, d.endsAt ?? null,
       d.title ? enc(d.title) : null, d.location !== undefined ? enc(d.location) : null, user.id]);
    return { ok: true };
  });

  /* ── Delegated calendars ───────────────────────────────── */

  app.get("/api/calendar/delegates", async (req) => {
    const { user } = req as AuthedRequest;
    const mine = await q<{ delegate_id: string; can_edit: boolean; display_name: string; email: string }>(
      `SELECT d.delegate_id, d.can_edit, u.display_name, u.email FROM calendar_delegates d
       JOIN users u ON u.id = d.delegate_id WHERE d.owner_id = $1 AND d.org_id = $2`, [user.id, user.orgId]);
    const forMe = await q<{ owner_id: string; can_edit: boolean; display_name: string; email: string }>(
      `SELECT d.owner_id, d.can_edit, u.display_name, u.email FROM calendar_delegates d
       JOIN users u ON u.id = d.owner_id WHERE d.delegate_id = $1 AND d.org_id = $2`, [user.id, user.orgId]);
    return {
      delegates: mine.map((d) => ({ id: d.delegate_id, canEdit: d.can_edit, displayName: d.display_name, email: d.email })),
      sharedWithMe: forMe.map((d) => ({ id: d.owner_id, canEdit: d.can_edit, displayName: d.display_name, email: d.email })),
    };
  });

  app.post("/api/calendar/delegates", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const d = z.object({ delegateId: z.string().max(64), canEdit: z.boolean().default(false) }).parse(req.body);
    if (d.delegateId === user.id)
      return reply.code(400).send({ error: "invalid", message: "Can't delegate to yourself" });
    const target = await one("SELECT 1 AS x FROM users WHERE id = $1 AND org_id = $2 AND NOT disabled",
      [d.delegateId, user.orgId]);
    if (!target) return reply.code(404).send({ error: "not_found", message: "User not found" });
    await run(
      `INSERT INTO calendar_delegates (owner_id, delegate_id, org_id, can_edit) VALUES ($1,$2,$3,$4)
       ON CONFLICT (owner_id, delegate_id) DO UPDATE SET can_edit = EXCLUDED.can_edit`,
      [user.id, d.delegateId, user.orgId, d.canEdit]);
    return { ok: true };
  });

  app.delete("/api/calendar/delegates/:id", async (req) => {
    const { user } = req as AuthedRequest;
    const { id } = req.params as { id: string };
    await run("DELETE FROM calendar_delegates WHERE owner_id = $1 AND delegate_id = $2", [user.id, id]);
    return { ok: true };
  });

  /* ── RSVP links ────────────────────────────────────────── */

  /** Organizer mints an RSVP token for one of the event's attendees
   *  (the mail template embeds these per-recipient). */
  app.get("/api/calendar/:id/rsvp-link", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { id } = req.params as { id: string };
    const e = await getEvent(id, user.orgId);
    if (!e || !(await canSee(e, user.id))) return notFound(reply);
    const isAdmin = user.role === "owner" || user.role === "admin";
    if (e.created_by !== user.id && !isAdmin)
      return reply.code(403).send({ error: "forbidden", message: "Only the organizer can mint RSVP links" });
    const { userId } = req.query as { userId?: string };
    const att = await one<{ user_id: string }>(
      "SELECT user_id FROM calendar_attendees WHERE event_id = $1 AND user_id = $2", [e.id, userId ?? ""]);
    if (!att) return reply.code(404).send({ error: "not_found", message: "Attendee not found" });
    return { token: rsvpToken(e.id, att.user_id) };
  });

  /** Reveal the caller's personal feed URL (webcal subscription link). */
  app.get("/api/calendar/feed-url", async (req) => {
    const { user } = req as AuthedRequest;
    return { url: `${publicUrl()}/api/calendar/feed/${feedToken(user.id)}` };
  });

  /** Single-event .ics download (Outlook/Apple importable). */
  app.get("/api/calendar/:id/ics", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const e = await getEvent((req.params as { id: string }).id, user.orgId);
    if (!e || !(await canSee(e, user.id))) return notFound(reply);
    const ics = buildIcs({
      uid: `${e.id}@kreatix`, summary: dec(e.title) ?? "Event",
      description: dec(e.description) ?? undefined, location: dec(e.location) ?? undefined,
      startsAt: new Date(e.starts_at), endsAt: new Date(e.ends_at),
      allDay: e.all_day, rrule: e.rrule ?? undefined,
      tz: e.tz ?? undefined,
    }, user.email);
    return reply
      .header("content-type", "text/calendar; charset=utf-8")
      .header("content-disposition", `attachment; filename="event-${e.id.slice(0, 8)}.ics"`)
      .send(ics);
  });

  /** Bulk .ics import — parses VEVENTs into owned events (max 100/file). */
  app.post("/api/calendar/import", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { ics } = (req.body ?? {}) as { ics?: string };
    if (!ics || ics.length > 500_000)
      return reply.code(400).send({ error: "invalid", message: "Expected { ics } payload" });
    const parsed = parseIcs(ics);
    if (!parsed.length) return reply.code(400).send({ error: "invalid", message: "No VEVENTs found" });
    if (parsed.length > 100) return reply.code(400).send({ error: "invalid", message: "Max 100 events per import" });
    // UID dedup — re-importing the same file skips events already brought in
    const existing = await q<{ ical_uid: string }>(
      "SELECT ical_uid FROM calendar_events WHERE org_id = $1 AND ical_uid = ANY($2)",
      [user.orgId, parsed.map((p) => p.uid)]);
    const seen = new Set(existing.map((r) => r.ical_uid));
    let skipped = 0;
    const created: string[] = [];
    for (const ev of parsed) {
      if (seen.has(ev.uid)) { skipped++; continue; }
      seen.add(ev.uid);
      const rr = ev.rrule && parseRRule(ev.rrule) ? ev.rrule.replace(/^RRULE:/i, "") : null;
      const row = await one<{ id: string }>(
        `INSERT INTO calendar_events (id, org_id, title, description, location, starts_at, ends_at, all_day, created_by, rrule, ical_uid, tz)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [randomUUID(), user.orgId, enc(ev.summary), enc(ev.description), enc(ev.location),
         ev.startsAt.toISOString(), ev.endsAt.toISOString(), ev.allDay, user.id, rr, ev.uid, ev.tz ?? null]);
      if (row) created.push(row.id);
    }
    return reply.code(201).send({ imported: created.length, skipped });
  });
  });
}

/* ── Reminder sweep — called every 60s from server.ts via runSweep ── */

const fmtLead = (mins: number) => !mins ? "now"
  : mins < 60 ? `in ${mins} min`
  : mins % 1440 === 0 ? `in ${mins / 1440} day${mins > 1440 ? "s" : ""}`
  : `in ${Math.round(mins / 6) / 10} hr`;

/** Bell notifications for occurrences whose reminder time has arrived.
 *  Recurring events expand ~25h ahead; the log dedups per (event, occurrence)
 *  so each instance notifies once. A reschedule re-fires naturally — the log
 *  key is the new starts_at. Cancelled exceptions stay silent. */
export async function sweepCalendarReminders(): Promise<number> {
  const now = Date.now();
  const horizon = new Date(now + 25 * 3600_000);
  const rows = await q<EventRow>(
    `SELECT * FROM calendar_events WHERE reminder_mins IS NOT NULL
       AND (starts_at <= $1 OR rrule IS NOT NULL) LIMIT 500`,
    [horizon.toISOString()]);
  if (!rows.length) return 0;
  const recIds = rows.filter((r) => r.rrule).map((r) => r.id);
  const excRows = recIds.length
    ? await q<ExceptionRow>(
        `SELECT * FROM calendar_exceptions
         WHERE event_id = ANY($1) AND occurrence_start >= $2 AND occurrence_start <= $3`,
        [recIds, new Date(now - 864e5).toISOString(), horizon.toISOString()])
    : [];
  const excBy = new Map<string, Map<string, ExceptionRow>>();
  for (const x of excRows) {
    if (!excBy.has(x.event_id)) excBy.set(x.event_id, new Map());
    excBy.get(x.event_id)!.set(new Date(x.occurrence_start).toISOString(), x);
  }
  const fired = new Set(
    (await q<{ event_id: string; occurrence_start: string }>(
      "SELECT event_id, occurrence_start FROM calendar_reminder_log WHERE event_id = ANY($1)",
      [rows.map((r) => r.id)]))
      .map((a) => `${a.event_id}|${new Date(a.occurrence_start).toISOString()}`));
  let sent = 0;
  for (const e of rows) {
    const dur = Date.parse(e.ends_at) - Date.parse(e.starts_at);
    const rr = e.rrule ? parseRRule(e.rrule) : null;
    const exc = excBy.get(e.id);
    const occStarts = rr
      ? expandOccurrences(new Date(e.starts_at), rr, new Date(now - 864e5), horizon, 400, e.tz ?? "UTC")
      : [new Date(e.starts_at)];
    for (const o of occStarts) {
      const key = o.toISOString();
      if (fired.has(`${e.id}|${key}`)) continue;
      const x = exc?.get(key);
      if (x?.cancelled) continue;
      const start = x?.starts_at ? Date.parse(x.starts_at) : o.getTime();
      const end = x?.ends_at ? Date.parse(x.ends_at) : start + dur;
      const trigger = start - (e.reminder_mins ?? 0) * 60_000;
      if (now < trigger || now >= end) continue;   // not due yet / already over
      const recips = await q<{ user_id: string }>(
        "SELECT user_id FROM calendar_attendees WHERE event_id = $1 AND status <> 'declined'",
        [e.id]);
      const ids = [...new Set([e.created_by, ...recips.map((r) => r.user_id)])];
      const title = dec(e.title) ?? "Event";
      for (const uid of ids)
        await run(
          `INSERT INTO notifications (id, user_id, kind, actor_id, message)
           VALUES ($1,$2,'calendar',$3,$4)`,
          [randomUUID(), uid, e.created_by,
           enc(`Reminder: ${title} starts ${fmtLead(e.reminder_mins ?? 0)}`)]);
      await run(
        "INSERT INTO calendar_reminder_log (event_id, occurrence_start) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [e.id, key]);
      sent += ids.length;
    }
  }
  return sent;
}
