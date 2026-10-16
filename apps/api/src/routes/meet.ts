import type { FastifyInstance, FastifyReply } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, statSync, existsSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { q, one, run } from "../db.js";
import { meetBase, meetEnabled, mintMeetToken, recDir, recordingEnabled } from "../meetBridge.js";
import { encryptField } from "../crypto.js";
import { fireTrigger } from "../rules.js";

interface MeetingRow {
  id: string; org_id: string; code: string; title: string;
  created_by: string; scheduled_at: string | null; status: string;
  created_at: string; ended_at: string | null;
  creator_name?: string;
}

const createSchema = z.object({
  title: z.string().trim().max(120).optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  startNow: z.boolean().optional(),
});

const meetingOut = (r: MeetingRow & { rec_count?: number }) => ({
  id: r.id, code: r.code, title: r.title, status: r.status,
  scheduledAt: r.scheduled_at, createdBy: r.created_by,
  createdByName: r.creator_name ?? null,
  createdAt: r.created_at, endedAt: r.ended_at,
  recordings: Number(r.rec_count ?? 0),
});

/** Join payload — fresh Jitsi JWT per call; the room code is the Jitsi room. */
const joinPayload = (m: MeetingRow, user: { displayName: string; email: string }, moderator: boolean) => ({
  base: meetBase(),
  room: m.code,
  jwt: mintMeetToken({ room: m.code, name: user.displayName, email: user.email, moderator }),
  displayName: user.displayName,
});

