import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { q, one, run, now } from "../db.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import {
  getSite, getLibrary, siteRoleFor, toSite, toLibrary, memberOut,
  type SiteRow, type LibraryRow,
} from "../sites.js";
import { ensureSubscription, effectivePlan, planLimit, entitled } from "../billing.js";
import { encryptField, decryptField } from "../crypto.js";
import { logActivity } from "../items.js";

const createSiteSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  type: z.enum(["team", "project", "department", "communication"]).default("team"),
  visibility: z.enum(["org", "private"]).default("org"),
});

const patchSiteSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  type: z.enum(["team", "project", "department", "communication"]).optional(),
  visibility: z.enum(["org", "private"]).optional(),
});

const memberSchema = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "member", "visitor"]).default("member"),
});

const roleSchema = z.object({ role: z.enum(["owner", "member", "visitor"]) });

const librarySchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(["documents", "media", "form"]).default("documents"),
});

const libraryPatchSchema = librarySchema.partial().extend({
  versioning: z.enum(["major", "minor"]).optional(),
});

const columnSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(["text", "number", "date", "choice", "person", "yesno"]).default("text"),
  required: z.boolean().default(false),
  choices: z.array(z.string().max(120)).max(50).optional(),
  position: z.number().int().min(0).optional(),
});

const viewSchema = z.object({
  name: z.string().min(1).max(80),
  config: z.object({
    sort: z.enum(["name", "updated", "size"]).optional(),
    dir: z.enum(["asc", "desc"]).optional(),
    kind: z.string().optional(),
    label: z.string().optional(),
    query: z.string().max(200).optional(),
    columnFilters: z.record(z.string(), z.string()).optional(),
  }).default({}),
  shared: z.boolean().default(true),
});

interface ColumnRow {
  id: string; library_id: string; name: string; type: string;
  required: boolean; choices: unknown; position: number; created_at: string;
}

interface ViewRow {
  id: string; library_id: string; name: string; config: unknown;
  created_by: string | null; shared: boolean; created_at: string;
}

const colOut = (r: ColumnRow) => ({
  id: r.id, libraryId: r.library_id, name: decryptField(r.name) ?? r.name,
  type: r.type, required: !!r.required,
  choices: Array.isArray(r.choices) ? (r.choices as string[]) : undefined,
  position: r.position, createdAt: r.created_at,
});

const viewOut = (r: ViewRow) => ({
  id: r.id, libraryId: r.library_id, name: decryptField(r.name) ?? r.name,
  config: (r.config ?? {}) as Record<string, unknown>, createdBy: r.created_by,
  shared: !!r.shared, createdAt: r.created_at,
});

const SITE_RANK: Record<string, number> = { visitor: 1, member: 2, owner: 3 };
const atLeast = (role: string | null, need: string) => role !== null && SITE_RANK[role] >= SITE_RANK[need];

