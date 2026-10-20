// Kreatix Forms — org forms with public share-token submission.
// Management routes are org-scoped + authed; the public view/submit/file
// upload pair lives in formPublicRoutes with no JWT (token-gated; an
// optional session is resolved for signed-in submission modes).
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth, resolveSession, type AuthedRequest } from "../auth.js";
import { q, one, run, now } from "../db.js";
import { encryptField, decryptField } from "../crypto.js";
import { fireTrigger } from "../rules.js";
import { storageQuota } from "../billing.js";
import { putBlob } from "../blobs.js";
import { scanDlp } from "../policies.js";
import { BLOCKED_EXTS, sniffReject, scanBuffer, buffer } from "./drive.js";
import { logActivity } from "../items.js";

export const FIELD_TYPES = [
  "text", "textarea", "email", "number", "date", "time", "url", "phone",
  "choice", "multiselect", "checkbox", "rating", "scale", "section", "file",
] as const;

const fieldSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().trim().min(1).max(300),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  description: z.string().trim().max(500).optional(),          // help text
  options: z.array(z.string().trim().min(1).max(200)).max(100).optional(), // choice/multiselect
  allowOther: z.boolean().optional(),                          // free-text extra
  min: z.number().optional(), max: z.number().optional(),      // number bounds
  minLen: z.number().int().min(0).max(8000).optional(),        // text bounds
  maxLen: z.number().int().min(1).max(8000).optional(),
  scaleMin: z.number().int().min(0).max(100).optional(),       // linear scale
  scaleMax: z.number().int().min(1).max(100).optional(),
  scaleLow: z.string().trim().max(100).optional(),             // scale endpoint labels
  scaleHigh: z.string().trim().max(100).optional(),
  showIf: z.object({ field: z.string().max(40), equals: z.string().max(200) }).optional(),
  correct: z.string().max(200).optional(),                     // quiz answer key
  points: z.number().min(0).max(1000).optional(),              // quiz weight
});

const settingsSchema = z.object({
  confirmMsg: z.string().trim().max(1000).optional(),
  closeAt: z.string().trim().max(40).optional(),               // ISO — auto-close
  closeAfter: z.number().int().min(1).max(1_000_000).optional(), // N responses — auto-close
  requireSignIn: z.boolean().optional(),                       // any authed user
  orgOnly: z.boolean().optional(),                             // same-org members only
  onePerUser: z.boolean().optional(),                          // dedupe signed-in submits
  collectName: z.boolean().optional(),                         // show free-text name field
  showProgress: z.boolean().optional(),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),    // public page brand color
  layout: z.enum(["classic", "chat"]).optional(),              // chat = one-at-a-time
  quiz: z.boolean().optional(),                                // score vs `correct` keys
  dlp: z.boolean().optional(),                                 // scan answers vs DLP rules
  requiresReview: z.boolean().optional(),                      // responses land pending
  retentionDays: z.number().int().min(1).max(3650).optional(),
  shuffleOptions: z.boolean().optional(),
});

const formSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  fields: z.array(fieldSchema).min(1).max(100),
  open: z.boolean().optional(),
  settings: settingsSchema.optional(),
});

export type Field = z.infer<typeof fieldSchema>;
export type FormSettings = z.infer<typeof settingsSchema>;

interface FormRow {
  id: string; org_id: string; title: string; description: string | null;
  schema: string; settings: string | null; open: boolean; token: string;
  created_by: string; created_at: string; updated_at: string;
  creator_name?: string; response_count?: number;
}
interface RespRow {
  id: string; answers: string; respondent: string | null;
  respondent_user_id: string | null; status: string; score: string | null; // NUMERIC → string
  created_at: string; resp_email?: string | null; resp_name?: string | null;
}

const dec = (v: string | null | undefined) => (v ? decryptField(v) ?? v : null);
const fieldsOf = (r: FormRow): Field[] => {
  try { return JSON.parse(decryptField(r.schema) ?? r.schema) as Field[]; } catch { return []; }
};
const settingsOf = (r: FormRow): FormSettings => {
  try { return JSON.parse(decryptField(r.settings) ?? r.settings ?? "{}") as FormSettings; }
  catch { return {}; }
};
const formOut = (r: FormRow) => ({
  id: r.id, title: dec(r.title), description: dec(r.description),
  fields: fieldsOf(r), settings: settingsOf(r), open: r.open, token: r.token,
  createdBy: r.created_by, createdByName: r.creator_name ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at,
  responses: Number(r.response_count ?? 0),
});

