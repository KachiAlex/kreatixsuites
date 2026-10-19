import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { q, one, run, now } from "../db.js";
import { getItem, touchItem, logActivity, itemName, writeLocked, type ItemRow } from "../items.js";
import { getLibrary, libraryPermission } from "../sites.js";
import { requestApproval } from "../approvals.js";
import { encryptField } from "../crypto.js";
import { requireAuth, permissionFor, hasPermission, type AuthedRequest } from "../auth.js";
import { storageQuota } from "../billing.js";
import { putBlob, getBlob } from "../blobs.js";
import { indexFile } from "../indexer.js";
import { getPolicies, dlpScanText, scanDlp, watermarkIfNeeded, WATERMARK_HEADER } from "../policies.js";

interface VersionRow {
  id: string;
  file_id: string;
  number: number;
  major: number | null;
  minor: number;
  published: boolean;
  pending: boolean;
  label: string | null;
  blob_key: string;
  size: number;
  created_by: string;
  created_at: string;
}

/** LCS line diff → list of hunks. Each hunk: {type: "same"|"add"|"del",
 *  lines: string[]}. Runs of identical lines collapse into "same" hunks
 *  capped at 3 context lines on each side. */
export function diffLines(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  const n = A.length, m = B.length;
  // LCS table (row-major, (n+1)×(m+1)) — fine for document-scale inputs
  const L = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i * (m + 1) + j] = A[i] === B[j]
        ? L[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
  const ops: { t: "same" | "add" | "del"; s: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ t: "same", s: A[i++] }); j++; }
    else if (L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1]) ops.push({ t: "del", s: A[i++] });
    else ops.push({ t: "add", s: B[j++] });
  }
  while (i < n) ops.push({ t: "del", s: A[i++] });
  while (j < m) ops.push({ t: "add", s: B[j++] });
  // collapse long "same" runs: keep ≤3 context lines, emit skip markers
  const hunks: { type: string; lines: string[]; skipped?: number }[] = [];
  let run: { t: string; s: string }[] = [];
  const flush = () => {
    if (!run.length) return;
    for (const o of run) {
      const last = hunks[hunks.length - 1];
      if (last && last.type === o.t) last.lines.push(o.s);
      else hunks.push({ type: o.t, lines: [o.s] });
    }
    run = [];
  };
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].t === "same") {
      // look ahead: is this same-run > 6 lines? keep only edges
      let len = 0;
      while (ops[k + len]?.t === "same") len++;
      if (len > 6) {
        for (let c = 0; c < 3; c++) run.push(ops[k++]);
        flush();
        hunks.push({ type: "skip", lines: [], skipped: len - 6 });
        k += len - 7; // outer k++ lands on the first of the last 3 context lines
        continue;
      }
    }
    run.push(ops[k]);
  }
  flush();
  return hunks;
}

function headVersion(fileId: string): Promise<VersionRow | undefined> {
  return one<VersionRow>("SELECT * FROM versions WHERE file_id = $1 ORDER BY number DESC LIMIT 1", [fileId]);
}

/** True when the item uses draft (minor) versioning — libraries set to
 *  'minor' mode, or any item currently checked out. */
export async function minorVersioning(item: ItemRow): Promise<boolean> {
  if (item.checked_out_by) return true;
  if (!item.library_id) return false;
  const lib = await getLibrary(item.library_id);
  return lib?.versioning === "minor";
}

/** Compute the major/minor/published stamp for the next version row.
 *  Major mode: every save → next major, published (legacy behavior).
 *  Minor mode: saves stack minor drafts under the current published major;
 *  drafts before any publish live at major 0 (SharePoint's 0.x). */
async function versionStamp(item: ItemRow): Promise<{ major: number; minor: number; published: boolean }> {
  const head = await headVersion(item.id);
  if (!(await minorVersioning(item))) {
    return { major: (head?.major ?? head?.number ?? 0) + 1, minor: 0, published: true };
  }
  if (head && !head.published) return { major: head.major ?? 0, minor: head.minor + 1, published: false };
  const lastPub = await one<{ major: number }>(
    "SELECT major FROM versions WHERE file_id = $1 AND published ORDER BY number DESC LIMIT 1", [item.id]);
  return { major: lastPub?.major ?? 0, minor: 1, published: false };
}

