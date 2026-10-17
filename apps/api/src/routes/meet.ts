import type { FastifyInstance, FastifyReply } from "fastify";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createReadStream, statSync, existsSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { q, one, run } from "../db.js";
import { meetBase, meetEnabled, mintMeetToken, recDir, recordingEnabled, dialInNumber } from "../meetBridge.js";
import { encryptField, decryptField } from "../crypto.js";
import { fireTrigger } from "../rules.js";

interface MeetingRow {
  id: string; org_id: string; code: string; title: string;
  created_by: string; scheduled_at: string | null; status: string;
  created_at: string; ended_at: string | null; channel_id: string | null;
  summary: string | null; dial_pin: string | null; creator_name?: string;
}

/** Jitsi MUC domain the deployment uses — default of docker-jitsi-meet; the
 *  conference mapper returns <room>@<this>. */
const MUC_DOMAIN = () => process.env.KREATIX_MEET_MUC_DOMAIN ?? "muc.meet.jitsi";

/** 9-digit numeric PIN for PSTN dial-in — unique across meetings; retries on
 *  the (rare) collision via the unique index. */
async function genDialPin(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const pin = String(randomInt(100_000_000, 1_000_000_000));
    const clash = await one(`SELECT 1 AS x FROM meetings WHERE dial_pin = $1`, [pin]);
    if (!clash) return pin;
  }
  return String(randomInt(1_000_000_000, 9_999_999_999));
}

const createSchema = z.object({
  title: z.string().trim().max(120).optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  startNow: z.boolean().optional(),
});

const meetingOut = (r: MeetingRow & { rec_count?: number; channel_id?: string | null }) => ({
  id: r.id, code: r.code, title: r.title, status: r.status,
  scheduledAt: r.scheduled_at, createdBy: r.created_by,
  createdByName: r.creator_name ?? null,
  createdAt: r.created_at, endedAt: r.ended_at,
  recordings: Number(r.rec_count ?? 0),
  channelId: r.channel_id ?? null,
  summary: r.summary ? decryptField(r.summary) ?? r.summary : null,
  dialIn: dialInNumber() || null,
  dialPin: r.dial_pin ?? null,
});

/** Record a participant join (idempotent roster row per meeting+user). */
const markJoin = async (meetingId: string, userId: string) =>
  run(
    `INSERT INTO meeting_attendance (meeting_id, user_id, joined_at, left_at)
     VALUES ($1,$2,now(),NULL)
     ON CONFLICT (meeting_id, user_id) DO UPDATE SET left_at = NULL`,
    [meetingId, userId]);

/** Join payload — fresh Jitsi JWT per call; the room code is the Jitsi room. */
const joinPayload = (m: MeetingRow, user: { displayName: string; email: string }, moderator: boolean) => ({
  base: meetBase(),
  room: m.code,
  jwt: mintMeetToken({ room: m.code, name: user.displayName, email: user.email, moderator }),
  displayName: user.displayName,
  meetingId: m.id,
  channelId: m.channel_id,
  dialIn: dialInNumber() || null,
  dialPin: m.dial_pin ?? null,
});

