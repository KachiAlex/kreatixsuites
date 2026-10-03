import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { q, one, run, now } from "../db.js";
import { getItem, logActivity } from "../items.js";
import { requireAuth, permissionFor, hasPermission, type AuthedRequest } from "../auth.js";
import { decryptField, encryptField } from "../crypto.js";

const createSchema = z.object({
  body: z.string().min(1).max(4000),
  anchor: z.string().max(500).nullable().optional(),
  parentId: z.string().nullable().optional(),
});

export function commentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/files/:id/comments", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(await permissionFor(user.id, item), "viewer")) {
      return reply.code(404).send({ error: "not_found" });
    }
    const rows = await q<CommentRow>(
      `SELECT c.*, u.display_name, u.initials FROM comments c JOIN users u ON u.id = c.author_id
       WHERE c.file_id = $1 ORDER BY c.created_at ASC`,
      [item.id],
    );
    return { comments: rows.map(commentOut) };
  });

  /** Users who can be @mentioned on this file: owner + users it is shared with. */
  app.get("/api/files/:id/mentionable", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(await permissionFor(user.id, item), "commenter")) {
      return reply.code(404).send({ error: "not_found" });
    }
    const rows = await q<{ id: string; email: string; display_name: string; initials: string }>(
      `SELECT id, email, display_name, initials FROM users
       WHERE id = $1 OR id IN (SELECT user_id FROM shares WHERE file_id = $2)
       ORDER BY display_name`,
      [item.owner_id, item.id],
    );
    return {
      users: rows.map((u) => ({ id: u.id, email: u.email, displayName: u.display_name, initials: u.initials })),
    };
  });

  app.post("/api/files/:id/comments", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(await permissionFor(user.id, item), "commenter")) {
      return reply.code(403).send({ error: "forbidden", message: "No comment access" });
    }
    const body = createSchema.parse(req.body);
    if (body.parentId) {
      const parent = await one<{ id: string }>(
        "SELECT id FROM comments WHERE id = $1 AND file_id = $2",
        [body.parentId, item.id],
      );
      if (!parent) return reply.code(400).send({ error: "bad_request", message: "Parent comment not on this file" });
    }
    const id = randomUUID();
    await run(
      "INSERT INTO comments (id, file_id, author_id, anchor, body, parent_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, item.id, user.id, body.anchor ?? null, encryptField(body.body), body.parentId ?? null, now()],
    );
    // @mentions: "@email" or "@name" → notify the file's owner + shared users
    const tokens = new Set([...body.body.matchAll(/@([\w.+-]+)/g)].map((m) => m[1]));
    for (const t of tokens) {
      const target = await one<{ id: string }>(
        `SELECT u.id FROM users u WHERE u.id != $1 AND (
           u.email = $2 OR u.display_name LIKE $3 || '%' OR u.display_name LIKE '% ' || $4 || '%')
         AND (u.id = $5 OR u.id IN (SELECT user_id FROM shares WHERE file_id = $6))`,
        [user.id, t, t, t, item.owner_id, item.id],
      );
      if (target) {
        await run(
          "INSERT INTO mentions (id, comment_id, file_id, from_user_id, to_user_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
          [randomUUID(), id, item.id, user.id, target.id, now()],
        );
      }
    }
    void logActivity(user.orgId, user.id, item.id, "comment", body.body.slice(0, 80));
    const row = (await one<CommentRow>(
      "SELECT c.*, u.display_name, u.initials FROM comments c JOIN users u ON u.id = c.author_id WHERE c.id = $1",
      [id],
    ))!;
    return { comment: commentOut(row) };
  });

  app.patch("/api/comments/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const c = await one<{ id: string; file_id: string; author_id: string }>(
      "SELECT * FROM comments WHERE id = $1",
      [(req.params as { id: string }).id],
    );
    if (!c) return reply.code(404).send({ error: "not_found" });
    const item = (await getItem(c.file_id))!;
    const perm = await permissionFor(user.id, item);
    const body = z.object({ resolved: z.boolean().optional(), body: z.string().max(4000).optional() }).parse(req.body);
    if (body.body !== undefined && c.author_id !== user.id) {
      return reply.code(403).send({ error: "forbidden", message: "Only the author can edit" });
    }
    if (body.resolved !== undefined && !hasPermission(perm, "commenter")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    await run(
      "UPDATE comments SET resolved = COALESCE($1, resolved), body = COALESCE($2, body) WHERE id = $3",
      [body.resolved === undefined ? null : body.resolved,
       body.body === undefined ? null : encryptField(body.body), c.id],
    );
    return { ok: true };
  });

  app.delete("/api/comments/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const c = await one<{ id: string; author_id: string; file_id: string }>(
      "SELECT * FROM comments WHERE id = $1",
      [(req.params as { id: string }).id],
    );
    if (!c) return reply.code(404).send({ error: "not_found" });
    const item = (await getItem(c.file_id))!;
    if (c.author_id !== user.id && !hasPermission(await permissionFor(user.id, item), "editor")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    await run("DELETE FROM comments WHERE id = $1", [c.id]);
    return { ok: true };
  });

  /** Recent mentions of the current user (notification bell) */
  app.get("/api/mentions", async (req) => {
    const { user } = req as AuthedRequest;
    const rows = await q<MentionRow>(
      `SELECT m.id, m.read_at, m.created_at, u.display_name AS from_name, u.initials AS from_initials,
              i.name AS file_name, i.kind AS file_kind, m.file_id, c.body
       FROM mentions m
       JOIN users u ON u.id = m.from_user_id
       JOIN items i ON i.id = m.file_id
       JOIN comments c ON c.id = m.comment_id
       WHERE m.to_user_id = $1 ORDER BY m.created_at DESC LIMIT 50`,
      [user.id],
    );
    return {
      mentions: rows.map((r) => ({
        id: r.id, fileId: r.file_id, fileName: decryptField(r.file_name), fileKind: r.file_kind,
        from: { displayName: r.from_name, initials: r.from_initials },
        excerpt: (decryptField(r.body) ?? "").slice(0, 120), read: !!r.read_at, createdAt: r.created_at,
      })),
      unread: rows.filter((r) => !r.read_at).length,
    };
  });

  /** Mark mentions read — body {ids?: string[]} or all when omitted */
  app.post("/api/mentions/read", async (req) => {
    const { user } = req as AuthedRequest;
    const { ids } = z.object({ ids: z.array(z.string()).optional() }).parse(req.body ?? {});
    if (ids?.length) {
      for (const id of ids) {
        await run("UPDATE mentions SET read_at = now() WHERE id = $1 AND to_user_id = $2", [id, user.id]);
      }
    } else {
      await run("UPDATE mentions SET read_at = now() WHERE to_user_id = $1 AND read_at IS NULL", [user.id]);
    }
    return { ok: true };
  });
}

interface MentionRow {
  id: string; file_id: string; file_name: string; file_kind: string;
  from_name: string; from_initials: string; body: string;
  read_at: string | null; created_at: string;
}

interface CommentRow {
  id: string;
  file_id: string;
  author_id: string;
  display_name: string;
  initials: string;
  anchor: string | null;
  body: string;
  resolved: boolean;
  parent_id: string | null;
  created_at: string;
}

function commentOut(r: CommentRow) {
  return {
    id: r.id, fileId: r.file_id, authorId: r.author_id,
    author: { displayName: r.display_name, initials: r.initials },
    anchor: r.anchor, body: decryptField(r.body) ?? "", resolved: !!r.resolved,
    parentId: r.parent_id, createdAt: r.created_at,
  };
}
