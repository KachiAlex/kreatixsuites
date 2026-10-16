// Kreatix Chat — Teams-style channels + direct messages. Channels are
// org-wide (every member sees them); dm/group conversations are member-
// scoped. Realtime delivery rides a per-user JSON websocket; message bodies
// are field-encrypted like comments/names elsewhere.
import { randomUUID } from "node:crypto";
import { jwtVerify } from "jose";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth, type AuthedRequest, type UserRow } from "../auth.js";
import { q, one, run } from "../db.js";
import { encryptField, decryptField } from "../crypto.js";

interface ChannelRow {
  id: string; org_id: string; kind: string; name: string | null;
  description: string | null; dm_key: string | null;
  created_by: string | null; last_message_at: string | null; created_at: string;
}
interface MessageRow {
  id: string; channel_id: string; user_id: string; body: string;
  reply_to: string | null; edited_at: string | null; created_at: string;
  author_name?: string | null; author_initials?: string | null;
}

const secret = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "kreatix-dev-secret-change-in-production",
);

// ---- realtime registry: userId → sockets, plus socket → org for channels ----
const WS_OPEN = 1;
interface ChatSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, cb: (...args: never[]) => void): void;
}
const peers = new Map<ChatSocket, { userId: string; orgId: string }>();

/** Push a chat event to every connected member of an org (channel-kind),
 *  or to an explicit user list (dm/group). */
function broadcast(orgId: string, userIds: string[] | null, payload: unknown) {
  const data = JSON.stringify(payload);
  for (const [sock, p] of peers) {
    if (sock.readyState !== WS_OPEN) continue;
    if (userIds ? !userIds.includes(p.userId) : p.orgId !== orgId) continue;
    try { sock.send(data); } catch { /* dropped */ }
  }
}

const body = (r: MessageRow): MessageOut => ({
  id: r.id, channelId: r.channel_id,
  author: { id: r.user_id, displayName: r.author_name ?? null, initials: r.author_initials ?? null },
  body: decryptField(r.body) ?? r.body,
  replyTo: r.reply_to, editedAt: r.edited_at, createdAt: r.created_at,
});
interface MessageOut {
  id: string; channelId: string;
  author: { id: string; displayName: string | null; initials: string | null };
  body: string; replyTo: string | null; editedAt: string | null; createdAt: string;
}

const postSchema = z.object({
  body: z.string().trim().min(1).max(8000),
  replyTo: z.string().max(64).nullish(),
});