export function meetRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  const getMeeting = async (id: string, orgId: string) =>
    one<MeetingRow>(
      `SELECT m.*, u.display_name AS creator_name FROM meetings m
       JOIN users u ON u.id = m.created_by WHERE m.id = $1 AND m.org_id = $2`, [id, orgId]);

  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: "not_found", message: "Meeting not found" });

  app.get("/api/meet/status", async () => ({ enabled: meetEnabled() }));

  app.get("/api/meet", async (req) => {
    const { user } = req as AuthedRequest;
    if (!meetEnabled()) return { enabled: false, meetings: [] };
    const rows = await q<MeetingRow & { rec_count: number }>(
      `SELECT m.*, u.display_name AS creator_name,
              (SELECT count(*) FROM meeting_recordings r WHERE r.meeting_id = m.id) AS rec_count
       FROM meetings m
       JOIN users u ON u.id = m.created_by WHERE m.org_id = $1
       ORDER BY CASE m.status WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,
                COALESCE(m.scheduled_at, m.created_at) DESC
       LIMIT 60`, [user.orgId]);
    return { enabled: true, recording: recordingEnabled(), meetings: rows.map(meetingOut) };
  });

  app.post("/api/meet", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!meetEnabled()) return reply.code(404).send({ error: "meet_disabled", message: "Meet is not configured" });
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid meeting" });
    const { title, scheduledAt, startNow } = parsed.data;
    const code = `kx-${randomBytes(5).toString("hex")}`;
    const row = await one<MeetingRow>(
      `INSERT INTO meetings (id, org_id, code, title, created_by, scheduled_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *, NULL AS creator_name`,
      [randomUUID(), user.orgId, code,
       title?.trim() || `${user.displayName}'s meeting`,
       user.id, scheduledAt ?? null, startNow ? "live" : "scheduled"]);
    // scheduled meetings get a calendar event so they show up on the calendar
    if (scheduledAt && row) {
      const endsAt = new Date(Date.parse(scheduledAt) + 30 * 60_000).toISOString();
      await run(
        `INSERT INTO calendar_events (id, org_id, title, starts_at, ends_at, meeting_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), user.orgId, encryptField(row.title) ?? row.title, scheduledAt, endsAt, row.id, user.id]);
    }
    return reply.code(201).send({ meeting: { ...meetingOut(row!), createdByName: user.displayName }, join: joinPayload(row!, user, true) });
  });

  app.get("/api/meet/:id/join", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!meetEnabled()) return reply.code(404).send({ error: "meet_disabled", message: "Meet is not configured" });
    const m = await getMeeting((req.params as { id: string }).id, user.orgId);
    if (!m) return notFound(reply);
    if (m.status === "ended") return reply.code(410).send({ error: "ended", message: "This meeting has ended" });
    if (m.status === "scheduled") await run("UPDATE meetings SET status = 'live' WHERE id = $1", [m.id]);
    return { join: joinPayload(m, user, m.created_by === user.id) };
  });

  /** Join by room code — same flow Teams' "join with a code" uses. */
  app.post("/api/meet/join-code", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!meetEnabled()) return reply.code(404).send({ error: "meet_disabled", message: "Meet is not configured" });
    const { code } = (req.body ?? {}) as { code?: string };
    const m = await one<MeetingRow>(
      `SELECT m.*, u.display_name AS creator_name FROM meetings m
       JOIN users u ON u.id = m.created_by WHERE m.code = $1 AND m.org_id = $2`,
      [(code ?? "").trim().toLowerCase(), user.orgId]);
    if (!m) return notFound(reply);
    if (m.status === "ended") return reply.code(410).send({ error: "ended", message: "This meeting has ended" });
    if (m.status === "scheduled") await run("UPDATE meetings SET status = 'live' WHERE id = $1", [m.id]);
    return { join: joinPayload(m, user, m.created_by === user.id) };
  });

  /** Guest link — outsiders open the Jitsi URL directly with a guest JWT. */
  app.post("/api/meet/:id/guest-link", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const m = await getMeeting((req.params as { id: string }).id, user.orgId);
    if (!m) return notFound(reply);
    if (m.created_by !== user.id && user.role !== "owner" && user.role !== "admin")
      return reply.code(403).send({ error: "forbidden", message: "Only the host can share a guest link" });
    if (m.status === "ended") return reply.code(410).send({ error: "ended", message: "This meeting has ended" });
    const jwt = mintMeetToken({ room: m.code, name: "Guest", ttlSec: 6 * 3600 });
    return { url: `${meetBase()}/${m.code}?jwt=${jwt}` };
  });

  app.post("/api/meet/:id/end", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const m = await getMeeting((req.params as { id: string }).id, user.orgId);
    if (!m) return notFound(reply);
    if (m.created_by !== user.id && user.role !== "owner" && user.role !== "admin")
      return reply.code(403).send({ error: "forbidden", message: "Only the host can end a meeting" });
    await run("UPDATE meetings SET status = 'ended', ended_at = now() WHERE id = $1", [m.id]);
    void fireTrigger(user.orgId, "meeting.ended",
      { meetingId: m.id, name: m.title ?? "Meeting" }, app.log);
    return { ok: true };
  });

  /** Recordings for a meeting — org members can list; playback is /stream. */
  app.get("/api/meet/:id/recordings", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const m = await getMeeting((req.params as { id: string }).id, user.orgId);
    if (!m) return notFound(reply);
    const rows = await q<{ id: string; size: number | null; duration_sec: number | null; created_at: string; path: string }>(
      "SELECT id, size, duration_sec, created_at, path FROM meeting_recordings WHERE meeting_id = $1 ORDER BY created_at DESC",
      [m.id]);
    return {
      recordings: rows.map((r) => ({
        id: r.id, size: r.size, durationSec: r.duration_sec,
        createdAt: r.created_at, name: basename(r.path),
      })),
    };
  });

  /** Authenticated playback — range-aware for seek support in <video>. */
  app.get("/api/meet/recordings/:rid/stream", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const rec = await one<{ id: string; path: string; org_id: string }>(
      "SELECT id, path, org_id FROM meeting_recordings WHERE id = $1", [(req.params as { rid: string }).rid]);
    if (!rec || rec.org_id !== user.orgId) return notFound(reply);
    const file = safeRecordingPath(rec.path);
    if (!file || !existsSync(file)) return reply.code(410).send({ error: "gone", message: "Recording file is not available" });
    const size = statSync(file).size;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    reply.header("content-type", "video/mp4").header("accept-ranges", "bytes");
    if (range) {
      const start = Math.min(parseInt(range[1], 10), size - 1);
      const end = range[2] ? Math.min(parseInt(range[2], 10), size - 1) : size - 1;
      return reply.code(206)
        .header("content-range", `bytes ${start}-${end}/${size}`)
        .header("content-length", end - start + 1)
        .send(createReadStream(file, { start, end }));
    }
    return reply.header("content-length", size).send(createReadStream(file));
  });
}

/** Resolve an ingest-supplied relative path inside the mounted recordings
 *  dir — rejects traversal outright. */
function safeRecordingPath(rel: string): string | null {
  const dir = recDir();
  if (!dir) return null;
  const root = resolve(dir);
  const abs = resolve(root, rel);
  return abs.startsWith(root + sep) ? abs : null;
}

/**
 * Recording ingest — called by the host-side sync script (recordings are too
 * large to push through HTTP; the file already sits on a shared mount).
 * Auth is a shared secret header, deliberately outside requireAuth.
 * Body: { path: "<relpath under recordings dir>" }. The room code is parsed
 * from the filename (kx-…) to resolve the meeting. Idempotent by path.
 */
export function meetIngestRoutes(app: FastifyInstance) {
  app.post("/api/meet/recordings/ingest", async (req, reply) => {
    const secret = process.env.KREATIX_MEET_INGEST_SECRET;
    if (!secret || req.headers["x-ingest-secret"] !== secret)
      return reply.code(401).send({ error: "unauthorized" });
    const dir = recDir();
    if (!dir) return reply.code(404).send({ error: "disabled", message: "Recording is not configured" });
    const { path } = (req.body ?? {}) as { path?: string };
    const file = path ? safeRecordingPath(path) : null;
    if (!file || !existsSync(file))
      return reply.code(400).send({ error: "invalid", message: "Unknown recording path" });
    const code = /kx-[0-9a-f]{10}/i.exec(basename(file))?.[0]?.toLowerCase();
    if (!code) return reply.code(422).send({ error: "no_room", message: "Filename carries no meeting code" });
    const m = await one<MeetingRow>("SELECT * FROM meetings WHERE code = $1", [code]);
    if (!m) return reply.code(404).send({ error: "no_meeting", message: "No meeting for that room code" });
    const size = statSync(file).size;
    const row = await one<{ id: string }>(
      `INSERT INTO meeting_recordings (id, meeting_id, org_id, path, size)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (meeting_id, path) DO NOTHING RETURNING id`,
      [randomUUID(), m.id, m.org_id, path, size]);
    // tell the host their recording landed
    void run(
      `INSERT INTO notifications (id, user_id, kind, actor_id, message)
       VALUES ($1,$2,'meet',$3,$4)`,
      [randomUUID(), m.created_by, m.created_by, encryptField(`Recording ready: ${m.title}`)]);
    return reply.code(row ? 201 : 200).send({ ok: true, id: row?.id ?? null });
  });
}
