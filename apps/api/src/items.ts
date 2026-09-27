import { randomUUID } from "node:crypto";
import { db, now } from "./db.js";
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
  starred: number;
  trashed: number;
  label: string;
  created_at: string;
  updated_at: string;
}

export function getItem(id: string): ItemRow | undefined {
  return db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
}

/** Decrypt an item's stored name (plaintext passthrough when key unset). */
export function itemName(row: { name: string }): string {
  return decryptField(row.name) ?? row.name;
}

export function toDriveItem(row: ItemRow, permission?: DriveItem["permission"]): DriveItem {
  const collaborators = db
    .prepare(
      `SELECT u.initials, u.display_name FROM shares s JOIN users u ON u.id = s.user_id
       WHERE s.file_id = ? LIMIT 4`,
    )
    .all(row.id) as { initials: string; display_name: string }[];
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
  db.prepare("UPDATE items SET updated_at = ? WHERE id = ?").run(now(), id);
}

export function logActivity(orgId: string, actorId: string, fileId: string | null, action: string, detail?: string) {
  db.prepare(
    "INSERT INTO activity (id, org_id, actor_id, file_id, action, detail, created_at) VALUES (?,?,?,?,?,?,?)",
  ).run(randomUUID(), orgId, actorId, fileId, action, encryptField(detail ?? null), now());
}
