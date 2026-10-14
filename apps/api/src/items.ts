import { randomUUID } from "node:crypto";
import { q, one, run, now } from "./db.js";
import { encryptField, decryptField } from "./crypto.js";
import type { DriveItem, FileKind } from "@kreatix/shared";

export interface ItemRow {
  id: string;
  org_id: string;
  parent_id: string | null;
  owner_id: string;
  name: string;
  kind: FileKind;
  mime: string;
  size: number;
  starred: boolean;
  trashed: boolean;
  label: string;
  media_for: string | null;
  library_id: string | null;
  checked_out_by: string | null;
  checked_out_at: string | null;
  created_at: string;
  updated_at: string;
}

export function getItem(id: string): Promise<ItemRow | undefined> {
  return one<ItemRow>("SELECT * FROM items WHERE id = $1", [id]);
}

/** Decrypt an item's stored name (plaintext passthrough when key unset). */
export function itemName(row: { name: string }): string {
  return decryptField(row.name) ?? row.name;
}

export async function toDriveItem(
  row: ItemRow,
  permission?: DriveItem["permission"],
  opts?: { metadata?: Record<string, string | null>; inherited?: boolean },
): Promise<DriveItem> {
  const collaborators = await q<{ initials: string; display_name: string }>(
    `SELECT u.initials, u.display_name FROM shares s JOIN users u ON u.id = s.user_id
     WHERE s.file_id = $1 LIMIT 4`,
    [row.id],
  );
  const lockHolder = row.checked_out_by
    ? await one<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [row.checked_out_by])
    : undefined;
  return {
    id: row.id,
    orgId: row.org_id,
    parentId: row.parent_id,
    ownerId: row.owner_id,
    name: itemName(row),
    kind: row.kind,
    mimeType: row.mime,
    size: row.size,
    starred: !!row.starred,
    trashed: !!row.trashed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    label: row.label ?? "internal",
    libraryId: row.library_id ?? null,
    checkedOut: row.checked_out_by
      ? { userId: row.checked_out_by, name: lockHolder?.display_name ?? "Someone", at: row.checked_out_at ?? "" }
      : null,
    metadata: opts?.metadata,
    inherited: opts?.inherited,
    permission,
    collaborators: collaborators.map((c) => ({ initials: c.initials, displayName: c.display_name })),
  };
}

/** True when the item is checked out by someone other than `userId` — those
 *  users keep read access but all writes (content, rename, move, delete) are
 *  blocked until check-in/discard, SharePoint-style. */
export function writeLocked(item: Pick<ItemRow, "checked_out_by">, userId: string): boolean {
  return !!item.checked_out_by && item.checked_out_by !== userId;
}

export function touchItem(id: string) {
  return run("UPDATE items SET updated_at = $1 WHERE id = $2", [now(), id]);
}

export function logActivity(orgId: string, actorId: string, fileId: string | null, action: string, detail?: string) {
  return run(
    "INSERT INTO activity (id, org_id, actor_id, file_id, action, detail, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [randomUUID(), orgId, actorId, fileId, action, encryptField(detail ?? null), now()],
  );
}
