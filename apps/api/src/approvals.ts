// Multi-step approval chains — shared by content.ts, drive.ts, and rules.ts.
// A library's approval_chain is an ordered list of steps; each step is
// { mode: "any"|"all", ids: userIds[] }. "any" advances on the first
// signature, "all" waits for every member. An active delegation lets a
// delegate act on a member's behalf. The pending version snapshots the
// chain so mid-review edits don't corrupt an in-flight approval.
import { randomUUID } from "node:crypto";
import { q, one, run, now } from "./db.js";
import { encryptField } from "./crypto.js";
import { itemName, type ItemRow } from "./items.js";
import { getLibrary, approverIds, normalizeChain } from "./sites.js";
import type { ApprovalStep } from "@kreatix/shared";

export { normalizeChain };
export type { ApprovalStep };

/** Members of `step` the user may act for — themselves plus anyone who has
 *  actively delegated to them. Returns the covered *entry* ids. */
export async function coveredEntries(userId: string, step: ApprovalStep): Promise<string[]> {
  const rows = await q<{ id: string }>(
    `SELECT u.id FROM users u
     WHERE u.id = ANY($1)
       AND (u.id = $2 OR (u.delegate_id = $2 AND (u.delegate_until IS NULL OR u.delegate_until > now())))`,
    [step.ids, userId]);
  return rows.map((r) => r.id);
}

/** Everyone who should be notified that a step is waiting: the step members
 *  plus each member's active delegate (delegates get the ping so they can act). */
async function stepAudience(step: ApprovalStep): Promise<string[]> {
  const rows = await q<{ uid: string }>(
    `SELECT u.id AS uid FROM users u WHERE u.id = ANY($1)
     UNION
     SELECT d.id FROM users u JOIN users d ON d.id = u.delegate_id
       AND (u.delegate_until IS NULL OR u.delegate_until > now())
     WHERE u.id = ANY($1)`,
    [step.ids]);
  return rows.map((r) => r.uid);
}

/** Bell-notify the audience for a pending step. */
export async function notifyApprovalStep(
  item: ItemRow,
  actorId: string,
  step: ApprovalStep,
  stepNum: number,
  total: number,
): Promise<void> {
  const msg = encryptField(
    `"${itemName(item)}" is awaiting your approval` +
    (total > 1 ? ` (step ${stepNum} of ${total}${step.mode === "all" ? ", all sign off" : ""})` : ""));
  for (const uid of await stepAudience(step)) {
    if (uid === actorId) continue;
    await run(
      `INSERT INTO notifications (id, user_id, kind, file_id, library_id, actor_id, message, created_at)
       VALUES ($1,$2,'approval',$3,$4,$5,$6,$7)`,
      [randomUUID(), uid, item.id, item.library_id, actorId, msg, now()]);
  }
}

/** Pend the head version for approval — snapshots the library's chain.
 *  Unlike submitForApproval this ignores the submitter's rank (rules and
 *  owner-oversight paths can force approval on anyone's draft). */
export async function requestApproval(item: ItemRow, actorId: string): Promise<boolean> {
  if (!item.library_id) return false;
  const lib = await getLibrary(item.library_id);
  if (!lib) return false;
  const head = await one<{ id: string; published: boolean; pending: boolean }>(
    "SELECT id, published, pending FROM versions WHERE file_id = $1 ORDER BY number DESC LIMIT 1",
    [item.id]);
  if (!head || head.published || head.pending) return false;
  const steps = normalizeChain(lib.approval_chain);
  await run(
    `UPDATE versions SET pending = true, pending_at = $2,
       approval_step = $3, approval_chain = $4, approval_done = '[]'::jsonb
     WHERE id = $1`,
    [head.id, now(), steps.length ? 0 : null, steps.length ? JSON.stringify(steps) : null]);
  if (steps.length) {
    await notifyApprovalStep(item, actorId, steps[0], 1, steps.length);
  } else {
    // legacy single-step: notify every owner-rank approver
    const msg = encryptField(`"${itemName(item)}" is awaiting approval`);
    for (const uid of await approverIds(item.library_id)) {
      if (uid === actorId) continue;
      await run(
        `INSERT INTO notifications (id, user_id, kind, file_id, library_id, actor_id, message, created_at)
         VALUES ($1,$2,'approval',$3,$4,$5,$6,$7)`,
        [randomUUID(), uid, item.id, item.library_id, actorId, msg, now()]);
    }
  }
  return true;
}
