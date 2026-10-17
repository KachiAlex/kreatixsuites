// Site helpers — SharePoint-style site → library → item permission plumbing.
// Kept free of auth.js imports so auth.ts can use these without a cycle.
import { randomUUID } from "node:crypto";
import { one, q, run, now } from "./db.js";
import { decryptField, encryptField } from "./crypto.js";

/** Normalize a stored approval chain — accepts legacy `string[]` user ids and
 *  structured `{ mode, ids }` steps; drops empties. */
export function normalizeChain(raw: unknown): import("@kreatix/shared").ApprovalStep[] {
  if (!Array.isArray(raw)) return [];
  const out: import("@kreatix/shared").ApprovalStep[] = [];
  for (const e of raw) {
    if (typeof e === "string" && e) {
      out.push({ mode: "any", ids: [e] });
    } else if (e && typeof e === "object") {
      const ids = Array.isArray((e as { ids?: unknown }).ids)
        ? (e as { ids: unknown[] }).ids.filter((x): x is string => typeof x === "string" && !!x)
        : [];
      if (ids.length) out.push({ mode: (e as { mode?: string }).mode === "all" ? "all" : "any", ids });
    }
  }
  return out;
}
import type { Library, Permission, Site, SiteMember, SiteRole } from "@kreatix/shared";

export interface SiteRow {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  type: Site["type"];
  visibility: "org" | "private";
  owner_id: string;
  hub_id: string | null;
  legal_hold: boolean;
  created_at: string;
  updated_at: string;
}

export interface LibraryRow {
  id: string;
  site_id: string;
  name: string;
  kind: Library["kind"];
  versioning: "major" | "minor";
  approval: boolean;
  inherit_permissions: boolean;
  retention_days: number | null;
  approval_chain: unknown; // JSONB — normalizeChain() parses
  created_at: string;
}

export const getSite = (id: string) => one<SiteRow>("SELECT * FROM sites WHERE id = $1", [id]);
export const getLibrary = (id: string) => one<LibraryRow>("SELECT * FROM libraries WHERE id = $1", [id]);

interface Userish { id: string; orgId: string; role: string }

/** SQL fragment: best site role a user holds via direct membership or group
 *  membership (site_group_members). Expects $1 = site id (or a correlated
 *  column like `st.id` after replaceAll), $2 = user id param. */
export const SITE_ROLE_SQL = `
  SELECT role FROM (
    SELECT role FROM site_members WHERE site_id = $1 AND user_id = $2
    UNION ALL
    SELECT sgm.role FROM site_group_members sgm
      JOIN group_members gm ON gm.group_id = sgm.group_id AND gm.user_id = $2
      WHERE sgm.site_id = $1
  ) r ORDER BY CASE r.role WHEN 'owner' THEN 3 WHEN 'member' THEN 2 ELSE 1 END DESC
  LIMIT 1`;

/** SQL fragment: best role a user holds on a library via direct or group
 *  grant — same shape as SITE_ROLE_SQL but against library_permissions. */
export const LIB_ROLE_SQL = `
  SELECT role FROM (
    SELECT role FROM library_permissions WHERE library_id = $1 AND user_id = $2
    UNION ALL
    SELECT lgp.role FROM library_group_permissions lgp
      JOIN group_members gm ON gm.group_id = lgp.group_id AND gm.user_id = $2
      WHERE lgp.library_id = $1
  ) r ORDER BY CASE r.role WHEN 'owner' THEN 3 WHEN 'member' THEN 2 ELSE 1 END DESC
  LIMIT 1`;

/** Effective site role for a user: site owner → membership or group grant →
 *  org-admin override → org-wide visibility → null. Most-permissive wins when
 *  several paths apply. */
export async function siteRoleFor(user: Userish, site: SiteRow): Promise<SiteRole | null> {
  if (site.org_id !== user.orgId) return null;
  if (site.owner_id === user.id) return "owner";
  const m = await one<{ role: SiteRole }>(SITE_ROLE_SQL, [site.id, user.id]);
  if (m) return m.role;
  // tenant admins can manage every site (SharePoint site-collection admin)
  if (user.role === "owner" || user.role === "admin") return "owner";
  if (site.visibility === "org") return "visitor";
  return null;
}