/** Fields visible given the current answers — showIf is evaluated the same
 *  way here and on the client so hidden required fields never block. */
const visibleFields = (fields: Field[], answers: Record<string, unknown>) =>
  fields.filter((f) => f.type === "section" ||
    !f.showIf || String(answers[f.showIf.field] ?? "") === f.showIf.equals);

const bad = (error: string, clean: Record<string, unknown>) => ({ ok: false as const, error, clean });
const ok = (clean: Record<string, unknown>) => ({ ok: true as const, clean });

/** Validate + normalize an answers payload against the field schema. File
 *  answers are checked against form_uploads so a respondent can't point at
 *  someone else's Drive item. */
async function validateAnswers(
  form: FormRow, fields: Field[], answers: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; clean: Record<string, unknown> }> {
  const clean: Record<string, unknown> = {};
  const seen = new Set(visibleFields(fields, answers).map((f) => f.id));
  for (const f of fields) {
    if (f.type === "section" || !seen.has(f.id)) continue;
    const v = answers[f.id];
    const empty = v === undefined || v === null || v === "" ||
      (Array.isArray(v) && !v.length);
    if (f.required && empty) return bad(`"${f.label}" is required`, clean);
    if (empty) continue;
    switch (f.type) {
      case "checkbox": clean[f.id] = v === true || v === "true"; break;
      case "rating": {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 5) return bad(`"${f.label}" must be 1-5`, clean);
        clean[f.id] = n; break;
      }
      case "scale": {
        const lo = f.scaleMin ?? 1, hi = f.scaleMax ?? 10;
        const n = Number(v);
        if (!Number.isInteger(n) || n < lo || n > hi)
          return bad(`"${f.label}" must be ${lo}-${hi}`, clean);
        clean[f.id] = n; break;
      }
      case "number": {
        const n = Number(v);
        if (!Number.isFinite(n)) return bad(`"${f.label}" must be a number`, clean);
        if (f.min !== undefined && n < f.min) return bad(`"${f.label}" must be at least ${f.min}`, clean);
        if (f.max !== undefined && n > f.max) return bad(`"${f.label}" must be at most ${f.max}`, clean);
        clean[f.id] = n; break;
      }
      case "email": {
        const s = String(v).slice(0, 200);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return bad(`"${f.label}" must be an email`, clean);
        clean[f.id] = s; break;
      }
      case "url": {
        const s = String(v).slice(0, 500);
        try { const u = new URL(s); if (!/^https?:$/.test(u.protocol)) throw 0; }
        catch { return bad(`"${f.label}" must be a valid http(s) URL`, clean); }
        clean[f.id] = s; break;
      }
      case "phone": {
        const s = String(v).slice(0, 40);
        if (!/^\+?[\d][\d .\-()]{4,28}$/.test(s)) return bad(`"${f.label}" must be a phone number`, clean);
        clean[f.id] = s; break;
      }
      case "time": {
        const s = String(v).slice(0, 8);
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) return bad(`"${f.label}" must be a time`, clean);
        clean[f.id] = s; break;
      }
      case "choice": {
        const s = String(v).slice(0, 200);
        if (f.options?.length && !f.options.includes(s) && !f.allowOther)
          return bad(`"${f.label}" has an invalid option`, clean);
        clean[f.id] = s; break;
      }
      case "multiselect": {
        if (!Array.isArray(v)) return bad(`"${f.label}" must be a list`, clean);
        const picks = [...new Set(v.map((x) => String(x).slice(0, 200)))].slice(0, 50);
        if (f.options?.length)
          for (const p of picks)
            if (!f.options.includes(p) && !f.allowOther)
              return bad(`"${f.label}" has an invalid option`, clean);
        clean[f.id] = picks; break;
      }
      case "date": {
        const s = String(v).slice(0, 40);
        if (isNaN(Date.parse(s))) return bad(`"${f.label}" must be a date`, clean);
        clean[f.id] = s; break;
      }
      case "file": {
        const o = v as { itemId?: unknown; name?: unknown };
        const itemId = typeof o?.itemId === "string" ? o.itemId.slice(0, 64) : "";
        const name = typeof o?.name === "string" ? o.name.slice(0, 300) : "";
        const up = itemId && await one(
          "SELECT item_id FROM form_uploads WHERE form_id = $1 AND item_id = $2",
          [form.id, itemId]);
        if (!up) return bad(`"${f.label}" needs a file uploaded through this form`, clean);
        clean[f.id] = { itemId, name }; break;
      }
      default: {
        const cap = f.type === "textarea" ? 8000 : 500;
        const s = String(v).slice(0, cap);
        if (f.minLen !== undefined && s.length < f.minLen)
          return bad(`"${f.label}" needs at least ${f.minLen} characters`, clean);
        if (f.maxLen !== undefined && s.length > f.maxLen)
          return bad(`"${f.label}" is over ${f.maxLen} characters`, clean);
        clean[f.id] = s;
      }
    }
  }
  return ok(clean);
}

