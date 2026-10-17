// Kreatix Tasks — Planner-lite: one org-shared kanban (todo/doing/done).
// Assignee + due-date + notes per card; assignees get a bell notification.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { q, one, run } from "../db.js";
import { encryptField, decryptField } from "../crypto.js";
import { fireTrigger } from "../rules.js";

interface TaskRow {
  id: string; org_id: string; title: string; notes: string | null; status: string;
  assignee_id: string | null; due_at: string | null; position: number;
  created_by: string; created_at: string; updated_at: string;
  assignee_name?: string | null; assignee_initials?: string | null; creator_name?: string | null;
}

const taskOut = (r: TaskRow) => ({
  id: r.id, title: decryptField(r.title) ?? r.title, notes: decryptField(r.notes),
  status: r.status, dueAt: r.due_at, position: r.position,
  assignee: r.assignee_id ? { id: r.assignee_id, displayName: r.assignee_name, initials: r.assignee_initials } : null,
  createdBy: r.created_by, createdByName: r.creator_name ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const taskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(4000).optional(),
  assigneeId: z.string().max(64).nullish(),
  dueAt: z.string().datetime({ offset: true }).nullish(),
  status: z.enum(["todo", "doing", "done"]).optional(),
});

const baseSelect = `SELECT t.*, a.display_name AS assignee_name, a.initials AS assignee_initials,
                    c.display_name AS creator_name
             FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id
             JOIN users c ON c.id = t.created_by`;

export function taskRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  const getTask = async (id: string, orgId: string) =>
    one<TaskRow>(`${baseSelect} WHERE t.id = $1 AND t.org_id = $2`, [id, orgId]);

  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: "not_found", message: "Task not found" });

  app.get("/api/tasks", async (req) => {
    const { user } = req as AuthedRequest;
    const rows = await q<TaskRow>(`${baseSelect} WHERE t.org_id = $1 ORDER BY t.status, t.position, t.created_at`, [user.orgId]);
    return { tasks: rows.map(taskOut) };
  });

  app.post("/api/tasks", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { user } = req as AuthedRequest;
    const parsed = taskSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid task" });
    const d = parsed.data;
    if (d.assigneeId) {
      const ok = await one("SELECT 1 AS x FROM users WHERE id = $1 AND org_id = $2 AND disabled = false", [d.assigneeId, user.orgId]);
      if (!ok) return reply.code(400).send({ error: "invalid", message: "Unknown assignee" });
    }
    const pos = await one<{ n: number }>(
      "SELECT COALESCE(MAX(position),0)+1 AS n FROM tasks WHERE org_id = $1 AND status = $2",
      [user.orgId, d.status ?? "todo"]);
    const row = await one<TaskRow>(
      `INSERT INTO tasks (id, org_id, title, notes, status, assignee_id, due_at, position, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [randomUUID(), user.orgId, encryptField(d.title) ?? d.title,
       d.notes ? encryptField(d.notes) ?? d.notes : null,
       d.status ?? "todo", d.assigneeId ?? null, d.dueAt ?? null, pos?.n ?? 1, user.id]);
    if (d.assigneeId && d.assigneeId !== user.id) {
      void run(
        `INSERT INTO notifications (id, user_id, kind, actor_id, message)
         VALUES ($1,$2,'task',$3,$4)`,
        [randomUUID(), d.assigneeId, user.id, encryptField(`${user.displayName} assigned you: ${d.title}`)]);
    }
    return reply.code(201).send({ task: taskOut({ ...row!, assignee_name: null, assignee_initials: null, creator_name: user.displayName }) });
  });

  app.patch("/api/tasks/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const t = await getTask((req.params as { id: string }).id, user.orgId);
    if (!t) return notFound(reply);
    const parsed = taskSchema.partial().extend({ position: z.number().int().optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid task" });
    const d = parsed.data;
    if (d.assigneeId) {
      const ok = await one("SELECT 1 AS x FROM users WHERE id = $1 AND org_id = $2 AND disabled = false", [d.assigneeId, user.orgId]);
      if (!ok) return reply.code(400).send({ error: "invalid", message: "Unknown assignee" });
    }
    const row = await one<TaskRow>(
      `UPDATE tasks SET
         title = COALESCE($2, title),
         notes = CASE WHEN $3::boolean THEN $4 ELSE notes END,
         status = COALESCE($5, status),
         assignee_id = CASE WHEN $6::boolean THEN $7 ELSE assignee_id END,
         due_at = CASE WHEN $8::boolean THEN $9 ELSE due_at END,
         position = COALESCE($10, position), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [t.id,
       d.title ? encryptField(d.title) ?? d.title : null,
       d.notes !== undefined, d.notes ? encryptField(d.notes) ?? d.notes : null,
       d.status ?? null,
       d.assigneeId !== undefined, d.assigneeId ?? null,
       d.dueAt !== undefined, d.dueAt ?? null,
       d.position ?? null]);
    if (d.assigneeId && d.assigneeId !== t.assignee_id && d.assigneeId !== user.id) {
      void run(
        `INSERT INTO notifications (id, user_id, kind, actor_id, message)
         VALUES ($1,$2,'task',$3,$4)`,
        [randomUUID(), d.assigneeId, user.id, encryptField(`${user.displayName} assigned you: ${d.title ?? decryptField(t.title) ?? t.title}`)]);
    }
    if (d.status && d.status !== t.status) {
      void fireTrigger(user.orgId, "task.status",
        { status: d.status, name: d.title ?? decryptField(t.title) ?? t.title, taskId: t.id },
        app.log);
    }
    const full = await getTask(t.id, user.orgId);
    return { task: taskOut(full ?? row!) };
  });

  app.delete("/api/tasks/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const t = await getTask((req.params as { id: string }).id, user.orgId);
    if (!t) return notFound(reply);
    if (t.created_by !== user.id && user.role !== "owner" && user.role !== "admin")
      return reply.code(403).send({ error: "forbidden", message: "Only the creator can delete" });
    await run("DELETE FROM tasks WHERE id = $1", [t.id]);
    return { ok: true };
  });
}
