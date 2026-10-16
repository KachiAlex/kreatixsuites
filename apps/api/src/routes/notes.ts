// Kreatix Notes — org-shared wiki pages (OneNote-lite). Every org member can
// read/create/edit; delete is creator or org-admin. Title/body are
// field-encrypted like other free-text.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { q, one, run } from "../db.js";
import { encryptField, decryptField } from "../crypto.js";

interface PageRow {
  id: string; org_id: string; title: string; body: string | null;
  created_by: string; updated_by: string | null;
  created_at: string; updated_at: string;
  creator_name?: string; updater_name?: string;
}

const pageSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(200_000).optional(),
});

const dec = (v: string | null | undefined) => (v ? decryptField(v) ?? v : null);
const pageOut = (r: PageRow) => ({
  id: r.id, title: dec(r.title), body: dec(r.body),
  createdBy: r.created_by, createdByName: r.creator_name ?? null,
  updatedBy: r.updated_by, updatedByName: r.updater_name ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const select = `SELECT p.*, c.display_name AS creator_name, u.display_name AS updater_name
  FROM wiki_pages p JOIN users c ON c.id = p.created_by
  LEFT JOIN users u ON u.id = p.updated_by`;

export function noteRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  const getPage = async (id: string, orgId: string) =>
    one<PageRow>(`${select} WHERE p.id = $1 AND p.org_id = $2`, [id, orgId]);
  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: "not_found", message: "Page not found" });

  app.get("/api/notes", async (req) => {
    const { user } = req as AuthedRequest;
    const rows = await q<PageRow>(`${select} WHERE p.org_id = $1 ORDER BY p.updated_at DESC LIMIT 500`, [user.orgId]);
    return { pages: rows.map((r) => ({ ...pageOut(r), body: undefined })) };
  });

  app.get("/api/notes/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const p = await getPage((req.params as { id: string }).id, user.orgId);
    if (!p) return notFound(reply);
    return { page: pageOut(p) };
  });

  app.post("/api/notes", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const parsed = pageSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid page" });
    const row = await one<PageRow>(
      `INSERT INTO wiki_pages (id, org_id, title, body, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,
      [randomUUID(), user.orgId,
       encryptField(parsed.data.title) ?? parsed.data.title,
       parsed.data.body ? encryptField(parsed.data.body) ?? parsed.data.body : null,
       user.id]);
    return reply.code(201).send({ page: pageOut({ ...row!, creator_name: user.displayName, updater_name: user.displayName }) });
  });

  app.patch("/api/notes/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const p = await getPage((req.params as { id: string }).id, user.orgId);
    if (!p) return notFound(reply);
    const parsed = pageSchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid page" });
    const row = await one<PageRow>(
      `UPDATE wiki_pages SET
         title = COALESCE($2, title),
         body = CASE WHEN $3::boolean THEN $4 ELSE body END,
         updated_by = $5, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [p.id,
       parsed.data.title ? encryptField(parsed.data.title) ?? parsed.data.title : null,
       parsed.data.body !== undefined, parsed.data.body ? encryptField(parsed.data.body) ?? parsed.data.body : null,
       user.id]);
    const full = await getPage(p.id, user.orgId);
    return { page: pageOut(full ?? row!) };
  });

  app.delete("/api/notes/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const p = await getPage((req.params as { id: string }).id, user.orgId);
    if (!p) return notFound(reply);
    if (p.created_by !== user.id && user.role !== "owner" && user.role !== "admin")
      return reply.code(403).send({ error: "forbidden", message: "Only the creator can delete" });
    await run("DELETE FROM wiki_pages WHERE id = $1", [p.id]);
    return { ok: true };
  });
}