/** Quiz mode: sum `points` (default 1) for answers matching `correct`. */
function scoreAnswers(fields: Field[], clean: Record<string, unknown>): { score: number; max: number } {
  let score = 0, max = 0;
  for (const f of fields) {
    if (!f.correct) continue;
    const pts = f.points ?? 1;
    max += pts;
    const a = clean[f.id];
    if (Array.isArray(a) ? a.includes(f.correct) : String(a ?? "") === f.correct) score += pts;
  }
  return { score, max };
}

/** open flag + scheduled/cap closes — returns a reason or null when live. */
async function closedReason(f: FormRow, s: FormSettings): Promise<string | null> {
  if (!f.open) return "This form is closed.";
  if (s.closeAt && Date.parse(s.closeAt) <= Date.now()) return "This form is closed.";
  if (s.closeAfter) {
    const c = await one<{ n: string }>(
      "SELECT count(*) AS n FROM form_responses WHERE form_id = $1", [f.id]);
    if (Number(c?.n ?? 0) >= s.closeAfter) return "This form has reached its response limit.";
  }
  return null;
}

const csvCell = (v: unknown): string => {
  const s = Array.isArray(v) ? v.join("; ")
    : typeof v === "object" && v !== null ? (v as { name?: string }).name ?? JSON.stringify(v)
    : v === true ? "Yes" : v === false ? "No" : v === undefined || v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Daily retention sweep — deletes responses older than the form's
 *  retentionDays setting (org data-minimization / GDPR posture). */
export async function sweepFormRetention(): Promise<number> {
  const forms = await q<FormRow>("SELECT id, settings FROM forms WHERE settings IS NOT NULL");
  let deleted = 0;
  for (const f of forms) {
    const days = settingsOf(f).retentionDays;
    if (!days) continue;
    deleted += await run(
      `DELETE FROM form_responses WHERE form_id = $1 AND created_at < now() - ($2 || ' days')::interval`,
      [f.id, days]);
  }
  return deleted;
}

const FORM_SELECT = `
  SELECT f.*, u.display_name AS creator_name,
         (SELECT count(*) FROM form_responses r WHERE r.form_id = f.id) AS response_count
  FROM forms f JOIN users u ON u.id = f.created_by`;

export function formRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  const getForm = async (id: string, orgId: string) =>
    one<FormRow>(`${FORM_SELECT} WHERE f.id = $1 AND f.org_id = $2`, [id, orgId]);
  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: "not_found", message: "Form not found" });
  const notOwner = (reply: FastifyReply) =>
    reply.code(403).send({ error: "forbidden", message: "Only the creator can do that" });
  const canManage = (f: FormRow, user: AuthedRequest["user"]) =>
    f.created_by === user.id || user.role === "owner" || user.role === "admin";

  app.get("/api/forms", async (req) => {
    const { user } = req as AuthedRequest;
    const rows = await q<FormRow>(`${FORM_SELECT} WHERE f.org_id = $1 ORDER BY f.updated_at DESC LIMIT 200`, [user.orgId]);
    return { forms: rows.map(formOut) };
  });

  app.post("/api/forms", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const parsed = formSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid form" });
    const d = parsed.data;
    const row = await one<FormRow>(
      `INSERT INTO forms (id, org_id, title, description, schema, settings, open, token, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [randomUUID(), user.orgId, encryptField(d.title) ?? d.title,
       d.description ? encryptField(d.description) ?? d.description : null,
       encryptField(JSON.stringify(d.fields)) ?? JSON.stringify(d.fields),
       d.settings ? encryptField(JSON.stringify(d.settings)) ?? JSON.stringify(d.settings) : null,
       d.open ?? true, `f-${randomBytes(9).toString("hex")}`, user.id]);
    return reply.code(201).send({ form: formOut({ ...row!, creator_name: user.displayName }) });
  });

  app.patch("/api/forms/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const f = await getForm((req.params as { id: string }).id, user.orgId);
    if (!f) return notFound(reply);
    if (!canManage(f, user)) return notOwner(reply);
    const parsed = formSchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid form" });
    const d = parsed.data;
    const row = await one<FormRow>(
      `UPDATE forms SET
         title = COALESCE($2, title), description = COALESCE($3, description),
         schema = COALESCE($4, schema), settings = COALESCE($5, settings),
         open = COALESCE($6, open), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [f.id, d.title ? encryptField(d.title) ?? d.title : null,
       d.description !== undefined ? (d.description ? encryptField(d.description) ?? d.description : null) : null,
       d.fields ? encryptField(JSON.stringify(d.fields)) ?? JSON.stringify(d.fields) : null,
       d.settings !== undefined
         ? (d.settings ? encryptField(JSON.stringify(d.settings)) ?? JSON.stringify(d.settings) : null)
         : null,
       d.open ?? null]);
    return { form: formOut({ ...row!, creator_name: f.creator_name }) };
  });

  app.delete("/api/forms/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const f = await getForm((req.params as { id: string }).id, user.orgId);
    if (!f) return notFound(reply);
    if (!canManage(f, user)) return notOwner(reply);
    await run("DELETE FROM forms WHERE id = $1", [f.id]);
    return { ok: true };
  });

  /** Copy schema + settings under a fresh token ("Intake form (copy)"). */
  app.post("/api/forms/:id/duplicate", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const f = await getForm((req.params as { id: string }).id, user.orgId);
    if (!f) return notFound(reply);
    const title = `${dec(f.title) ?? "Untitled"} (copy)`.slice(0, 200);
    const row = await one<FormRow>(
      `INSERT INTO forms (id, org_id, title, description, schema, settings, open, token, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8) RETURNING *`,
      [randomUUID(), user.orgId, encryptField(title) ?? title, f.description,
       f.schema, f.settings, `f-${randomBytes(9).toString("hex")}`, user.id]);
    return reply.code(201).send({ form: formOut({ ...row!, creator_name: user.displayName }) });
  });

  /** Response rows — creator/admins only (respondent data is sensitive). */
  app.get("/api/forms/:id/responses", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const f = await getForm((req.params as { id: string }).id, user.orgId);
    if (!f) return notFound(reply);
    if (!canManage(f, user)) return notOwner(reply);
    const rows = await q<RespRow>(
      `SELECT r.*, u.email AS resp_email, u.display_name AS resp_name
       FROM form_responses r LEFT JOIN users u ON u.id = r.respondent_user_id
       WHERE r.form_id = $1 ORDER BY r.created_at DESC LIMIT 5000`, [f.id]);
    return {
      form: formOut(f),
      responses: rows.map((r) => {
        let answers: Record<string, unknown> = {};
        try { answers = JSON.parse(decryptField(r.answers) ?? r.answers); } catch { /* malformed */ }
        return {
          id: r.id, answers, status: r.status,
          score: r.score === null ? null : Number(r.score),
          respondent: r.resp_email ?? r.resp_name ?? dec(r.respondent),
          verified: !!r.respondent_user_id, createdAt: r.created_at,
        };
      }),
    };
  });

  /** All responses as CSV — spreadsheet round-trip without leaving the suite. */
  app.get("/api/forms/:id/responses.csv", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const f = await getForm((req.params as { id: string }).id, user.orgId);
    if (!f) return notFound(reply);
    if (!canManage(f, user)) return notOwner(reply);
    const s = settingsOf(f);
    const fields = fieldsOf(f).filter((x) => x.type !== "section");
    const rows = await q<RespRow>(
      `SELECT r.*, u.email AS resp_email FROM form_responses r
       LEFT JOIN users u ON u.id = r.respondent_user_id
       WHERE r.form_id = $1 ORDER BY r.created_at`, [f.id]);
    const head = ["Submitted", "Status", "Respondent", ...fields.map((x) => x.label), ...(s.quiz ? ["Score"] : [])];
    const lines = [head.map(csvCell).join(",")];
    for (const r of rows) {
      let answers: Record<string, unknown> = {};
      try { answers = JSON.parse(decryptField(r.answers) ?? r.answers); } catch { /* malformed */ }
      lines.push([
        r.created_at, r.status, r.resp_email ?? dec(r.respondent) ?? "",
        ...fields.map((x) => answers[x.id]),
        ...(s.quiz ? [r.score ?? ""] : []),
      ].map(csvCell).join(","));
    }
    reply.header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${(dec(f.title) ?? "responses").replace(/[^\w-]+/g, "_")}.csv"`);
    return reply.send("\uFEFF" + lines.join("\n")); // BOM so Excel detects UTF-8
  });

  /** Per-question aggregates for the summary view (approved responses only). */
  app.get("/api/forms/:id/summary", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const f = await getForm((req.params as { id: string }).id, user.orgId);
    if (!f) return notFound(reply);
    if (!canManage(f, user)) return notOwner(reply);
    const fields = fieldsOf(f).filter((x) => x.type !== "section" && x.type !== "file");
    const rows = await q<{ answers: string; score: string | null }>(
      "SELECT answers, score FROM form_responses WHERE form_id = $1 AND status = 'approved' LIMIT 20000",
      [f.id]);
    const answers = rows.map((r) => {
      try { return JSON.parse(decryptField(r.answers) ?? r.answers) as Record<string, unknown>; }
      catch { return {}; }
    });
    const summary = fields.map((fd) => {
      const vals = answers.map((a) => a[fd.id]).filter((v) =>
        v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length));
      const out: Record<string, unknown> = { id: fd.id, label: fd.label, type: fd.type, answered: vals.length };
      if (fd.type === "choice" || fd.type === "rating" || fd.type === "checkbox") {
        const counts: Record<string, number> = {};
        for (const v of vals) { const k = String(v === true ? "Yes" : v === false ? "No" : v); counts[k] = (counts[k] ?? 0) + 1; }
        out.buckets = Object.entries(counts).map(([v, n]) => ({ v, n })).sort((a, b) => b.n - a.n);
      } else if (fd.type === "multiselect") {
        const counts: Record<string, number> = {};
        for (const v of vals) for (const p of (Array.isArray(v) ? v : [])) counts[p] = (counts[p] ?? 0) + 1;
        out.buckets = Object.entries(counts).map(([v, n]) => ({ v, n })).sort((a, b) => b.n - a.n);
      } else if (fd.type === "scale" || fd.type === "number") {
        const nums = vals.map(Number).filter(Number.isFinite);
        out.buckets = Object.entries(nums.reduce<Record<string, number>>((m, n) => ({ ...m, [n]: (m[n] ?? 0) + 1 }), {}))
          .map(([v, n]) => ({ v, n })).sort((a, b) => Number(a.v) - Number(b.v));
        out.avg = nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null;
      } else {
        out.samples = vals.slice(0, 10).map(String);
      }
      return out;
    });
    const scores = rows.map((r) => (r.score === null ? null : Number(r.score))).filter((x): x is number => x !== null);
    return {
      form: formOut(f), total: answers.length,
      avgScore: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null,
      summary,
    };
  });

  app.patch("/api/forms/:id/responses/:rid", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const f = await getForm((req.params as { id: string }).id, user.orgId);
    if (!f) return notFound(reply);
    if (!canManage(f, user)) return notOwner(reply);
    const status = (req.body as { status?: string })?.status;
    if (!["approved", "rejected", "pending"].includes(status ?? ""))
      return reply.code(400).send({ error: "invalid", message: "Expected status" });
    const n = await run(
      "UPDATE form_responses SET status = $2 WHERE id = $3 AND form_id = $1",
      [f.id, status, (req.params as { rid: string }).rid]);
    return { ok: n > 0 };
  });

  app.delete("/api/forms/:id/responses/:rid", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const f = await getForm((req.params as { id: string }).id, user.orgId);
    if (!f) return notFound(reply);
    if (!canManage(f, user)) return notOwner(reply);
    await run("DELETE FROM form_responses WHERE id = $1 AND form_id = $2",
      [(req.params as { rid: string }).rid, f.id]);
    return { ok: true };
  });
}

