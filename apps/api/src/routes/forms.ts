// Kreatix Forms — org forms with public share-token submission.
// Management routes are org-scoped + authed; the public view/submit/file
// upload pair lives in formPublicRoutes with no JWT (token-gated; an
// optional session is resolved for signed-in submission modes).
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth, resolveSession, type AuthedRequest } from "../auth.js";
import { q, one, run, tx, now } from "../db.js";
import { encryptField, decryptField } from "../crypto.js";
import { fireTrigger } from "../rules.js";
import { storageQuota, paystackInit, paystackVerify } from "../billing.js";
import { putBlob, getBlob } from "../blobs.js";
import { scanDlp } from "../policies.js";
import { BLOCKED_EXTS, sniffReject, scanBuffer, buffer } from "./drive.js";
import { logActivity } from "../items.js";

export const FIELD_TYPES = [
  "text", "textarea", "email", "number", "date", "time", "url", "phone",
  "choice", "multiselect", "checkbox", "rating", "scale", "nps", "ranking",
  "section", "file", "payment",
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
  payAmount: z.number().int().min(1).max(100_000_000).optional(), // ₦ for payment fields
  payLabel: z.string().trim().max(200).optional(),             // e.g. "Registration fee"
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
  editAfterSubmit: z.boolean().optional(),                     // respondent can edit via editToken
  syncSheet: z.string().max(64).optional(),                    // Drive sheets item — live row sync
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
  created_by: string; created_at: string; updated_at: string; view_count: number;
  creator_name?: string; response_count?: number;
}
interface RespRow {
  id: string; answers: string; respondent: string | null;
  respondent_user_id: string | null; status: string; score: string | null; // NUMERIC → string
  edit_token: string | null; pay_ref: string | null; paid_at: string | null;
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
  responses: Number(r.response_count ?? 0), viewCount: Number(r.view_count ?? 0),
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
      case "nps": {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 10) return bad(`"${f.label}" must be 0-10`, clean);
        clean[f.id] = n; break;
      }
      case "ranking": {
        if (!Array.isArray(v) || !f.options?.length) return bad(`"${f.label}" must rank all options`, clean);
        const order = [...new Set(v.map((x) => String(x).slice(0, 200)))];
        if (order.length !== f.options.length || !order.every((o) => f.options!.includes(o)))
          return bad(`"${f.label}" must rank every option exactly once`, clean);
        clean[f.id] = order; break;
      }
      case "payment": break; // no answer — payment state lives on the response row
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

/** Form payments settle to the org's own Paystack account (Admin sets the
 *  secret; platform env key is only the fallback path's — never for forms). */
const orgPaystackSecret = async (orgId: string): Promise<string | null> => {
  const o = await one<{ paystack_secret: string | null }>(
    "SELECT paystack_secret FROM orgs WHERE id = $1", [orgId]);
  return o?.paystack_secret ? decryptField(o.paystack_secret) ?? o.paystack_secret : null;
};

