import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { q, one, run, now } from "../db.js";
import { getItem, touchItem, logActivity, itemName } from "../items.js";
import { requireAuth, permissionFor, hasPermission, type AuthedRequest } from "../auth.js";
import { putBlob, getBlob } from "../blobs.js";
import { indexFile } from "../indexer.js";

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

function headVersion(fileId: string): Promise<VersionRow | undefined> {
  return one<VersionRow>("SELECT * FROM versions WHERE file_id = $1 ORDER BY number DESC LIMIT 1", [fileId]);
}

/** MIME types that must never execute in an origin-bearing context. */
const SCRIPTABLE = /^(text\/html|image\/svg\+xml|application\/xhtml\+xml|text\/xml|application\/xml)/i;

/**
 * Stream raw binary content. Scriptable types are served inside a CSP sandbox
 * and as attachments so stored HTML/SVG can't run scripts on the app origin.
 */
export function sendRawBlob(
  reply: import("fastify").FastifyReply,
  mime: string,
  blob: Buffer,
  filename = "file",
) {
  reply.header("content-type", mime).header("content-length", blob.length);
  if (SCRIPTABLE.test(mime)) {
    reply
      .header("content-security-policy", "sandbox")
      .header("content-disposition", contentDisposition(filename));
  }
  return reply.send(blob);
}

/** RFC 5987 content-disposition — ASCII fallback + UTF-8 filename* for
 *  names with non-ASCII characters, control chars stripped. */
