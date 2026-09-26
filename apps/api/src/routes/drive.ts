import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, now } from "../db.js";
import { getItem, toDriveItem, touchItem, logActivity, type ItemRow } from "../items.js";
import { requireAuth, permissionFor, hasPermission, type AuthedRequest } from "../auth.js";
import { putBlob } from "../blobs.js";
import { FILE_KINDS } from "@kreatix/shared";

const createSchema = z.object({
  name: z.string().min(1).max(255),
  kind: z.enum(["folder", "writer", "sheets", "present", "pdf", "file"]),
  parentId: z.string().nullable().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  starred: z.boolean().optional(),
  parentId: z.string().nullable().optional(),
});

const DEFAULT_DOCS: Record<string, unknown> = {
  writer: { kind: "writer", doc: { type: "doc", content: [{ type: "paragraph" }] } },
  sheets: { kind: "sheets", workbook: { sheets: [{ name: "Sheet1", cells: {} }] } },
  present: { kind: "present", deck: { slides: [{ id: "s1", objects: [] }] } },
};

export function driveRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /** List items: ?view=home|recent|starred|shared|trash  or ?parent=<id> for folder browsing */
  app.get("/api/drive", async (req) => {
    const { user } = req as AuthedRequest;
    const q = req.query as { view?: string; parent?: string };

    let rows: ItemRow[];
    const base = `
      SELECT DISTINCT i.* FROM items i
      LEFT JOIN shares s ON s.file_id = i.id AND s.user_id = :uid`;

    if (q.parent !== undefined) {
      rows = db
        .prepare(`${base} WHERE i.trashed = 0 AND (i.owner_id = :uid OR s.user_id IS NOT NULL)
                  AND i.parent_id IS :parent ORDER BY i.kind = 'folder' DESC, i.name`)
        .all({ uid: user.id, parent: q.parent === "" ? null : q.parent }) as ItemRow[];
    } else if (q.view === "starred") {
      rows = db
        .prepare(`${base} WHERE i.trashed = 0 AND i.starred = 1 AND (i.owner_id = :uid OR s.user_id IS NOT NULL)
                  ORDER BY i.updated_at DESC`)
        .all({ uid: user.id }) as ItemRow[];
    } else if (q.view === "shared") {
      rows = db
        .prepare(`SELECT i.* FROM items i JOIN shares s ON s.file_id = i.id
                  WHERE s.user_id = ? AND i.trashed = 0 ORDER BY i.updated_at DESC`)
        .all(user.id) as ItemRow[];
    } else if (q.view === "trash") {
      rows = db
        .prepare("SELECT * FROM items WHERE owner_id = ? AND trashed = 1 ORDER BY updated_at DESC")
        .all(user.id) as ItemRow[];
    } else {
      // home + recent: items I own or that are shared with me
      const limit = q.view === "home" ? 8 : 50;
      rows = db
        .prepare(`${base} WHERE i.trashed = 0 AND i.kind != 'folder' AND (i.owner_id = :uid OR s.user_id IS NOT NULL)
                  ORDER BY i.updated_at DESC LIMIT ${limit}`)
        .all({ uid: user.id }) as ItemRow[];
    }

    return { items: rows.map((r) => toDriveItem(r, permissionFor(user.id, r) ?? undefined)) };
  });

  app.get("/api/drive/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(permissionFor(user.id, item), "viewer")) {
      return reply.code(404).send({ error: "not_found", message: "File not found" });
    }
    const owner = db.prepare("SELECT display_name FROM users WHERE id = ?").get(item.owner_id) as { display_name: string } | undefined;
    return { item: { ...toDriveItem(item, permissionFor(user.id, item) ?? undefined), ownerName: owner?.display_name } };
  });

  app.post("/api/drive", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const body = createSchema.parse(req.body);
    const id = randomUUID();

    if (body.parentId) {
      const parent = getItem(body.parentId);
      if (!parent || parent.kind !== "folder" || !hasPermission(permissionFor(user.id, parent), "editor")) {
        return reply.code(403).send({ error: "forbidden", message: "Cannot create in this folder" });
      }
    }

    db.prepare(
      `INSERT INTO items (id, org_id, parent_id, owner_id, name, kind, mime, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, user.orgId, body.parentId ?? null, user.id, body.name, body.kind,
      `application/x-kreatix-${body.kind}`, now(), now(),
    );

    // Seed initial immutable version for suite-native docs (SRS §19)
    const doc = DEFAULT_DOCS[body.kind];
    if (doc) {
      const { key, size } = putBlob(Buffer.from(JSON.stringify(doc)));
      db.prepare(
        "INSERT INTO versions (id, file_id, number, label, blob_key, size, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)",
      ).run(randomUUID(), id, 1, "Initial version", key, size, user.id, now());
      db.prepare("UPDATE items SET size = ? WHERE id = ?").run(size, id);
    }

    logActivity(user.orgId, user.id, id, "create", body.name);
    return { item: toDriveItem(getItem(id)!, "owner") };
  });

  /** Binary upload (PDFs, office files, media): raw body + ?name=&parent= */
  app.post("/api/drive/upload", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { name, parent, kind } = req.query as { name?: string; parent?: string; kind?: string };
    const buf = Buffer.isBuffer(req.body) ? req.body : await buffer(req);
    if (!buf.length) return reply.code(400).send({ error: "bad_request", message: "Empty upload" });

    const fileKind = FILE_KINDS.includes(kind as never) ? (kind as ItemRow["kind"]) : "file";
    const id = randomUUID();
    const { key, size } = putBlob(buf);

    db.prepare(
      `INSERT INTO items (id, org_id, parent_id, owner_id, name, kind, mime, size, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, user.orgId, parent || null, user.id, name ?? "Untitled", fileKind,
      (req.headers["content-type"] as string) ?? "application/octet-stream", size, now(), now());
    db.prepare(
      "INSERT INTO versions (id, file_id, number, label, blob_key, size, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(randomUUID(), id, 1, "Initial upload", key, size, user.id, now());

    logActivity(user.orgId, user.id, id, "upload", name ?? "Untitled");
    return { item: toDriveItem(getItem(id)!, "owner") };
  });

  app.patch("/api/drive/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(permissionFor(user.id, item), "editor")) {
      return reply.code(403).send({ error: "forbidden", message: "No edit access" });
    }
    const body = patchSchema.parse(req.body);
    db.prepare(
      `UPDATE items SET name = COALESCE(?, name), starred = COALESCE(?, starred),
       parent_id = CASE WHEN ? THEN ? ELSE parent_id END, updated_at = ? WHERE id = ?`,
    ).run(
      body.name ?? null, body.starred === undefined ? null : body.starred ? 1 : 0,
      body.parentId !== undefined ? 1 : 0, body.parentId ?? null, now(), item.id,
    );
    return { item: toDriveItem(getItem(item.id)!, permissionFor(user.id, item) ?? undefined) };
  });

  app.delete("/api/drive/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = getItem((req.params as { id: string }).id);
    if (!item || item.owner_id !== user.id) {
      return reply.code(403).send({ error: "forbidden", message: "Only the owner can delete" });
    }
    if ((req.query as { permanent?: string }).permanent === "true") {
      db.prepare("DELETE FROM items WHERE id = ?").run(item.id);
      logActivity(user.orgId, user.id, item.id, "delete-permanent", item.name);
      return { ok: true };
    }
    db.prepare("UPDATE items SET trashed = 1, updated_at = ? WHERE id = ?").run(now(), item.id);
    logActivity(user.orgId, user.id, item.id, "trash", item.name);
    return { ok: true };
  });

  app.post("/api/drive/:id/restore", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = getItem((req.params as { id: string }).id);
    if (!item || item.owner_id !== user.id) {
      return reply.code(403).send({ error: "forbidden" });
    }
    db.prepare("UPDATE items SET trashed = 0, updated_at = ? WHERE id = ?").run(now(), item.id);
    return { item: toDriveItem(getItem(item.id)!, "owner") };
  });
}

async function buffer(req: { raw: NodeJS.ReadableStream }): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req.raw) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