const A1 = (i: number) => { // 0-based → A1 column letters (AA past Z)
  let s = ""; let n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

interface SheetDoc { workbook?: { sheets?: { name?: string; cells?: Record<string, { v?: unknown; s?: unknown }> }[] } }

/** Live Sheets sync — settings.syncSheet names a sheets-kind Drive item; each
 *  approved/pending response appends a row as a new immutable version. The
 *  row-write runs inside a `SELECT … FOR UPDATE` on the item so concurrent
 *  submits can't clobber each other. */
async function syncSheetRow(
  f: FormRow, fields: Field[], clean: Record<string, unknown>,
  respondent: string | null, createdAt: string, score: number | null,
): Promise<void> {
  const itemId = settingsOf(f).syncSheet;
  if (!itemId) return;
  await tx(async (c) => {
    const it = await c.query(
      "SELECT id FROM items WHERE id = $1 AND org_id = $2 AND kind = 'sheets' AND trashed = false FOR UPDATE",
      [itemId, f.org_id]);
    if (!it.rowCount) return;
    const v = await c.query<{ blob_key: string; number: number }>(
      "SELECT blob_key, number FROM versions WHERE file_id = $1 ORDER BY number DESC LIMIT 1", [itemId]);
    const blob = v.rowCount ? await getBlob(v.rows[0].blob_key) : null;
    let doc: SheetDoc | null = null;
    try { doc = blob ? JSON.parse(blob.toString("utf8")) as SheetDoc : null; } catch { /* recreate below */ }
    if (!doc?.workbook?.sheets?.length)
      doc = { workbook: { sheets: [{ name: "Responses", cells: {} }] } };
    const sheet = doc.workbook!.sheets![0];
    if (!sheet.cells) sheet.cells = {};
    const cells = sheet.cells;
    const answerable = fields.filter((x) => x.type !== "section" && x.type !== "payment");
    const hasPay = fields.some((x) => x.type === "payment");
    const s = settingsOf(f);
    const cols = ["Submitted", "Respondent", ...answerable.map((x) => x.label),
      ...(s.quiz ? ["Score"] : []), ...(hasPay ? ["Paid"] : [])];
    let maxRow = 0;
    for (const ref of Object.keys(cells)) {
      const m = /^[A-Z]+(\d+)$/.exec(ref);
      if (m) maxRow = Math.max(maxRow, Number(m[1]));
    }
    if (!maxRow) { // fresh workbook — write the header first
      cols.forEach((col, i) => { cells[`${A1(i)}1`] = { v: col, s: { b: true } }; });
      maxRow = 1;
    }
    const row = maxRow + 1;
    const cell = (v: unknown): string | number | boolean =>
      Array.isArray(v) ? v.join("; ")
        : typeof v === "object" && v !== null ? ((v as { name?: string }).name ?? "") : v as string | number | boolean;
    cells[`A${row}`] = { v: createdAt };
    cells[`B${row}`] = { v: respondent ?? "anonymous" };
    answerable.forEach((fd, ci) => {
      const av = clean[fd.id];
      if (av !== undefined) cells[`${A1(ci + 2)}${row}`] = { v: cell(av) };
    });
    if (s.quiz && score !== null) cells[`${A1(answerable.length + 2)}${row}`] = { v: score };
    if (hasPay) cells[`${A1(cols.length - 1)}${row}`] = { v: "yes" };
    const buf = Buffer.from(JSON.stringify(doc));
    const { key, size } = await putBlob(buf);
    const num = Number(v.rows[0]?.number ?? 0) + 1;
    await c.query(
      `INSERT INTO versions (id, file_id, number, major, minor, published, label, blob_key, size, created_by, created_at)
       VALUES ($1,$2,$3,$3,0,true,'Form response',$4,$5,$6,$7)`,
      [randomUUID(), itemId, num, key, size, f.created_by, now()]);
    await c.query("UPDATE items SET size = $2, updated_at = now() WHERE id = $1", [itemId, size]);
  });
}

/** open flag + scheduled/cap closes — returns a reason or null when live. */
async function closedReason(f: FormRow, s: FormSettings): Promise<string | null> {
  if (!f.open) return "This form is closed.";
  if (s.closeAt && Date.parse(s.closeAt) <= Date.now()) return "This form is closed.";
  if (s.closeAfter) {
    const c = await one<{ n: string }>(
      "SELECT count(*) AS n FROM form_responses WHERE form_id = $1 AND status != 'unpaid'", [f.id]);
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
          paidAt: r.paid_at, payRef: r.pay_ref,
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
    const fields = fieldsOf(f).filter((x) => x.type !== "section" && x.type !== "payment");
    const rows = await q<RespRow>(
      `SELECT r.*, u.email AS resp_email FROM form_responses r
       LEFT JOIN users u ON u.id = r.respondent_user_id
       WHERE r.form_id = $1 ORDER BY r.created_at`, [f.id]);
    const head = ["Submitted", "Status", "Respondent", ...fields.map((x) => x.label),
      ...(s.quiz ? ["Score"] : []), ...(fields.some((x) => x.type === "payment") ? ["Paid"] : [])];
    const lines = [head.map(csvCell).join(",")];
    for (const r of rows) {
      let answers: Record<string, unknown> = {};
      try { answers = JSON.parse(decryptField(r.answers) ?? r.answers); } catch { /* malformed */ }
      lines.push([
        r.created_at, r.status, r.resp_email ?? dec(r.respondent) ?? "",
        ...fields.map((x) => answers[x.id]),
        ...(s.quiz ? [r.score ?? ""] : []),
        ...(head.includes("Paid") ? [r.paid_at ? "yes" : ""] : []),
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
    const fields = fieldsOf(f).filter((x) => x.type !== "section" && x.type !== "file" && x.type !== "payment");
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
      } else if (fd.type === "nps") {
        // Net Promoter: %promoters (9-10) − %detractors (0-6), −100…+100
        const nums = vals.map(Number).filter(Number.isFinite);
        const pro = nums.filter((n) => n >= 9).length;
        const det = nums.filter((n) => n <= 6).length;
        out.buckets = Object.entries(nums.reduce<Record<string, number>>((m, n) => ({ ...m, [n]: (m[n] ?? 0) + 1 }), {}))
          .map(([v, n]) => ({ v, n })).sort((a, b) => Number(a.v) - Number(b.v));
        out.nps = nums.length ? Math.round((pro / nums.length - det / nums.length) * 100) : null;
      } else if (fd.type === "ranking") {
        // mean position per option (1 = ranked top) — lower is better
        const sums: Record<string, { t: number; n: number }> = {};
        for (const v of vals) (Array.isArray(v) ? v : []).forEach((o, i) => {
          const k = String(o); sums[k] = sums[k] ?? { t: 0, n: 0 };
          sums[k].t += i + 1; sums[k].n += 1;
        });
        out.buckets = Object.entries(sums)
          .map(([v, s2]) => ({ v, n: Math.round((s2.t / s2.n) * 100) / 100 }))
          .sort((a, b) => a.n - b.n);
        out.rankAvg = true; // client renders `n` as "avg rank", not a count
      } else {
        out.samples = vals.slice(0, 10).map(String);
      }
      return out;
    });
    const scores = rows.map((r) => (r.score === null ? null : Number(r.score))).filter((x): x is number => x !== null);
    const views = Number(f.view_count ?? 0);
    return {
      form: formOut(f), total: answers.length, views,
      completionRate: views ? Math.round((answers.length / views) * 100) : null,
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
    const edit = String((req.query as { edit?: string }).edit ?? "");
    let prior: { answers: Record<string, unknown>; respondent: string | null } | null = null;
    if (edit && s.editAfterSubmit) {
      const r = await one<RespRow>(
        "SELECT answers, respondent FROM form_responses WHERE form_id = $1 AND edit_token = $2",
        [f.id, edit.slice(0, 64)]);
      if (r) {
        let answers: Record<string, unknown> = {};
        try { answers = JSON.parse(decryptField(r.answers) ?? r.answers); } catch { /* malformed */ }
        prior = { answers, respondent: dec(r.respondent) };
      }
    }
    if (!closed && !edit)
      void run("UPDATE forms SET view_count = view_count + 1 WHERE id = $1", [f.id]);
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
        shuffleOptions: !!s.shuffleOptions, editAfterSubmit: !!s.editAfterSubmit,
      },
      prior,
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
      // unpaid rows don't lock a respondent out — a payment they abandoned
      // mustn't block a retry (they have ~30 min to finish it)
      const dup = await one(
        `SELECT id FROM form_responses WHERE form_id = $1 AND respondent_user_id = $2
           AND (status != 'unpaid' OR created_at > now() - interval '30 minutes')`,
        [f.id, user.id]);
      if (dup) return reply.code(409).send({ error: "already_submitted", message: "You've already responded" });
    }

    const fields = fieldsOf(f);
    const v = await validateAnswers(f, fields, body.answers);
    if (!v.ok) return reply.code(400).send({ error: "invalid", message: v.error });
    const quiz = s.quiz ? scoreAnswers(fields, v.clean) : null;
    const id = randomUUID();
    const respondent = body.respondent ? String(body.respondent).slice(0, 200) : null;
    const editToken = s.editAfterSubmit ? randomBytes(16).toString("hex") : null;

    if (s.dlp) {
      const text = Object.values(v.clean).map((x) =>
        Array.isArray(x) ? x.join(" ") : typeof x === "object" && x !== null ? (x as { name?: string }).name ?? "" : String(x)).join("\n");
      const scan = await scanDlp(f.org_id, { type: "form", id },
        dec(f.title) ?? "form", text, user?.id ?? null);
      if (scan.blockedBy)
        return reply.code(400).send({ error: "blocked", message: `Response blocked by a workspace data policy (${scan.blockedBy})` });
    }

    // Payment field → the response is parked as `unpaid`; every side effect
    // (notify, trigger, sheet sync) fires when the verify endpoint confirms
    // the Paystack reference, so bots can't cheap-shot a notification flood.
    const payField = fields.find((x) => x.type === "payment" && x.payAmount);
    let status = s.requiresReview ? "pending" : "approved";
    let payUrl: string | null = null;
    let payRef: string | null = null;
    if (payField) {
      const secret = await orgPaystackSecret(f.org_id);
      if (!secret) return reply.code(400).send({
        error: "no_payments",
        message: "This workspace hasn't connected a payment account yet",
      });
      payRef = `fp-${randomBytes(10).toString("hex")}`;
      const emailField = fields.find((x) => x.type === "email");
      const email = (user?.email
        ?? (emailField ? String(v.clean[emailField.id] ?? "") : ""))
        || (respondent && /@/.test(respondent) ? respondent : `respondent-${payRef}@kreatix-forms.invalid`);
      const origin = String(req.headers.origin ?? `https://${req.headers.host ?? ""}`);
      try {
        payUrl = (await paystackInit(email, payField.payAmount!, payRef,
          `${origin}/f/${f.token}?paid=${payRef}`, secret)).authorization_url;
      } catch (e) {
        app.log.warn({ err: String(e), form: f.id }, "paystack init failed");
        return reply.code(502).send({ error: "payment", message: "Couldn't start the payment — try again" });
      }
      status = "unpaid";
    }

    await run(
      `INSERT INTO form_responses (id, form_id, answers, respondent, respondent_user_id, status, score, edit_token, pay_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, f.id,
       encryptField(JSON.stringify(v.clean)) ?? JSON.stringify(v.clean),
       respondent ? encryptField(respondent) ?? respondent : null,
       user?.id ?? null, status, quiz?.score ?? null, editToken, payRef]);
    if (status !== "unpaid")
      responseFinal(app, f, s, user?.id ?? null, respondent, status, quiz?.score ?? null, v.clean);
    return reply.code(201).send({
      ok: true, score: quiz?.score ?? null, maxScore: quiz?.max ?? null,
      payUrl, payRef, editToken,
    });
  });

  /** Respondent edit — bearer editToken (returned at submit, kept by the
   *  respondent) rewrites answers; re-validates, re-scans DLP, re-scores,
   *  and drops back to pending when the form requires review. */
  app.put("/api/forms/public/:token", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const f = await byToken((req.params as { token: string }).token);
    if (!f) return reply.code(404).send({ error: "not_found", message: "Form unavailable" });
    const s = settingsOf(f);
    if (!s.editAfterSubmit) return reply.code(404).send({ error: "not_found", message: "Form unavailable" });
    if (await closedReason(f, s)) return reply.code(404).send({ error: "not_found", message: "Form unavailable" });
    const body = (req.body ?? {}) as { editToken?: string; answers?: Record<string, unknown>; respondent?: string };
    const row = await one<RespRow>(
      "SELECT * FROM form_responses WHERE form_id = $1 AND edit_token = $2",
      [f.id, String(body.editToken ?? "").slice(0, 64)]);
    if (!row) return reply.code(404).send({ error: "not_found", message: "Response not found" });
    if (row.pay_ref && !row.paid_at)
      return reply.code(400).send({ error: "unpaid", message: "This response is awaiting payment" });
    if (!body.answers || typeof body.answers !== "object")
      return reply.code(400).send({ error: "invalid", message: "Expected { answers }" });
    const fields = fieldsOf(f);
    const v = await validateAnswers(f, fields, body.answers);
    if (!v.ok) return reply.code(400).send({ error: "invalid", message: v.error });
    const quiz = s.quiz ? scoreAnswers(fields, v.clean) : null;
    const status = s.requiresReview ? "pending" : row.status;
    const respondent = body.respondent ? String(body.respondent).slice(0, 200) : null;
    if (s.dlp) {
      const text = Object.values(v.clean).map((x) =>
        Array.isArray(x) ? x.join(" ") : typeof x === "object" && x !== null ? (x as { name?: string }).name ?? "" : String(x)).join("\n");
      const scan = await scanDlp(f.org_id, { type: "form", id: row.id },
        dec(f.title) ?? "form", text, row.respondent_user_id);
      if (scan.blockedBy)
        return reply.code(400).send({ error: "blocked", message: `Response blocked by a workspace data policy (${scan.blockedBy})` });
    }
    await run(
      "UPDATE form_responses SET answers = $2, respondent = $3, score = $4, status = $5 WHERE id = $1",
      [row.id, encryptField(JSON.stringify(v.clean)) ?? JSON.stringify(v.clean),
       respondent ? encryptField(respondent) ?? respondent : null,
       quiz?.score ?? null, status]);
    return { ok: true, score: quiz?.score ?? null, maxScore: quiz?.max ?? null };
  });

  /** Payment verify — the respondent returns from Paystack with ?paid=<ref>;
   *  we verify server-side (authoritative), flip the parked response, and
   *  fire the usual side effects. Idempotent + CAS on paid_at. */
  app.get("/api/forms/public/:token/verify", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const f = await byToken((req.params as { token: string }).token);
    if (!f) return reply.code(404).send({ error: "not_found", message: "Form unavailable" });
    const ref = String((req.query as { ref?: string }).ref ?? "").slice(0, 64);
    const row = ref && await one<RespRow>(
      "SELECT * FROM form_responses WHERE form_id = $1 AND pay_ref = $2", [f.id, ref]);
    if (!row) return reply.code(404).send({ error: "not_found", message: "Payment not found" });
    if (row.paid_at) return { paid: true, already: true };
    const secret = await orgPaystackSecret(f.org_id);
    if (!secret) return reply.code(400).send({ error: "no_payments", message: "Payments not configured" });
    const v = await paystackVerify(ref, secret);
    if (!v.ok) return { paid: false };
    const s = settingsOf(f);
    const status = s.requiresReview ? "pending" : "approved";
    const n = await run(
      "UPDATE form_responses SET paid_at = now(), status = $2 WHERE id = $1 AND paid_at IS NULL",
      [row.id, status]);
    if (n > 0) {
      let clean: Record<string, unknown> = {};
      try { clean = JSON.parse(decryptField(row.answers) ?? row.answers); } catch { /* malformed */ }
      responseFinal(app, f, s, row.respondent_user_id, dec(row.respondent), status,
        row.score === null ? null : Number(row.score), clean);
    }
    return { paid: true };
  });
}

/** Side effects that run once a response is "real" (approved/pending — i.e.
 *  immediately for free forms, or after payment verification): creator
 *  notification, automation trigger, activity log, live Sheets sync. */
function responseFinal(
  app: FastifyInstance, f: FormRow, s: FormSettings,
  actorId: string | null, respondent: string | null, status: string,
  score: number | null, clean: Record<string, unknown>,
): void {
  void run(
    `INSERT INTO notifications (id, user_id, kind, actor_id, message)
     VALUES ($1,$2,'form',$3,$4)`,
    [randomUUID(), f.created_by, actorId ?? f.created_by,
     encryptField(status === "pending"
       ? `Response awaiting review: ${dec(f.title) ?? "form"}`
       : `New response: ${dec(f.title) ?? "form"}`)]);
  void fireTrigger(f.org_id, "form.submitted",
    { formId: f.id, name: dec(f.title) ?? "form",
      respondent: respondent ? respondent.slice(0, 120) : "" },
    app.log);
  void logActivity(f.org_id, actorId ?? f.created_by, null, "form.submitted",
    `${dec(f.title) ?? "form"}: new response`);
  void syncSheetRow(f, fieldsOf(f), clean, respondent, now(), score)
    .catch((e) => app.log.warn({ err: String(e), form: f.id }, "form sheet sync failed"));
}