function contentDisposition(filename: string): string {
  const clean = filename.replace(/[\r\n"\\]/g, "_");
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_") || "file";
  const enc = encodeURIComponent(clean);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${enc}`;
}

export function contentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /** GET current file content (head version blob) */
  app.get("/api/files/:id/content", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(await permissionFor(user.id, item), "viewer")) {
      return reply.code(404).send({ error: "not_found", message: "File not found" });
    }
    // PDF files interleave two version kinds: raw %PDF bytes (uploads + page
    // re-organizations) and {kind:"pdf"} annotation JSON. Head may be either —
    // for pdf items return the latest JSON version (anns), not raw bytes.
    if (item.kind === "pdf") {
      const rows = await q<VersionRow>(
        "SELECT * FROM versions WHERE file_id = $1 ORDER BY number DESC LIMIT 25", [item.id]);
      for (const row of rows) {
        const b = getBlob(row.blob_key);
        if (!b || b[0] !== 0x7b) continue;
        try {
          const parsed = JSON.parse(b.toString("utf8"));
          if (parsed?.kind === "pdf") return { version: row.number, content: parsed };
        } catch { /* not json — keep scanning */ }
      }
    }

    const v = await headVersion(item.id);
    if (!v) return reply.code(404).send({ error: "not_found", message: "No content" });
    const blob = getBlob(v.blob_key);
    if (!blob) return reply.code(404).send({ error: "not_found", message: "Blob missing" });

    if (item.mime.startsWith("application/x-kreatix-")) {
      return { version: v.number, content: JSON.parse(blob.toString("utf8")) };
    }
    return sendRawBlob(reply, item.mime, blob, itemName(item));
  });

  /** GET the PDF bytes — the LATEST version whose blob is a real PDF (page
   *  organization pushes new raw versions; annotation JSON versions are skipped). */
  app.get("/api/files/:id/raw", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(await permissionFor(user.id, item), "viewer")) {
      return reply.code(404).send({ error: "not_found", message: "File not found" });
    }
    const rows = await q<VersionRow>(
      "SELECT * FROM versions WHERE file_id = $1 ORDER BY number DESC LIMIT 50", [item.id]);
    for (const v of rows) {
      const blob = getBlob(v.blob_key);
      if (blob && blob.subarray(0, 5).equals(Buffer.from("%PDF-")))
        return sendRawBlob(reply, item.mime, blob, itemName(item));
    }
    return reply.code(404).send({ error: "not_found", message: "No PDF bytes" });
  });

  /** PUT new PDF bytes (page-organization output) — stores an immutable raw
   *  version that /raw will serve; the annotation JSON stays the head content. */
  app.put("/api/files/:id/pdf-bytes", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(await permissionFor(user.id, item), "editor")) {
      return reply.code(403).send({ error: "forbidden", message: "No edit access" });
    }
    let buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf) {
      const chunks: Buffer[] = [];
      for await (const c of req.raw) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as ArrayBuffer));
      buf = Buffer.concat(chunks);
    }
    if (!buf.length || !buf.subarray(0, 5).equals(Buffer.from("%PDF-")))
      return reply.code(400).send({ error: "bad_request", message: "Expected PDF bytes" });
    const label = (req.query as { label?: string }).label?.slice(0, 120);
    const { key, size } = putBlob(buf);
    const next = ((await headVersion(item.id))?.number ?? 0) + 1;
    await run(
      "INSERT INTO versions (id, file_id, number, label, blob_key, size, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [randomUUID(), item.id, next, label ?? "Edited pages", key, size, user.id, now()],
    );
    await run("UPDATE items SET size = $1 WHERE id = $2", [size, item.id]);
    void touchItem(item.id);
    return { version: next };
  });

  /** GET a remote page's HTML for the web→PDF import (server-side fetch avoids
   *  browser CORS; response is returned as inert text — clients must parse it
   *  without injecting it into the DOM). Every hop is resolved and checked
   *  against private/reserved ranges — this endpoint must not be a proxy into
   *  the local network. */
  app.get("/api/fetch-html", async (req, reply) => {
    let url: URL;
    try {
      url = new URL(String((req.query as { url?: string }).url ?? ""));
    } catch {
      return reply.code(400).send({ error: "bad_request", message: "Invalid URL" });
    }
    try {
      const res = await fetchPublic(url, 3);
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("text/html"))
        return reply.code(415).send({ error: "unsupported", message: "URL did not return HTML" });
      // bounded read — stop the body stream at 4MB rather than buffering all
      const reader = res.body?.getReader();
      if (!reader) return reply.code(502).send({ error: "fetch_failed" });
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (total > 4_000_000) { void reader.cancel(); break; }
      }
      const html = new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c)))).slice(0, 2_000_000);
      return { url: res.url, html };
    } catch (e) {
      if (e instanceof PrivateAddressError)
        return reply.code(403).send({ error: "blocked", message: "That URL is not allowed" });
      return reply.code(502).send({ error: "fetch_failed", message: "Could not fetch that URL" });
    }
  });

  /** PUT new content — creates an immutable version (autosave calls this, debounced client-side) */
  app.put("/api/files/:id/content", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(await permissionFor(user.id, item), "reviewer")) {
      return reply.code(403).send({ error: "forbidden", message: "No edit access" });
    }
    const body = z
      .object({ content: z.unknown(), label: z.string().max(120).optional() })
      .parse(req.body);
    // Writes from outside a live collab session invalidate the persisted CRDT
    // state — the next session re-seeds from this canonical JSON.
    if ((req.query as { collab?: string }).collab !== "1") {
      await run("DELETE FROM collab_states WHERE file_id = $1", [item.id]);
    }
    const data = Buffer.from(JSON.stringify(body.content));
    const { key, size } = putBlob(data);
    const next = ((await headVersion(item.id))?.number ?? 0) + 1;

    await run(
      "INSERT INTO versions (id, file_id, number, label, blob_key, size, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [randomUUID(), item.id, next, body.label ?? null, key, size, user.id, now()],
    );
    await run("UPDATE items SET size = $1 WHERE id = $2", [size, item.id]);
    // An uploaded native file (docx/xlsx/pptx) keeps its office mime until the
    // first canonical-JSON save — then it becomes a kreatix doc so opens stop
    // re-importing the original binary (which would clobber edits).
    if (["writer", "sheets", "present"].includes(item.kind) && !item.mime.startsWith("application/x-kreatix-")) {
      await run("UPDATE items SET mime = $2 WHERE id = $1", [item.id, `application/x-kreatix-${item.kind}`]);
    }
    void indexFile(item.id, item.kind, body.content).catch(() => { /* best-effort */ });
    void touchItem(item.id);
    return { version: next };
  });

  app.get("/api/files/:id/versions", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(await permissionFor(user.id, item), "viewer")) {
      return reply.code(404).send({ error: "not_found" });
    }
    const rows = await q<VersionRow & { display_name: string; initials: string }>(
      `SELECT v.*, u.display_name, u.initials FROM versions v JOIN users u ON u.id = v.created_by
       WHERE v.file_id = $1 ORDER BY v.number DESC`,
      [item.id],
    );
    return {
      versions: rows.map((v) => ({
        id: v.id, fileId: v.file_id, number: v.number, label: v.label,
        size: v.size, createdBy: v.display_name, createdAt: v.created_at,
      })),
    };
  });

  /** Rename a version's label (named versions). */
  app.patch("/api/files/:id/versions/:n", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { id, n } = req.params as { id: string; n: string };
    const item = await getItem(id);
    if (!item || !hasPermission(await permissionFor(user.id, item), "editor")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const { label } = z.object({ label: z.string().max(120).nullable() }).parse(req.body);
    const vn = Number(n);
    if (!Number.isInteger(vn) || vn < 1) return reply.code(400).send({ error: "bad_request" });
    const res = await run(
      "UPDATE versions SET label = $1 WHERE file_id = $2 AND number = $3",
      [label || null, item.id, vn],
    );
    if (!(res as { rowCount?: number }).rowCount) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });

  app.get("/api/files/:id/versions/:n/content", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { id, n } = req.params as { id: string; n: string };
    const item = await getItem(id);
    if (!item || !hasPermission(await permissionFor(user.id, item), "viewer")) {
      return reply.code(404).send({ error: "not_found" });
    }
    const vn = Number(n);
    if (!Number.isInteger(vn) || vn < 1) return reply.code(400).send({ error: "bad_request" });
    const v = await one<VersionRow>(
      "SELECT * FROM versions WHERE file_id = $1 AND number = $2",
      [item.id, vn],
    );
    const blob = v && getBlob(v.blob_key);
    if (!v || !blob) return reply.code(404).send({ error: "not_found" });
    try {
      return { version: v.number, content: JSON.parse(blob.toString("utf8")) };
    } catch {
      // binary version (e.g. the original PDF upload) — stream it raw
      return sendRawBlob(reply, item.mime, blob, itemName(item));
    }
  });

  /** Restore an older version — implemented as a new head version copying the old blob (SRS §19) */
  app.post("/api/files/:id/versions/:n/restore", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { id, n } = req.params as { id: string; n: string };
    const item = await getItem(id);
    if (!item || !hasPermission(await permissionFor(user.id, item), "editor")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const vn = Number(n);
    if (!Number.isInteger(vn) || vn < 1) return reply.code(400).send({ error: "bad_request" });
    const v = await one<VersionRow>(
      "SELECT * FROM versions WHERE file_id = $1 AND number = $2",
      [item.id, vn],
    );
    if (!v) return reply.code(404).send({ error: "not_found" });
    // restored content is canonical — clear live CRDT state so it re-seeds
    await run("DELETE FROM collab_states WHERE file_id = $1", [item.id]);
    const next = ((await headVersion(item.id))?.number ?? 0) + 1;
    await run(
      "INSERT INTO versions (id, file_id, number, label, blob_key, size, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [randomUUID(), item.id, next, `Restored from v${v.number}`, v.blob_key, v.size, user.id, now()],
    );
    void touchItem(item.id);
    void logActivity(user.orgId, user.id, item.id, "restore-version", `v${v.number} → v${next}`);
    return { version: next };
  });
}

// ---- outbound fetch guard (SSRF) ----

class PrivateAddressError extends Error {}

/** Reject private/loopback/link-local/reserved destinations. */
function isPrivateAddress(addr: string): boolean {
  const v6 = addr.includes(":");
  if (!v6) {
    const p = addr.split(".").map(Number);
    const [a, b] = p;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)   // CGNAT
      || a >= 224;                            // multicast + reserved + broadcast
  }
  const norm = addr.toLowerCase();
  if (norm === "::" || norm === "::1") return true;
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(norm);
  if (v4mapped) return isPrivateAddress(v4mapped[1]);
  return norm.startsWith("fc") || norm.startsWith("fd") // ULA fc00::/7
    || norm.startsWith("fe8") || norm.startsWith("fe9") // link-local fe80::/10
    || norm.startsWith("fea") || norm.startsWith("feb")
    || norm.startsWith("ff");                            // multicast ff00::/8
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new PrivateAddressError("http(s) only");
  if (isIP(url.hostname)) {
    if (isPrivateAddress(url.hostname)) throw new PrivateAddressError(url.hostname);
    return;
  }
  const addrs = await lookup(url.hostname, { all: true }).catch(() => [] as { address: string }[]);
  if (!addrs.length) throw new PrivateAddressError(`unresolvable host ${url.hostname}`);
  // every resolved record must be public — one private A record is enough
  // for the connection to land inside the network
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) throw new PrivateAddressError(`${url.hostname} → ${address}`);
  }
}

/** fetch() that validates every redirect hop's resolved IP — no following
 *  redirects into private space. */
async function fetchPublic(url: URL, maxRedirects: number): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(12000) });
    if (![301, 302, 303, 307, 308].includes(res.status) || hop >= maxRedirects) return res;
    const loc = res.headers.get("location");
    if (!loc) return res;
    try { current = new URL(loc, current); } catch { return res; }
    void res.body?.cancel();
  }
}
