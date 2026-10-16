// Kreatix Calendar — org events with attendee RSVP. Visibility is creator +
// attendees (Outlook model); toggling "Add Meet" creates a meetings row and
// stores its id so the event can hand out a Jitsi join payload.
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { q, one, run } from "../db.js";
import { encryptField, decryptField } from "../crypto.js";
import { meetEnabled } from "../meetBridge.js";
import { parseRRule, expandOccurrences, parseIcs, buildIcs } from "../recurrence.js";

interface EventRow {
  id: string; org_id: string; title: string; description: string | null;
  location: string | null; starts_at: string; ends_at: string; all_day: boolean;
  meeting_id: string | null; created_by: string; created_at: string; updated_at: string;
  rrule: string | null;
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
});

const enc = (v: string | null | undefined) => (v ? encryptField(v) ?? v : null);
const dec = (v: string | null | undefined) => (v ? decryptField(v) ?? v : null);

const eventOut = (r: EventRow, attendees: AttRow[] = [], occ?: { startsAt: Date; endsAt: Date }) => ({
  id: r.id, title: dec(r.title), description: dec(r.description), location: dec(r.location),
  startsAt: occ ? occ.startsAt.toISOString() : r.starts_at,
  endsAt: occ ? occ.endsAt.toISOString() : r.ends_at,
  allDay: r.all_day, rrule: r.rrule, occurrenceOf: occ ? r.starts_at : undefined,
  meetingId: r.meeting_id, createdBy: r.created_by, createdAt: r.created_at,
  attendees: attendees.map((a) => ({ id: a.user_id, displayName: a.display_name, initials: a.initials, status: a.status })),
});

export function calendarRoutes(app: FastifyInstance) {
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

  /** Events overlapping [from,to] that I created or attend. */
  app.get("/api/calendar", async (req) => {
    const { user } = req as AuthedRequest;
    const { from, to } = req.query as { from?: string; to?: string };
    const lo = from && !isNaN(Date.parse(from)) ? from : new Date(Date.now() - 32 * 864e5).toISOString();
    const hi = to && !isNaN(Date.parse(to)) ? to : new Date(Date.now() + 62 * 864e5).toISOString();
    const rows = await q<EventRow>(
      `SELECT e.* FROM calendar_events e
       WHERE e.org_id = $1 AND e.starts_at < $3
         AND (e.ends_at > $2 OR e.rrule IS NOT NULL)
         AND (e.created_by = $4 OR EXISTS (
           SELECT 1 FROM calendar_attendees a WHERE a.event_id = e.id AND a.user_id = $4))
       ORDER BY e.starts_at`, [user.orgId, lo, hi, user.id]);
    const atts = await attendeesOf(rows.map((r) => r.id));
    const loD = new Date(lo), hiD = new Date(hi);
    const events: ReturnType<typeof eventOut>[] = [];
    for (const r of rows) {
      const rr = parseRRule(r.rrule);
      if (!rr) {
        events.push(eventOut(r, atts.filter((a) => a.event_id === r.id)));
        continue;
      }
      const st = new Date(r.starts_at), en = new Date(r.ends_at);
      const dur = en.getTime() - st.getTime();
      for (const occ of expandOccurrences(st, rr, loD, hiD)) {
        events.push(eventOut(r, atts.filter((a) => a.event_id === r.id),
          { startsAt: occ, endsAt: new Date(occ.getTime() + dur) }));
      }
    }
    return { events };
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
    const attendeeIds = [...new Set((d.attendeeIds ?? []).filter((i) => i !== user.id))];
    if (attendeeIds.length) {
      const okCount = await q<{ id: string }>(
        "SELECT id FROM users WHERE org_id = $1 AND disabled = false AND id = ANY($2)",
        [user.orgId, attendeeIds]);
      if (okCount.length !== attendeeIds.length)
        return reply.code(400).send({ error: "invalid", message: "Unknown attendee" });
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
      `INSERT INTO calendar_events (id, org_id, title, description, location, starts_at, ends_at, all_day, meeting_id, created_by, rrule)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, user.orgId, enc(d.title), enc(d.description), enc(d.location),
       d.startsAt, d.endsAt, !!d.allDay, meetingId, user.id, d.rrule ?? null]);
    for (const uid of attendeeIds) {
      await run("INSERT INTO calendar_attendees (event_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, uid]);
      void run(
        `INSERT INTO notifications (id, user_id, kind, actor_id, message)
         VALUES ($1,$2,'calendar',$3,$4)`,
        [randomUUID(), uid, user.id,
         enc(`${user.displayName} invited you: ${d.title}`)]);
    }
    const atts = await attendeesOf([id]);
    return reply.code(201).send({ event: eventOut(row!, atts) });
  });

  app.patch("/api/calendar/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const e = await getEvent((req.params as { id: string }).id, user.orgId);
    if (!e || !(await canSee(e, user.id))) return notFound(reply);
    if (e.created_by !== user.id) return reply.code(403).send({ error: "forbidden", message: "Only the organizer can edit" });
    const parsed = eventSchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid event" });
    const d = parsed.data;
    if (d.rrule && !parseRRule(d.rrule))
      return reply.code(400).send({ error: "invalid", message: "Unsupported recurrence rule" });
    const row = await one<EventRow>(
      `UPDATE calendar_events SET
         title = COALESCE($2, title), description = COALESCE($3, description),
         location = COALESCE($4, location), starts_at = COALESCE($5, starts_at),
         ends_at = COALESCE($6, ends_at), all_day = COALESCE($7, all_day),
         rrule = CASE WHEN $8::boolean THEN $9 ELSE rrule END, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [e.id, d.title ? enc(d.title) : null, d.description !== undefined ? enc(d.description) : null,
       d.location !== undefined ? enc(d.location) : null, d.startsAt ?? null, d.endsAt ?? null,
       d.allDay ?? null, d.rrule !== undefined, d.rrule ?? null]);
    // attendee edits are wholesale-replace when provided
    if (d.attendeeIds) {
      const keep = [...new Set(d.attendeeIds.filter((i) => i !== user.id))];
      await run("DELETE FROM calendar_attendees WHERE event_id = $1 AND NOT (user_id = ANY($2))", [e.id, keep]);
      for (const uid of keep)
        await run("INSERT INTO calendar_attendees (event_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [e.id, uid]);
    }
    const atts = await attendeesOf([e.id]);
    return { event: eventOut(row!, atts) };
  });

  app.delete("/api/calendar/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const e = await getEvent((req.params as { id: string }).id, user.orgId);
    if (!e || !(await canSee(e, user.id))) return notFound(reply);
    if (e.created_by !== user.id && user.role !== "owner" && user.role !== "admin")
      return reply.code(403).send({ error: "forbidden", message: "Only the organizer can delete" });
    if (e.meeting_id) await run("UPDATE meetings SET status = 'ended', ended_at = now() WHERE id = $1", [e.meeting_id]);
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
    return { ok: true };
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
    const created: string[] = [];
    for (const ev of parsed) {
      const rr = ev.rrule && parseRRule(ev.rrule) ? ev.rrule.replace(/^RRULE:/i, "") : null;
      const row = await one<{ id: string }>(
        `INSERT INTO calendar_events (id, org_id, title, description, location, starts_at, ends_at, all_day, created_by, rrule)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [randomUUID(), user.orgId, enc(ev.summary), enc(ev.description), enc(ev.location),
         ev.startsAt.toISOString(), ev.endsAt.toISOString(), ev.allDay, user.id, rr]);
      if (row) created.push(row.id);
    }
    return reply.code(201).send({ imported: created.length });
  });
}
