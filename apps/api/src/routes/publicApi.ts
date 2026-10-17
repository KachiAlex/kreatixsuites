// Public REST API v1 — org-scoped service access via `kx_` API keys.
//
// Auth: `Authorization: Bearer kx_…`. App-only semantics — the key operates on
// the org surface, not a user's personal ACL (SharePoint app-principal model).
// Scopes: read (metadata/content/search), write (tasks), hooks (webhook CRUD).
// Org conditional-access IP allowlists apply to key traffic as well.
import { randomUUID } from "node:crypto";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { q, one, run } from "../db.js";
import { resolveApiKey, keyAllows, type ApiKey, type ApiScope } from "../integrations.js";
import { getPolicies, ipAllowed } from "../policies.js";
import { encryptField } from "../crypto.js";
import { itemName, type ItemRow } from "../items.js";
import { getBlob } from "../blobs.js";

interface KeyedRequest extends FastifyRequest { apiKey: ApiKey }

const unauth = (reply: FastifyReply) =>
  reply.code(401).send({ error: "unauthorized", message: "Valid kx_ API key required" });

/** Resolve the bearer key, enforce the org's IP allowlist, attach req.apiKey. */
function keyAuth(scope: ApiScope) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const key = token ? await resolveApiKey(token) : null;
    if (!key) return unauth(reply);
    if (!keyAllows(key, scope)) {
      return reply.code(403).send({ error: "scope_required", message: `This key lacks the '${scope}' scope` });
    }
    const { allowedIpRanges } = await getPolicies(key.org_id);
    if (allowedIpRanges.length && !ipAllowed(req.ip, allowedIpRanges)) {
      return reply.code(403).send({ error: "ip_restricted", message: "This key's org restricts API access by IP" });
    }
    (req as KeyedRequest).apiKey = key;
  };
}

const LIST_COLS = `i.id, i.org_id, i.parent_id, i.owner_id, i.name, i.kind, i.mime,
  i.size, i.trashed, i.label, i.updated_at, u.display_name AS owner_name`;

const itemOut = (r: ItemRow & { owner_name?: string | null }) => ({
  id: r.id, name: itemName(r), kind: r.kind, mimeType: r.mime, size: r.size,
  parentId: r.parent_id, trashed: r.trashed, label: r.label,
  updatedAt: r.updated_at, owner: r.owner_name ?? null,
});

export async function publicApiRoutes(app: FastifyInstance) {
  app.get("/api/v1/org", { preHandler: keyAuth("read") }, async (req) => {
    const key = (req as KeyedRequest).apiKey;
    const org = await one<{ id: string; name: string }>("SELECT id, name FROM orgs WHERE id = $1", [key.org_id]);
    return {
      org: { id: org?.id, name: org?.name },
      key: { name: key.name, prefix: key.prefix, scopes: key.scopes },
    };
  });

  app.get("/api/v1/files", { preHandler: keyAuth("read") }, async (req) => {
    const key = (req as KeyedRequest).apiKey;
    const { parent } = req.query as { parent?: string };
    const rows = await q<ItemRow & { owner_name: string | null }>(
      `SELECT ${LIST_COLS} FROM items i LEFT JOIN users u ON u.id = i.owner_id
       WHERE i.org_id = $1 AND NOT i.trashed AND i.media_for IS NULL
         AND ($2::text IS NULL OR COALESCE(i.parent_id,'') = $2)
       ORDER BY i.updated_at DESC LIMIT 200`, [key.org_id, parent === undefined ? null : parent]);
    return { items: rows.map(itemOut) };
  });

  app.get("/api/v1/files/:id", { preHandler: keyAuth("read") }, async (req, reply) => {
    const key = (req as KeyedRequest).apiKey;
    const { id } = req.params as { id: string };
    const r = await one<ItemRow & { owner_name: string | null }>(
      `SELECT ${LIST_COLS} FROM items i LEFT JOIN users u ON u.id = i.owner_id
       WHERE i.id = $1 AND i.org_id = $2`, [id, key.org_id]);
    if (!r) return reply.code(404).send({ error: "not_found" });
    const v = await one<{ n: number }>(
      "SELECT MAX(number) AS n FROM versions WHERE file_id = $1", [id]);
    return { item: { ...itemOut(r), version: v?.n ?? 0 } };
  });

  app.get("/api/v1/files/:id/content", { preHandler: keyAuth("read") }, async (req, reply) => {
    const key = (req as KeyedRequest).apiKey;
    const { id } = req.params as { id: string };
    const r = await one<{ mime: string; blob_key: string }>(
      `SELECT i.mime, v.blob_key FROM items i
       JOIN versions v ON v.file_id = i.id
       WHERE i.id = $1 AND i.org_id = $2 AND NOT i.trashed
       ORDER BY v.number DESC LIMIT 1`, [id, key.org_id]);
    if (!r) return reply.code(404).send({ error: "not_found" });
    const buf = getBlob(r.blob_key);
    if (!buf) return reply.code(404).send({ error: "not_found" });
    return reply.header("content-type", r.mime).send(buf);
  });

  app.get("/api/v1/search", { preHandler: keyAuth("read") }, async (req) => {
    const key = (req as KeyedRequest).apiKey;
    const term = ((req.query as { q?: string }).q ?? "").trim();
    if (!term) return { items: [] };
    const rows = await q<ItemRow & { owner_name: string | null }>(
      `SELECT ${LIST_COLS} FROM items i LEFT JOIN users u ON u.id = i.owner_id
       JOIN search_index s ON s.file_id = i.id
       WHERE i.org_id = $1 AND NOT i.trashed AND s.body ILIKE '%' || $2 || '%'
       ORDER BY i.updated_at DESC LIMIT 50`, [key.org_id, term]);
    return { items: rows.map(itemOut) };
  });

  app.post("/api/v1/tasks", { preHandler: keyAuth("write") }, async (req, reply) => {
    const key = (req as KeyedRequest).apiKey;
    const body = (req.body ?? {}) as { title?: string; notes?: string; assigneeId?: string; dueAt?: string };
    if (!body.title?.trim()) return reply.code(400).send({ error: "title_required" });
    // created_by is NOT NULL — attribute to the key's creator, else org owner
    const creator = key.created_by
      ?? (await one<{ id: string }>(
        "SELECT id FROM users WHERE org_id = $1 AND role = 'owner' ORDER BY created_at LIMIT 1",
        [key.org_id]))?.id;
    if (!creator) return reply.code(409).send({ error: "no_creator", message: "Key has no surviving creator" });
    const id = randomUUID();
    const title = body.title.trim().slice(0, 200);
    await run(
      `INSERT INTO tasks (id, org_id, title, notes, assignee_id, due_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, key.org_id, encryptField(title) ?? title,
       body.notes ? encryptField(body.notes.slice(0, 4000)) ?? body.notes.slice(0, 4000) : null,
       body.assigneeId ?? null, body.dueAt ?? null, creator]);
    return reply.code(201).send({ task: { id, title } });
  });

  app.get("/api/v1/hooks", { preHandler: keyAuth("hooks") }, async (req) => {
    const key = (req as KeyedRequest).apiKey;
    const hooks = await q<{ id: string; url: string; events: string[]; active: boolean; created_at: string }>(
      "SELECT id, url, events, active, created_at FROM webhooks WHERE org_id = $1 ORDER BY created_at DESC",
      [key.org_id]);
    return { hooks };
  });
}
