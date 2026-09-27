import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, now } from "../db.js";
import { getItem, touchItem, logActivity } from "../items.js";
import { requireAuth, permissionFor, hasPermission, type AuthedRequest } from "../auth.js";
import { putBlob, getBlob } from "../blobs.js";

interface VersionRow {
  id: string;
  file_id: string;
  number: number;
  label: string | null;
  blob_key: string;
  size: number;
  created_by: string;
  created_at: string;
}

function headVersion(fileId: string): VersionRow | undefined {
  return db
    .prepare("SELECT * FROM versions WHERE file_id = ? ORDER BY number DESC LIMIT 1")
    .get(fileId) as VersionRow | undefined;
}

export function contentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /** GET current file content (head version blob) */
  app.get("/api/files/:id/content", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(permissionFor(user.id, item), "viewer")) {
      return reply.code(404).send({ error: "not_found", message: "File not found" });
    }
    const v = headVersion(item.id);
    if (!v) return reply.code(404).send({ error: "not_found", message: "No content" });
    const blob = getBlob(v.blob_key);
    if (!blob) return reply.code(404).send({ error: "not_found", message: "Blob missing" });

    if (item.mime.startsWith("application/x-kreatix-")) {
      return { version: v.number, content: JSON.parse(blob.toString("utf8")) };
    }
    // PDF files: head blob may be our annotation wrapper JSON — detect and unwrap.
    // (v1 is always the raw PDF upload; later versions are {kind:"pdf",…} JSON)
    if (item.kind === "pdf" && blob[0] === 0x7b /* '{' */) {
      try {
        const parsed = JSON.parse(blob.toString("utf8"));
        if (parsed?.kind === "pdf") return { version: v.number, content: parsed };
      } catch { /* fall through to raw */ }
    }
    reply.header("content-type", item.mime).header("content-length", blob.length);
    return reply.send(blob);
  });

  /** GET the original uploaded binary (version 1) — used by the PDF viewer to fetch
   *  the document bytes even when later head versions hold annotation JSON. */
  app.get("/api/files/:id/raw", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(permissionFor(user.id, item), "viewer")) {
      return reply.code(404).send({ error: "not_found", message: "File not found" });
    }
    const v = db
      .prepare("SELECT * FROM versions WHERE file_id = ? ORDER BY number ASC LIMIT 1")
      .get(item.id) as VersionRow | undefined;
    const blob = v && getBlob(v.blob_key);
    if (!v || !blob) return reply.code(404).send({ error: "not_found", message: "Blob missing" });
    reply.header("content-type", item.mime).header("content-length", blob.length);
    return reply.send(blob);
  });

  /** PUT new content — creates an immutable version (autosave calls this, debounced client-side) */
  app.put("/api/files/:id/content", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(permissionFor(user.id, item), "editor")) {
      return reply.code(403).send({ error: "forbidden", message: "No edit access" });
    }
    const body = z
      .object({ content: z.unknown(), label: z.string().max(120).optional() })
      .parse(req.body);
    // Writes from outside a live collab session invalidate the persisted CRDT
    // state — the next session re-seeds from this canonical JSON.
    if ((req.query as { collab?: string }).collab !== "1") {
      db.prepare("DELETE FROM collab_states WHERE file_id = ?").run(item.id);
    }
    const data = Buffer.from(JSON.stringify(body.content));
    const { key, size } = putBlob(data);
    const next = (headVersion(item.id)?.number ?? 0) + 1;

    db.prepare(
      "INSERT INTO versions (id, file_id, number, label, blob_key, size, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(randomUUID(), item.id, next, body.label ?? null, key, size, user.id, now());
    db.prepare("UPDATE items SET size = ? WHERE id = ?").run(size, item.id);
    touchItem(item.id);
    return { version: next };
  });

  app.get("/api/files/:id/versions", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(permissionFor(user.id, item), "viewer")) {
      return reply.code(404).send({ error: "not_found" });
    }
    const rows = db
      .prepare(
        `SELECT v.*, u.display_name, u.initials FROM versions v JOIN users u ON u.id = v.created_by
         WHERE v.file_id = ? ORDER BY v.number DESC`,
      )
      .all(item.id) as (VersionRow & { display_name: string; initials: string })[];
    return {
      versions: rows.map((v) => ({
        id: v.id, fileId: v.file_id, number: v.number, label: v.label,
        size: v.size, createdBy: v.display_name, createdAt: v.created_at,
      })),
    };
  });

  app.get("/api/files/:id/versions/:n/content", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { id, n } = req.params as { id: string; n: string };
    const item = getItem(id);
    if (!item || !hasPermission(permissionFor(user.id, item), "viewer")) {
      return reply.code(404).send({ error: "not_found" });
    }
    const v = db
      .prepare("SELECT * FROM versions WHERE file_id = ? AND number = ?")
      .get(item.id, Number(n)) as VersionRow | undefined;
    const blob = v && getBlob(v.blob_key);
    if (!v || !blob) return reply.code(404).send({ error: "not_found" });
    try {
      return { version: v.number, content: JSON.parse(blob.toString("utf8")) };
    } catch {
      // binary version (e.g. the original PDF upload) — stream it raw
      reply.header("content-type", item.mime).header("content-length", blob.length);
      return reply.send(blob);
    }
  });

  /** Restore an older version — implemented as a new head version copying the old blob (SRS §19) */
  app.post("/api/files/:id/versions/:n/restore", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { id, n } = req.params as { id: string; n: string };
    const item = getItem(id);
    if (!item || !hasPermission(permissionFor(user.id, item), "editor")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const v = db
      .prepare("SELECT * FROM versions WHERE file_id = ? AND number = ?")
      .get(item.id, Number(n)) as VersionRow | undefined;
    if (!v) return reply.code(404).send({ error: "not_found" });
    // restored content is canonical — clear live CRDT state so it re-seeds
    db.prepare("DELETE FROM collab_states WHERE file_id = ?").run(item.id);
    const next = (headVersion(item.id)?.number ?? 0) + 1;
    db.prepare(
      "INSERT INTO versions (id, file_id, number, label, blob_key, size, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(randomUUID(), item.id, next, `Restored from v${v.number}`, v.blob_key, v.size, user.id, now());
    touchItem(item.id);
    logActivity(user.orgId, user.id, item.id, "restore-version", `v${v.number} → v${next}`);
    return { version: next };
  });
}
