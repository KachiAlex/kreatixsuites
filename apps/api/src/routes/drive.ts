import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { q as dbq, run, now } from "../db.js";
import { getItem, toDriveItem, touchItem, logActivity, itemName, type ItemRow } from "../items.js";
import { requireAuth, permissionFor, hasPermission, type AuthedRequest } from "../auth.js";
import { putBlob } from "../blobs.js";
import { FILE_KINDS } from "@kreatix/shared";
import { purgeItem } from "../policies.js";
import { indexFile } from "../indexer.js";
import { encryptField } from "../crypto.js";

const createSchema = z.object({
  name: z.string().min(1).max(255),
  kind: z.enum(["folder", "writer", "sheets", "present", "pdf", "file"]),
  parentId: z.string().nullable().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  starred: z.boolean().optional(),
  parentId: z.string().nullable().optional(),
  label: z.enum(["internal", "public", "confidential", "restricted"]).optional(),
});

const BLOCKED_EXTS = new Set([
  "exe", "msi", "bat", "cmd", "com", "scr", "pif", "vbs", "vbe", "jse", "wsf", "wsh",
  "ps1", "dll", "hta", "cpl", "jar", "lnk", "reg", "apk",
]);

const SCAN_CMD = process.env.KREATIX_SCAN_CMD;

// EICAR anti-virus test signature — always rejected.
const EICAR = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR");

