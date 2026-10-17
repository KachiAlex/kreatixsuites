// Automation rules — "when X → do Y" wiring between suite apps. Triggers are
// fired at existing emit points (form submitted, file added, task moved,
// meeting ended) plus an hourly schedule sweep (daily digests, overdue
// tasks, stale approvals). Fire-and-forget: rule failures log and never
// block the source event; every fire lands in automation_fires as a run log.
import { randomUUID } from "node:crypto";
import { q, one, run, now } from "./db.js";
import { encryptField, decryptField } from "./crypto.js";
import { putBlob } from "./blobs.js";
import { getItem } from "./items.js";
import { normalizeChain } from "./sites.js";
import { requestApproval } from "./approvals.js";

export type RuleTrigger = "form.submitted" | "file.created" | "task.status" | "meeting.ended"
  | "schedule.daily" | "schedule.weekly" | "task.overdue" | "approval.overdue";
export type RuleAction = "task.create" | "notify" | "approval.request" | "doc.generate"
  | "file.move" | "file.setColumn" | "task.transition" | "note.publish";

export interface RuleRow {
  id: string; org_id: string; name: string; enabled: boolean;
  trigger: string; match: Record<string, string> | null;
  action: string; config: Record<string, string | null>;
  created_by: string; created_at: string;
}

/** matchKeys describe the trigger's optional ctx filter fields; kind drives
 *  the Admin form control (select with options | number input). */
export interface MatchKey { key: string; label: string; kind: "select" | "number"; }

export const TRIGGERS: { id: RuleTrigger; label: string; matchKeys?: MatchKey[] }[] = [
  { id: "form.submitted", label: "Form response submitted", matchKeys: [{ key: "formId", label: "Limit to a form", kind: "select" }] },
  { id: "file.created", label: "File added to a library", matchKeys: [{ key: "libraryId", label: "Limit to a library", kind: "select" }] },
  { id: "task.status", label: "Task moved to a status", matchKeys: [{ key: "status", label: "Status (todo|doing|done)", kind: "select" }] },
  { id: "meeting.ended", label: "Meeting ended" },
  { id: "task.overdue", label: "Task becomes overdue (daily)" },
  { id: "approval.overdue", label: "Approval waiting too long (daily)", matchKeys: [{ key: "days", label: "Days pending (default 2)", kind: "number" }] },
  { id: "schedule.daily", label: "Every day at…", matchKeys: [{ key: "hour", label: "UTC hour (0-23, default 8)", kind: "number" }] },
  { id: "schedule.weekly", label: "Every week on…", matchKeys: [{ key: "dow", label: "Day of week", kind: "select" }, { key: "hour", label: "UTC hour (0-23, default 8)", kind: "number" }] },
];

/** fields describe each action's config; kind drives the Admin control. */
export interface ActionField { key: string; label: string; kind: "text" | "textarea" | "user" | "library" | "status" | "number" | "bool"; }

export const ACTIONS: { id: RuleAction; label: string; needs?: "fileId" | "taskId"; fields?: ActionField[] }[] = [
  {
    id: "task.create", label: "Create a task",
    fields: [
      { key: "title", label: "Title", kind: "text" },
      { key: "assigneeId", label: "Assignee", kind: "user" },
      { key: "dueInDays", label: "Due in days", kind: "number" },
      { key: "notes", label: "Notes", kind: "textarea" },
    ],
  },
  {
    id: "notify", label: "Send a notification",
    fields: [
      { key: "message", label: "Message", kind: "text" },
      { key: "userId", label: "To (blank = admins; supports {{vars}})", kind: "user" },
    ],
  },
  { id: "approval.request", label: "Submit the file for approval", needs: "fileId" },
  {
    id: "doc.generate", label: "Generate a document from the event",
    fields: [
      { key: "libraryId", label: "Target library", kind: "library" },
      { key: "name", label: "File name", kind: "text" },
      { key: "body", label: "Body text", kind: "textarea" },
      { key: "requestApproval", label: "Also submit for approval", kind: "bool" },
    ],
  },
  {
    id: "file.move", label: "Move the file to a library", needs: "fileId",
    fields: [{ key: "libraryId", label: "Target library", kind: "library" }],
  },
  {
    id: "file.setColumn", label: "Set a metadata column on the file", needs: "fileId",
    fields: [
      { key: "column", label: "Column name", kind: "text" },
      { key: "value", label: "Value", kind: "text" },
    ],
  },
  {
    id: "task.transition", label: "Move the task to a status", needs: "taskId",
    fields: [{ key: "status", label: "Status", kind: "status" }],
  },
  {
    id: "note.publish", label: "Publish a Notes page",
    fields: [
      { key: "title", label: "Page title", kind: "text" },
      { key: "body", label: "Body", kind: "textarea" },
    ],
  },
];