const SITE_PERM: Record<SiteRole, Permission> = {
  owner: "owner",
  member: "editor",
  visitor: "viewer",
};

/** Permission a user gains on library items via site membership (or an
 *  explicit library grant when inheritance is broken), or null. Single join
 *  query — used by permissionFor when item.library_id is set. */
export async function libraryPermission(userId: string, libraryId: string): Promise<Permission | null> {
  const row = await one<{
    member_role: SiteRole | null;
    lib_role: SiteRole | null;
    inherit: boolean;
    owner_id: string;
    visibility: string;
    site_org: string;
    user_role: string;
    user_org: string;
  }>(
    `SELECT (
       ${SITE_ROLE_SQL.replaceAll("$1", "st.id").replaceAll("$2", "$2")}
     ) AS member_role,
     (
       ${LIB_ROLE_SQL.replaceAll("$1", "l.id").replaceAll("$2", "$2")}
     ) AS lib_role,
     l.inherit_permissions AS inherit,
     st.owner_id, st.visibility, st.org_id AS site_org,
     u.role AS user_role, u.org_id AS user_org
     FROM libraries l
     JOIN sites st ON st.id = l.site_id
     JOIN users u ON u.id = $2
     WHERE l.id = $1`,
    [libraryId, userId],
  );
  if (!row || row.site_org !== row.user_org) return null;
  // site owner + org admins always reach every library (site-collection admin)
  if (row.owner_id === userId || row.user_role === "owner" || row.user_role === "admin")
    return "owner";
  if (!row.inherit) return row.lib_role ? SITE_PERM[row.lib_role] : null;
  const role: SiteRole | null =
    row.member_role ?? (row.visibility === "org" ? "visitor" : null);
  return role ? SITE_PERM[role] : null;
}

/** Effective site-style role on a specific library — handler-level variant of
 *  libraryPermission that also honors broken inheritance. Used by library-
 *  scoped routes (columns, views, pending queue) and list browsing. */
export async function libraryRoleFor(user: Userish, site: SiteRow, lib: LibraryRow): Promise<SiteRole | null> {
  if (site.org_id !== user.orgId) return null;
  if (site.owner_id === user.id || user.role === "owner" || user.role === "admin") return "owner";
  if (!lib.inherit_permissions) {
    const g = await one<{ role: SiteRole }>(LIB_ROLE_SQL, [lib.id, user.id]);
    return g?.role ?? null;
  }
  return siteRoleFor(user, site);
}

/** IDs of every library the user can see — member sites, org-visible sites,
 *  explicit grants on broken-inheritance libraries, and (for org owner/admin)
 *  all sites in the org. Used by Drive listings. */
export async function visibleLibraryIds(user: Userish): Promise<string[]> {
  const rows = await q<{ id: string }>(
    `SELECT l.id FROM libraries l
     JOIN sites st ON st.id = l.site_id
     LEFT JOIN site_members sm ON sm.site_id = st.id AND sm.user_id = $2
     LEFT JOIN library_permissions lp ON lp.library_id = l.id AND lp.user_id = $2
     WHERE st.org_id = $1 AND (
       $3::boolean OR st.owner_id = $2 OR lp.user_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM library_group_permissions lgp
                  JOIN group_members gm ON gm.group_id = lgp.group_id
                  WHERE lgp.library_id = l.id AND gm.user_id = $2)
       OR (l.inherit_permissions AND (st.visibility = 'org' OR sm.user_id IS NOT NULL
           OR EXISTS (SELECT 1 FROM site_group_members sgm
                      JOIN group_members gm ON gm.group_id = sgm.group_id
                      WHERE sgm.site_id = st.id AND gm.user_id = $2))))`,
    [user.orgId, user.id, user.role === "owner" || user.role === "admin"],
  );
  return rows.map((r) => r.id);
}

