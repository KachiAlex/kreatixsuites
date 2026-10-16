import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SiteRole, FileKind } from "@kreatix/shared";
import { q, one, run, now } from "../db.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import {
  getSite, getLibrary, siteRoleFor, libraryRoleFor, toSite, toLibrary, memberOut,
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

const contentTypeSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  // 'folder' is only meaningful on docSet types (the set itself is a folder)
  allowedKinds: z.array(z.enum(["folder", "writer", "sheets", "present", "pdf", "file"])).default(["writer", "sheets", "present", "pdf", "file"]),
  isDefault: z.boolean().default(false),
  /** Document-set type — applies to folders; shared columns propagate inside */
  docSet: z.boolean().default(false),
});

const contentTypePatchSchema = contentTypeSchema.partial();

const roleSchema = z.object({ role: z.enum(["owner", "member", "visitor"]) });

const librarySchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(["documents", "media", "form"]).default("documents"),
});

const libraryPatchSchema = librarySchema.partial().extend({
  versioning: z.enum(["major", "minor"]).optional(),
  approval: z.boolean().optional(),
  inherit: z.boolean().optional(),
  /** auto-trash items untouched this many days (null clears) */
  retentionDays: z.number().int().min(0).max(36500).nullable().optional(),
});

const columnSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(["text", "number", "date", "choice", "person", "yesno", "managed"]).default("text"),
  required: z.boolean().default(false),
  choices: z.array(z.string().max(120)).max(50).optional(),
  /** bound term set when type === 'managed' */
  termSetId: z.string().nullable().optional(),
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
  required: boolean; choices: unknown; term_set_id: string | null;
  position: number; created_at: string;
}

interface ViewRow {
  id: string; library_id: string; name: string; config: unknown;
  created_by: string | null; shared: boolean; created_at: string;
}

const colOut = (r: ColumnRow) => ({
  id: r.id, libraryId: r.library_id, name: decryptField(r.name) ?? r.name,
  type: r.type, required: !!r.required,
  choices: Array.isArray(r.choices) ? (r.choices as string[]) : undefined,
  termSetId: r.term_set_id ?? undefined,
  position: r.position, createdAt: r.created_at,
});

const viewOut = (r: ViewRow) => ({
  id: r.id, libraryId: r.library_id, name: decryptField(r.name) ?? r.name,
  config: (r.config ?? {}) as Record<string, unknown>, createdBy: r.created_by,
  shared: !!r.shared, createdAt: r.created_at,
});

interface CtRow {
  id: string; site_id: string; library_id: string | null; name: string; description: string | null;
  template_blob_key: string | null; allowed_kinds: unknown; is_default: boolean; doc_set: boolean;
  created_at: string;
}

