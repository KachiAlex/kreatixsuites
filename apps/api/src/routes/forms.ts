// Kreatix Forms — org forms with public share-token submission (Microsoft
// Forms model). Management routes are org-scoped + authed; the public
// view/submit pair lives in formPublicRoutes with no JWT (token-gated).
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { q, one, run } from "../db.js";
import { encryptField, decryptField } from "../crypto.js";
import { fireTrigger } from "../rules.js";

const FIELD_TYPES = ["text", "textarea", "email", "number", "date", "choice", "checkbox", "rating"] as const;
const fieldSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().trim().min(1).max(300),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(200)).max(50).optional(), // choice
});
const formSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  fields: z.array(fieldSchema).min(1).max(50),
  open: z.boolean().optional(),
});
type Field = z.infer<typeof fieldSchema>;

interface FormRow {
  id: string; org_id: string; title: string; description: string | null;
  schema: string; open: boolean; token: string;
  created_by: string; created_at: string; updated_at: string;
  creator_name?: string; response_count?: number;
}
interface RespRow { id: string; answers: string; respondent: string | null; created_at: string }

const dec = (v: string | null | undefined) => (v ? decryptField(v) ?? v : null);
const fieldsOf = (r: FormRow): Field[] => {
  try { return JSON.parse(decryptField(r.schema) ?? r.schema) as Field[]; } catch { return []; }
};
const formOut = (r: FormRow) => ({
  id: r.id, title: dec(r.title), description: dec(r.description),
  fields: fieldsOf(r), open: r.open, token: r.token,
  createdBy: r.created_by, createdByName: r.creator_name ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at,
  responses: Number(r.response_count ?? 0),
});

/** Validate an answers payload against the form's field schema. */
function validateAnswers(fields: Field[], answers: Record<string, unknown>): { ok: boolean; error?: string; clean: Record<string, string | boolean | number> } {
  const clean: Record<string, string | boolean | number> = {};
  for (const f of fields) {
    const v = answers[f.id];
    const empty = v === undefined || v === null || v === "";
    if (f.required && empty) return { ok: false, error: `"${f.label}" is required`, clean };
    if (empty) continue;
    switch (f.type) {
      case "checkbox": clean[f.id] = v === true || v === "true"; break;
      case "rating": {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 5) return { ok: false, error: `"${f.label}" must be 1-5`, clean };
        clean[f.id] = n; break;
      }
      case "number": {
        const n = Number(v);
        if (!Number.isFinite(n)) return { ok: false, error: `"${f.label}" must be a number`, clean };
        clean[f.id] = n; break;
      }
      case "choice": {
        const s = String(v).slice(0, 200);
        if (f.options?.length && !f.options.includes(s))
          return { ok: false, error: `"${f.label}" has an invalid option`, clean };
        clean[f.id] = s; break;
      }
      case "date": {
        const s = String(v).slice(0, 40);
        if (isNaN(Date.parse(s))) return { ok: false, error: `"${f.label}" must be a date`, clean };
        clean[f.id] = s; break;
      }
      default: clean[f.id] = String(v).slice(0, f.type === "textarea" ? 8000 : 500);
    }
  }
  return { ok: true, clean };
}