export function siteRoutes(app: FastifyInstance) {
  app.register(async (authed) => {
    authed.addHook("preHandler", requireAuth);

    /** Sites visible to me — member, owner, org-visible, or (org admin) all. */
    authed.get("/api/sites", async (req) => {
      const { user } = req as AuthedRequest;
      const rows = await q<SiteRow & { member_role: string | null }>(
        `SELECT st.*, sm.role AS member_role FROM sites st
         LEFT JOIN site_members sm ON sm.site_id = st.id AND sm.user_id = $2
         WHERE st.org_id = $1 AND (
           st.visibility = 'org' OR st.owner_id = $2 OR sm.user_id IS NOT NULL OR $3::boolean)
         ORDER BY st.updated_at DESC`,
        [user.orgId, user.id, user.role === "owner" || user.role === "admin"],
      );
      const sites = await Promise.all(rows.map(async (r) =>
        toSite(r, r.owner_id === user.id ? "owner"
          : (r.member_role as never) ?? (user.role === "owner" || user.role === "admin" ? "owner"
          : "visitor"))));
      return { sites };
    });

    authed.post("/api/sites", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const body = createSiteSchema.parse(req.body);
      // plan gate: sites count is a paid-tier limit (free = 1)
      const plan = await effectivePlan(await ensureSubscription(user.orgId));
      const max = planLimit(plan, "sites", 1);
      if (max > 0) {
        const n = await one<{ n: number }>("SELECT COUNT(*) AS n FROM sites WHERE org_id = $1", [user.orgId]);
        if ((n?.n ?? 0) >= max) {
          return reply.code(402).send({ error: "plan_limit", message: `Your plan allows ${max} site${max === 1 ? "" : "s"} — upgrade for more` });
        }
      }
      const id = randomUUID();
      const libId = randomUUID();
      await run(
        `INSERT INTO sites (id, org_id, name, description, type, visibility, owner_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, user.orgId, encryptField(body.name), body.description ? encryptField(body.description) : null,
         body.type, body.visibility, user.id, now(), now()],
      );
      await run("INSERT INTO site_members (site_id, user_id, role, created_at) VALUES ($1,$2,'owner',$3)",
        [id, user.id, now()]);
      // every site starts with a Documents library — SharePoint's convention
      await run("INSERT INTO libraries (id, site_id, name, kind, created_at) VALUES ($1,$2,$3,'documents',$4)",
        [libId, id, encryptField("Documents"), now()]);
      void logActivity(user.orgId, user.id, null, "site-create", body.name);
      return { site: toSite((await getSite(id))!, "owner", 1) };
    });

    /** Single site — detail, libraries, members count, my role. */
    authed.get("/api/sites/:id", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const site = await getSite((req.params as { id: string }).id);
      const role = site ? await siteRoleFor(user, site) : null;
      if (!site || !role) return reply.code(404).send({ error: "not_found", message: "Site not found" });
      const libs = await q<LibraryRow & { n: number }>(
        `SELECT l.*, (SELECT COUNT(*) FROM items i WHERE i.library_id = l.id AND NOT i.trashed) AS n
         FROM libraries l WHERE l.site_id = $1 ORDER BY l.created_at`,
        [site.id],
      );
      const mc = await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_members WHERE site_id = $1", [site.id]);
      return {
        site: toSite(site, role, mc?.n ?? 0),
        libraries: await Promise.all(libs.map((l) => toLibrary(l, l.n))),
      };
    });

    authed.patch("/api/sites/:id", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const site = await getSite((req.params as { id: string }).id);
      const role = site ? await siteRoleFor(user, site) : null;
      if (!site || !atLeast(role, "owner")) return reply.code(403).send({ error: "forbidden" });
      const body = patchSiteSchema.parse(req.body);
      await run(
        `UPDATE sites SET name = COALESCE($2, name),
         description = CASE WHEN $7 THEN $3 ELSE description END,
         type = COALESCE($4, type), visibility = COALESCE($5, visibility), updated_at = $6 WHERE id = $1`,
        [site.id,
         body.name === undefined ? null : encryptField(body.name),
         body.description === undefined || body.description === null ? null : encryptField(body.description),
         body.type ?? null, body.visibility ?? null, now(),
         body.description !== undefined],
      );
      // description: explicit null clears
      if (body.description === null) await run("UPDATE sites SET description = NULL WHERE id = $1", [site.id]);
      return { site: toSite((await getSite(site.id))!, role) };
    });

    authed.delete("/api/sites/:id", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const site = await getSite((req.params as { id: string }).id);
      const role = site ? await siteRoleFor(user, site) : null;
      if (!site || !atLeast(role, "owner")) return reply.code(403).send({ error: "forbidden" });
      const n = await one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM items i JOIN libraries l ON l.id = i.library_id
         WHERE l.site_id = $1 AND NOT i.trashed`, [site.id]);
      if ((n?.n ?? 0) > 0) {
        return reply.code(409).send({ error: "conflict", message: "Delete or move the site's files first" });
      }
      await run("UPDATE items SET library_id = NULL WHERE library_id IN (SELECT id FROM libraries WHERE site_id = $1)", [site.id]);
      await run("DELETE FROM sites WHERE id = $1", [site.id]);
      void logActivity(user.orgId, user.id, null, "site-delete", decryptField(site.name) ?? site.name);
      return { ok: true };
    });

    // ---- members ----

    authed.get("/api/sites/:id/members", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const site = await getSite((req.params as { id: string }).id);
      const role = site ? await siteRoleFor(user, site) : null;
      if (!site || !role) return reply.code(404).send({ error: "not_found" });
      const rows = await q<{ user_id: string; role: string; created_at: string; display_name: string; email: string; initials: string }>(
        `SELECT sm.user_id, sm.role, sm.created_at, u.display_name, u.email, u.initials
         FROM site_members sm JOIN users u ON u.id = sm.user_id
         WHERE sm.site_id = $1 ORDER BY sm.created_at`,
        [site.id],
      );
      return {
        members: rows.map((r) => memberOut(r.user_id, r.role as never, r, r.created_at)),
        myRole: role,
      };
    });

    authed.post("/api/sites/:id/members", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const site = await getSite((req.params as { id: string }).id);
      const role = site ? await siteRoleFor(user, site) : null;
      if (!site || !atLeast(role, "owner")) return reply.code(403).send({ error: "forbidden" });
      const body = memberSchema.parse(req.body);
      const target = await one<{ id: string; org_id: string }>(
        "SELECT id, org_id FROM users WHERE email = $1", [body.email]);
      if (!target || target.org_id !== user.orgId) {
        return reply.code(404).send({ error: "not_found", message: "No workspace member with that email" });
      }
      await run(
        `INSERT INTO site_members (site_id, user_id, role, created_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (site_id, user_id) DO UPDATE SET role = excluded.role`,
        [site.id, target.id, body.role, now()],
      );
      void logActivity(user.orgId, user.id, null, "site-member-add", `${body.email} → ${body.role} @ ${decryptField(site.name) ?? site.name}`);
      return { ok: true };
    });

    authed.patch("/api/sites/:id/members/:uid", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const site = await getSite((req.params as { id: string }).id);
      const role = site ? await siteRoleFor(user, site) : null;
      if (!site || !atLeast(role, "owner")) return reply.code(403).send({ error: "forbidden" });
      const { uid } = req.params as { uid: string };
      const body = roleSchema.parse(req.body);
      await run("UPDATE site_members SET role = $3 WHERE site_id = $1 AND user_id = $2", [site.id, uid, body.role]);
      return { ok: true };
    });

    authed.delete("/api/sites/:id/members/:uid", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const site = await getSite((req.params as { id: string }).id);
      const role = site ? await siteRoleFor(user, site) : null;
      if (!site || !atLeast(role, "owner")) return reply.code(403).send({ error: "forbidden" });
      const { uid } = req.params as { uid: string };
      // never leave a site without an owner
      const target = await one<{ role: string }>(
        "SELECT role FROM site_members WHERE site_id = $1 AND user_id = $2", [site.id, uid]);
      if (target?.role === "owner") {
        const owners = await one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM site_members WHERE site_id = $1 AND role = 'owner'", [site.id]);
        if ((owners?.n ?? 0) <= 1) {
          return reply.code(400).send({ error: "bad_request", message: "A site needs at least one owner" });
        }
      }
      await run("DELETE FROM site_members WHERE site_id = $1 AND user_id = $2", [site.id, uid]);
      return { ok: true };
    });

    // ---- libraries ----

    authed.post("/api/sites/:id/libraries", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const site = await getSite((req.params as { id: string }).id);
      const role = site ? await siteRoleFor(user, site) : null;
      if (!site || !atLeast(role, "member")) return reply.code(403).send({ error: "forbidden" });
      const body = librarySchema.parse(req.body);
      const id = randomUUID();
      await run("INSERT INTO libraries (id, site_id, name, kind, created_at) VALUES ($1,$2,$3,$4,$5)",
        [id, site.id, encryptField(body.name), body.kind, now()]);
      void logActivity(user.orgId, user.id, null, "library-create", `${body.name} @ ${decryptField(site.name) ?? site.name}`);
      return { library: await toLibrary((await getLibrary(id))!) };
    });

    authed.patch("/api/sites/:id/libraries/:lid", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const site = await getSite((req.params as { id: string }).id);
      const role = site ? await siteRoleFor(user, site) : null;
      const { lid } = req.params as { lid: string };
      const lib = site ? await getLibrary(lid) : undefined;
      if (!site || !lib || lib.site_id !== site.id || !atLeast(role, "member"))
        return reply.code(403).send({ error: "forbidden" });
      const body = libraryPatchSchema.parse(req.body);
      // versioning is a governance knob — owners only
      if (body.versioning !== undefined && !atLeast(role, "owner")) {
        return reply.code(403).send({ error: "forbidden", message: "Only site owners can change versioning" });
      }
      await run("UPDATE libraries SET name = COALESCE($2, name), kind = COALESCE($3, kind), versioning = COALESCE($4, versioning) WHERE id = $1",
        [lib.id, body.name === undefined ? null : encryptField(body.name), body.kind ?? null, body.versioning ?? null]);
      return { library: await toLibrary((await getLibrary(lib.id))!) };
    });

    authed.delete("/api/sites/:id/libraries/:lid", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const site = await getSite((req.params as { id: string }).id);
      const role = site ? await siteRoleFor(user, site) : null;
      const { lid } = req.params as { lid: string };
      const lib = site ? await getLibrary(lid) : undefined;
      if (!site || !lib || lib.site_id !== site.id || !atLeast(role, "owner"))
        return reply.code(403).send({ error: "forbidden" });
      const n = await one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM items WHERE library_id = $1 AND NOT trashed", [lib.id]);
      if ((n?.n ?? 0) > 0) {
        return reply.code(409).send({ error: "conflict", message: "Delete or move the library's files first" });
      }
      await run("DELETE FROM libraries WHERE id = $1", [lib.id]);
      return { ok: true };
    });

    // ---- custom columns (SharePoint site columns) ----

    /** Resolve site+library+role for nested routes; null reply handled by caller. */
    const libCtx = async (req: FastifyRequest, reply: FastifyReply) => {
      const { user } = req as AuthedRequest;
      const { id, lid } = req.params as { id: string; lid: string };
      const site = await getSite(id);
      const role = site ? await siteRoleFor(user, site) : null;
      const lib = site ? await getLibrary(lid) : undefined;
      if (!site || !lib || lib.site_id !== site.id || !role) {
        void reply.code(404).send({ error: "not_found", message: "Library not found" });
        return null;
      }
      return { user, site, lib, role };
    };

    authed.get("/api/sites/:id/libraries/:lid/columns", async (req, reply) => {
      const ctx = await libCtx(req, reply);
      if (!ctx) return;
      const cols = await q<ColumnRow>(
        "SELECT * FROM library_columns WHERE library_id = $1 ORDER BY position, created_at", [ctx.lib.id]);
      return { columns: cols.map(colOut) };
    });

    authed.post("/api/sites/:id/libraries/:lid/columns", async (req, reply) => {
      const ctx = await libCtx(req, reply);
      if (!ctx) return;
      if (!atLeast(ctx.role, "owner")) return reply.code(403).send({ error: "forbidden" });
      if (!(await entitled(ctx.user.orgId, "docmgmt"))) {
        return reply.code(402).send({ error: "plan_limit", message: "Custom columns require a paid plan" });
      }
      const body = columnSchema.parse(req.body);
      const id = randomUUID();
      const pos = body.position ?? (await one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM library_columns WHERE library_id = $1", [ctx.lib.id]))?.n ?? 0;
      await run(
        `INSERT INTO library_columns (id, library_id, name, type, required, choices, position, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, ctx.lib.id, encryptField(body.name), body.type, body.required,
         body.choices ? JSON.stringify(body.choices) : null, pos, now()],
      );
      return { column: colOut((await one<ColumnRow>("SELECT * FROM library_columns WHERE id = $1", [id]))!) };
    });

    authed.patch("/api/sites/:id/libraries/:lid/columns/:cid", async (req, reply) => {
      const ctx = await libCtx(req, reply);
      if (!ctx) return;
      if (!atLeast(ctx.role, "owner")) return reply.code(403).send({ error: "forbidden" });
      const { cid } = req.params as { cid: string };
      const body = columnSchema.partial().parse(req.body);
      const res = await run(
        `UPDATE library_columns SET name = COALESCE($2, name), type = COALESCE($3, type),
         required = COALESCE($4, required), choices = COALESCE($5, choices), position = COALESCE($6, position)
         WHERE id = $1 AND library_id = $7`,
        [cid, body.name === undefined ? null : encryptField(body.name), body.type ?? null,
         body.required ?? null, body.choices === undefined ? null : JSON.stringify(body.choices),
         body.position ?? null, ctx.lib.id],
      );
      if (!(res as { rowCount?: number }).rowCount) return reply.code(404).send({ error: "not_found" });
      return { column: colOut((await one<ColumnRow>("SELECT * FROM library_columns WHERE id = $1", [cid]))!) };
    });

    authed.delete("/api/sites/:id/libraries/:lid/columns/:cid", async (req, reply) => {
      const ctx = await libCtx(req, reply);
      if (!ctx) return;
      if (!atLeast(ctx.role, "owner")) return reply.code(403).send({ error: "forbidden" });
      const { cid } = req.params as { cid: string };
      await run("DELETE FROM library_columns WHERE id = $1 AND library_id = $2", [cid, ctx.lib.id]);
      return { ok: true };
    });

    // ---- saved views ----

    authed.get("/api/sites/:id/libraries/:lid/views", async (req, reply) => {
      const ctx = await libCtx(req, reply);
      if (!ctx) return;
      const rows = await q<ViewRow>(
        `SELECT * FROM library_views WHERE library_id = $1 AND (shared OR created_by = $2)
         ORDER BY created_at`, [ctx.lib.id, ctx.user.id]);
      return { views: rows.map(viewOut) };
    });

    authed.post("/api/sites/:id/libraries/:lid/views", async (req, reply) => {
      const ctx = await libCtx(req, reply);
      if (!ctx) return;
      if (!atLeast(ctx.role, "member")) return reply.code(403).send({ error: "forbidden" });
      if (!(await entitled(ctx.user.orgId, "docmgmt"))) {
        return reply.code(402).send({ error: "plan_limit", message: "Saved views require a paid plan" });
      }
      const body = viewSchema.parse(req.body);
      const id = randomUUID();
      await run(
        `INSERT INTO library_views (id, library_id, name, config, created_by, shared, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, ctx.lib.id, encryptField(body.name), JSON.stringify(body.config), ctx.user.id, body.shared, now()],
      );
      return { view: viewOut((await one<ViewRow>("SELECT * FROM library_views WHERE id = $1", [id]))!) };
    });

    authed.delete("/api/sites/:id/libraries/:lid/views/:vid", async (req, reply) => {
      const ctx = await libCtx(req, reply);
      if (!ctx) return;
      const { vid } = req.params as { vid: string };
      const row = await one<ViewRow>("SELECT * FROM library_views WHERE id = $1 AND library_id = $2", [vid, ctx.lib.id]);
      if (!row) return reply.code(404).send({ error: "not_found" });
      // creator or site owner may delete
      if (row.created_by !== ctx.user.id && !atLeast(ctx.role, "owner")) {
        return reply.code(403).send({ error: "forbidden" });
      }
      await run("DELETE FROM library_views WHERE id = $1", [vid]);
      return { ok: true };
    });
  });
}
