// Automation rules — "when X → do Y" wiring between suite apps. Triggers are
// fired at existing emit points (form submitted, file added, task moved,
// meeting ended); actions create a task or drop a bell notification.
// Fire-and-forget: rule failures log and never block the source event.
import { randomUUID } from "node:crypto";
import { q, run } from "./db.js";
import { encryptField, decryptField } from "./crypto.js";

export type RuleTrigger = "form.submitted" | "file.created" | "task.status" | "meeting.ended"
  | "schedule.daily" | "task.overdue";
export type RuleAction = "task.create" | "notify";

export interface RuleRow {
  id: string; org_id: string; name: string; enabled: boolean;
  trigger: string; match: Record<string, string> | null;
  action: string; config: Record<string, string | null>;
  created_by: string; created_at: string;
}

export const TRIGGERS: { id: RuleTrigger; label: string; matchKey?: string; matchLabel?: string }[] = [
  { id: "form.submitted", label: "Form response submitted", matchKey: "formId", matchLabel: "Limit to a form" },
  { id: "file.created", label: "File added to a library", matchKey: "libraryId", matchLabel: "Limit to a library" },
  { id: "task.status", label: "Task moved to a status", matchKey: "status", matchLabel: "Status (todo|doing|done)" },
  { id: "meeting.ended", label: "Meeting ended" },
  { id: "task.overdue", label: "Task becomes overdue (daily)" },
  { id: "schedule.daily", label: "Every day at…", matchKey: "hour", matchLabel: "UTC hour (0-23, default 8)" },
];

export const ACTIONS: { id: RuleAction; label: string }[] = [
  { id: "task.create", label: "Create a task" },
  { id: "notify", label: "Send a notification" },
];

/** {{var}} interpolation against the trigger context. */
const interp = (tpl: string, ctx: Record<string, string>) =>
  tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => ctx[k] ?? "");

/** Match filter: every key in rule.match must equal ctx[key]. */
const matches = (rule: RuleRow, ctx: Record<string, string>) =>
  !rule.match || Object.entries(rule.match).every(([k, v]) => ctx[k] === v);

/** Fire a trigger — runs every enabled matching rule in the org. Callers use
 *  `void fireTrigger(...)`; errors are logged, never thrown. */
export async function fireTrigger(
  orgId: string,
  trigger: RuleTrigger,
  ctx: Record<string, string>,
  log?: { warn: (o: unknown, m: string) => void },
): Promise<number> {
  let fired = 0;
  try {
    const rules = await q<RuleRow>(
      "SELECT * FROM automation_rules WHERE org_id = $1 AND trigger = $2 AND enabled",
      [orgId, trigger]);
    for (const rule of rules) {
      if (!matches(rule, ctx)) continue;
      try {
        await execute(rule, ctx);
        fired++;
      } catch (e) {
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
  if (rule.action === "task.create") {
    const title = interp(cfg.title ?? `${rule.name}: {{name}}`, ctx).slice(0, 200) || rule.name;
    const notes = cfg.notes ? interp(cfg.notes, ctx).slice(0, 4000) : null;
    const assignee = cfg.assigneeId || null;
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
  if (rule.action === "notify") {
    const message = interp(cfg.message ?? `${rule.name}: {{name}}`, ctx).slice(0, 300);
    if (cfg.userId) {
      await notify(rule.org_id, cfg.userId, message, rule.created_by);
    } else {
      // no target → org owner + admins
      const admins = await q<{ id: string }>(
        "SELECT id FROM users WHERE org_id = $1 AND role IN ('owner','admin') AND NOT disabled", [rule.org_id]);
      for (const a of admins) await notify(rule.org_id, a.id, message, rule.created_by);
    }
  }
}

async function notify(orgId: string, userId: string, message: string, actorId: string | null) {
  await run(
    `INSERT INTO notifications (id, user_id, kind, actor_id, message)
     SELECT $1, $2, 'automation', $3, $4 WHERE EXISTS (SELECT 1 FROM users WHERE id = $2 AND org_id = $5)`,
    [randomUUID(), userId, actorId, encryptField(message) ?? message, orgId]);
}

/** Dedupe marker — a (rule, key) pair fires once. Returns true the first
 *  time; subsequent calls no-op. Keys embed a period ("2026-10-17") for
 *  per-day schedules or a stable id for one-shot triggers. */
async function claimFire(ruleId: string, key: string): Promise<boolean> {
  const row = await q<{ x: number }>(
    `INSERT INTO automation_fires (rule_id, dedupe_key) VALUES ($1,$2)
     ON CONFLICT DO NOTHING RETURNING 1 AS x`, [ruleId, key]);
  return row.length > 0;
}

/** Hourly sweep: fires `task.overdue` for newly-overdue tasks and
 *  `schedule.daily` digests at each rule's configured UTC hour. Called from
 *  a server interval — never throws. */
export async function runScheduleSweep(
  log?: { warn: (o: unknown, m: string) => void; info?: (o: unknown, m: string) => void },
): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const hour = new Date().getUTCHours();

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
        if (!(await claimFire(rule.id, `task:${t.id}:${today}`))) continue;
        const title = decryptField(t.title) ?? t.title;
        void execute(rule, { taskId: t.id, name: title, date: today })
          .catch((e) => log?.warn({ err: String(e), rule: rule.id }, "automation rule failed"));
      }
    }

    // schedule.daily: fires in the rule's UTC hour, once per day
    const daily = await q<RuleRow>(
      "SELECT * FROM automation_rules WHERE trigger = 'schedule.daily' AND enabled", []);
    for (const rule of daily) {
      const want = Math.max(0, Math.min(23, Number(rule.match?.hour ?? 8)));
      if (hour !== want) continue;
      if (!(await claimFire(rule.id, `daily:${today}`))) continue;
      const list = byOrg.get(rule.org_id) ?? [];
      const names = list.slice(0, 8).map((t) => decryptField(t.title) ?? t.title);
      void execute(rule, {
        date: today, overdueCount: String(list.length), overdueNames: names.join(", "),
        name: `daily digest ${today}`,
      }).catch((e) => log?.warn({ err: String(e), rule: rule.id }, "automation rule failed"));
    }
  } catch (e) {
    log?.warn({ err: String(e) }, "automation sweep failed");
  }
}