export function chatRoutes(app: FastifyInstance) {

  // ---- live stream: one ws per client; server pushes message/channel events ----
  app.get("/api/chat/stream", { websocket: true }, (socket, req) => {
    const token = (req.query as { t?: string; token?: string }).t
      ?? (req.query as { token?: string }).token ?? "";
    void (async () => {
      try {
        const { payload } = await jwtVerify(token, secret);
        if (payload.aud === "kreatix-mfa") throw new Error("mfa");
        const user = await one<UserRow>("SELECT * FROM users WHERE id = $1", [payload.sub as string]);
        if (!user || user.disabled) throw new Error("unauthorized");
        peers.set(socket, { userId: user.id, orgId: user.org_id });
        socket.send(JSON.stringify({ t: "ready" }));
        const drop = () => peers.delete(socket);
        socket.on("close", drop);
        socket.on("error", drop);
      } catch {
        socket.close(4401, "unauthorized");
      }
    })();
  });

  // ---- REST surface ----
  app.register(async (authed) => {
    authed.addHook("preHandler", requireAuth);

    const getChannel = async (id: string, orgId: string) =>
      one<ChannelRow>("SELECT * FROM chat_channels WHERE id = $1 AND org_id = $2", [id, orgId]);

    const isMember = async (channelId: string, userId: string) =>
      one("SELECT 1 AS x FROM chat_members WHERE channel_id = $1 AND user_id = $2", [channelId, userId]);

    /** channel → any org member; dm/group → listed members only. */
    const canSee = async (c: ChannelRow, userId: string) =>
      c.kind === "channel" || !!(await isMember(c.id, userId));

    const memberIds = async (channelId: string) =>
      (await q<{ user_id: string }>("SELECT user_id FROM chat_members WHERE channel_id = $1", [channelId]))
        .map((r) => r.user_id);

    const notFound = (reply: FastifyReply) =>
      reply.code(404).send({ error: "not_found", message: "Conversation not found" });
    const forbidden = (reply: FastifyReply) =>
      reply.code(403).send({ error: "forbidden", message: "You are not in this conversation" });

    /** First-list bootstrap: the org always has a General channel and the
     *  caller has a membership row on every channel (unread bookkeeping). */
    const ensureGeneral = async (orgId: string, userId: string) => {
      const gen = await one<{ id: string }>(
        "SELECT id FROM chat_channels WHERE org_id = $1 AND kind = 'channel' ORDER BY created_at LIMIT 1",
        [orgId]);
      if (!gen) {
        const id = randomUUID();
        await run(
          `INSERT INTO chat_channels (id, org_id, kind, name, description, created_by)
           VALUES ($1, $2, 'channel', 'General', 'Org-wide conversation', $3)`,
          [id, orgId, userId]);
      }
      // membership rows on channels exist purely for read state — upsert all.
      // last_read starts at max(channel created, user joined org): pre-existing
      // history isn't "unread" for a new joiner, but posts after they arrived are.
      await run(
        `INSERT INTO chat_members (channel_id, user_id, last_read_at)
         SELECT c.id, $2, GREATEST(c.created_at, u.created_at)
         FROM chat_channels c, users u
         WHERE u.id = $2 AND c.org_id = $1 AND c.kind = 'channel'
         ON CONFLICT (channel_id, user_id) DO NOTHING`,
        [orgId, userId]);
    };

    /** Org people picker for new chats. */
    authed.get("/api/chat/people", async (req) => {
      const { user } = req as AuthedRequest;
      const rows = await q<{ id: string; display_name: string; email: string; initials: string }>(
        `SELECT id, display_name, email, initials FROM users
         WHERE org_id = $1 AND disabled = false AND id != $2 ORDER BY display_name`,
        [user.orgId, user.id]);
      return { people: rows.map((r) => ({ id: r.id, displayName: r.display_name, email: r.email, initials: r.initials })) };
    });

    /** Channel + DM list with unread counts and last-message previews. */
    authed.get("/api/chat", async (req) => {
      const { user } = req as AuthedRequest;
      await ensureGeneral(user.orgId, user.id);
      const channels = await q<ChannelRow & { unread: string; last_body: string | null; last_at: string | null }>(
        `SELECT * FROM (
           SELECT c.*,
                  COALESCE((SELECT count(*) FROM chat_messages m
                            WHERE m.channel_id = c.id AND m.created_at > mbr.last_read_at
                              AND m.user_id != $2), 0)::text AS unread,
                  (SELECT m.body FROM chat_messages m WHERE m.channel_id = c.id
                    ORDER BY m.created_at DESC LIMIT 1) AS last_body,
                  (SELECT m.created_at FROM chat_messages m WHERE m.channel_id = c.id
                    ORDER BY m.created_at DESC LIMIT 1) AS last_at
           FROM chat_channels c
           LEFT JOIN chat_members mbr ON mbr.channel_id = c.id AND mbr.user_id = $2
           WHERE c.org_id = $1 AND (c.kind = 'channel' OR mbr.user_id IS NOT NULL)
         ) s ORDER BY COALESCE(s.last_at, s.created_at) DESC`, [user.orgId, user.id]);
      // dm/group titles come from the other participants
      const dms = channels.filter((c) => c.kind !== "channel");
      const dmMembers = dms.length
        ? await q<{ channel_id: string; user_id: string; display_name: string; initials: string }>(
            `SELECT cm.channel_id, u.id AS user_id, u.display_name, u.initials
             FROM chat_members cm JOIN users u ON u.id = cm.user_id
             WHERE cm.channel_id = ANY($1)`, [dms.map((d) => d.id)])
        : [];
      return {
        channels: channels.map((c) => {
          const members = dmMembers.filter((m) => m.channel_id === c.id);
          const others = members.filter((m) => m.user_id !== user.id);
          return {
            id: c.id, kind: c.kind,
            name: c.kind === "channel" ? c.name
              : others.length ? others.map((m) => m.display_name).join(", ")
              : c.name ?? "Chat",
            description: c.description,
            members: members.map((m) => ({ id: m.user_id, displayName: m.display_name, initials: m.initials })),
            unread: Number(c.unread),
            lastMessage: c.last_body ? (decryptField(c.last_body) ?? "") : null,
            lastAt: c.last_at ?? c.created_at,
          };
        }),
      };
    });

    const createSchema = z.object({
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().max(400).optional(),
    });
    authed.post("/api/chat/channels", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const parsed = createSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Name required" });
      const id = randomUUID();
      const row = await one<ChannelRow>(
        `INSERT INTO chat_channels (id, org_id, kind, name, description, created_by)
         VALUES ($1,$2,'channel',$3,$4,$5) RETURNING *`,
        [id, user.orgId, parsed.data.name, parsed.data.description ?? null, user.id]);
      await run("INSERT INTO chat_members (channel_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [id, user.id]);
      broadcast(user.orgId, null, { t: "channel", channelId: id });
      return reply.code(201).send({ channel: { id: row!.id, kind: row!.kind, name: row!.name } });
    });

    /** Open (or reuse) a DM/group conversation. */
    authed.post("/api/chat/dm", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const ids = [...new Set(((req.body as { userIds?: string[] })?.userIds ?? [])
        .filter((i): i is string => typeof i === "string"))].filter((i) => i !== user.id);
      if (!ids.length || ids.length > 20)
        return reply.code(400).send({ error: "invalid", message: "Pick at least one person" });
      const valid = await q<{ id: string }>(
        "SELECT id FROM users WHERE org_id = $1 AND disabled = false AND id = ANY($2)",
        [user.orgId, ids]);
      if (valid.length !== ids.length)
        return reply.code(400).send({ error: "invalid", message: "Unknown recipient" });
      const all = [...ids, user.id].sort();
      const dmKey = all.join(":");
      const existing = await one<ChannelRow>(
        "SELECT * FROM chat_channels WHERE org_id = $1 AND dm_key = $2", [user.orgId, dmKey]);
      if (existing) return { channel: { id: existing.id, kind: existing.kind, name: existing.name } };
      const id = randomUUID();
      const kind = ids.length === 1 ? "dm" : "group";
      const row = await one<ChannelRow>(
        `INSERT INTO chat_channels (id, org_id, kind, dm_key, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`, [id, user.orgId, kind, dmKey, user.id]);
      for (const uid of all)
        await run("INSERT INTO chat_members (channel_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, uid]);
      broadcast(user.orgId, all, { t: "channel", channelId: id });
      return reply.code(201).send({ channel: { id: row!.id, kind: row!.kind, name: row!.name } });
    });

    authed.get("/api/chat/:id/messages", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const c = await getChannel((req.params as { id: string }).id, user.orgId);
      if (!c) return notFound(reply);
      if (!(await canSee(c, user.id))) return forbidden(reply);
      const { before, limit: lim } = req.query as { before?: string; limit?: string };
      const limit = Math.min(Number(lim) || 50, 100);
      const rows = await q<MessageRow>(
        `SELECT m.*, u.display_name AS author_name, u.initials AS author_initials
         FROM chat_messages m JOIN users u ON u.id = m.user_id
         WHERE m.channel_id = $1 ${before ? "AND m.created_at < $3" : ""}
         ORDER BY m.created_at DESC LIMIT $2`,
        before ? [c.id, limit, before] : [c.id, limit]);
      return { messages: rows.reverse().map(body) };
    });

    authed.post("/api/chat/:id/messages", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const c = await getChannel((req.params as { id: string }).id, user.orgId);
      if (!c) return notFound(reply);
      if (!(await canSee(c, user.id))) return forbidden(reply);
      const parsed = postSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Empty message" });
      const row = await one<MessageRow>(
        `INSERT INTO chat_messages (id, channel_id, user_id, body, reply_to)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [randomUUID(), c.id, user.id, encryptField(parsed.data.body) ?? parsed.data.body,
         parsed.data.replyTo ?? null]);
      await run("UPDATE chat_channels SET last_message_at = now() WHERE id = $1", [c.id]);
      // posting counts as reading — keep the author's unread at zero
      await run(
        `INSERT INTO chat_members (channel_id, user_id, last_read_at) VALUES ($1,$2,now())
         ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_at = now()`,
        [c.id, user.id]);
      const msg = body({ ...row!, author_name: user.displayName, author_initials: user.initials });
      const targets = c.kind === "channel" ? null : await memberIds(c.id);
      broadcast(user.orgId, targets, { t: "message", channelId: c.id, message: msg });
      // bell notifications: dm/group recipients + @mentions in channels
      const mentionIds = c.kind === "channel" ? await mentionedUsers(parsed.data.body, user.orgId, user.id) : [];
      const notifyIds = new Set([
        ...(targets ?? []).filter((i) => i !== user.id),
        ...mentionIds,
      ]);
      for (const uid of notifyIds) {
        void run(
          `INSERT INTO notifications (id, user_id, kind, actor_id, message)
           VALUES ($1,$2,'chat',$3,$4)`,
          [randomUUID(), uid, user.id,
           encryptField(`${user.displayName} in ${c.name ?? "chat"}: ${parsed.data.body.slice(0, 120)}`)]);
      }
      return reply.code(201).send({ message: msg });
    });

    /** @handle mentions — localpart or display-name first word. */
    const mentionedUsers = async (text: string, orgId: string, selfId: string): Promise<string[]> => {
      const handles = [...new Set([...text.matchAll(/@([a-zA-Z0-9._-]+)/g)].map((m) => m[1].toLowerCase()))];
      if (!handles.length) return [];
      const rows = await q<{ id: string }>(
        `SELECT id FROM users WHERE org_id = $1 AND disabled = false AND id != $2 AND (
           lower(split_part(email,'@',1)) = ANY($3)
           OR lower(split_part(display_name,' ',1)) = ANY($3))`,
        [orgId, selfId, handles]);
      return rows.map((r) => r.id);
    };

    authed.patch("/api/chat/messages/:id", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const parsed = z.object({ body: z.string().trim().min(1).max(8000) }).safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Empty message" });
      const m = await one<MessageRow & { org_id: string }>(
        `SELECT m.*, c.org_id FROM chat_messages m JOIN chat_channels c ON c.id = m.channel_id
         WHERE m.id = $1 AND c.org_id = $2`, [(req.params as { id: string }).id, user.orgId]);
      if (!m) return reply.code(404).send({ error: "not_found", message: "Message not found" });
      if (m.user_id !== user.id) return forbidden(reply);
      await run("UPDATE chat_messages SET body = $1, edited_at = now() WHERE id = $2",
        [encryptField(parsed.data.body) ?? parsed.data.body, m.id]);
      const targets = (await one<{ kind: string }>("SELECT kind FROM chat_channels WHERE id = $1", [m.channel_id]))!.kind === "channel"
        ? null : await memberIds(m.channel_id);
      broadcast(user.orgId, targets, { t: "message:update", channelId: m.channel_id, messageId: m.id, body: parsed.data.body, editedAt: new Date().toISOString() });
      return { ok: true };
    });

    authed.delete("/api/chat/messages/:id", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const m = await one<MessageRow & { org_id: string; kind: string }>(
        `SELECT m.*, c.org_id, c.kind FROM chat_messages m JOIN chat_channels c ON c.id = m.channel_id
         WHERE m.id = $1 AND c.org_id = $2`, [(req.params as { id: string }).id, user.orgId]);
      if (!m) return reply.code(404).send({ error: "not_found", message: "Message not found" });
      const isAdmin = user.role === "owner" || user.role === "admin";
      if (m.user_id !== user.id && !isAdmin) return forbidden(reply);
      await run("DELETE FROM chat_messages WHERE id = $1", [m.id]);
      broadcast(user.orgId, m.kind === "channel" ? null : await memberIds(m.channel_id),
        { t: "message:delete", channelId: m.channel_id, messageId: m.id });
      return { ok: true };
    });

    authed.post("/api/chat/:id/read", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const c = await getChannel((req.params as { id: string }).id, user.orgId);
      if (!c) return notFound(reply);
      await run(
        `INSERT INTO chat_members (channel_id, user_id, last_read_at) VALUES ($1,$2,now())
         ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_at = now()`,
        [c.id, user.id]);
      return { ok: true };
    });
  });
}
