// Automation rules — org-scoped "when X → do Y" (Power Automate-lite).
// Members create rules; creators and org admins manage them.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { q, one, run } from "../db.js";
import { TRIGGERS, ACTIONS, type RuleRow } from "../rules.js";

const ruleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().optional(),
  trigger: z.enum(["form.submitted", "file.created", "task.status", "meeting.ended",
    "schedule.daily", "schedule.weekly", "task.overdue", "approval.overdue"]),
  match: z.record(z.string(), z.string().max(200)).nullish(),
  action: z.enum(["task.create", "notify", "approval.request", "doc.generate",
    "file.move", "file.setColumn", "task.transition", "note.publish"]),
  config: z.record(z.string(), z.string().max(4000).nullable()).default({}),
});

const ruleOut = (r: RuleRow) => ({
  id: r.id, name: r.name, enabled: r.enabled, trigger: r.trigger,
  match: r.match, action: r.action, config: r.config,
  createdBy: r.created_by, createdAt: r.created_at,
});

export function rulesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/rules", async (req) => {
    const { user } = req as AuthedRequest;
    const rows = await q<RuleRow>(
      "SELECT * FROM automation_rules WHERE org_id = $1 ORDER BY created_at DESC", [user.orgId]);
    return { rules: rows.map(ruleOut), triggers: TRIGGERS, actions: ACTIONS };
  });

  app.post("/api/rules", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const parsed = ruleSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid rule" });
    const d = parsed.data;
    const row = await one<RuleRow>(
      `INSERT INTO automation_rules (id, org_id, name, enabled, trigger, match, action, config, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [randomUUID(), user.orgId, d.name, d.enabled ?? true, d.trigger,
       d.match && Object.keys(d.match).length ? JSON.stringify(d.match) : null,
       d.action, JSON.stringify(d.config), user.id]);
    return reply.code(201).send({ rule: ruleOut(row!) });
  });

  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: "not_found", message: "Rule not found" });
  const getRule = (id: string, orgId: string) =>
    one<RuleRow>("SELECT * FROM automation_rules WHERE id = $1 AND org_id = $2", [id, orgId]);
  const canManage = (r: RuleRow, user: { id: string; role: string }) =>
    r.created_by === user.id || user.role === "owner" || user.role === "admin";

  app.patch("/api/rules/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const r = await getRule((req.params as { id: string }).id, user.orgId);
    if (!r) return notFound(reply);
    if (!canManage(r, user)) return reply.code(403).send({ error: "forbidden" });
    const parsed = ruleSchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid rule" });
    const d = parsed.data;
    const row = await one<RuleRow>(
      `UPDATE automation_rules SET
         name = COALESCE($2, name), enabled = COALESCE($3, enabled),
         trigger = COALESCE($4, trigger), action = COALESCE($5, action),
         match = CASE WHEN $6::boolean THEN $7::jsonb ELSE match END,
         config = CASE WHEN $8::boolean THEN $9::jsonb ELSE config END
       WHERE id = $1 RETURNING *`,
      [r.id, d.name ?? null, d.enabled ?? null, d.trigger ?? null, d.action ?? null,
       d.match !== undefined, d.match ? JSON.stringify(d.match) : null,
       d.config !== undefined, d.config ? JSON.stringify(d.config) : "{}"]);
    return { rule: ruleOut(row!) };
  });

  /** Run log — recent fires for a rule (admin observability). */
  app.get("/api/rules/:id/runs", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const r = await getRule((req.params as { id: string }).id, user.orgId);
    if (!r) return notFound(reply);
    const rows = await q<{ dedupe_key: string; fired_at: string; ok: boolean | null; detail: Record<string, string> | null }>(
      "SELECT dedupe_key, fired_at, ok, detail FROM automation_fires WHERE rule_id = $1 ORDER BY fired_at DESC LIMIT 50",
      [r.id]);
    return { runs: rows };
  });

  app.delete("/api/rules/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const r = await getRule((req.params as { id: string }).id, user.orgId);
    if (!r) return notFound(reply);
    if (!canManage(r, user)) return reply.code(403).send({ error: "forbidden" });
    await run("DELETE FROM automation_rules WHERE id = $1", [r.id]);
    return { ok: true };
  });
}
