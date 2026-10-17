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
  legal_hold: boolean;
  dlp_flagged: boolean;
  media_for: string | null;
  library_id: string | null;
  content_type_id: string | null;
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

/** Bulk variant — 3 queries total regardless of row count (was ~3 per row:
 *  collaborators, lock-holder name, pending-head). `perms[i]` aligns with
 *  `rows[i]`; pass the result of a bulk permissionsFor. */
export async function toDriveItems(
  rows: ItemRow[],
  perms?: (DriveItem["permission"] | undefined)[],
  opts?: { metaByItem?: Map<string, Record<string, string | null>>; approver?: boolean; inherited?: boolean },
): Promise<DriveItem[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const lockIds = [...new Set(rows.map((r) => r.checked_out_by).filter((x): x is string => !!x))];
  const libIds = rows.filter((r) => r.library_id).map((r) => r.id);
  const [shareRows, lockRows, pendingRows] = await Promise.all([
    q<{ file_id: string; initials: string; display_name: string }>(
      `SELECT s.file_id, u.initials, u.display_name FROM shares s JOIN users u ON u.id = s.user_id
       WHERE s.file_id = ANY($1)`, [ids]),
    lockIds.length
      ? q<{ id: string; display_name: string }>("SELECT id, display_name FROM users WHERE id = ANY($1)", [lockIds])
      : Promise.resolve([] as { id: string; display_name: string }[]),
    libIds.length
      ? q<{ file_id: string; pending: boolean }>(
        `SELECT DISTINCT ON (file_id) file_id, pending FROM versions
         WHERE file_id = ANY($1) ORDER BY file_id, number DESC`, [libIds])
      : Promise.resolve([] as { file_id: string; pending: boolean }[]),
  ]);
  const collabByFile = new Map<string, { initials: string; displayName: string }[]>();
  for (const s of shareRows) {
    const list = collabByFile.get(s.file_id) ?? [];
    if (list.length < 4) list.push({ initials: s.initials, displayName: s.display_name });
    collabByFile.set(s.file_id, list);
  }
  const lockNames = new Map(lockRows.map((r) => [r.id, r.display_name]));
  const pendingByFile = new Map(pendingRows.map((r) => [r.file_id, r.pending]));
  return rows.map((row, i) => {
    const lockHolderName = row.checked_out_by ? lockNames.get(row.checked_out_by) : undefined;
    const pendingApproval = row.library_id ? pendingByFile.get(row.id) : undefined;
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
      legalHold: !!row.legal_hold,
      dlpFlagged: !!row.dlp_flagged,
      libraryId: row.library_id ?? null,
      contentTypeId: row.content_type_id ?? null,
      checkedOut: row.checked_out_by
        ? { userId: row.checked_out_by, name: lockHolderName ?? "Someone", at: row.checked_out_at ?? "" }
        : null,
      pendingApproval,
      canApprove: opts?.approver,
      metadata: opts?.metaByItem?.get(row.id),
      inherited: opts?.inherited,
      permission: perms?.[i],
      collaborators: collabByFile.get(row.id) ?? [],
    } satisfies DriveItem;
  });
}

export async function toDriveItem(
  row: ItemRow,
  permission?: DriveItem["permission"],
  opts?: { metadata?: Record<string, string | null>; inherited?: boolean; approver?: boolean },
): Promise<DriveItem> {
  const [item] = await toDriveItems([row], [permission], {
    metaByItem: opts?.metadata ? new Map([[row.id, opts.metadata]]) : undefined,
    inherited: opts?.inherited,
    approver: opts?.approver,
  });
  return item;
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

export function logActivity(orgId: string, actorId: string, fileId: string | null, action: string, detail?: string, siteId?: string) {
  return run(
    "INSERT INTO activity (id, org_id, actor_id, file_id, action, detail, site_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [randomUUID(), orgId, actorId, fileId, action, encryptField(detail ?? null), siteId ?? null, now()],
  );
}