/** Promote the head draft to the next published major — used by publish,
 *  approval, and major check-in. Returns the new {major} or null when
 *  nothing to publish. */
export async function publishHead(item: ItemRow): Promise<number | null> {
  const head = await headVersion(item.id);
  if (!head || head.published) return null;
  const lastPub = await one<{ major: number }>(
    "SELECT major FROM versions WHERE file_id = $1 AND published ORDER BY number DESC LIMIT 1", [item.id]);
  const major = (lastPub?.major ?? 0) + 1;
  await run("UPDATE versions SET major = $1, minor = 0, published = true, pending = false, pending_at = NULL, approval_step = NULL, approval_chain = NULL, approval_done = NULL WHERE id = $2",
    [major, head.id]);
  return major;
}

/** Content approval gate: when the item's library requires approval, anyone
 *  below owner rank on the library (including the file's creator) submits
 *  instead of publishing — only owner-rank users are approvers (SharePoint
 *  "Submit for approval"). Returns true when the request went to the queue. */
export async function submitForApproval(
  item: ItemRow,
  user: { id: string; orgId: string; role: string },
): Promise<boolean> {
  if (!item.library_id) return false;
  const lib = await getLibrary(item.library_id);
  if (!lib?.approval) return false;
  const perm = await libraryPermission(user.id, item.library_id);
  if (!perm || perm === "owner") return false;
  return requestApproval(item, user.id);
}