export function meetRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // backfill dial PINs for meetings created before dial-in support
  void (async () => {
    const missing = await q<{ id: string }>(`SELECT id FROM meetings WHERE dial_pin IS NULL LIMIT 500`);
    for (const r of missing)
      await run(`UPDATE meetings SET dial_pin = $2 WHERE id = $1 AND dial_pin IS NULL`, [r.id, await genDialPin()]).catch(() => {});
  })();

  const getMeeting = async (id: string, orgId: string) =>
    one<MeetingRow>(
      `SELECT m.*, u.display_name AS creator_name FROM meetings m
       JOIN users u ON u.id = m.created_by WHERE m.id = $1 AND m.org_id = $2`, [id, orgId]);

  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: "not_found", message: "Meeting not found" });

  app.get("/api/meet/status", async () => ({
    enabled: meetEnabled(), recording: recordingEnabled(),
    dialIn: dialInNumber() || null,
  }));

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
    return { enabled: true, base: meetBase(), recording: recordingEnabled(), dialIn: dialInNumber() || null, meetings: rows.map(meetingOut) };
  });

  app.post("/api/meet", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!meetEnabled()) return reply.code(404).send({ error: "meet_disabled", message: "Meet is not configured" });
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid meeting" });
    const { title, scheduledAt, startNow } = parsed.data;
    const code = `kx-${randomBytes(5).toString("hex")}`;
    const dialPin = await genDialPin();
    const row = await one<MeetingRow>(
      `INSERT INTO meetings (id, org_id, code, title, created_by, scheduled_at, status, dial_pin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *, NULL AS creator_name`,
      [randomUUID(), user.orgId, code,
       title?.trim() || `${user.displayName}'s meeting`,
       user.id, scheduledAt ?? null, startNow ? "live" : "scheduled", dialPin]);
    // every meeting gets a suite chat channel so in-call chat persists after
    // the call ends (the Jitsi iframe chat dies with the room)
    if (row) {
      const channelId = randomUUID();
      await run(
        `INSERT INTO chat_channels (id, org_id, kind, name, description, created_by)
         VALUES ($1,$2,'channel',$3,$4,$5)`,
        [channelId, user.orgId, `Meet: ${row.title}`, `Persistent chat for meeting ${code}`, user.id]);
      await run("INSERT INTO chat_members (channel_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [channelId, user.id]);
      await run("UPDATE meetings SET channel_id = $2 WHERE id = $1", [row.id, channelId]);
      row.channel_id = channelId;
    }
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
    await markJoin(m.id, user.id);
    if (m.channel_id)
      await run("INSERT INTO chat_members (channel_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [m.channel_id, user.id]);
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
    await markJoin(m.id, user.id);
    if (m.channel_id)
      await run("INSERT INTO chat_members (channel_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [m.channel_id, user.id]);
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
    // Guests land on Jitsi directly (no iframe), so tune via URL-hash config instead.
    const tuning = "#config.disableThirdPartyRequests=true&config.disableDeepLinking=true" +
      "&interfaceConfig.SHOW_JITSI_WATERMARK=false&interfaceConfig.SHOW_WATERMARK_FOR_GUESTS=false" +
      "&interfaceConfig.APP_NAME=%22Kreatix%20Meet%22&interfaceConfig.MOBILE_APP_PROMO=false";
    return { url: `${meetBase()}/${m.code}?jwt=${jwt}${tuning}` };
  });

  app.post("/api/meet/:id/end", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const m = await getMeeting((req.params as { id: string }).id, user.orgId);
    if (!m) return notFound(reply);
    if (m.created_by !== user.id && user.role !== "owner" && user.role !== "admin")
      return reply.code(403).send({ error: "forbidden", message: "Only the host can end a meeting" });
    await run("UPDATE meetings SET status = 'ended', ended_at = now() WHERE id = $1", [m.id]);
    // close any still-open attendance rows
    await run("UPDATE meeting_attendance SET left_at = now() WHERE meeting_id = $1 AND left_at IS NULL", [m.id]);
    void fireTrigger(user.orgId, "meeting.ended",
      { meetingId: m.id, name: m.title ?? "Meeting" }, app.log);
    return { ok: true };
  });

  /** Attendance roster — who joined and when; left_at is filled on end. */
  app.get("/api/meet/:id/attendance", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const m = await getMeeting((req.params as { id: string }).id, user.orgId);
    if (!m) return notFound(reply);
    const rows = await q<{ user_id: string; joined_at: string; left_at: string | null; display_name: string; initials: string }>(
      `SELECT a.user_id, a.joined_at, a.left_at, u.display_name, u.initials
       FROM meeting_attendance a JOIN users u ON u.id = a.user_id
       WHERE a.meeting_id = $1 ORDER BY a.joined_at`, [m.id]);
    return {
      attendees: rows.map((r) => ({
        userId: r.user_id, name: r.display_name, initials: r.initials,
        joinedAt: r.joined_at, leftAt: r.left_at,
      })),
    };
  });

  /** Recording clip markers + transcript — host/admin edit, members read. */
  app.patch("/api/meet/recordings/:rid", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const rec = await one<{ id: string; org_id: string; meeting_id: string; created_by: string }>(
      `SELECT r.id, r.org_id, r.meeting_id, m.created_by
       FROM meeting_recordings r JOIN meetings m ON m.id = r.meeting_id WHERE r.id = $1`,
      [(req.params as { rid: string }).rid]);
    if (!rec || rec.org_id !== user.orgId) return notFound(reply);
    if (rec.created_by !== user.id && user.role !== "owner" && user.role !== "admin")
      return reply.code(403).send({ error: "forbidden", message: "Only the host can edit a recording" });
    const body = z.object({
      clipStart: z.number().min(0).nullable().optional(),
      clipEnd: z.number().min(0).nullable().optional(),
    }).parse(req.body ?? {});
    await run("UPDATE meeting_recordings SET clip_start = $2, clip_end = $3 WHERE id = $1",
      [rec.id, body.clipStart ?? null, body.clipEnd ?? null]);
    return { ok: true };
  });

  /** Transcription via an OpenAI-compatible /audio/transcriptions endpoint
   *  (KREATIX_TRANSCRIBE_URL + KREATIX_TRANSCRIBE_KEY) — off-box Whisper,
   *  Groq, or any compatible service. Runs inline; mp4 may be large. */
  app.post("/api/meet/recordings/:rid/transcribe", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const url = process.env.KREATIX_TRANSCRIBE_URL;
    if (!url) return reply.code(404).send({ error: "disabled", message: "Transcription is not configured" });
    const rec = await one<{ id: string; org_id: string; path: string; meeting_id: string; created_by: string }>(
      `SELECT r.id, r.org_id, r.path, r.meeting_id, m.created_by
       FROM meeting_recordings r JOIN meetings m ON m.id = r.meeting_id WHERE r.id = $1`,
      [(req.params as { rid: string }).rid]);
    if (!rec || rec.org_id !== user.orgId) return notFound(reply);
    if (rec.created_by !== user.id && user.role !== "owner" && user.role !== "admin")
      return reply.code(403).send({ error: "forbidden", message: "Only the host can transcribe" });
    const file = safeRecordingPath(rec.path);
    if (!file || !existsSync(file)) return reply.code(410).send({ error: "gone" });
    const form = new FormData();
    form.append("file", new Blob([await import("node:fs/promises").then((fs) => fs.readFile(file))]),
      basename(file));
    form.append("model", process.env.KREATIX_TRANSCRIBE_MODEL ?? "whisper-large-v3");
    form.append("response_format", "verbose_json");
    const resp = await fetch(url, {
      method: "POST",
      headers: process.env.KREATIX_TRANSCRIBE_KEY
        ? { authorization: `Bearer ${process.env.KREATIX_TRANSCRIBE_KEY}` } : {},
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) {
      return reply.code(502).send({ error: "transcribe_failed", message: `Upstream ${resp.status}` });
    }
    const out = (await resp.json()) as { text?: string; segments?: { start: number; text: string }[] };
    const text = out.segments?.length
      ? out.segments.map((s) => `[${Math.floor(s.start / 60)}:${String(Math.floor(s.start % 60)).padStart(2, "0")}] ${s.text.trim()}`).join("\n")
      : (out.text ?? "");
    await run("UPDATE meeting_recordings SET transcript = $2 WHERE id = $1", [rec.id, encryptField(text) ?? text]);
    return { ok: true, transcript: text };
  });

  /** Recordings for a meeting — org members can list; playback is /stream. */
  app.get("/api/meet/:id/recordings", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const m = await getMeeting((req.params as { id: string }).id, user.orgId);
    if (!m) return notFound(reply);
    const rows = await q<{ id: string; size: number | null; duration_sec: number | null; created_at: string; path: string; clip_start: number | null; clip_end: number | null; has_tr: boolean }>(
      `SELECT id, size, duration_sec, created_at, path, clip_start, clip_end,
              (transcript IS NOT NULL) AS has_tr
       FROM meeting_recordings WHERE meeting_id = $1 ORDER BY created_at DESC`,
      [m.id]);
    return {
      recordings: rows.map((r) => ({
        id: r.id, size: r.size, durationSec: r.duration_sec,
        createdAt: r.created_at, name: basename(r.path),
        clipStart: r.clip_start, clipEnd: r.clip_end, hasTranscript: r.has_tr,
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

  /** Transcript text for a recording (members of the org can read). */
  app.get("/api/meet/recordings/:rid/transcript", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const rec = await one<{ transcript: string | null; org_id: string }>(
      "SELECT transcript, org_id FROM meeting_recordings WHERE id = $1", [(req.params as { rid: string }).rid]);
    if (!rec || rec.org_id !== user.orgId) return notFound(reply);
    if (!rec.transcript) return reply.code(404).send({ error: "no_transcript" });
    return { transcript: decryptField(rec.transcript) ?? rec.transcript };
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

  /**
   * Jitsi conferenceMapper protocol — the piece an IVR (Asterisk/FreeSWITCH)
   * queries to turn a dialled PIN into the conference Jigasi should join.
   *   GET /api/meet/dialin-map?id=<pin>                  → { id, conference, name }
   *   GET /api/meet/dialin-map?conference=<room@muc>     → same (reverse lookup,
   *                                                       used by the Jitsi web
   *                                                       "dial in" dialog via
   *                                                       dialInConfCodeUrl)
   * Deliberately unauthenticated — PBX/Jigasi infra calls it; it only reveals a
   * room name for a PIN, and rooms themselves stay JWT-gated.
   */
  app.get("/api/meet/dialin-map", async (req, reply) => {
    const { id, conference } = req.query as { id?: string; conference?: string };
    let m: MeetingRow | undefined;
    if (id && /^\d{6,12}$/.test(id)) {
      m = await one<MeetingRow>(`SELECT * FROM meetings WHERE dial_pin = $1`, [id]);
    } else if (conference) {
      const room = conference.split("@")[0];
      if (/^kx-[0-9a-f]{10}$/i.test(room))
        m = await one<MeetingRow>(`SELECT * FROM meetings WHERE code = $1`, [room.toLowerCase()]);
    }
    if (!m) return reply.code(404).send({ error: "not_found" });
    return {
      id: m.dial_pin,
      conference: `${m.code}@${MUC_DOMAIN()}`,
      name: m.title,
      meeting_id: m.id,
    };
  });

  /** phoneNumberList for the Jitsi "invite → dial in" dialog (dialInNumbersUrl). */
  app.get("/api/meet/dialin-numbers", async (_req, reply) => {
    const number = dialInNumber();
    if (!number) return reply.code(404).send({ error: "disabled" });
    return {
      numbers: { default: [number] },
      conferenceMapper: `${process.env.KREATIX_PUBLIC_URL ?? ""}/api/meet/dialin-map`,
    };
  });
}