const ctOut = (r: CtRow, columns?: { columnId: string; required: boolean; shared: boolean; position: number }[]) => ({
  id: r.id, siteId: r.site_id, libraryId: r.library_id,
  name: decryptField(r.name) ?? r.name,
  description: r.description ? decryptField(r.description) ?? r.description : null,
  templateBlobKey: r.template_blob_key,
  allowedKinds: Array.isArray(r.allowed_kinds) ? (r.allowed_kinds as FileKind[]) : [],
  isDefault: !!r.is_default, docSet: !!r.doc_set, createdAt: r.created_at,
  columns,
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
      void logActivity(user.orgId, user.id, null, "site-create", body.name, id);
      return { site: toSite((await getSite(id))!, "owner", 1) };
    });

    /** Single site — detail, libraries, members count, my role. */
    authed.get("/api/sites/:id", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const site = await getSite((req.params as { id: string }).id);
      const role = site ? await siteRoleFor(user, site) : null;
      // limited access (SharePoint): a library grantee on a private site can
      // open it to reach their library, even without site membership
      let viewRole = role;
      if (!viewRole && site) {
        const grant = await one<{ 1: number }>(
          `SELECT 1 FROM library_permissions lp JOIN libraries l ON l.id = lp.library_id
           WHERE l.site_id = $1 AND lp.user_id = $2 LIMIT 1`,
          [site.id, user.id],
        );
        if (grant) viewRole = "visitor";
      }
      if (!site || !viewRole) return reply.code(404).send({ error: "not_found", message: "Site not found" });
      // security-trim: owners see every library; members/implicit visitors see
      // inheriting ones; grant-only users see just their granted libraries
      const libs = await q<LibraryRow & { n: number }>(
        `SELECT l.*, (SELECT COUNT(*) FROM items i WHERE i.library_id = l.id AND NOT i.trashed) AS n
         FROM libraries l WHERE l.site_id = $1
           AND ($3::boolean OR (l.inherit_permissions AND $4::boolean)
                OR EXISTS (SELECT 1 FROM library_permissions lp
                           WHERE lp.library_id = l.id AND lp.user_id = $2))
         ORDER BY l.created_at`,
        [site.id, user.id, role === "owner", role !== null],
      );
      const mc = await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_members WHERE site_id = $1", [site.id]);
      return {
        site: toSite(site, viewRole, mc?.n ?? 0),
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
      void logActivity(user.orgId, user.id, null, "site-delete", decryptField(site.name) ?? site.name, site.id);
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
      void logActivity(user.orgId, user.id, null, "site-member-add", `${body.email} → ${body.role} @ ${decryptField(site.name) ?? site.name}`, site.id);
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

    /** Site activity feed — site-level events (member adds, settings) plus
     *  file events inside the site's libraries. Any site role can view. */
    authed.get("/api/sites/:id/activity", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const site = await getSite((req.params as { id: string }).id);
      const role = site ? await siteRoleFor(user, site) : null;
      if (!site || !role) return reply.code(404).send({ error: "not_found" });
      const rows = await q<{
        id: string; action: string; detail: string | null; file_id: string | null;
        created_at: string; display_name: string; initials: string;
      }>(
        `SELECT a.id, a.action, a.detail, a.file_id, a.created_at, u.display_name, u.initials
         FROM activity a JOIN users u ON u.id = a.actor_id
         WHERE a.org_id = $2 AND (
           a.site_id = $1
           OR a.file_id IN (SELECT i.id FROM items i JOIN libraries l ON l.id = i.library_id
                            WHERE l.site_id = $1))
         ORDER BY a.created_at DESC LIMIT 50`,
        [site.id, user.orgId],
      );
      return {
        events: rows.map((r) => ({
          id: r.id, action: r.action, fileId: r.file_id,
          detail: r.detail ? decryptField(r.detail) ?? r.detail : null,
          actor: { displayName: r.display_name, initials: r.initials },
          createdAt: r.created_at,
        })),
      };
    });

    /** Audit export — full site activity as CSV (SharePoint audit log
     *  reports). Site owners only; capped at 10k rows, newest first. */
    authed.get("/api/sites/:id/audit.csv", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const site = await getSite((req.params as { id: string }).id);
      const role = site ? await siteRoleFor(user, site) : null;
      if (!site || role !== "owner") {
        return reply.code(403).send({ error: "forbidden", message: "Only site owners can export the audit log" });
      }
      const rows = await q<{
        action: string; detail: string | null; created_at: string;
        actor: string; file_name: string | null;
      }>(
        `SELECT a.action, a.detail, a.created_at, u.display_name AS actor, i.name AS file_name
         FROM activity a JOIN users u ON u.id = a.actor_id
         LEFT JOIN items i ON i.id = a.file_id
         WHERE a.org_id = $2 AND (
           a.site_id = $1
           OR a.file_id IN (SELECT f.id FROM items f JOIN libraries l ON l.id = f.library_id
                            WHERE l.site_id = $1))
         ORDER BY a.created_at DESC LIMIT 10000`,
        [site.id, user.orgId],
      );
      const cell = (v: string | null) => `"${(v ?? "").replaceAll('"', '""')}"`;
      const csv = "timestamp,actor,action,file,detail\n" + rows.map((r) =>
        [r.created_at, r.actor, r.action, r.file_name ? decryptField(r.file_name) ?? r.file_name : "",
         r.detail ? decryptField(r.detail) ?? r.detail : ""].map(cell).join(","),
      ).join("\n");
      reply.header("content-disposition", `attachment; filename="site-audit-${site.id.slice(0, 8)}.csv"`);
      return reply.type("text/csv").send(csv);
    });

    // ---- term store (SharePoint managed metadata, org-scoped) ----

    const orgAdmin = (role: string) => role === "owner" || role === "admin";

    const termSetOut = (r: { id: string; org_id: string; name: string; description: string | null; created_at: string },
      terms?: { id: string; set_id: string; parent_id: string | null; name: string; position: number }[]) => ({
      id: r.id, orgId: r.org_id, name: decryptField(r.name) ?? r.name,
      description: r.description ? decryptField(r.description) ?? r.description : null,
      terms: terms?.map((t) => ({
        id: t.id, setId: t.set_id, parentId: t.parent_id,
        name: decryptField(t.name) ?? t.name, position: t.position,
      })),
      createdAt: r.created_at,
    });

    /** List the org's term sets with their terms — any org member can read
     *  (columns and property pickers need the vocabulary). */
    authed.get("/api/termsets", async (req) => {
      const { user } = req as AuthedRequest;
      const sets = await q<{ id: string; org_id: string; name: string; description: string | null; created_at: string }>(
        "SELECT * FROM term_sets WHERE org_id = $1 ORDER BY created_at", [user.orgId]);
      const terms = sets.length ? await q<{ id: string; set_id: string; parent_id: string | null; name: string; position: number }>(
        "SELECT * FROM terms WHERE set_id = ANY($1) ORDER BY position, created_at", [sets.map((s) => s.id)]) : [];
      return { termSets: sets.map((s) => termSetOut(s, terms.filter((t) => t.set_id === s.id))) };
    });

    const termSetSchema = z.object({
      name: z.string().min(1).max(120),
      description: z.string().max(500).nullable().optional(),
    });

    authed.post("/api/termsets", async (req, reply) => {
      const { user } = req as AuthedRequest;
      if (!orgAdmin(user.role)) return reply.code(403).send({ error: "forbidden", message: "Only org admins manage the term store" });
      if (!(await entitled(user.orgId, "docmgmt"))) {
        return reply.code(402).send({ error: "plan_limit", message: "Managed metadata requires a paid plan" });
      }
      const body = termSetSchema.parse(req.body);
      const id = randomUUID();
      await run("INSERT INTO term_sets (id, org_id, name, description, created_at) VALUES ($1,$2,$3,$4,$5)",
        [id, user.orgId, encryptField(body.name), body.description ? encryptField(body.description) : null, now()]);
      return { termSet: termSetOut((await one<{ id: string; org_id: string; name: string; description: string | null; created_at: string }>(
        "SELECT * FROM term_sets WHERE id = $1", [id]))!, []) };
    });

    authed.delete("/api/termsets/:id", async (req, reply) => {
      const { user } = req as AuthedRequest;
      if (!orgAdmin(user.role)) return reply.code(403).send({ error: "forbidden" });
      const res = await run("DELETE FROM term_sets WHERE id = $1 AND org_id = $2",
        [(req.params as { id: string }).id, user.orgId]);
      if (!res) return reply.code(404).send({ error: "not_found" });
      return { ok: true };
    });

    authed.post("/api/termsets/:id/terms", async (req, reply) => {
      const { user } = req as AuthedRequest;
      if (!orgAdmin(user.role)) return reply.code(403).send({ error: "forbidden" });
      const set = await one<{ id: string }>(
        "SELECT id FROM term_sets WHERE id = $1 AND org_id = $2",
        [(req.params as { id: string }).id, user.orgId]);
      if (!set) return reply.code(404).send({ error: "not_found" });
      const body = z.object({
        name: z.string().min(1).max(120),
        parentId: z.string().nullable().optional(),
        position: z.number().int().min(0).optional(),
      }).parse(req.body);
      // nested terms must live in the same set
      if (body.parentId) {
        const parent = await one("SELECT id FROM terms WHERE id = $1 AND set_id = $2", [body.parentId, set.id]);
        if (!parent) return reply.code(400).send({ error: "bad_request", message: "Parent term not in this set" });
      }
      const id = randomUUID();
      const pos = body.position ?? (await one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM terms WHERE set_id = $1", [set.id]))?.n ?? 0;
      await run("INSERT INTO terms (id, set_id, parent_id, name, position, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, set.id, body.parentId ?? null, encryptField(body.name), pos, now()]);
      const t = await one<{ id: string; set_id: string; parent_id: string | null; name: string; position: number }>(
        "SELECT * FROM terms WHERE id = $1", [id]);
      return { term: { id: t!.id, setId: t!.set_id, parentId: t!.parent_id, name: decryptField(t!.name) ?? t!.name, position: t!.position } };
    });

    authed.delete("/api/termsets/:id/terms/:tid", async (req, reply) => {
      const { user } = req as AuthedRequest;
      if (!orgAdmin(user.role)) return reply.code(403).send({ error: "forbidden" });
      const { id, tid } = req.params as { id: string; tid: string };
      const res = await run(
        `DELETE FROM terms WHERE id = $1 AND set_id IN (SELECT id FROM term_sets WHERE id = $2 AND org_id = $3)`,
        [tid, id, user.orgId]);
      if (!res) return reply.code(404).send({ error: "not_found" });
      return { ok: true };
    });

    // ---- content types (site-scoped) ----

    authed.get("/api/sites/:id/content-types", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const site = await getSite((req.params as { id: string }).id);
      const role = site ? await siteRoleFor(user, site) : null;
      if (!site || !role) return reply.code(404).send({ error: "not_found" });
      const rows = await q<CtRow>(
        "SELECT * FROM content_types WHERE site_id = $1 AND library_id IS NULL ORDER BY created_at",
        [site.id],
      );
      return { contentTypes: rows.map((r) => ctOut(r)) };
    });

    authed.post("/api/sites/:id/content-types", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const site = await getSite((req.params as { id: string }).id);
      const role = site ? await siteRoleFor(user, site) : null;
      if (!site || !atLeast(role, "owner")) return reply.code(403).send({ error: "forbidden" });
      const body = contentTypeSchema.parse(req.body);
      const id = randomUUID();
      await run(
        `INSERT INTO content_types (id, site_id, name, description, allowed_kinds, is_default, doc_set, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, site.id, encryptField(body.name), body.description ? encryptField(body.description) : null,
         JSON.stringify(body.allowedKinds), body.isDefault, body.docSet, now()],
      );
      const r = await one<CtRow>("SELECT * FROM content_types WHERE id = $1", [id]);
      if (!r) return reply.code(404).send({ error: "not_found" });
      return { contentType: ctOut(r) };
    });

    authed.patch("/api/sites/:id/content-types/:ctid", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const site = await getSite((req.params as { id: string }).id);
      const role = site ? await siteRoleFor(user, site) : null;
      if (!site || !atLeast(role, "owner")) return reply.code(403).send({ error: "forbidden" });
      const { ctid } = req.params as { ctid: string };
      const body = contentTypePatchSchema.parse(req.body);
      await run(
        `UPDATE content_types SET name = COALESCE($2, name), description = COALESCE($3, description),
         allowed_kinds = COALESCE($4, allowed_kinds), is_default = COALESCE($5, is_default),
         doc_set = COALESCE($6, doc_set)
         WHERE id = $1 AND site_id = $7`,
        [ctid, body.name === undefined ? null : encryptField(body.name),
         body.description === undefined ? null : encryptField(body.description),
         body.allowedKinds === undefined ? null : JSON.stringify(body.allowedKinds),
         body.isDefault === undefined ? null : body.isDefault,
         body.docSet === undefined ? null : body.docSet, site.id],
      );
      const r = await one<CtRow>("SELECT * FROM content_types WHERE id = $1", [ctid]);
      if (!r) return reply.code(404).send({ error: "not_found" });
      return { contentType: ctOut(r) };
    });

    authed.delete("/api/sites/:id/content-types/:ctid", async (req, reply) => {
      const { user } = req as AuthedRequest;
      const site = await getSite((req.params as { id: string }).id);
      const role = site ? await siteRoleFor(user, site) : null;
      if (!site || !atLeast(role, "owner")) return reply.code(403).send({ error: "forbidden" });
      const { ctid } = req.params as { ctid: string };
      await run("DELETE FROM content_types WHERE id = $1 AND site_id = $2", [ctid, site.id]);
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
      void logActivity(user.orgId, user.id, null, "library-create", `${body.name} @ ${decryptField(site.name) ?? site.name}`, site.id);
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
      // versioning + approval + inheritance + retention are governance knobs — owners only
      if ((body.versioning !== undefined || body.approval !== undefined || body.inherit !== undefined || body.retentionDays !== undefined) && !atLeast(role, "owner")) {
        return reply.code(403).send({ error: "forbidden", message: "Only site owners can change versioning, approval, permissions, or retention" });
      }
      if ((body.approval !== undefined || body.inherit !== undefined || body.retentionDays !== undefined) && !(await entitled(user.orgId, "docmgmt"))) {
        return reply.code(402).send({ error: "plan_limit", message: "This feature requires a paid plan" });
      }
      await run(`UPDATE libraries SET name = COALESCE($2, name), kind = COALESCE($3, kind),
        versioning = COALESCE($4, versioning), approval = COALESCE($5, approval),
        inherit_permissions = COALESCE($6, inherit_permissions),
        retention_days = CASE WHEN $8 THEN $7 ELSE retention_days END WHERE id = $1`,
        [lib.id, body.name === undefined ? null : encryptField(body.name), body.kind ?? null,
         body.versioning ?? null, body.approval ?? null, body.inherit ?? null,
         body.retentionDays !== undefined && body.retentionDays && body.retentionDays > 0 ? body.retentionDays : null,
         body.retentionDays !== undefined]);
      // retentionDays: explicit null/0 clears the rule
      // restoring inheritance discards unique grants (SharePoint behavior)
      if (body.inherit === true) {
        await run("DELETE FROM library_permissions WHERE library_id = $1", [lib.id]);
      }
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

    /** Resolve site+library+role for nested routes; null reply handled by
     *  caller. Role honors broken inheritance — an explicit library grantee
     *  reaches lib-scoped routes even without site membership, and a site
     *  member without a grant can't reach a non-inheriting library. */
    const libCtx = async (req: FastifyRequest, reply: FastifyReply) => {
      const { user } = req as AuthedRequest;
      const { id, lid } = req.params as { id: string; lid: string };
      const site = await getSite(id);
      const lib = site ? await getLibrary(lid) : undefined;
      const role = site && lib && lib.site_id === site.id
        ? await libraryRoleFor(user, site, lib)
        : null;
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
      // managed columns must bind to a term set owned by this org
      if (body.type === "managed") {
        if (!body.termSetId) {
          return reply.code(400).send({ error: "bad_request", message: "Managed columns need a term set" });
        }
        const ts = await one("SELECT id FROM term_sets WHERE id = $1 AND org_id = $2", [body.termSetId, ctx.user.orgId]);
        if (!ts) return reply.code(400).send({ error: "bad_request", message: "Unknown term set" });
      }
      const id = randomUUID();
      const pos = body.position ?? (await one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM library_columns WHERE library_id = $1", [ctx.lib.id]))?.n ?? 0;
      await run(
        `INSERT INTO library_columns (id, library_id, name, type, required, choices, term_set_id, position, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, ctx.lib.id, encryptField(body.name), body.type, body.required,
         body.choices ? JSON.stringify(body.choices) : null,
         body.type === "managed" ? body.termSetId : null, pos, now()],
      );
      return { column: colOut((await one<ColumnRow>("SELECT * FROM library_columns WHERE id = $1", [id]))!) };
    });

    authed.patch("/api/sites/:id/libraries/:lid/columns/:cid", async (req, reply) => {
      const ctx = await libCtx(req, reply);
      if (!ctx) return;
      if (!atLeast(ctx.role, "owner")) return reply.code(403).send({ error: "forbidden" });
      const { cid } = req.params as { cid: string };
      const body = columnSchema.partial().parse(req.body);
      // a managed column can be re-pointed at another org-owned term set
      if (body.termSetId) {
        const ts = await one("SELECT id FROM term_sets WHERE id = $1 AND org_id = $2", [body.termSetId, ctx.user.orgId]);
        if (!ts) return reply.code(400).send({ error: "bad_request", message: "Unknown term set" });
      }
      const res = await run(
        `UPDATE library_columns SET name = COALESCE($2, name), type = COALESCE($3, type),
         required = COALESCE($4, required), choices = COALESCE($5, choices), position = COALESCE($6, position),
         term_set_id = COALESCE($8, term_set_id)
         WHERE id = $1 AND library_id = $7`,
        [cid, body.name === undefined ? null : encryptField(body.name), body.type ?? null,
         body.required ?? null, body.choices === undefined ? null : JSON.stringify(body.choices),
         body.position ?? null, ctx.lib.id, body.termSetId ?? null],
      );
      if (!res) return reply.code(404).send({ error: "not_found" });
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

    /** Items whose head draft is awaiting approval — the approver's queue
     *  (site owners only; SharePoint "Approve/reject" list). */
    authed.get("/api/sites/:id/libraries/:lid/pending", async (req, reply) => {
      const ctx = await libCtx(req, reply);
      if (!ctx) return;
      if (!atLeast(ctx.role, "owner")) return reply.code(403).send({ error: "forbidden" });
      const rows = await q<{ id: string; name: string; updated_at: string; submitted_by: string; display_name: string }>(
        `SELECT i.id, i.name, i.updated_at, v.created_by AS submitted_by, u.display_name
         FROM items i
         JOIN versions v ON v.file_id = i.id AND v.pending
           AND v.number = (SELECT MAX(number) FROM versions WHERE file_id = i.id)
         JOIN users u ON u.id = v.created_by
         WHERE i.library_id = $1 AND NOT i.trashed AND i.kind != 'folder'
         ORDER BY i.updated_at DESC`,
        [ctx.lib.id],
      );
      return {
        pending: rows.map((r) => ({
          id: r.id, name: decryptField(r.name) ?? r.name,
          updatedAt: r.updated_at, submittedBy: r.display_name,
        })),
      };
    });

    // ---- unique library permissions (SharePoint "stop inheriting") ----

    /** Inherit flag + explicit grants on a broken-inheritance library. */
    authed.get("/api/sites/:id/libraries/:lid/permissions", async (req, reply) => {
      const ctx = await libCtx(req, reply);
      if (!ctx) return;
      if (!atLeast(ctx.role, "owner")) return reply.code(403).send({ error: "forbidden" });
      const rows = await q<{ user_id: string; role: SiteRole; created_at: string; display_name: string; email: string; initials: string }>(
        `SELECT lp.user_id, lp.role, lp.created_at, u.display_name, u.email, u.initials
         FROM library_permissions lp JOIN users u ON u.id = lp.user_id
         WHERE lp.library_id = $1 ORDER BY lp.created_at`,
        [ctx.lib.id],
      );
      return {
        inherit: !!ctx.lib.inherit_permissions,
        grants: rows.map((r) => memberOut(r.user_id, r.role, r, r.created_at)),
      };
    });

    authed.post("/api/sites/:id/libraries/:lid/permissions", async (req, reply) => {
      const ctx = await libCtx(req, reply);
      if (!ctx) return;
      if (!atLeast(ctx.role, "owner")) return reply.code(403).send({ error: "forbidden" });
      if (ctx.lib.inherit_permissions) {
        return reply.code(409).send({ error: "conflict", message: "Stop inheriting permissions before granting library access" });
      }
      const body = z.object({
        email: z.string().email(),
        role: z.enum(["owner", "member", "visitor"]).default("member"),
      }).parse(req.body);
      const target = await one<{ id: string; org_id: string }>(
        "SELECT id, org_id FROM users WHERE email = $1", [body.email]);
      if (!target || target.org_id !== ctx.user.orgId) {
        return reply.code(404).send({ error: "not_found", message: "No workspace member with that email" });
      }
      await run(
        `INSERT INTO library_permissions (library_id, user_id, role, created_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (library_id, user_id) DO UPDATE SET role = excluded.role`,
        [ctx.lib.id, target.id, body.role, now()],
      );
      void logActivity(ctx.user.orgId, ctx.user.id, null, "library-grant",
        `${body.email} → ${body.role} @ ${decryptField(ctx.lib.name) ?? ctx.lib.name}`, ctx.site.id);
      return { ok: true };
    });

    authed.delete("/api/sites/:id/libraries/:lid/permissions/:uid", async (req, reply) => {
      const ctx = await libCtx(req, reply);
      if (!ctx) return;
      if (!atLeast(ctx.role, "owner")) return reply.code(403).send({ error: "forbidden" });
      const { uid } = req.params as { uid: string };
      await run("DELETE FROM library_permissions WHERE library_id = $1 AND user_id = $2", [ctx.lib.id, uid]);
      return { ok: true };
    });

    // ---- content types (library-scoped) ----

    authed.get("/api/sites/:id/libraries/:lid/content-types", async (req, reply) => {
      const ctx = await libCtx(req, reply);
      if (!ctx) return;
      // the picker sees library-scoped types AND site-scoped ones (site types
      // are available in every library — SharePoint site content types)
      const rows = await q<CtRow>(
        `SELECT * FROM content_types WHERE site_id = $1 AND (library_id = $2 OR library_id IS NULL) ORDER BY created_at`,
        [ctx.site.id, ctx.lib.id],
      );
      const binds = rows.length ? await q<{ content_type_id: string; column_id: string; required: boolean; shared: boolean; position: number }>(
        `SELECT * FROM content_type_columns WHERE content_type_id = ANY($1) ORDER BY position`,
        [rows.map((r) => r.id)],
      ) : [];
      return {
        contentTypes: rows.map((r) => ctOut(r,
          binds.filter((b) => b.content_type_id === r.id)
            .map((b) => ({ columnId: b.column_id, required: !!b.required, shared: !!b.shared, position: b.position })))),
      };
    });

    authed.post("/api/sites/:id/libraries/:lid/content-types", async (req, reply) => {
      const ctx = await libCtx(req, reply);
      if (!ctx) return;
      if (!atLeast(ctx.role, "owner")) return reply.code(403).send({ error: "forbidden" });
      const body = contentTypeSchema.parse(req.body);
      const id = randomUUID();
      await run(
        `INSERT INTO content_types (id, site_id, library_id, name, description, allowed_kinds, is_default, doc_set, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, ctx.site.id, ctx.lib.id, encryptField(body.name), body.description ? encryptField(body.description) : null,
         JSON.stringify(body.allowedKinds), body.isDefault, body.docSet, now()],
      );
      const r = await one<CtRow>("SELECT * FROM content_types WHERE id = $1", [id]);
      if (!r) return reply.code(404).send({ error: "not_found" });
      return { contentType: ctOut(r) };
    });

    authed.patch("/api/sites/:id/libraries/:lid/content-types/:ctid", async (req, reply) => {
      const ctx = await libCtx(req, reply);
      if (!ctx) return;
      if (!atLeast(ctx.role, "owner")) return reply.code(403).send({ error: "forbidden" });
      const { ctid } = req.params as { ctid: string };
      const body = contentTypePatchSchema.parse(req.body);
      await run(
        `UPDATE content_types SET name = COALESCE($2, name), description = COALESCE($3, description),
         allowed_kinds = COALESCE($4, allowed_kinds), is_default = COALESCE($5, is_default),
         doc_set = COALESCE($6, doc_set)
         WHERE id = $1 AND site_id = $7 AND library_id = $8`,
        [ctid, body.name === undefined ? null : encryptField(body.name),
         body.description === undefined ? null : encryptField(body.description),
         body.allowedKinds === undefined ? null : JSON.stringify(body.allowedKinds),
         body.isDefault === undefined ? null : body.isDefault,
         body.docSet === undefined ? null : body.docSet, ctx.site.id, ctx.lib.id],
      );
      const r = await one<CtRow>("SELECT * FROM content_types WHERE id = $1", [ctid]);
      if (!r) return reply.code(404).send({ error: "not_found" });
      return { contentType: ctOut(r) };
    });

    /** Bind library columns to a content type — the schema's field set.
     *  required here overrides the column's global required flag for items
     *  of this type. Replaces the binding set wholesale. */
    authed.put("/api/sites/:id/libraries/:lid/content-types/:ctid/columns", async (req, reply) => {
      const ctx = await libCtx(req, reply);
      if (!ctx) return;
      if (!atLeast(ctx.role, "owner")) return reply.code(403).send({ error: "forbidden" });
      const { ctid } = req.params as { ctid: string };
      const ct = await one<{ id: string }>(
        "SELECT id FROM content_types WHERE id = $1 AND site_id = $2", [ctid, ctx.site.id]);
      if (!ct) return reply.code(404).send({ error: "not_found" });
      const body = z.object({
        columns: z.array(z.object({
          columnId: z.string(),
          required: z.boolean().default(false),
          /** doc-set types: value propagates to items placed inside */
          shared: z.boolean().default(false),
          position: z.number().int().min(0).default(0),
        })).max(100),
      }).parse(req.body);
      // all bound columns must belong to this library
      const valid = await q<{ id: string }>(
        "SELECT id FROM library_columns WHERE id = ANY($1) AND library_id = $2",
        [body.columns.map((c) => c.columnId), ctx.lib.id]);
      const validIds = new Set(valid.map((v) => v.id));
      await run("DELETE FROM content_type_columns WHERE content_type_id = $1", [ctid]);
      for (const c of body.columns.filter((x) => validIds.has(x.columnId))) {
        await run(
          `INSERT INTO content_type_columns (content_type_id, column_id, required, shared, position)
           VALUES ($1,$2,$3,$4,$5)`,
          [ctid, c.columnId, c.required, c.shared, c.position],
        );
      }
      const binds = await q<{ column_id: string; required: boolean; shared: boolean; position: number }>(
        "SELECT * FROM content_type_columns WHERE content_type_id = $1 ORDER BY position", [ctid]);
      return {
        columns: binds.map((b) => ({ columnId: b.column_id, required: !!b.required, shared: !!b.shared, position: b.position })),
      };
    });

    authed.delete("/api/sites/:id/libraries/:lid/content-types/:ctid", async (req, reply) => {
      const ctx = await libCtx(req, reply);
      if (!ctx) return;
      if (!atLeast(ctx.role, "owner")) return reply.code(403).send({ error: "forbidden" });
      const { ctid } = req.params as { ctid: string };
      await run("DELETE FROM content_types WHERE id = $1 AND site_id = $2 AND library_id = $3", [ctid, ctx.site.id, ctx.lib.id]);
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