/** Public (token-gated, no JWT) — view, submit, and file upload. Signed-in
 *  modes resolve an optional session; anonymous still works when the form
 *  doesn't require it. */
export function formPublicRoutes(app: FastifyInstance) {
  const byToken = (token: string) =>
    one<FormRow>("SELECT * FROM forms WHERE token = $1", [token]);

  app.get("/api/forms/public/:token", async (req, reply) => {
    const f = await byToken((req.params as { token: string }).token);
    if (!f) return reply.code(404).send({ error: "not_found", message: "Form unavailable" });
    const s = settingsOf(f);
    const closed = await closedReason(f, s);
    // `correct`/`points` are the quiz answer key — never ship them to the
    // public page, or anyone can read the answers out of the payload
    const pubFields = closed ? [] : fieldsOf(f).map(({ correct: _c, points: _p, ...rest }) => rest);
    return {
      form: {
        title: dec(f.title), description: dec(f.description), fields: pubFields,
        closedReason: closed, confirmMsg: s.confirmMsg ?? null,
        collectName: s.collectName !== false, layout: s.layout ?? "classic",
        showProgress: !!s.showProgress, accent: s.accent ?? null,
        requireSignIn: !!(s.requireSignIn || s.orgOnly || s.onePerUser),
        orgOnly: !!s.orgOnly, quiz: !!s.quiz,
        shuffleOptions: !!s.shuffleOptions,
      },
    };
  });

  /** File-field upload — token-gated, lands as a Drive item owned by the
   *  form's creator; form_uploads ties it to this form so submissions can't
   *  reference arbitrary items. 25 MB cap. */
  app.post("/api/forms/public/:token/files", {
    bodyLimit: 30 * 1024 * 1024,
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const f = await byToken((req.params as { token: string }).token);
    const s = f ? settingsOf(f) : {};
    if (!f || !fieldsOf(f).some((x) => x.type === "file"))
      return reply.code(404).send({ error: "not_found", message: "Form unavailable" });
    if (await closedReason(f, s)) return reply.code(404).send({ error: "not_found", message: "Form unavailable" });
    if (s.requireSignIn || s.orgOnly || s.onePerUser) {
      const { user } = await resolveSession(req);
      if (!user) return reply.code(401).send({ error: "signin_required", message: "Sign in to submit" });
      if (s.orgOnly && user.org_id !== f.org_id)
        return reply.code(403).send({ error: "forbidden", message: "Members of that workspace only" });
    }
    const name = String((req.query as { name?: string }).name ?? "upload").slice(0, 300);
    // text/* hits Fastify's built-in string parser before the wildcard buffer
    // parser — accept Buffer, string, or raw stream (same shape as Drive)
    const buf = Buffer.isBuffer(req.body)
      ? req.body
      : typeof req.body === "string" && req.body.length
        ? Buffer.from(req.body)
        : await buffer(req);
    if (!buf.length) return reply.code(400).send({ error: "bad_request", message: "Empty upload" });
    if (buf.length > 25 * 1024 * 1024)
      return reply.code(413).send({ error: "too_large", message: "Files over 25 MB aren't accepted" });
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    if (BLOCKED_EXTS.has(ext))
      return reply.code(415).send({ error: "blocked_file_type", message: `'.${ext}' files are not allowed` });
    const sniff = sniffReject(buf, ext);
    if (sniff) return reply.code(415).send({ error: "blocked_file_type", message: `Upload rejected: ${sniff}` });
    const verdict = await scanBuffer(buf, name);
    if (verdict !== null)
      return reply.code(415).send({ error: "upload_rejected", message: `Upload rejected by scanner: ${verdict}` });
    const quota = await storageQuota(f.org_id, buf.length);
    if (!quota.ok) return reply.code(413).send({ error: "storage_quota", message: "Workspace storage is full" });
    const id = randomUUID();
    const { key, size } = await putBlob(buf);
    await run(
      `INSERT INTO items (id, org_id, parent_id, owner_id, name, kind, mime, size, created_at, updated_at)
       VALUES ($1,$2,NULL,$3,$4,'file',$5,$6,$7,$7)`,
      [id, f.org_id, f.created_by, encryptField(name),
       (req.headers["content-type"] as string) ?? "application/octet-stream", size, now()]);
    await run(
      `INSERT INTO versions (id, file_id, number, major, minor, published, label, blob_key, size, created_by, created_at)
       VALUES ($1,$2,1,1,0,true,'Form upload',$3,$4,$5,$6)`,
      [randomUUID(), id, key, size, f.created_by, now()]);
    await run("INSERT INTO form_uploads (item_id, form_id) VALUES ($1,$2)", [id, f.id]);
    return reply.code(201).send({ item: { id, name, size } });
  });

  // anonymous mutation — capped hard; each submit writes rows, notifies
  // subscribers and fires automation rules/webhooks. `hp` is a honeypot:
  // bots that fill hidden fields get a fake success and no row is stored.
  app.post("/api/forms/public/:token", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const f = await byToken((req.params as { token: string }).token);
    if (!f) return reply.code(404).send({ error: "not_found", message: "Form unavailable" });
    const s = settingsOf(f);
    if (await closedReason(f, s)) return reply.code(404).send({ error: "not_found", message: "Form unavailable" });
    const body = (req.body ?? {}) as { answers?: Record<string, unknown>; respondent?: string; hp?: string };
    if (body.hp) return { ok: true };
    if (!body.answers || typeof body.answers !== "object")
      return reply.code(400).send({ error: "invalid", message: "Expected { answers }" });

    const { user } = await resolveSession(req);
    if ((s.requireSignIn || s.orgOnly || s.onePerUser) && !user)
      return reply.code(401).send({ error: "signin_required", message: "Sign in to submit this form" });
    if (s.orgOnly && user && user.org_id !== f.org_id)
      return reply.code(403).send({ error: "forbidden", message: "Only members of that workspace can respond" });
    if (s.onePerUser && user) {
      const dup = await one("SELECT id FROM form_responses WHERE form_id = $1 AND respondent_user_id = $2",
        [f.id, user.id]);
      if (dup) return reply.code(409).send({ error: "already_submitted", message: "You've already responded" });
    }

    const fields = fieldsOf(f);
    const v = await validateAnswers(f, fields, body.answers);
    if (!v.ok) return reply.code(400).send({ error: "invalid", message: v.error });
    const quiz = s.quiz ? scoreAnswers(fields, v.clean) : null;
    const status = s.requiresReview ? "pending" : "approved";
    const id = randomUUID();

    if (s.dlp) {
      const text = Object.values(v.clean).map((x) =>
        Array.isArray(x) ? x.join(" ") : typeof x === "object" && x !== null ? (x as { name?: string }).name ?? "" : String(x)).join("\n");
      const scan = await scanDlp(f.org_id, { type: "form", id },
        dec(f.title) ?? "form", text, user?.id ?? null);
      if (scan.blockedBy)
        return reply.code(400).send({ error: "blocked", message: `Response blocked by a workspace data policy (${scan.blockedBy})` });
    }

    await run(
      `INSERT INTO form_responses (id, form_id, answers, respondent, respondent_user_id, status, score)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, f.id,
       encryptField(JSON.stringify(v.clean)) ?? JSON.stringify(v.clean),
       body.respondent ? encryptField(String(body.respondent).slice(0, 200)) ?? String(body.respondent).slice(0, 200) : null,
       user?.id ?? null, status, quiz?.score ?? null]);
    void run(
      `INSERT INTO notifications (id, user_id, kind, actor_id, message)
       VALUES ($1,$2,'form',$3,$4)`,
      [randomUUID(), f.created_by, user?.id ?? f.created_by,
       encryptField(status === "pending"
         ? `Response awaiting review: ${dec(f.title) ?? "form"}`
         : `New response: ${dec(f.title) ?? "form"}`)]);
    void fireTrigger(f.org_id, "form.submitted",
      { formId: f.id, name: dec(f.title) ?? "form",
        respondent: user?.email ?? (body.respondent ? String(body.respondent).slice(0, 120) : "") },
      app.log);
    void logActivity(f.org_id, user?.id ?? f.created_by, null, "form.submitted",
      `${dec(f.title) ?? "form"}: new response`);
    return reply.code(201).send({ ok: true, score: quiz?.score ?? null, maxScore: quiz?.max ?? null });
  });
}
