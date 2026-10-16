import type { FastifyInstance, FastifyReply } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { q, one, run } from "../db.js";
import { meetBase, meetEnabled, mintMeetToken } from "../meetBridge.js";

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

const meetingOut = (r: MeetingRow) => ({
  id: r.id, code: r.code, title: r.title, status: r.status,
  scheduledAt: r.scheduled_at, createdBy: r.created_by,
  createdByName: r.creator_name ?? null,
  createdAt: r.created_at, endedAt: r.ended_at,
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
    const rows = await q<MeetingRow>(
      `SELECT m.*, u.display_name AS creator_name FROM meetings m
       JOIN users u ON u.id = m.created_by WHERE m.org_id = $1
       ORDER BY CASE m.status WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,
                COALESCE(m.scheduled_at, m.created_at) DESC
       LIMIT 60`, [user.orgId]);
    return { enabled: true, meetings: rows.map(meetingOut) };
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
    return { ok: true };
  });
}