/** {{var}} interpolation against the trigger context. */
const interp = (tpl: string, ctx: Record<string, string>) =>
  tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => ctx[k] ?? "");

/** Match filter: every key in rule.match must equal ctx[key]. */
const matches = (rule: RuleRow, ctx: Record<string, string>) =>
  !rule.match || Object.entries(rule.match).every(([k, v]) => ctx[k] === v);

/** Dedupe marker + run log — a (rule, key) pair fires once. detail captures
 *  a compact ctx snapshot for the Admin "runs" view. */
async function claimFire(ruleId: string, key: string, ctx?: Record<string, string>): Promise<boolean> {
  const detail = ctx ? JSON.stringify(Object.fromEntries(
    Object.entries(ctx).filter(([k]) => !k.startsWith("_")).slice(0, 12))) : null;
  const row = await q<{ x: number }>(
    `INSERT INTO automation_fires (rule_id, dedupe_key, detail) VALUES ($1,$2,$3::jsonb)
     ON CONFLICT DO NOTHING RETURNING 1 AS x`, [ruleId, key, detail]);
  return row.length > 0;
}

async function markFire(ruleId: string, key: string, ok: boolean, err?: string) {
  await run("UPDATE automation_fires SET ok = $3, detail = COALESCE(detail,'{}'::jsonb) || $4::jsonb WHERE rule_id = $1 AND dedupe_key = $2",
    [ruleId, key, ok, JSON.stringify(err ? { error: err } : { done: true })]);
}

/** Fire a trigger — runs every enabled matching rule in the org. Callers use
 *  `void fireTrigger(...)`; errors are logged, never thrown. ctx.eventId (if
 *  present) dedupes repeat emissions of the same event. */
export async function fireTrigger(
  orgId: string,
  trigger: RuleTrigger,
  ctx: Record<string, string>,
  log?: { warn: (o: unknown, m: string) => void },
): Promise<number> {
  // outbound webhooks share this emit point — fires whether or not a rule matches
  void import("./integrations.js")
    .then((m) => m.deliverHooks(orgId, trigger, ctx, log))
    .catch((e) => log?.warn({ err: String(e) }, "webhook dispatch failed"));
  let fired = 0;
  try {
    const rules = await q<RuleRow>(
      "SELECT * FROM automation_rules WHERE org_id = $1 AND trigger = $2 AND enabled",
      [orgId, trigger]);
    for (const rule of rules) {
      if (!matches(rule, ctx)) continue;
      const key = ctx.eventId ? `ev:${ctx.eventId}` : `ev:${randomUUID()}`;
      try {
        if (!(await claimFire(rule.id, key, ctx))) continue;
        await execute(rule, ctx);
        await markFire(rule.id, key, true);
        fired++;
      } catch (e) {
        await markFire(rule.id, key, false, String(e).slice(0, 300)).catch(() => {});
        log?.warn({ err: String(e), rule: rule.id }, "automation rule failed");
      }
    }
  } catch (e) {
    log?.warn({ err: String(e), trigger }, "automation trigger lookup failed");
  }
  return fired;
}

