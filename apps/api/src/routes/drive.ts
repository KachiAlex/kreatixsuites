import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { q as dbq, one, run, now, tx } from "../db.js";
import { getItem, toDriveItem, touchItem, logActivity, itemName, writeLocked, type ItemRow } from "../items.js";
import { requireAuth, permissionFor, hasPermission, type AuthedRequest } from "../auth.js";
import { entitled } from "../billing.js";
import { getSite, getLibrary, siteRoleFor, libraryPermission, visibleLibraryIds } from "../sites.js";
import { publishHead, submitForApproval } from "./content.js";
import { putBlob, getBlob } from "../blobs.js";
import { FILE_KINDS } from "@kreatix/shared";
import { purgeItem } from "../policies.js";
import { indexFile } from "../indexer.js";
import { encryptField, decryptField } from "../crypto.js";

const createSchema = z.object({
  name: z.string().min(1).max(255),
  kind: z.enum(["folder", "writer", "sheets", "present", "pdf", "file"]),
  parentId: z.string().nullable().optional(),
  libraryId: z.string().nullable().optional(),
  contentTypeId: z.string().nullable().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  starred: z.boolean().optional(),
  parentId: z.string().nullable().optional(),
  libraryId: z.string().nullable().optional(),
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

  /** List items: ?view=home|recent|starred|shared|trash, ?parent=<id> for folder
   *  browsing, or ?library=<id> for a site library root (SharePoint-style:
   *  every item in a library is visible to site members, not just owned/shared). */
  app.get("/api/drive", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const q = req.query as { view?: string; parent?: string; library?: string };

    // libraries the user can reach via site membership / org visibility
    const libIds = await visibleLibraryIds(user);

    let rows: ItemRow[];
    let libRole: string | null = null; // set when browsing a library root
    let approver = false;              // site-owner rank — approves submissions
    // media_for items are embedded doc assets — never surfaced as Drive files
    const base = `
      SELECT DISTINCT i.* FROM items i
      LEFT JOIN shares s ON s.file_id = i.id AND s.user_id = $1`;

    if (q.library !== undefined) {
      const lib = await getLibrary(q.library);
      // grant-aware access: covers site roles AND broken-inheritance grants
      const perm = lib ? await libraryPermission(user.id, lib.id) : null;
      if (!lib || !perm) {
        return reply.code(404).send({ error: "not_found", message: "Library not found" });
      }
      libRole = perm === "owner" ? "owner" : perm === "editor" ? "member" : "visitor";
      approver = perm === "owner";
      rows = await dbq<ItemRow>(
        `${base} WHERE i.trashed = false AND i.media_for IS NULL AND i.library_id = $2
         AND i.parent_id IS NULL`,
        [user.id, q.library],
      );
    } else if (q.parent !== undefined) {
      const parentId = q.parent === "" ? null : q.parent;
      if (parentId) {
        // folder-share inheritance: a readable folder exposes everything
        // inside it — children need no share of their own
        const parent = await getItem(parentId);
        if (!parent || parent.kind !== "folder" || !hasPermission(await permissionFor(user.id, parent), "viewer")) {
          return reply.code(404).send({ error: "not_found", message: "Folder not found" });
        }
        if (parent.library_id) {
          approver = (await libraryPermission(user.id, parent.library_id)) === "owner";
        }
        rows = await dbq<ItemRow>(
          `${base} WHERE i.trashed = false AND i.media_for IS NULL AND i.parent_id = $2`,
          [user.id, parentId],
        );
      } else {
        // root browse: own/shared items only, never library items — those
        // surface via Sites
        rows = await dbq<ItemRow>(
          `${base} WHERE i.trashed = false AND i.media_for IS NULL AND (i.owner_id = $1 OR s.user_id IS NOT NULL)
           AND i.parent_id IS NULL AND i.library_id IS NULL`,
          [user.id],
        );
      }
    } else if (q.view === "starred") {
      rows = await dbq<ItemRow>(
        `${base} WHERE i.trashed = false AND i.media_for IS NULL AND i.starred
         AND (i.owner_id = $1 OR s.user_id IS NOT NULL OR i.library_id = ANY($2))
         ORDER BY i.updated_at DESC`,
        [user.id, libIds],
      );
    } else if (q.view === "shared") {
      rows = await dbq<ItemRow>(
        `SELECT i.* FROM items i JOIN shares s ON s.file_id = i.id
         WHERE s.user_id = $1 AND i.trashed = false AND i.media_for IS NULL ORDER BY i.updated_at DESC`,
        [user.id],
      );
    } else if (q.view === "trash") {
      // site-scoped recycle bin (SharePoint): site owners see anything trashed
      // inside the site's libraries, regardless of who owned the file
      const siteScope = (req.query as { site?: string }).site;
      if (siteScope) {
        const site = await getSite(siteScope);
        const role = site ? await siteRoleFor(user, site) : null;
        if (!site || role !== "owner") {
          return reply.code(403).send({ error: "forbidden", message: "Only site owners can view the site recycle bin" });
        }
        rows = await dbq<ItemRow>(
          `SELECT * FROM items WHERE trashed AND media_for IS NULL
           AND library_id IN (SELECT id FROM libraries WHERE site_id = $1)
           ORDER BY updated_at DESC`,
          [site.id],
        );
      } else {
        rows = await dbq<ItemRow>(
          "SELECT * FROM items WHERE owner_id = $1 AND media_for IS NULL AND trashed ORDER BY updated_at DESC",
          [user.id],
        );
      }
    } else if (q.view === "mirror") {
      // offline-shell sync: complete non-trashed set (folders included, no
      // cap) so the local mirror can purge items deleted on other devices
      rows = await dbq<ItemRow>(
        `${base} WHERE i.trashed = false AND i.media_for IS NULL AND (i.owner_id = $1 OR s.user_id IS NOT NULL OR i.library_id = ANY($2))
         ORDER BY i.updated_at DESC`,
        [user.id, libIds],
      );
    } else {
      // home + recent: items I own, shared with me, or in libraries I can see
      const limit = q.view === "home" ? 8 : 50;
      rows = await dbq<ItemRow>(
        `${base} WHERE i.trashed = false AND i.media_for IS NULL AND i.kind != 'folder'
         AND (i.owner_id = $1 OR s.user_id IS NOT NULL OR i.library_id = ANY($2))
         ORDER BY i.updated_at DESC LIMIT ${limit}`,
        [user.id, libIds],
      );
    }

    // viewer-level readers never see items that have only draft versions
    // (SharePoint: unpublished files are invisible to readers)
    let visibleIds: Set<string> | null = null;
    const viewerScoped = q.library !== undefined && libRole !== null && !atLeastRank(libRole, "member");
    if (viewerScoped && rows.length) {
      const pubs = await dbq<{ file_id: string }>(
        "SELECT DISTINCT file_id FROM versions WHERE file_id = ANY($1) AND published",
        [rows.map((r) => r.id)],
      );
      visibleIds = new Set(pubs.map((p) => p.file_id));
      rows = rows.filter((r) => r.kind === "folder" || visibleIds!.has(r.id));
    }

    // custom-column values ride along on library listings
    let metaByItem: Map<string, Record<string, string | null>> | null = null;
    const libItemIds = rows.filter((r) => r.library_id).map((r) => r.id);
    if (libItemIds.length) {
      const metaRows = await dbq<{ item_id: string; column_id: string; value: string | null }>(
        "SELECT item_id, column_id, value FROM item_metadata WHERE item_id = ANY($1)",
        [libItemIds],
      );
      metaByItem = new Map();
      for (const m of metaRows) {
        const cur = metaByItem.get(m.item_id) ?? {};
        cur[m.column_id] = m.value === null ? null : (decryptField(m.value) ?? m.value);
        metaByItem.set(m.item_id, cur);
      }
    }

    const items = await Promise.all(
      rows.map(async (r) => toDriveItem(r, (await permissionFor(user.id, r)) ?? undefined,
        { metadata: metaByItem?.get(r.id), approver })),
    );
    // names are encrypted at rest — ciphertext can't sort in SQL, so folder
    // and library browsing re-sort on the decrypted name
    if (q.parent !== undefined || q.library !== undefined) {
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
    // library items carry their custom-column values (same as listings)
    let metadata: Record<string, string | null> | undefined;
    if (item.library_id) {
      const meta = await dbq<{ column_id: string; value: string | null }>(
        "SELECT column_id, value FROM item_metadata WHERE item_id = $1", [item.id]);
      metadata = {};
      for (const m of meta) metadata[m.column_id] = m.value === null ? null : (decryptField(m.value) ?? m.value);
    }
    return { item: { ...(await toDriveItem(item, (await permissionFor(user.id, item)) ?? undefined,
      { metadata, approver: await canApprove(user, item) })), ownerName: owner[0]?.display_name } };
  });

  app.post("/api/drive", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const body = createSchema.parse(req.body);
    const id = randomUUID();

    // library derivation: explicit libraryId at a library root, else inherit
    // the parent folder's library — requires site 'member' (editor) either way
    let libraryId: string | null = null;
    if (body.parentId) {
      const parent = await getItem(body.parentId);
      if (!parent || parent.kind !== "folder" || !hasPermission(await permissionFor(user.id, parent), "editor")) {
        return reply.code(403).send({ error: "forbidden", message: "Cannot create in this folder" });
      }
      libraryId = parent.library_id;
    }
    if (!libraryId && body.libraryId) libraryId = body.libraryId;
    if (libraryId && !(await canWriteLibrary(user, libraryId))) {
      return reply.code(403).send({ error: "forbidden", message: "No write access to this library" });
    }

    // content type validation (SharePoint schema enforcement)
    let contentTypeId: string | null = null;
    let templateBlobKey: string | null = null;
    if (body.contentTypeId) {
      const ct = await one<{
        id: string; site_id: string; library_id: string | null; allowed_kinds: unknown;
        template_blob_key: string | null; doc_set: boolean;
      }>("SELECT * FROM content_types WHERE id = $1", [body.contentTypeId]);
      if (!ct) return reply.code(404).send({ error: "not_found", message: "Content type not found" });
      if (ct.doc_set) {
        // doc-set types stamp folders, not documents
        if (body.kind !== "folder") {
          return reply.code(400).send({ error: "bad_request", message: "Document set types apply to folders" });
        }
      } else {
        const allowed = Array.isArray(ct.allowed_kinds) ? (ct.allowed_kinds as string[]) : [];
        if (allowed.length && !allowed.includes(body.kind)) {
          return reply.code(400).send({ error: "bad_request", message: `Kind '${body.kind}' not allowed for this content type` });
        }
      }
      // site-scoped types are available across the site; library-scoped only within their library
      if (ct.library_id !== null && ct.library_id !== libraryId) {
        return reply.code(403).send({ error: "forbidden", message: "This content type is not available in this library" });
      }
      if (ct.site_id !== null) {
        const site = await getSite(ct.site_id);
        const role = site ? await siteRoleFor(user, site) : null;
        if (!role) return reply.code(403).send({ error: "forbidden", message: "Content type site not accessible" });
      }
      contentTypeId = ct.id;
      templateBlobKey = ct.template_blob_key;
    }

    await run(
      `INSERT INTO items (id, org_id, parent_id, owner_id, name, kind, mime, library_id, content_type_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, user.orgId, body.parentId ?? null, user.id, encryptField(body.name), body.kind,
       `application/x-kreatix-${body.kind}`, libraryId, contentTypeId, now(), now()],
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
    // content type template overrides the default doc
    if (templateBlobKey) {
      const buf = await getBlob(templateBlobKey);
      if (buf) {
        const size = buf.length;
        await run(
          "UPDATE versions SET blob_key = $1, size = $2 WHERE file_id = $3 AND number = 1",
          [templateBlobKey, size, id],
        );
        await run("UPDATE items SET size = $1 WHERE id = $2", [size, id]);
      }
    }

    // document-set inheritance: the new item picks up its parent set's
    // shared column values (SharePoint welcome-page columns)
    if (body.parentId) await propagateSharedColumns(body.parentId, [id]);

    await logActivity(user.orgId, user.id, id, "create", body.name);
    return { item: await toDriveItem((await getItem(id))!, "owner") };
  });

  /** Binary upload (PDFs, office files, media): raw body + ?name=&parent= */
  app.post("/api/drive/upload", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { name, parent, kind, mediaFor, library } = req.query as { name?: string; parent?: string; kind?: string; mediaFor?: string; library?: string };
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
    // uploads honor folder permissions the same as item creation; a parent
    // inside a library stamps the upload with that library
    let libraryId: string | null = null;
    if (parent) {
      const p = await getItem(parent);
      if (!p || p.kind !== "folder" || !hasPermission(await permissionFor(user.id, p), "editor")) {
        return reply.code(403).send({ error: "forbidden", message: "Cannot upload into this folder" });
      }
      libraryId = p.library_id;
    }
    if (!libraryId && library) libraryId = library;
    if (libraryId && !(await canWriteLibrary(user, libraryId))) {
      return reply.code(403).send({ error: "forbidden", message: "No write access to this library" });
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
      `INSERT INTO items (id, org_id, parent_id, owner_id, name, kind, mime, size, media_for, library_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, user.orgId, parent || null, user.id, encryptField(name ?? "Untitled"), fileKind,
       (req.headers["content-type"] as string) ?? "application/octet-stream", size, mediaForId, libraryId, now(), now()],
    );
    await run(
      "INSERT INTO versions (id, file_id, number, major, minor, published, label, blob_key, size, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [randomUUID(), id, 1, 1, 0, true, "Initial upload", key, size, user.id, now()],
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
    if (writeLocked(item, user.id)) {
      return reply.code(423).send({ error: "locked", message: "Checked out by someone else" });
    }
    const body = patchSchema.parse(req.body);
    // moving = parent change or explicit library root target
    const moving = body.parentId !== undefined || body.libraryId !== undefined;
    let newLibraryId: string | null | undefined; // undefined = unchanged
    if (moving) {
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
        newLibraryId = parent.library_id;
      } else if (body.libraryId) {
        newLibraryId = body.libraryId;
      } else {
        newLibraryId = null; // explicit parentId:null → personal Drive root
      }
      if (newLibraryId !== (item.library_id ?? null)) {
        // leaving a library = removing it from the shared space — owner-level
        // only (item owner or site owner), not just any editor
        if (item.library_id && !hasPermission(await permissionFor(user.id, item), "owner")) {
          return reply.code(403).send({ error: "forbidden", message: "Only the owner can move files out of a library" });
        }
        // entering a library requires member+ on its site
        if (newLibraryId && !(await canWriteLibrary(user, newLibraryId))) {
          return reply.code(403).send({ error: "forbidden", message: "No write access to that library" });
        }
      }
    }
    // a move always rewrites parent_id (library root moves mean parent null)
    const parentVal = body.parentId ?? null;
    await run(
      `UPDATE items SET name = COALESCE($1, name), starred = COALESCE($2, starred),
       label = COALESCE($3, label),
       parent_id = CASE WHEN $4 THEN $5 ELSE parent_id END, updated_at = $6 WHERE id = $7`,
      [
        body.name === undefined ? null : encryptField(body.name),
        body.starred === undefined ? null : body.starred,
        body.label ?? null,
        moving, parentVal, now(), item.id,
      ],
    );
    // reparent the whole subtree's library stamp when a folder changes libraries
    if (moving && newLibraryId !== undefined && newLibraryId !== (item.library_id ?? null)) {
      await run(
        `WITH RECURSIVE sub AS (
           SELECT id FROM items WHERE id = $1
           UNION ALL SELECT i.id FROM items i JOIN sub s ON i.parent_id = s.id)
         UPDATE items SET library_id = $2 WHERE id IN (SELECT id FROM sub)`,
        [item.id, newLibraryId],
      );
    }
    // moved into a document set → the moved subtree inherits its shared values
    if (moving && body.parentId) {
      await propagateSharedColumns(body.parentId, [item.id, ...(await subtreeIds(item.id))]);
    }
    if (body.label) void logActivity(user.orgId, user.id, item.id, "label", body.label);
    return { item: await toDriveItem((await getItem(item.id))!, (await permissionFor(user.id, item)) ?? undefined) };
  });

  app.delete("/api/drive/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    // owner rank = item owner or site owner (libraries) — shares can't grant it
    if (!item || !hasPermission(await permissionFor(user.id, item), "owner")) {
      return reply.code(403).send({ error: "forbidden", message: "Only the owner can delete" });
    }
    if (writeLocked(item, user.id)) {
      return reply.code(423).send({ error: "locked", message: "Checked out by someone else" });
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
    if (!item || !hasPermission(await permissionFor(user.id, item), "owner")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    await run("UPDATE items SET trashed = false, updated_at = $1 WHERE id = $2", [now(), item.id]);
    return { item: await toDriveItem((await getItem(item.id))!, "owner") };
  });

  // ---- check-in / check-out (library document management) ----

  /** Exclusive editing lock. Owner rank can re-take a stale lock via force. */
  app.post("/api/drive/:id/checkout", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || item.kind === "folder" || !hasPermission(await permissionFor(user.id, item), "editor")) {
      return reply.code(403).send({ error: "forbidden", message: "No edit access" });
    }
    if (!(await entitled(user.orgId, "docmgmt"))) {
      return reply.code(402).send({ error: "plan_limit", message: "Check-in/check-out requires a paid plan" });
    }
    if (item.checked_out_by && item.checked_out_by !== user.id) {
      const holder = await one<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [item.checked_out_by]);
      return reply.code(409).send({
        error: "checked_out",
        message: `Checked out by ${holder?.display_name ?? "someone else"}`,
      });
    }
    await run("UPDATE items SET checked_out_by = $1, checked_out_at = $2 WHERE id = $3",
      [user.id, now(), item.id]);
    void logActivity(user.orgId, user.id, item.id, "checkout", itemName(item));
    return { ok: true };
  });

  /** Release the lock. `publish:true` promotes the head draft to the next
   *  major version; otherwise the latest draft stays a draft. Blocks when
   *  required library columns are unset (SharePoint required-field gate). */
  app.post("/api/drive/:id/checkin", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(await permissionFor(user.id, item), "editor")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    if (!item.checked_out_by) return reply.code(409).send({ error: "conflict", message: "Not checked out" });
    // only the lock holder — or owner-rank override — can check in
    if (item.checked_out_by !== user.id && !hasPermission(await permissionFor(user.id, item), "owner")) {
      return reply.code(403).send({ error: "forbidden", message: "Checked out by someone else" });
    }
    const body = z.object({
      comment: z.string().max(300).optional(),
      publish: z.boolean().default(false),
    }).parse(req.body ?? {});

    // required custom columns must be filled before check-in — the library's
    // global required set, plus columns the item's content type marks required
    if (item.library_id) {
      const missing = await dbq<{ name: string }>(
        `SELECT c.name FROM library_columns c
         WHERE c.library_id = $1 AND (
           c.required
           OR EXISTS (SELECT 1 FROM content_type_columns b
                      WHERE b.column_id = c.id AND b.required AND b.content_type_id = $3)
         )
           AND NOT EXISTS (SELECT 1 FROM item_metadata m
             WHERE m.column_id = c.id AND m.item_id = $2 AND m.value IS NOT NULL AND m.value <> '')`,
        [item.library_id, item.id, item.content_type_id],
      );
      if (missing.length) {
        return reply.code(409).send({
          error: "required_metadata",
          message: `Required: ${missing.map((m) => decryptField(m.name) ?? m.name).join(", ")}`,
        });
      }
    }

    if (body.comment) {
      await run(
        "UPDATE versions SET label = $1 WHERE file_id = $2 AND number = (SELECT MAX(number) FROM versions WHERE file_id = $2)",
        [body.comment, item.id],
      );
    }
    let major: number | null = null;
    let pending = false;
    if (body.publish) {
      if (await submitForApproval(item, user)) {
        pending = true;
      } else {
        major = await publishHead(item);
      }
    }
    await run("UPDATE items SET checked_out_by = NULL, checked_out_at = NULL, updated_at = $1 WHERE id = $2",
      [now(), item.id]);
    void logActivity(user.orgId, user.id, item.id, pending ? "submit-approval" : "checkin",
      `${itemName(item)}${major !== null ? ` → v${major}.0` : ""}${body.comment ? ` — ${body.comment}` : ""}`);
    return { ok: true, published: major !== null, pending };
  });

  /** Abandon the lock without publishing. Holder or owner-rank. */
  app.post("/api/drive/:id/checkout/discard", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(await permissionFor(user.id, item), "editor")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    if (!item.checked_out_by) return { ok: true };
    if (item.checked_out_by !== user.id && !hasPermission(await permissionFor(user.id, item), "owner")) {
      return reply.code(403).send({ error: "forbidden", message: "Checked out by someone else" });
    }
    await run("UPDATE items SET checked_out_by = NULL, checked_out_at = NULL WHERE id = $1", [item.id]);
    void logActivity(user.orgId, user.id, item.id, "checkout-discard", itemName(item));
    return { ok: true };
  });

  /** Set custom-column values on a library item: { values: {columnId: value|null} } */
  app.patch("/api/drive/:id/metadata", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(await permissionFor(user.id, item), "editor")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    if (!item.library_id) return reply.code(400).send({ error: "bad_request", message: "Not a library item" });
    if (writeLocked(item, user.id)) {
      return reply.code(423).send({ error: "locked", message: "Checked out by someone else" });
    }
    const { values } = z.object({ values: z.record(z.string(), z.string().nullable()) }).parse(req.body);
    const cols = await dbq<{ id: string; type: string; choices: unknown; term_set_id: string | null }>(
      "SELECT id, type, choices, term_set_id FROM library_columns WHERE library_id = $1", [item.library_id]);
    const colById = new Map(cols.map((c) => [c.id, c]));
    for (const [cid, raw] of Object.entries(values)) {
      const col = colById.get(cid);
      if (!col) return reply.code(400).send({ error: "bad_request", message: `Unknown column ${cid}` });
      if (raw === null || raw === "") {
        await run("DELETE FROM item_metadata WHERE item_id = $1 AND column_id = $2", [item.id, cid]);
        continue;
      }
      const v = String(raw).slice(0, 500);
      // light type validation
      if (col.type === "number" && Number.isNaN(Number(v))) {
        return reply.code(400).send({ error: "bad_request", message: "Expected a number" });
      }
      if (col.type === "yesno" && !["yes", "no"].includes(v.toLowerCase())) {
        return reply.code(400).send({ error: "bad_request", message: "Expected yes or no" });
      }
      if (col.type === "choice" && Array.isArray(col.choices) && !(col.choices as string[]).includes(v)) {
        return reply.code(400).send({ error: "bad_request", message: "Value is not an allowed choice" });
      }
      // managed metadata: the value must be a term in the bound term set
      if (col.type === "managed" && col.term_set_id) {
        const names = (await dbq<{ name: string }>(
          "SELECT name FROM terms WHERE set_id = $1", [col.term_set_id]))
          .map((t) => decryptField(t.name) ?? t.name);
        if (!names.includes(v)) {
          return reply.code(400).send({ error: "bad_request", message: "Value is not a term in the bound set" });
        }
      }
      await run(
        `INSERT INTO item_metadata (item_id, column_id, value) VALUES ($1,$2,$3)
         ON CONFLICT (item_id, column_id) DO UPDATE SET value = excluded.value`,
        [item.id, cid, encryptField(v)],
      );
    }
    // editing a document set pushes its shared columns down to the contents
    if (item.kind === "folder" && item.content_type_id) {
      await propagateSharedColumns(item.id, await subtreeIds(item.id));
    }
    await touchItem(item.id);
    return { ok: true };
  });

  // ---- content approval (SharePoint "Approve/reject") ----

  /** Approve a submitted draft — publishes it as the next major version.
   *  Approvers are site owners in libraries (not the file's creator). */
  app.post("/api/drive/:id/approve", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || !(await canApprove(user, item))) {
      return reply.code(403).send({ error: "forbidden", message: "Only site owners can approve" });
    }
    const head = await one<{ id: string; pending: boolean; published: boolean }>(
      "SELECT id, pending, published FROM versions WHERE file_id = $1 ORDER BY number DESC LIMIT 1", [item.id]);
    if (!head?.pending) return reply.code(409).send({ error: "conflict", message: "Nothing awaiting approval" });
    const major = await publishHead(item);
    void logActivity(user.orgId, user.id, item.id, "approve", `${itemName(item)} → v${major}.0`);
    return { ok: true, major };
  });

  /** Reject a submitted draft — clears the pending flag; the draft stays a
   *  draft for the editor to revise. Owner rank only. */
  app.post("/api/drive/:id/reject", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || !(await canApprove(user, item))) {
      return reply.code(403).send({ error: "forbidden", message: "Only site owners can reject" });
    }
    const { comment } = z.object({ comment: z.string().max(300).optional() }).parse(req.body ?? {});
    const head = await one<{ id: string; pending: boolean }>(
      "SELECT id, pending FROM versions WHERE file_id = $1 ORDER BY number DESC LIMIT 1", [item.id]);
    if (!head?.pending) return reply.code(409).send({ error: "conflict", message: "Nothing awaiting approval" });
    await run("UPDATE versions SET pending = false WHERE id = $1", [head.id]);
    void logActivity(user.orgId, user.id, item.id, "reject",
      `${itemName(item)}${comment ? ` — ${comment}` : ""}`);
    return { ok: true };
  });

  // ---- copy (SharePoint "Copy to") ----

  /**
   * Deep-copy an item (folders recurse) into a folder, a library root, or the
   * personal Drive root. Copies reference the same immutable blobs — no data
   * is duplicated. Fresh version history starts at 1.0, shares/comments/
   * check-out are not carried (the copy inherits destination permissions).
   */
  app.post("/api/drive/:id/copy", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    const srcPerm = item ? await permissionFor(user.id, item) : null;
    if (!item || !hasPermission(srcPerm, "viewer")) {
      return reply.code(404).send({ error: "not_found", message: "File not found" });
    }
    // viewer-level copiers get the latest PUBLISHED version — unpublished
    // drafts stay invisible to them even inside a copy they own
    const headClause = hasPermission(srcPerm, "editor") ? "" : "AND published";
    if (item.media_for) {
      return reply.code(400).send({ error: "bad_request", message: "Embedded media can't be copied" });
    }
    const body = z.object({
      parentId: z.string().nullable().optional(),
      libraryId: z.string().nullable().optional(),
      name: z.string().min(1).max(255).optional(),
    }).parse(req.body ?? {});

    // resolve the destination: folder → its library stamps the copy;
    // library root → member+ required; neither → personal Drive root
    let targetParent: string | null = null;
    let targetLibrary: string | null = null;
    if (body.parentId) {
      const parent = await getItem(body.parentId);
      if (!parent || parent.kind !== "folder" || !hasPermission(await permissionFor(user.id, parent), "editor")) {
        return reply.code(403).send({ error: "forbidden", message: "Cannot copy into this folder" });
      }
      targetParent = parent.id;
      targetLibrary = parent.library_id;
    } else if (body.libraryId) {
      if (!(await canWriteLibrary(user, body.libraryId))) {
        return reply.code(403).send({ error: "forbidden", message: "No write access to that library" });
      }
      targetLibrary = body.libraryId;
    }

    const subtree = await dbq<ItemRow>(
      `WITH RECURSIVE sub AS (
         SELECT * FROM items WHERE id = $1
         UNION ALL SELECT i.* FROM items i JOIN sub s ON i.parent_id = s.id)
       SELECT * FROM sub WHERE media_for IS NULL`,
      [item.id],
    );
    if (subtree.length > 500) {
      return reply.code(400).send({ error: "bad_request", message: "Folder is too large to copy" });
    }

    const ids = new Map(subtree.map((r) => [r.id, randomUUID()]));
    const ts = now();
    await tx(async (c) => {
      for (const r of subtree) {
        const newId = ids.get(r.id)!;
        const newParent = r.id === item.id ? targetParent : (r.parent_id ? ids.get(r.parent_id) ?? null : null);
        const head = await c.query<{ id: string; blob_key: string; size: number }>(
          `SELECT id, blob_key, size FROM versions WHERE file_id = $1 ${headClause} ORDER BY number DESC LIMIT 1`, [r.id]);
        await c.query(
          `INSERT INTO items (id, org_id, parent_id, owner_id, name, kind, mime, size, library_id, content_type_id, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [newId, user.orgId, newParent, user.id,
           // names store encrypted — reuse the ciphertext verbatim unless renamed
           r.id === item.id && body.name ? encryptField(body.name) : r.name,
           r.kind, r.mime, head.rows[0]?.size ?? r.size, targetLibrary,
           // content type copies within the same library; cross-library copies reset to null
           targetLibrary && targetLibrary === r.library_id ? r.content_type_id : null,
           ts, ts],
        );
        if (head.rows[0]) {
          await c.query(
            `INSERT INTO versions (id, file_id, number, major, minor, published, label, blob_key, size, created_by, created_at)
             VALUES ($1,$2,1,1,0,true,$3,$4,$5,$6,$7)`,
            [randomUUID(), newId, `Copied from ${itemName(r)}`, head.rows[0].blob_key, head.rows[0].size, user.id, ts],
          );
        }
        // custom-column values carry over only within the same library —
        // column ids are per-library, so cross-library copies start clean
        if (targetLibrary && targetLibrary === r.library_id) {
          await c.query(
            `INSERT INTO item_metadata (item_id, column_id, value)
             SELECT $1, column_id, value FROM item_metadata WHERE item_id = $2`,
            [newId, r.id],
          );
        }
        // index rows re-key verbatim — same org key, so ciphertext ports;
        // skipped for viewer copiers since the index may hold draft text
        if (headClause === "") {
          await c.query(
            `INSERT INTO search_index (file_id, body) SELECT $1, body FROM search_index WHERE file_id = $2
             ON CONFLICT (file_id) DO NOTHING`,
            [newId, r.id],
          );
        }
      }
    });
    void logActivity(user.orgId, user.id, ids.get(item.id)!, "copy", itemName(item));
    return { item: await toDriveItem((await getItem(ids.get(item.id)!))!, "owner") };
  });
}

const SITE_RANK: Record<string, number> = { visitor: 1, member: 2, owner: 3 };
const atLeastRank = (role: string | null, need: string) => role !== null && (SITE_RANK[role] ?? 0) >= SITE_RANK[need];

/** Library-level editor rank required to write into a library — resolves
 *  site roles and broken-inheritance grants alike. */
async function canWriteLibrary(user: { id: string; orgId: string; role: string }, libraryId: string): Promise<boolean> {
  return hasPermission(await libraryPermission(user.id, libraryId), "editor");
}

/** Document-set shared columns: copy the set's values for its type's 'shared'
 *  bound columns into each child item (SharePoint shared columns). Values are
 *  stored field-encrypted, so ciphertext ports verbatim within the org. */
async function propagateSharedColumns(setItemId: string, childIds: string[]): Promise<void> {
  if (!childIds.length) return;
  const set = await getItem(setItemId);
  if (!set?.content_type_id) return;
  const sharedCols = await dbq<{ column_id: string }>(
    "SELECT column_id FROM content_type_columns WHERE content_type_id = $1 AND shared",
    [set.content_type_id],
  );
  if (!sharedCols.length) return;
  const vals = await dbq<{ column_id: string; value: string }>(
    `SELECT column_id, value FROM item_metadata
     WHERE item_id = $1 AND column_id = ANY($2) AND value IS NOT NULL`,
    [setItemId, sharedCols.map((c) => c.column_id)],
  );
  if (!vals.length) return;
  for (const cid of childIds) {
    for (const v of vals) {
      await run(
        `INSERT INTO item_metadata (item_id, column_id, value) VALUES ($1,$2,$3)
         ON CONFLICT (item_id, column_id) DO UPDATE SET value = excluded.value`,
        [cid, v.column_id, v.value],
      );
    }
  }
}

/** All item ids in a doc set's subtree (descendants only). */
async function subtreeIds(rootId: string): Promise<string[]> {
  const rows = await dbq<{ id: string }>(
    `WITH RECURSIVE sub AS (
       SELECT id FROM items WHERE parent_id = $1
       UNION ALL SELECT i.id FROM items i JOIN sub s ON i.parent_id = s.id)
     SELECT id FROM sub`,
    [rootId],
  );
  return rows.map((r) => r.id);
}

/** Approver rank — in a library that's owner rank on the LIBRARY (site owner
 *  or an explicit 'owner' grant on a non-inheriting library); a member who
 *  created a file can't approve their own submission. Outside libraries it
 *  falls back to item ownership. */
async function canApprove(user: { id: string; orgId: string; role: string }, item: ItemRow): Promise<boolean> {
  if (item.library_id) {
    return (await libraryPermission(user.id, item.library_id)) === "owner";
  }
  return hasPermission(await permissionFor(user.id, item), "owner");
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