/** Executable binary magic — rejected regardless of declared extension. */
const EXEC_MAGIC = [Buffer.from("MZ"), Buffer.from("\x7fELF"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from([0xfe, 0xed, 0xfa, 0xcf])];

/** Extension → required magic bytes (content sniffing; catches renamed .exe). */
const EXT_MAGIC: Record<string, Buffer> = {
  pdf: Buffer.from("%PDF-"),
  docx: Buffer.from("PK\x03\x04"), xlsx: Buffer.from("PK\x03\x04"),
  pptx: Buffer.from("PK\x03\x04"), zip: Buffer.from("PK\x03\x04"),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  jpg: Buffer.from([0xff, 0xd8, 0xff]), jpeg: Buffer.from([0xff, 0xd8, 0xff]),
  gif: Buffer.from("GIF8"),
};

/** Returns a rejection reason, or null when the buffer passes the gate. */
function sniffReject(buf: Buffer, ext: string): string | null {
  if (buf.includes(EICAR)) return "EICAR test signature";
  if (EXEC_MAGIC.some((m) => buf.subarray(0, m.length).equals(m))) return "executable binary";
  const want = EXT_MAGIC[ext];
  if (want && !buf.subarray(0, want.length).equals(want)) {
    return `'.${ext}' file content does not match its type`;
  }
  return null;
}

/** Write buffer to a temp file, run KREATIX_SCAN_CMD, return stderr verdict or null. */
async function scanBuffer(buf: Buffer, name: string): Promise<string | null> {
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const { execFile } = await import("node:child_process");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const tmp = join(tmpdir(), `kreatix-scan-${randomUUID()}-${name.replace(/[^\w.-]/g, "_").slice(-80)}`);
  try {
    writeFileSync(tmp, buf);
    const [cmd, ...args] = SCAN_CMD!.split(" ");
    await new Promise<void>((resolve, reject) => {
      execFile(cmd, [...args, tmp], { timeout: 30_000 }, (err, _stdout, stderr) =>
        err ? reject(new Error(stderr?.trim() || err.message)) : resolve(),
      );
    });
    return null; // exit 0 = clean
  } catch (e) {
    return e instanceof Error ? e.message.slice(0, 300) : "scan failed";
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

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
    // media_for items are embedded doc assets — never surfaced as Drive files
    const base = `
      SELECT DISTINCT i.* FROM items i
      LEFT JOIN shares s ON s.file_id = i.id AND s.user_id = $1`;

    if (q.parent !== undefined) {
      // IS NOT DISTINCT FROM — null-safe equality (parent_id IS NULL at root)
      rows = await dbq<ItemRow>(
        `${base} WHERE i.trashed = false AND i.media_for IS NULL AND (i.owner_id = $1 OR s.user_id IS NOT NULL)
         AND i.parent_id IS NOT DISTINCT FROM $2`,
        [user.id, q.parent === "" ? null : q.parent],
      );
    } else if (q.view === "starred") {
      rows = await dbq<ItemRow>(
        `${base} WHERE i.trashed = false AND i.media_for IS NULL AND i.starred AND (i.owner_id = $1 OR s.user_id IS NOT NULL)
         ORDER BY i.updated_at DESC`,
        [user.id],
      );
    } else if (q.view === "shared") {
      rows = await dbq<ItemRow>(
        `SELECT i.* FROM items i JOIN shares s ON s.file_id = i.id
         WHERE s.user_id = $1 AND i.trashed = false AND i.media_for IS NULL ORDER BY i.updated_at DESC`,
        [user.id],
      );
    } else if (q.view === "trash") {
      rows = await dbq<ItemRow>(
        "SELECT * FROM items WHERE owner_id = $1 AND media_for IS NULL AND trashed ORDER BY updated_at DESC",
        [user.id],
      );
    } else {
      // home + recent: items I own or that are shared with me
      const limit = q.view === "home" ? 8 : 50;
      rows = await dbq<ItemRow>(
        `${base} WHERE i.trashed = false AND i.media_for IS NULL AND i.kind != 'folder' AND (i.owner_id = $1 OR s.user_id IS NOT NULL)
         ORDER BY i.updated_at DESC LIMIT ${limit}`,
        [user.id],
      );
    }

    const items = await Promise.all(
      rows.map(async (r) => toDriveItem(r, (await permissionFor(user.id, r)) ?? undefined)),
    );
    // names are encrypted at rest — ciphertext can't sort in SQL, so folder
    // browsing re-sorts on the decrypted name
    if (q.parent !== undefined) {
      items.sort(
        (a, b) =>
          (b.kind === "folder" ? 1 : 0) - (a.kind === "folder" ? 1 : 0) ||
          a.name.localeCompare(b.name),
      );
    }
    return { items };
  });

  app.get("/api/drive/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(await permissionFor(user.id, item), "viewer")) {
      return reply.code(404).send({ error: "not_found", message: "File not found" });
    }
    const owner = await dbq<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [item.owner_id]);
    return { item: { ...(await toDriveItem(item, (await permissionFor(user.id, item)) ?? undefined)), ownerName: owner[0]?.display_name } };
  });

  app.post("/api/drive", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const body = createSchema.parse(req.body);
    const id = randomUUID();

    if (body.parentId) {
      const parent = await getItem(body.parentId);
      if (!parent || parent.kind !== "folder" || !hasPermission(await permissionFor(user.id, parent), "editor")) {
        return reply.code(403).send({ error: "forbidden", message: "Cannot create in this folder" });
      }
    }

    await run(
      `INSERT INTO items (id, org_id, parent_id, owner_id, name, kind, mime, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, user.orgId, body.parentId ?? null, user.id, encryptField(body.name), body.kind,
       `application/x-kreatix-${body.kind}`, now(), now()],
    );

    // Seed initial immutable version for suite-native docs (SRS §19)
    const doc = DEFAULT_DOCS[body.kind];
    if (doc) {
      const { key, size } = putBlob(Buffer.from(JSON.stringify(doc)));
      await run(
        "INSERT INTO versions (id, file_id, number, label, blob_key, size, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [randomUUID(), id, 1, "Initial version", key, size, user.id, now()],
      );
      await run("UPDATE items SET size = $1 WHERE id = $2", [size, id]);
    }

    await logActivity(user.orgId, user.id, id, "create", body.name);
    return { item: await toDriveItem((await getItem(id))!, "owner") };
  });

  /** Binary upload (PDFs, office files, media): raw body + ?name=&parent= */
  app.post("/api/drive/upload", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { name, parent, kind, mediaFor } = req.query as { name?: string; parent?: string; kind?: string; mediaFor?: string };
    // text/* content-types hit Fastify's built-in parser (string body) before
    // the wildcard buffer parser — handle all three shapes.
    const buf = Buffer.isBuffer(req.body)
      ? req.body
      : typeof req.body === "string" && req.body.length
        ? Buffer.from(req.body)
        : await buffer(req);
    if (!buf.length) return reply.code(400).send({ error: "bad_request", message: "Empty upload" });

    // malware/type gate: never-executable extensions, plus optional external
    // scanner (KREATIX_SCAN_CMD receives the temp path; non-zero exit = reject)
    const ext = (name ?? "").split(".").pop()?.toLowerCase() ?? "";
    if (BLOCKED_EXTS.has(ext)) {
      return reply.code(415).send({ error: "blocked_file_type", message: `'.${ext}' files are not allowed` });
    }
    const sniff = sniffReject(buf, ext);
    if (sniff) {
      void logActivity(user.orgId, user.id, null, "upload-blocked", `${name ?? "upload"}: ${sniff}`);
      return reply.code(415).send({ error: "blocked_file_type", message: `Upload rejected: ${sniff}` });
    }
    if (SCAN_CMD) {
      const verdict = await scanBuffer(buf, name ?? "upload");
      if (verdict !== null) {
        void logActivity(user.orgId, user.id, null, "upload-blocked", `${name ?? "upload"}: ${verdict}`);
        return reply.code(415).send({ error: "upload_rejected", message: `Upload rejected by scanner: ${verdict}` });
      }
    }

    const fileKind = FILE_KINDS.includes(kind as never)
      ? (kind as ItemRow["kind"])
      : ext === "pdf" || buf.subarray(0, 5).equals(Buffer.from("%PDF-"))
        ? "pdf"
        : "file";
    // uploads honor folder permissions the same as item creation
    if (parent) {
      const p = await getItem(parent);
      if (!p || p.kind !== "folder" || !hasPermission(await permissionFor(user.id, p), "editor")) {
        return reply.code(403).send({ error: "forbidden", message: "Cannot upload into this folder" });
      }
    }
    const id = randomUUID();
    const { key, size } = putBlob(buf);

    // mediaFor: embedded media (doc images) inherit viewer access from the host doc
    let mediaForId: string | null = null;
    if (mediaFor) {
      const host = await getItem(mediaFor);
      if (host && hasPermission(await permissionFor(user.id, host), "editor")) mediaForId = mediaFor;
    }

    await run(
      `INSERT INTO items (id, org_id, parent_id, owner_id, name, kind, mime, size, media_for, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, user.orgId, parent || null, user.id, encryptField(name ?? "Untitled"), fileKind,
       (req.headers["content-type"] as string) ?? "application/octet-stream", size, mediaForId, now(), now()],
    );
    await run(
      "INSERT INTO versions (id, file_id, number, label, blob_key, size, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [randomUUID(), id, 1, "Initial upload", key, size, user.id, now()],
    );

    void logActivity(user.orgId, user.id, id, "upload", name ?? "Untitled");
    // index PDF uploads immediately (body text + later annotation text)
    if (fileKind === "pdf") void indexFile(id, "pdf", null).catch(() => {});
    return { item: await toDriveItem((await getItem(id))!, "owner") };
  });

  app.patch("/api/drive/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(await permissionFor(user.id, item), "editor")) {
      return reply.code(403).send({ error: "forbidden", message: "No edit access" });
    }
    const body = patchSchema.parse(req.body);
    if (body.parentId) {
      const parent = await getItem(body.parentId);
      if (!parent || parent.kind !== "folder" || !hasPermission(await permissionFor(user.id, parent), "editor")) {
        return reply.code(403).send({ error: "forbidden", message: "Cannot move into this folder" });
      }
      // a folder must not be moved into itself or its own descendant —
      // walk the ancestor chain (bounded) and reject if we meet the item
      if (await isAncestorOf(item.id, body.parentId)) {
        return reply.code(400).send({ error: "bad_request", message: "Cannot move a folder into its own subtree" });
      }
    }
    await run(
      `UPDATE items SET name = COALESCE($1, name), starred = COALESCE($2, starred),
       label = COALESCE($3, label),
       parent_id = CASE WHEN $4 THEN $5 ELSE parent_id END, updated_at = $6 WHERE id = $7`,
      [
        body.name === undefined ? null : encryptField(body.name),
        body.starred === undefined ? null : body.starred,
        body.label ?? null,
        body.parentId !== undefined, body.parentId ?? null, now(), item.id,
      ],
    );
    if (body.label) void logActivity(user.orgId, user.id, item.id, "label", body.label);
    return { item: await toDriveItem((await getItem(item.id))!, (await permissionFor(user.id, item)) ?? undefined) };
  });

  app.delete("/api/drive/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || item.owner_id !== user.id) {
      return reply.code(403).send({ error: "forbidden", message: "Only the owner can delete" });
    }
    if ((req.query as { permanent?: string }).permanent === "true") {
      await purgeItem(item.id);
      void logActivity(user.orgId, user.id, item.id, "delete-permanent", itemName(item));
      return { ok: true };
    }
    await run("UPDATE items SET trashed = true, updated_at = $1 WHERE id = $2", [now(), item.id]);
    void logActivity(user.orgId, user.id, item.id, "trash", itemName(item));
    return { ok: true };
  });

  app.post("/api/drive/:id/restore", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || item.owner_id !== user.id) {
      return reply.code(403).send({ error: "forbidden" });
    }
    await run("UPDATE items SET trashed = false, updated_at = $1 WHERE id = $2", [now(), item.id]);
    return { item: await toDriveItem((await getItem(item.id))!, "owner") };
  });
}

/** True when `ancestorId` appears in `itemId`'s parent chain (bounded walk). */
async function isAncestorOf(ancestorId: string, itemId: string): Promise<boolean> {
  let cur: string | null = itemId;
  for (let i = 0; i < 64 && cur; i++) {
    if (cur === ancestorId) return true;
    const row = await getItem(cur);
    cur = row?.parent_id ?? null;
  }
  return false;
}

async function buffer(req: { raw: NodeJS.ReadableStream }): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req.raw) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