export function formRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  const getForm = async (id: string, orgId: string) =>
    one<FormRow>(
      `SELECT f.*, u.display_name AS creator_name,
              (SELECT count(*) FROM form_responses r WHERE r.form_id = f.id) AS response_count
       FROM forms f JOIN users u ON u.id = f.created_by
       WHERE f.id = $1 AND f.org_id = $2`, [id, orgId]);
  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: "not_found", message: "Form not found" });

  app.get("/api/forms", async (req) => {
    const { user } = req as AuthedRequest;
    const rows = await q<FormRow>(
      `SELECT f.*, u.display_name AS creator_name,
              (SELECT count(*) FROM form_responses r WHERE r.form_id = f.id) AS response_count
       FROM forms f JOIN users u ON u.id = f.created_by
       WHERE f.org_id = $1 ORDER BY f.updated_at DESC LIMIT 200`, [user.orgId]);
    return { forms: rows.map(formOut) };
  });

  app.post("/api/forms", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const parsed = formSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid form" });
    const d = parsed.data;
    const row = await one<FormRow>(
      `INSERT INTO forms (id, org_id, title, description, schema, open, token, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [randomUUID(), user.orgId, encryptField(d.title) ?? d.title,
       d.description ? encryptField(d.description) ?? d.description : null,
       encryptField(JSON.stringify(d.fields)) ?? JSON.stringify(d.fields),
       d.open ?? true, `f-${randomBytes(9).toString("hex")}`, user.id]);
    return reply.code(201).send({ form: formOut({ ...row!, creator_name: user.displayName }) });
  });

  app.patch("/api/forms/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const f = await getForm((req.params as { id: string }).id, user.orgId);
    if (!f) return notFound(reply);
    if (f.created_by !== user.id && user.role !== "owner" && user.role !== "admin")
      return reply.code(403).send({ error: "forbidden", message: "Only the creator can edit" });
    const parsed = formSchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid form" });
    const d = parsed.data;
    const row = await one<FormRow>(
      `UPDATE forms SET
         title = COALESCE($2, title), description = COALESCE($3, description),
         schema = COALESCE($4, schema), open = COALESCE($5, open), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [f.id, d.title ? encryptField(d.title) ?? d.title : null,
       d.description !== undefined ? (d.description ? encryptField(d.description) ?? d.description : null) : null,
       d.fields ? encryptField(JSON.stringify(d.fields)) ?? JSON.stringify(d.fields) : null,
       d.open ?? null]);
    return { form: formOut({ ...row!, creator_name: f.creator_name }) };
  });

  app.delete("/api/forms/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const f = await getForm((req.params as { id: string }).id, user.orgId);
    if (!f) return notFound(reply);
    if (f.created_by !== user.id && user.role !== "owner" && user.role !== "admin")
      return reply.code(403).send({ error: "forbidden", message: "Only the creator can delete" });
    await run("DELETE FROM forms WHERE id = $1", [f.id]);
    return { ok: true };
  });

  /** Response rows — creator/admins only (respondent data is sensitive). */
  app.get("/api/forms/:id/responses", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const f = await getForm((req.params as { id: string }).id, user.orgId);
    if (!f) return notFound(reply);
    if (f.created_by !== user.id && user.role !== "owner" && user.role !== "admin")
      return reply.code(403).send({ error: "forbidden", message: "Only the creator sees responses" });
    const rows = await q<RespRow>(
      "SELECT id, answers, respondent, created_at FROM form_responses WHERE form_id = $1 ORDER BY created_at DESC LIMIT 500",
      [f.id]);
    return {
      form: formOut(f),
      responses: rows.map((r) => {
        let answers: Record<string, unknown> = {};
        try { answers = JSON.parse(decryptField(r.answers) ?? r.answers); } catch { /* malformed */ }
        return { id: r.id, answers, respondent: dec(r.respondent), createdAt: r.created_at };
      }),
    };
  });
}

/** Public (token-gated, no JWT) — view + submit an open form. */
export function formPublicRoutes(app: FastifyInstance) {
  const byToken = (token: string) =>
    one<FormRow>("SELECT * FROM forms WHERE token = $1", [token]);

  app.get("/api/forms/public/:token", async (req, reply) => {
    const f = await byToken((req.params as { token: string }).token);
    if (!f || !f.open) return reply.code(404).send({ error: "not_found", message: "Form unavailable" });
    return { form: { title: dec(f.title), description: dec(f.description), fields: fieldsOf(f) } };
  });

  app.post("/api/forms/public/:token", async (req, reply) => {
    const f = await byToken((req.params as { token: string }).token);
    if (!f || !f.open) return reply.code(404).send({ error: "not_found", message: "Form unavailable" });
    const { answers, respondent } = (req.body ?? {}) as { answers?: Record<string, unknown>; respondent?: string };
    if (!answers || typeof answers !== "object")
      return reply.code(400).send({ error: "invalid", message: "Expected { answers }" });
    const v = validateAnswers(fieldsOf(f), answers);
    if (!v.ok) return reply.code(400).send({ error: "invalid", message: v.error });
    await run(
      "INSERT INTO form_responses (id, form_id, answers, respondent) VALUES ($1,$2,$3,$4)",
      [randomUUID(), f.id,
       encryptField(JSON.stringify(v.clean)) ?? JSON.stringify(v.clean),
       respondent ? encryptField(String(respondent).slice(0, 200)) ?? String(respondent).slice(0, 200) : null]);
    void run(
      `INSERT INTO notifications (id, user_id, kind, actor_id, message)
       VALUES ($1,$2,'form',$3,$4)`,
      [randomUUID(), f.created_by, f.created_by,
       encryptField(`New response: ${dec(f.title) ?? "form"}`)]);
    void fireTrigger(f.org_id, "form.submitted",
      { formId: f.id, name: dec(f.title) ?? "form", respondent: respondent ? String(respondent).slice(0, 120) : "" },
      app.log);
    return reply.code(201).send({ ok: true });
  });
}
