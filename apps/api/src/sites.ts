// Site helpers — SharePoint-style site → library → item permission plumbing.
// Kept free of auth.js imports so auth.ts can use these without a cycle.
import { one, q } from "./db.js";
import { decryptField } from "./crypto.js";
import type { Library, Permission, Site, SiteMember, SiteRole } from "@kreatix/shared";

export interface SiteRow {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  type: Site["type"];
  visibility: "org" | "private";
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface LibraryRow {
  id: string;
  site_id: string;
  name: string;
  kind: Library["kind"];
  created_at: string;
}

export const getSite = (id: string) => one<SiteRow>("SELECT * FROM sites WHERE id = $1", [id]);
export const getLibrary = (id: string) => one<LibraryRow>("SELECT * FROM libraries WHERE id = $1", [id]);

interface Userish { id: string; orgId: string; role: string }

/** Effective site role for a user: site owner → membership row → org-admin
 *  override → org-wide visibility → null. */
export async function siteRoleFor(user: Userish, site: SiteRow): Promise<SiteRole | null> {
  if (site.org_id !== user.orgId) return null;
  if (site.owner_id === user.id) return "owner";
  const m = await one<{ role: SiteRole }>(
    "SELECT role FROM site_members WHERE site_id = $1 AND user_id = $2",
    [site.id, user.id],
  );
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

/** Permission a user gains on library items via site membership, or null.
 *  Single join query — used by permissionFor when item.library_id is set. */
export async function libraryPermission(userId: string, libraryId: string): Promise<Permission | null> {
  const row = await one<{
    member_role: SiteRole | null;
    owner_id: string;
    visibility: string;
    site_org: string;
    user_role: string;
    user_org: string;
  }>(
    `SELECT sm.role AS member_role, st.owner_id, st.visibility, st.org_id AS site_org,
            u.role AS user_role, u.org_id AS user_org
     FROM libraries l
     JOIN sites st ON st.id = l.site_id
     JOIN users u ON u.id = $2
     LEFT JOIN site_members sm ON sm.site_id = st.id AND sm.user_id = $2
     WHERE l.id = $1`,
    [libraryId, userId],
  );
  if (!row || row.site_org !== row.user_org) return null;
  const role: SiteRole | null =
    row.owner_id === userId ? "owner"
    : row.member_role ?? (row.user_role === "owner" || row.user_role === "admin" ? "owner"
    : row.visibility === "org" ? "visitor" : null);
  return role ? SITE_PERM[role] : null;
}

/** IDs of every library the user can see — member sites, org-visible sites,
 *  and (for org owner/admin) all sites in the org. Used by Drive listings. */
export async function visibleLibraryIds(user: Userish): Promise<string[]> {
  const rows = await q<{ id: string }>(
    `SELECT l.id FROM libraries l JOIN sites st ON st.id = l.site_id
     WHERE st.org_id = $1 AND (
       st.visibility = 'org'
       OR $3::boolean
       OR EXISTS (SELECT 1 FROM site_members sm WHERE sm.site_id = st.id AND sm.user_id = $2)
       OR st.owner_id = $2)`,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function toLibrary(row: LibraryRow, itemCount?: number): Promise<Library> {
  return {
    id: row.id,
    siteId: row.site_id,
    name: decryptField(row.name) ?? row.name,
    kind: row.kind,
    itemCount,
    createdAt: row.created_at,
  };
}

export function memberOut(userId: string, role: SiteRole, u: { display_name: string; email: string; initials: string }, created_at: string): SiteMember {
  return { userId, role, createdAt: created_at, user: { displayName: u.display_name, email: u.email, initials: u.initials } };
}