export function toSite(row: SiteRow, myRole?: SiteRole | null, memberCount?: number): Site {
  return {
    id: row.id,
    orgId: row.org_id,
    name: decryptField(row.name) ?? row.name,
    description: row.description ? decryptField(row.description) ?? row.description : null,
    type: row.type,
    visibility: row.visibility,
    ownerId: row.owner_id,
    myRole: myRole ?? null,
    memberCount,
    hubId: row.hub_id ?? null,
    legalHold: !!row.legal_hold,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** IDs of users who hold owner rank on this library — the approval audience:
 *  site owner, owner site members/groups (when inheriting), explicit library
 *  owner grants (when broken), and tenant admins. Mirrors canApprove. */
export async function approverIds(libraryId: string): Promise<string[]> {
  const rows = await q<{ id: string }>(
    `SELECT DISTINCT uid AS id FROM (
       SELECT st.owner_id AS uid FROM sites st
         JOIN libraries l ON l.site_id = st.id WHERE l.id = $1
       UNION
       SELECT sm.user_id FROM site_members sm
         JOIN libraries l ON l.site_id = sm.site_id
         WHERE l.id = $1 AND l.inherit_permissions AND sm.role = 'owner'
       UNION
       SELECT gm.user_id FROM site_group_members sgm
         JOIN libraries l ON l.site_id = sgm.site_id
         JOIN group_members gm ON gm.group_id = sgm.group_id
         WHERE l.id = $1 AND l.inherit_permissions AND sgm.role = 'owner'
       UNION
       SELECT lp.user_id FROM library_permissions lp
         JOIN libraries l ON l.id = lp.library_id
         WHERE lp.library_id = $1 AND NOT l.inherit_permissions AND lp.role = 'owner'
       UNION
       SELECT gm.user_id FROM library_group_permissions lgp
         JOIN libraries l ON l.id = lgp.library_id
         JOIN group_members gm ON gm.group_id = lgp.group_id
         WHERE lgp.library_id = $1 AND NOT l.inherit_permissions AND lgp.role = 'owner'
       UNION
       SELECT u.id FROM users u
         JOIN libraries l ON true
         JOIN sites st ON st.id = l.site_id
         WHERE l.id = $1 AND u.org_id = st.org_id AND u.role IN ('owner','admin')
     ) r`,
    [libraryId],
  );
  return rows.map((r) => r.id);
}

/** Library alerts (SharePoint "Alert me") — every subscriber except the
 *  actor gets a notification row for the file event. */
export async function notifyLibrarySubscribers(
  libraryId: string | null,
  actorId: string,
  kind: string,
  fileId: string | null,
  message: string,
): Promise<void> {
  if (!libraryId) return;
  const subs = await q<{ user_id: string; org_id: string }>(
    `SELECT s.user_id, u.org_id FROM library_subscriptions s
     JOIN users u ON u.id = s.user_id
     WHERE s.library_id = $1 AND s.user_id != $2`,
    [libraryId, actorId],
  );
  for (const sub of subs) {
    await run(
      `INSERT INTO notifications (id, user_id, kind, file_id, library_id, actor_id, message, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), sub.user_id, kind, fileId, libraryId, actorId, encryptField(message), now()],
    );
  }
}

export async function toLibrary(row: LibraryRow, itemCount?: number): Promise<Library> {
  return {
    id: row.id,
    siteId: row.site_id,
    name: decryptField(row.name) ?? row.name,
    kind: row.kind,
    versioning: row.versioning === "minor" ? "minor" : "major",
    approval: !!row.approval,
    inheritPermissions: row.inherit_permissions !== false,
    approvalChain: normalizeChain(row.approval_chain).length
      ? normalizeChain(row.approval_chain) : null,
    retentionDays: row.retention_days ?? null,
    itemCount,
    createdAt: row.created_at,
  };
}

export function memberOut(userId: string, role: SiteRole, u: { display_name: string; email: string; initials: string }, created_at: string): SiteMember {
  return { userId, role, createdAt: created_at, user: { displayName: u.display_name, email: u.email, initials: u.initials } };
}
