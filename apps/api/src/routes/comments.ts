import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, now } from "../db.js";
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
    const item = getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(permissionFor(user.id, item), "viewer")) {
      return reply.code(404).send({ error: "not_found" });
    }
    const rows = db
      .prepare(
        `SELECT c.*, u.display_name, u.initials FROM comments c JOIN users u ON u.id = c.author_id
         WHERE c.file_id = ? ORDER BY c.created_at ASC`,
      )
      .all(item.id) as CommentRow[];
    return { comments: rows.map(commentOut) };
  });

  app.post("/api/files/:id/comments", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(permissionFor(user.id, item), "commenter")) {
      return reply.code(403).send({ error: "forbidden", message: "No comment access" });
    }
    const body = createSchema.parse(req.body);
    const id = randomUUID();
    db.prepare(
      "INSERT INTO comments (id, file_id, author_id, anchor, body, parent_id, created_at) VALUES (?,?,?,?,?,?,?)",
    ).run(id, item.id, user.id, body.anchor ?? null, encryptField(body.body), body.parentId ?? null, now());
    // @mentions: "@email" or "@name" → notify the file's owner + shared users
    const tokens = new Set([...body.body.matchAll(/@([\w.+-]+)/g)].map((m) => m[1]));
    for (const t of tokens) {
      const target = db.prepare(
        `SELECT u.id FROM users u WHERE u.id != ? AND (
           u.email = ? OR u.display_name LIKE ? || '%' OR u.display_name LIKE '% ' || ? || '%')
         AND (u.id = ? OR u.id IN (SELECT user_id FROM shares WHERE file_id = ?))`,
      ).get(user.id, t, t, t, item.owner_id, item.id) as { id: string } | undefined;
      if (target) {
        db.prepare(
          "INSERT INTO mentions (id, comment_id, file_id, from_user_id, to_user_id, created_at) VALUES (?,?,?,?,?,?)",
        ).run(randomUUID(), id, item.id, user.id, target.id, now());
      }
    }
    logActivity(user.orgId, user.id, item.id, "comment", body.body.slice(0, 80));
    const row = db
      .prepare("SELECT c.*, u.display_name, u.initials FROM comments c JOIN users u ON u.id = c.author_id WHERE c.id = ?")
      .get(id) as CommentRow;
    return { comment: commentOut(row) };
  });

  app.patch("/api/comments/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const c = db.prepare("SELECT * FROM comments WHERE id = ?").get((req.params as { id: string }).id) as
      | { id: string; file_id: string; author_id: string }
      | undefined;
    if (!c) return reply.code(404).send({ error: "not_found" });
    const item = getItem(c.file_id)!;
    const perm = permissionFor(user.id, item);
    const body = z.object({ resolved: z.boolean().optional(), body: z.string().max(4000).optional() }).parse(req.body);
    if (body.body !== undefined && c.author_id !== user.id) {
      return reply.code(403).send({ error: "forbidden", message: "Only the author can edit" });
    }
    if (body.resolved !== undefined && !hasPermission(perm, "commenter")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    db.prepare("UPDATE comments SET resolved = COALESCE(?, resolved), body = COALESCE(?, body) WHERE id = ?")
      .run(body.resolved === undefined ? null : body.resolved ? 1 : 0,
        body.body === undefined ? null : encryptField(body.body), c.id);
    return { ok: true };
  });

  app.delete("/api/comments/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const c = db.prepare("SELECT * FROM comments WHERE id = ?").get((req.params as { id: string }).id) as
      | { id: string; author_id: string; file_id: string }
      | undefined;
    if (!c) return reply.code(404).send({ error: "not_found" });
    const item = getItem(c.file_id)!;
    if (c.author_id !== user.id && !hasPermission(permissionFor(user.id, item), "editor")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    db.prepare("DELETE FROM comments WHERE id = ?").run(c.id);
    return { ok: true };
  });

  /** Recent mentions of the current user (notification bell) */
  app.get("/api/mentions", async (req) => {
    const { user } = req as AuthedRequest;
    const rows = db.prepare(
      `SELECT m.id, m.read_at, m.created_at, u.display_name AS from_name, u.initials AS from_initials,
              i.name AS file_name, i.kind AS file_kind, m.file_id, c.body
       FROM mentions m
       JOIN users u ON u.id = m.from_user_id
       JOIN items i ON i.id = m.file_id
       JOIN comments c ON c.id = m.comment_id
       WHERE m.to_user_id = ? ORDER BY m.created_at DESC LIMIT 50`,
    ).all(user.id) as MentionRow[];
    return {
      mentions: rows.map((r) => ({
        id: r.id, fileId: r.file_id, fileName: r.file_name, fileKind: r.file_kind,
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
      const q = db.prepare("UPDATE mentions SET read_at = datetime('now') WHERE id = ? AND to_user_id = ?");
      for (const id of ids) q.run(id, user.id);
    } else {
      db.prepare("UPDATE mentions SET read_at = datetime('now') WHERE to_user_id = ? AND read_at IS NULL").run(user.id);
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
  resolved: number;
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