/** Tell the draft author their submission was decided (approve/reject). */
export async function notifySubmitter(
  item: ItemRow,
  submitterId: string,
  actorId: string,
  approved: boolean,
  comment?: string,
): Promise<void> {
  if (submitterId === actorId) return;
  const msg = encryptField(
    `"${itemName(item)}" was ${approved ? "approved and published" : "rejected"}` +
    (comment ? ` — ${comment}` : ""),
  );
  await run(
    `INSERT INTO notifications (id, user_id, kind, file_id, library_id, actor_id, message, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [randomUUID(), submitterId, "approval", item.id, item.library_id, actorId, msg, now()],
  );
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
    const perm = item ? await permissionFor(user.id, item) : null;
    if (!item || !hasPermission(perm, "viewer")) {
      return reply.code(404).send({ error: "not_found", message: "File not found" });
    }
    // readers see the latest PUBLISHED version — drafts stay invisible to
    // viewer-level access (SharePoint draft-visibility semantics)
    const onlyPublished = !hasPermission(perm, "editor") ? "AND v.published" : "";
    // PDF files interleave two version kinds: raw %PDF bytes (uploads + page
    // re-organizations) and {kind:"pdf"} annotation JSON. Head may be either —
    // for pdf items return the latest JSON version (anns), not raw bytes.
    if (item.kind === "pdf") {
      const rows = await q<VersionRow>(
        `SELECT * FROM versions v WHERE file_id = $1 ${onlyPublished} ORDER BY number DESC LIMIT 25`, [item.id]);
      for (const row of rows) {
        const b = await getBlob(row.blob_key);
        if (!b || b[0] !== 0x7b) continue;
        try {
          const parsed = JSON.parse(b.toString("utf8"));
          if (parsed?.kind === "pdf") return { version: row.number, content: parsed };
        } catch { /* not json — keep scanning */ }
      }
    }

    const v = onlyPublished
      ? await one<VersionRow>(
          "SELECT * FROM versions WHERE file_id = $1 AND published ORDER BY number DESC LIMIT 1", [item.id])
      : await headVersion(item.id);
    if (!v) return reply.code(404).send({ error: "not_found", message: "No published content" });
    const blob = await getBlob(v.blob_key);
    if (!blob) return reply.code(404).send({ error: "not_found", message: "Blob missing" });

    if (item.mime.startsWith("application/x-kreatix-")) {
      const policies = await getPolicies(item.org_id);
      const wm = watermarkIfNeeded(blob, item.mime, item.label ?? "internal", policies, user.email);
      if (wm.watermarked) reply.header(WATERMARK_HEADER, item.label);
      return { version: v.number, content: JSON.parse(blob.toString("utf8")), watermarked: wm.watermarked };
    }
    const policies = await getPolicies(item.org_id);
    const wm = watermarkIfNeeded(blob, item.mime, item.label ?? "internal", policies, user.email);
    if (wm.watermarked) reply.header(WATERMARK_HEADER, item.label);
    return sendRawBlob(reply, item.mime, wm.blob, itemName(item));
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
      const blob = await getBlob(v.blob_key);
      if (blob && blob.subarray(0, 5).equals(Buffer.from("%PDF-")))
        return sendRawBlob(reply, item.mime, blob, itemName(item));
    }
    return reply.code(404).send({ error: "not_found", message: "No PDF bytes" });
  });

  /** PUT new PDF bytes (page-organization output) — stores an immutable raw
   *  version that /raw will serve; the annotation JSON stays the head content. */
  app.put("/api/files/:id/pdf-bytes", { bodyLimit: 170 * 1024 * 1024 }, async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(await permissionFor(user.id, item), "editor")) {
      return reply.code(403).send({ error: "forbidden", message: "No edit access" });
    }
    if (writeLocked(item, user.id)) {
      return reply.code(423).send({ error: "locked", message: "Checked out by someone else" });
    }
    let buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf) {
      const chunks: Buffer[] = [];
      for await (const c of req.raw) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as ArrayBuffer));
      buf = Buffer.concat(chunks);
    }
    if (!buf.length || !buf.subarray(0, 5).equals(Buffer.from("%PDF-")))
      return reply.code(400).send({ error: "bad_request", message: "Expected PDF bytes" });
    const quota = await storageQuota(user.orgId, buf.length);
    if (!quota.ok) {
      return reply.code(413).send({ error: "storage_quota",
        message: `Workspace storage full (${Math.round(quota.limit / 1048576)}MB plan limit) — upgrade or free space` });
    }
    const label = (req.query as { label?: string }).label?.slice(0, 120);
    const { key, size } = await putBlob(buf);
    const next = ((await headVersion(item.id))?.number ?? 0) + 1;
    const stamp = await versionStamp(item);
    await run(
      "INSERT INTO versions (id, file_id, number, major, minor, published, label, blob_key, size, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [randomUUID(), item.id, next, stamp.major, stamp.minor, stamp.published, label ?? "Edited pages", key, size, user.id, now()],
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
    if (writeLocked(item, user.id)) {
      return reply.code(423).send({ error: "locked", message: "Checked out by someone else — changes are blocked until they check in" });
    }
    const body = z
      .object({ content: z.unknown(), label: z.string().max(120).optional() })
      .parse(req.body);
    // Writes from outside a live collab session invalidate the persisted CRDT
    // state — the next session re-seeds from this canonical JSON.
    if ((req.query as { collab?: string }).collab !== "1") {
      await run("DELETE FROM collab_states WHERE file_id = $1", [item.id]);
    }
    // DLP-lite — scan outgoing content against org patterns. "block" rejects
    // the save outright; "flag" stamps the item + audit row and lets it in.
    const policies = await getPolicies(user.orgId);
    if (policies.dlpOnSave !== "off") {
      const text = typeof body.content === "string" ? body.content : JSON.stringify(body.content);
      const hit = dlpScanText(itemName(item), text.slice(0, 200_000), policies);
      if (hit && policies.dlpOnSave === "block") {
        return reply.code(422).send({
          error: "dlp_blocked",
          message: `Save blocked by org data-loss-prevention policy (matched /${hit}/)`,
        });
      }
      if (hit) {
        await run("UPDATE items SET dlp_flagged = true WHERE id = $1", [item.id]);
        void logActivity(user.orgId, user.id, item.id, "dlp-flag", `matched /${hit}/`);
      } else if (item.dlp_flagged) {
        await run("UPDATE items SET dlp_flagged = false WHERE id = $1", [item.id]);
      }
    }
    // DLP engine — named rules with the reviewable event queue
    const scan = await scanDlp(user.orgId, { type: "item", id: item.id }, itemName(item),
      typeof body.content === "string" ? body.content : JSON.stringify(body.content), user.id);
    if (scan.blockedBy) {
      return reply.code(422).send({
        error: "dlp_blocked",
        message: `Save blocked by DLP rule "${scan.blockedBy}"`,
      });
    }

    const data = Buffer.from(JSON.stringify(body.content));
    const quota = await storageQuota(user.orgId, data.length);
    if (!quota.ok) {
      return reply.code(413).send({ error: "storage_quota",
        message: `Workspace storage full (${Math.round(quota.limit / 1048576)}MB plan limit) — upgrade or free space` });
    }
    const { key, size } = await putBlob(data);
    const next = ((await headVersion(item.id))?.number ?? 0) + 1;
    const stamp = await versionStamp(item);

    await run(
      "INSERT INTO versions (id, file_id, number, major, minor, published, label, blob_key, size, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [randomUUID(), item.id, next, stamp.major, stamp.minor, stamp.published, body.label ?? null, key, size, user.id, now()],
    );
    await run("UPDATE items SET size = $1 WHERE id = $2", [size, item.id]);
    // An uploaded native file (docx/xlsx/pptx) keeps its office mime until the
    // first canonical-JSON save — then it becomes a kreatix doc so opens stop
    // re-importing the original binary (which would clobber edits).
    if (["writer", "sheets", "present", "board"].includes(item.kind) && !item.mime.startsWith("application/x-kreatix-")) {
      await run("UPDATE items SET mime = $2 WHERE id = $1", [item.id, `application/x-kreatix-${item.kind}`]);
    }
    // Unstamped binaries (kind 'file' — chat uploads, legacy items) upgrade to
    // their real editor kind when the first canonical save lands, so lists
    // show the right icon and opens route without the extension fallback.
    const savedKind = (body.content as { kind?: unknown })?.kind;
    if (item.kind === "file" && typeof savedKind === "string" &&
        ["writer", "sheets", "present", "board"].includes(savedKind)) {
      await run("UPDATE items SET kind = $2, mime = $3 WHERE id = $1",
        [item.id, savedKind, `application/x-kreatix-${savedKind}`]);
    }
    void indexFile(item.id, item.kind, body.content).catch(() => { /* best-effort */ });
    void touchItem(item.id);
    return { version: next };
  });

  app.get("/api/files/:id/versions", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    const perm = item ? await permissionFor(user.id, item) : null;
    if (!item || !hasPermission(perm, "viewer")) {
      return reply.code(404).send({ error: "not_found" });
    }
    // drafts (unpublished minors) are only visible to editors+
    const seeDrafts = hasPermission(perm, "editor");
    const rows = await q<VersionRow & { display_name: string; initials: string }>(
      `SELECT v.*, u.display_name, u.initials FROM versions v JOIN users u ON u.id = v.created_by
       WHERE v.file_id = $1 ${seeDrafts ? "" : "AND v.published"} ORDER BY v.number DESC`,
      [item.id],
    );
    return {
      versions: rows.map((v) => ({
        id: v.id, fileId: v.file_id, number: v.number,
        major: v.major ?? v.number, minor: v.minor, published: !!v.published,
        pending: !!v.pending,
        label: v.label, size: v.size, createdBy: v.display_name, createdAt: v.created_at,
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
    const perm = item ? await permissionFor(user.id, item) : null;
    if (!item || !hasPermission(perm, "viewer")) {
      return reply.code(404).send({ error: "not_found" });
    }
    const vn = Number(n);
    if (!Number.isInteger(vn) || vn < 1) return reply.code(400).send({ error: "bad_request" });
    const v = await one<VersionRow>(
      "SELECT * FROM versions WHERE file_id = $1 AND number = $2",
      [item.id, vn],
    );
    // viewers may not read draft content
    if (v && !v.published && !hasPermission(perm, "editor")) {
      return reply.code(404).send({ error: "not_found" });
    }
    const blob = v && await getBlob(v.blob_key);
    if (!v || !blob) return reply.code(404).send({ error: "not_found" });
    try {
      return { version: v.number, content: JSON.parse(blob.toString("utf8")) };
    } catch {
      // binary version (e.g. the original PDF upload) — stream it raw
      return sendRawBlob(reply, item.mime, blob, itemName(item));
    }
  });

  /** Line-level diff between two versions of a text/JSON file — powers the
   *  "compare before restore" preview. Binary versions return 422. */
  app.get("/api/files/:id/diff", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    const perm = item ? await permissionFor(user.id, item) : null;
    if (!item || !hasPermission(perm, "viewer")) return reply.code(404).send({ error: "not_found" });
    const { a, b } = req.query as { a?: string; b?: string };
    const va = Number(a), vb = Number(b);
    if (!Number.isInteger(va) || !Number.isInteger(vb) || va < 1 || vb < 1)
      return reply.code(400).send({ error: "bad_request", message: "a and b must be version numbers" });
    const rows = await q<VersionRow>(
      "SELECT * FROM versions WHERE file_id = $1 AND number = ANY($2)", [item.id, [va, vb]]);
    const ra = rows.find((r) => r.number === va), rb = rows.find((r) => r.number === vb);
    if (!ra || !rb) return reply.code(404).send({ error: "not_found", message: "Version not found" });
    if ((!ra.published || !rb.published) && !hasPermission(perm, "editor"))
      return reply.code(404).send({ error: "not_found" });
    const textOf = async (v: VersionRow): Promise<string | null> => {
      const blob = await getBlob(v.blob_key);
      if (!blob) return null;
      try { return JSON.parse(blob.toString("utf8")); } catch { return null; }
    };
    const pretty = async (v: VersionRow) => {
      const c = await textOf(v);
      if (c === null) return null;
      return typeof c === "string" ? c : JSON.stringify(c, null, 2);
    };
    const ta = await pretty(ra), tb = await pretty(rb);
    if (ta === null || tb === null)
      return reply.code(422).send({ error: "binary", message: "Only text/JSON versions can be diffed" });
    return { a: va, b: vb, hunks: diffLines(ta, tb) };
  });

  /** Restore an older version — implemented as a new head version copying the old blob (SRS §19) */
  app.post("/api/files/:id/versions/:n/restore", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { id, n } = req.params as { id: string; n: string };
    const item = await getItem(id);
    if (!item || !hasPermission(await permissionFor(user.id, item), "editor")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    if (writeLocked(item, user.id)) {
      return reply.code(423).send({ error: "locked", message: "Checked out by someone else" });
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
    const stamp = await versionStamp(item);
    await run(
      "INSERT INTO versions (id, file_id, number, major, minor, published, label, blob_key, size, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [randomUUID(), item.id, next, stamp.major, stamp.minor, stamp.published, `Restored from v${v.number}`, v.blob_key, v.size, user.id, now()],
    );
    void touchItem(item.id);
    void logActivity(user.orgId, user.id, item.id, "restore-version", `v${v.number} → v${next}`);
    return { version: next };
  });

  /** Publish the head draft as the next major version (minor-versioned
   *  libraries / checked-out files). Editor+ only. In approval-enabled
   *  libraries, member requests are diverted to the owner approval queue. */
  app.post("/api/files/:id/publish", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const item = await getItem((req.params as { id: string }).id);
    if (!item || !hasPermission(await permissionFor(user.id, item), "editor")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    if (writeLocked(item, user.id)) {
      return reply.code(423).send({ error: "locked", message: "Checked out by someone else" });
    }
    if (await submitForApproval(item, user)) {
      void logActivity(user.orgId, user.id, item.id, "submit-approval", itemName(item));
      return { ok: true, pending: true };
    }
    const major = await publishHead(item);
    if (major === null) return reply.code(409).send({ error: "conflict", message: "No draft to publish" });
    void logActivity(user.orgId, user.id, item.id, "publish", `v${major}.0`);
    return { ok: true, major };
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