async function execute(rule: RuleRow, ctx: Record<string, string>): Promise<void> {
  const cfg = rule.config ?? {};
  switch (rule.action) {
    case "task.create": {
      const title = interp(cfg.title ?? `${rule.name}: {{name}}`, ctx).slice(0, 200) || rule.name;
      const notes = cfg.notes ? interp(cfg.notes, ctx).slice(0, 4000) : null;
      const assignee = cfg.assigneeId ? interp(cfg.assigneeId, ctx) : null;
      const id = randomUUID();
      await run(
        `INSERT INTO tasks (id, org_id, title, notes, assignee_id, due_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, rule.org_id, encryptField(title) ?? title,
         notes ? encryptField(notes) ?? notes : null,
         assignee, cfg.dueInDays ? new Date(Date.now() + Number(cfg.dueInDays) * 864e5).toISOString() : null,
         rule.created_by]);
      if (assignee) await notify(rule.org_id, assignee, `Task assigned: ${title}`, null);
      return;
    }
    case "notify": {
      const message = interp(cfg.message ?? `${rule.name}: {{name}}`, ctx).slice(0, 300);
      const target = cfg.userId ? interp(cfg.userId, ctx) : null;
      if (target) {
        // resolve to concrete org users — an id, or interpolate ctx like {{approverId}}
        const ids = await q<{ id: string }>(
          "SELECT id FROM users WHERE org_id = $1 AND id = $2 AND NOT disabled", [rule.org_id, target]);
        for (const u of ids) await notify(rule.org_id, u.id, message, rule.created_by);
      } else {
        const admins = await q<{ id: string }>(
          "SELECT id FROM users WHERE org_id = $1 AND role IN ('owner','admin') AND NOT disabled", [rule.org_id]);
        for (const a of admins) await notify(rule.org_id, a.id, message, rule.created_by);
      }
      return;
    }
    case "approval.request": {
      if (!ctx.fileId) throw new Error("no file in context");
      const item = await getItem(ctx.fileId);
      if (!item || item.org_id !== rule.org_id) throw new Error("file not found");
      const ok = await requestApproval(item, rule.created_by);
      if (!ok) throw new Error("nothing to approve (published or no draft)");
      return;
    }
    case "doc.generate": {
      if (!cfg.libraryId) throw new Error("target library required");
      const lib = await one<{ id: string; site_id: string }>(
        `SELECT l.id, l.site_id FROM libraries l JOIN sites s ON s.id = l.site_id
         WHERE l.id = $1 AND s.org_id = $2`, [cfg.libraryId, rule.org_id]);
      if (!lib) throw new Error("target library not found");
      const name = (interp(cfg.name ?? "{{name}}", ctx).slice(0, 200)) || `Generated ${rule.name}`;
      const text = interp(cfg.body ?? "", ctx).slice(0, 40000);
      const doc = {
        type: "doc",
        content: text.split("\n").map((line) => line.trim()
          ? { type: "paragraph", content: [{ type: "text", text: line }] }
          : { type: "paragraph" }),
      };
      const { key, size } = putBlob(Buffer.from(JSON.stringify(doc)));
      const id = randomUUID();
      await run(
        `INSERT INTO items (id, org_id, parent_id, owner_id, name, kind, mime, library_id, created_at, updated_at)
         VALUES ($1,$2,NULL,$3,$4,'writer','application/x-kreatix-writer',$5,$6,$6)`,
        [id, rule.org_id, rule.created_by, encryptField(name) ?? name, lib.id, now()]);
      await run(
        `INSERT INTO versions (id, file_id, number, major, minor, published, blob_key, size, created_by, created_at)
         VALUES ($1,$2,1,0,1,false,$3,$4,$5,$6)`,
        [randomUUID(), id, key, size, rule.created_by, now()]);
      await run("UPDATE items SET size = $1 WHERE id = $2", [size, id]);
      if (cfg.requestApproval === "true" || cfg.requestApproval === "1") {
        const item = await getItem(id);
        if (item) await requestApproval(item, rule.created_by);
      }
      return;
    }
    case "file.move": {
      if (!ctx.fileId) throw new Error("no file in context");
      if (!cfg.libraryId) throw new Error("target library required");
      const lib = await one<{ id: string }>(
        `SELECT l.id FROM libraries l JOIN sites s ON s.id = l.site_id
         WHERE l.id = $1 AND s.org_id = $2`, [cfg.libraryId, rule.org_id]);
      if (!lib) throw new Error("target library not found");
      await run(
        `WITH RECURSIVE sub AS (
           SELECT id FROM items WHERE id = $1 AND org_id = $2
           UNION ALL SELECT i.id FROM items i JOIN sub s ON i.parent_id = s.id)
         UPDATE items SET library_id = $3 WHERE id IN (SELECT id FROM sub)`,
        [ctx.fileId, rule.org_id, lib.id]);
      await run("UPDATE items SET parent_id = NULL, updated_at = $2 WHERE id = $1", [ctx.fileId, now()]);
      return;
    }
    case "file.setColumn": {
      if (!ctx.fileId) throw new Error("no file in context");
      const col = await one<{ id: string }>(
        `SELECT c.id FROM library_columns c
         JOIN items i ON i.library_id = c.library_id
         WHERE i.id = $1 AND i.org_id = $2 AND lower(c.name) = lower($3)`,
        [ctx.fileId, rule.org_id, cfg.column ?? ""]);
      if (!col) throw new Error(`column '${cfg.column}' not found on the file's library`);
      const value = interp(cfg.value ?? "", ctx).slice(0, 2000);
      await run(
        `INSERT INTO item_metadata (item_id, column_id, value) VALUES ($1,$2,$3)
         ON CONFLICT (item_id, column_id) DO UPDATE SET value = $3`,
        [ctx.fileId, col.id, encryptField(value) ?? value]);
      return;
    }
    case "task.transition": {
      if (!ctx.taskId) throw new Error("no task in context");
      const status = ["todo", "doing", "done"].includes(cfg.status ?? "") ? cfg.status! : "done";
      await run("UPDATE tasks SET status = $3, updated_at = now() WHERE id = $1 AND org_id = $2",
        [ctx.taskId, rule.org_id, status]);
      return;
    }
    case "note.publish": {
      const title = interp(cfg.title ?? "{{name}}", ctx).slice(0, 200) || rule.name;
      const body = interp(cfg.body ?? "", ctx).slice(0, 40000);
      await run(
        `INSERT INTO wiki_pages (id, org_id, title, body, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$5)`,
        [randomUUID(), rule.org_id, encryptField(title) ?? title,
         body ? encryptField(body) ?? body : null, rule.created_by]);
      return;
    }
  }
}

async function notify(orgId: string, userId: string, message: string, actorId: string | null) {
  await run(
    `INSERT INTO notifications (id, user_id, kind, actor_id, message)
     SELECT $1, $2, 'automation', $3, $4 WHERE EXISTS (SELECT 1 FROM users WHERE id = $2 AND org_id = $5)`,
    [randomUUID(), userId, actorId, encryptField(message) ?? message, orgId]);
}

/** Hourly sweep: fires `task.overdue` for newly-overdue tasks,
 *  `approval.overdue` for pending drafts older than the rule's threshold,
 *  and `schedule.daily`/`schedule.weekly` digests at each rule's configured
 *  UTC time. Called from a server interval — never throws. */
export async function runScheduleSweep(
  log?: { warn: (o: unknown, m: string) => void; info?: (o: unknown, m: string) => void },
): Promise<void> {
  const fire = async (rule: RuleRow, key: string, ctx: Record<string, string>) => {
    try {
      if (!(await claimFire(rule.id, key, ctx))) return;
      await execute(rule, ctx);
      await markFire(rule.id, key, true);
    } catch (e) {
      await markFire(rule.id, key, false, String(e).slice(0, 300)).catch(() => {});
      log?.warn({ err: String(e), rule: rule.id }, "automation rule failed");
    }
  };
  try {
    const nowD = new Date();
    const today = nowD.toISOString().slice(0, 10);
    const hour = nowD.getUTCHours();
    const dow = nowD.getUTCDay();

    // per-org overdue task list — shared ctx for both scheduled triggers
    const overdue = await q<{ org_id: string; title: string; id: string; assignee_id: string | null }>(
      `SELECT org_id, title, id, assignee_id FROM tasks
       WHERE due_at IS NOT NULL AND due_at < now() AND status != 'done'`, []);
    const byOrg = new Map<string, typeof overdue>();
    for (const t of overdue) {
      const arr = byOrg.get(t.org_id) ?? [];
      arr.push(t);
      byOrg.set(t.org_id, arr);
    }

    // task.overdue: one fire per task per day
    const odRules = await q<RuleRow>(
      "SELECT * FROM automation_rules WHERE trigger = 'task.overdue' AND enabled", []);
    for (const rule of odRules) {
      for (const t of byOrg.get(rule.org_id) ?? []) {
        await fire(rule, `task:${t.id}:${today}`,
          { taskId: t.id, name: decryptField(t.title) ?? t.title, date: today });
      }
    }

    // approval.overdue: pending drafts older than the rule's day threshold
    const apRules = await q<RuleRow>(
      "SELECT * FROM automation_rules WHERE trigger = 'approval.overdue' AND enabled", []);
    if (apRules.length) {
      const pending = await q<{
        org_id: string; vid: string; file_id: string; created_by: string;
        pending_at: string; approval_step: number | null; approval_chain: unknown;
      }>(
        `SELECT st.org_id, v.id AS vid, v.file_id, v.created_by, v.pending_at,
                v.approval_step, v.approval_chain
         FROM versions v
         JOIN items i ON i.id = v.file_id
         JOIN libraries l ON l.id = i.library_id
         JOIN sites st ON st.id = l.site_id
         WHERE v.pending AND v.pending_at IS NOT NULL`, []);
      for (const rule of apRules) {
        const days = Math.max(1, Number(rule.match?.days ?? 2));
        for (const p of pending) {
          if (p.org_id !== rule.org_id) continue;
          if (Date.now() - new Date(p.pending_at).getTime() < days * 864e5) continue;
          const steps = normalizeChain(p.approval_chain);
          const step = steps[p.approval_step ?? 0];
          const daysPending = Math.floor((Date.now() - new Date(p.pending_at).getTime()) / 864e5);
          await fire(rule, `appr:${p.vid}:${today}`, {
            fileId: p.file_id, name: "pending approval", date: today,
            daysPending: String(daysPending), step: String((p.approval_step ?? 0) + 1),
            approverId: step?.ids[0] ?? "", submitterId: p.created_by,
          });
        }
      }
    }

    // schedule.daily / schedule.weekly: digests in the rule's UTC hour
    const daily = await q<RuleRow>(
      "SELECT * FROM automation_rules WHERE trigger IN ('schedule.daily','schedule.weekly') AND enabled", []);
    for (const rule of daily) {
      const want = Math.max(0, Math.min(23, Number(rule.match?.hour ?? 8)));
      if (hour !== want) continue;
      if (rule.trigger === "schedule.weekly") {
        const wantDow = Math.max(0, Math.min(6, Number(rule.match?.dow ?? 1)));
        if (dow !== wantDow) continue;
      }
      const list = byOrg.get(rule.org_id) ?? [];
      const names = list.slice(0, 8).map((t) => decryptField(t.title) ?? t.title);
      await fire(rule, `${rule.trigger}:${today}`, {
        date: today, overdueCount: String(list.length), overdueNames: names.join(", "),
        name: `${rule.trigger === "schedule.weekly" ? "weekly" : "daily"} digest ${today}`,
      });
    }
  } catch (e) {
    log?.warn({ err: String(e) }, "automation sweep failed");
  }
}
