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

export async function toDriveItem(row: ItemRow, permission?: DriveItem["permission"]): Promise<DriveItem> {
  const collaborators = await q<{ initials: string; display_name: string }>(
    `SELECT u.initials, u.display_name FROM shares s JOIN users u ON u.id = s.user_id
     WHERE s.file_id = $1 LIMIT 4`,
    [row.id],
  );
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
    permission,
    collaborators: collaborators.map((c) => ({ initials: c.initials, displayName: c.display_name })),
  };
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
