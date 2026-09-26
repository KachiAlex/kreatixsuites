import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, now } from "../db.js";
import { getItem, logActivity } from "../items.js";
import { requireAuth, permissionFor, hasPermission, type AuthedRequest } from "../auth.js";

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
    ).run(id, item.id, user.id, body.anchor ?? null, body.body, body.parentId ?? null, now());
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
      .run(body.resolved === undefined ? null : body.resolved ? 1 : 0, body.body ?? null, c.id);
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
    anchor: r.anchor, body: r.body, resolved: !!r.resolved,
    parentId: r.parent_id, createdAt: r.created_at,
  };
}
