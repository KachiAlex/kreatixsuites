// User erasure (GDPR delete + SCIM deprovision). Policy:
//   - the user row is ANONYMIZED, not deleted — every FK stays valid and
//     shared content (comments, chat messages, versions, hold custodians)
//     keeps an intelligible "Deleted user" attribution instead of either
//     500ing on RESTRICT FKs or cascade-wiping org data
//   - personal artifacts (mentions, comments, invites, memberships,
//     notifications, per-user settings) are deleted outright
//   - owned files are deleted when nobody else was shared in; files with
//     collaborators transfer to a successor (another owner → admin →
//     earliest member) so colleagues don't lose shared work
//   - org infrastructure (sites, meetings, wikis, calendar events, forms,
//     tasks) always transfers — it was never personal data
//   - when the user is the LAST member, the whole org is deleted instead
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { one, q, run, tx, DATA_DIR } from "./db.js";

const blobFile = (key: string) => join(DATA_DIR, "blobs", key.slice(0, 2), key);

/** Delete blob files no remaining version references (post-commit). */
export async function unlinkOrphanedBlobs(keys: string[]): Promise<number> {
  let n = 0;
  for (const k of keys) {
    if (await one("SELECT 1 AS x FROM versions WHERE blob_key = $1 LIMIT 1", [k])) continue;
    try { await unlink(blobFile(k)); n++; } catch { /* already gone */ }
  }
  return n;
}

export interface EraseResult {
  mode: "anonymized" | "org_deleted";
  transferredTo: string | null;
  blobsUnlinked: number;
}

/** Erase a user. Anonymizes + transfers when org-mates remain; deletes the
 *  whole org when they're the last member. */
export async function eraseUser(userId: string): Promise<EraseResult> {
  const user = await one<{ id: string; org_id: string }>("SELECT id, org_id FROM users WHERE id = $1", [userId]);
  if (!user) return { mode: "anonymized", transferredTo: null, blobsUnlinked: 0 };

  const mates = await q<{ id: string; role: string }>(
    "SELECT id, role FROM users WHERE org_id = $1 AND id <> $2 ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, created_at LIMIT 1",
    [user.org_id, userId]);
  const successor = mates[0]?.id ?? null;

  if (!successor) {
    // last member — whole-org deletion (same cascade as superadmin org delete)
    const { deleteOrgData } = await import("./orgDelete.js");
    await deleteOrgData(user.org_id);
    return { mode: "org_deleted", transferredTo: null, blobsUnlinked: 0 };
  }

  // blob keys for items that will be deleted (not transferred)
  const doomed = await q<{ blob_key: string }>(
    `SELECT v.blob_key FROM versions v
     JOIN items i ON i.id = v.file_id
     WHERE i.owner_id = $1
       AND NOT EXISTS (SELECT 1 FROM shares s WHERE s.file_id = i.id)`,
    [userId]).then((rows) => rows.map((r) => r.blob_key));

  await tx(async (c) => {
    // delete private items (nobody shared in); transfer the rest
    await c.query(
      `DELETE FROM items WHERE owner_id = $1
       AND NOT EXISTS (SELECT 1 FROM shares s WHERE s.file_id = items.id)`, [userId]);
    await c.query("UPDATE items SET owner_id = $2 WHERE owner_id = $1", [userId, successor]);

    // org infrastructure → successor (the FK graph's transfer set)
    for (const [table, col] of [
      ["sites", "owner_id"], ["meetings", "created_by"], ["wiki_pages", "created_by"],
      ["calendar_events", "created_by"], ["forms", "created_by"], ["tasks", "created_by"],
    ] as const) {
      await c.query(`UPDATE ${table} SET ${col} = $2 WHERE ${col} = $1`, [userId, successor]);
    }

    // personal rows → gone
    for (const [table, col] of [
      ["activity", "actor_id"], ["mentions", "from_user_id"], ["comments", "author_id"],
      ["ai_actions", "user_id"], ["ai_usage", "user_id"], ["shares", "user_id"],
      ["org_invites", "created_by"], ["feedback", "user_id"], ["notifications", "user_id"],
      ["notifications", "actor_id"], ["chat_members", "user_id"], ["meeting_attendance", "user_id"],
      ["calendar_attendees", "user_id"], ["library_permissions", "user_id"],
      ["library_subscriptions", "user_id"], ["site_members", "user_id"],
      ["group_members", "user_id"], ["library_views", "created_by"], ["mail_priority", "user_id"],
    ] as const) {
      await c.query(`DELETE FROM ${table} WHERE ${col} = $1`, [userId]).catch(() => {});
    }
    await c.query("DELETE FROM calendar_delegates WHERE owner_id = $1 OR delegate_id = $1", [userId]).catch(() => {});
    await c.query("DELETE FROM mail_shares WHERE owner_id = $1 OR delegate_id = $1", [userId]).catch(() => {});
    // versions authored on files now owned by others
    await c.query(
      "DELETE FROM versions WHERE created_by = $1 AND file_id NOT IN (SELECT id FROM items WHERE owner_id = $1)",
      [userId]);

    // anonymize — the row stays so chat messages/reactions/versions authored
    // keep a coherent attribution and every FK stays satisfied
    await c.query(
      `UPDATE users SET
         email = 'deleted-' || id || '@deleted.invalid',
         display_name = 'Deleted user', initials = 'DU',
         password_hash = 'deleted', disabled = true, role = 'member',
         totp_secret = NULL, totp_backups = NULL, scim_external_id = NULL,
         delegate_id = NULL, delegate_until = NULL,
         mail_user_id = NULL, mail_email = NULL
       WHERE id = $1`, [userId]);
  });

  const unlinked = await unlinkOrphanedBlobs(doomed);
  return { mode: "anonymized", transferredTo: successor, blobsUnlinked: unlinked };
}
