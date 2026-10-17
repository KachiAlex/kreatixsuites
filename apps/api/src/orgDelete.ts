// Whole-org deletion — shared by the superadmin portal and GDPR self-erasure
// (when the last member deletes their account). The cascade is derived from
// pg_constraint so tables added by later migrations are covered automatically
// instead of rotting in a handwritten list.
import { q, one, tx } from "./db.js";
import { unlinkOrphanedBlobs } from "./lifecycle.js";

export interface OrgDeleteStats {
  users: number;
  files: number;
  blobs: number;
}

/** Permanently deletes an org and every reachable row. Caller handles the
 *  not-found / super-org guards and any audit logging. */
export async function deleteOrgData(orgId: string): Promise<OrgDeleteStats> {
  const stats: OrgDeleteStats = { users: 0, files: 0, blobs: 0 };
  const blobKeys = await tx(async (c) => {
    const del = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rowCount ?? 0;
    const fileIds = (await c.query<{ id: string }>("SELECT id FROM items WHERE org_id = $1", [orgId])).rows.map((r) => r.id);
    const userIds = (await c.query<{ id: string }>("SELECT id FROM users WHERE org_id = $1", [orgId])).rows.map((r) => r.id);
    const keys = fileIds.length
      ? (await c.query<{ blob_key: string }>("SELECT DISTINCT blob_key FROM versions WHERE file_id = ANY($1)", [fileIds])).rows.map((r) => r.blob_key)
      : [];
    if (userIds.length) {
      // cross-org safety: content these users authored on OTHER workspaces'
      // files (shared-file edits) is reassigned to each file's owner so the
      // other tenant keeps its history.
      await del("UPDATE versions v SET created_by = (SELECT owner_id FROM items i WHERE i.id = v.file_id) WHERE v.created_by = ANY($1)", [userIds]);
      await del("UPDATE comments c SET author_id = (SELECT owner_id FROM items i WHERE i.id = c.file_id) WHERE c.author_id = ANY($1)", [userIds]);
      await del("UPDATE items SET owner_id = (SELECT u2.id FROM users u2 WHERE u2.org_id = items.org_id ORDER BY NOT u2.disabled DESC, u2.created_at LIMIT 1) WHERE owner_id = ANY($1) AND org_id <> $2", [userIds, orgId]);
    }

    // Generic org-scoped cascade. Scope of each table = "org_id = $1" (when it
    // has the column) OR any row reachable through an FK into an org-scoped
    // parent (e.g. meeting_attendance → meetings).
    const fks = (await c.query<{ child: string; col: string; parent: string; pkey: string }>(
      `SELECT cl.relname AS child, a.attname AS col, pl.relname AS parent, pa.attname AS pkey
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_class pl ON pl.oid = con.confrelid
       JOIN pg_attribute a  ON a.attrelid = con.conrelid  AND a.attnum = con.conkey[1]
       JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
       WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1`)).rows;
    const orgTables = new Set((await c.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE column_name = 'org_id' AND table_schema = 'public'`)).rows.map((r) => r.table_name));
    const NEVER = new Set(["orgs", "users", "items", "sa_audit", "sweep_state", "backup_runs",
      "billing_config", "plans", "schema_migrations"]);

    // recursive scope expression for table t — memoized; self-FKs ignored
    const scopeOf = (t: string, seen = new Set<string>()): string | null => {
      if (seen.has(t)) return null;
      seen.add(t);
      const parts: string[] = [];
      if (orgTables.has(t)) parts.push(`org_id = $1`);
      for (const f of fks.filter((f) => f.child === t && f.parent !== t)) {
        const ps = scopeOf(f.parent, seen);
        if (ps) parts.push(`${f.col} IN (SELECT ${f.pkey} FROM ${f.parent} WHERE ${ps})`);
      }
      return parts.length ? `(${parts.join(" OR ")})` : null;
    };

    // delete children before parents — deepest (most-child) first. Union of
    // org_id tables (even FK-less ones like org_policies) and every table
    // that references an org-scoped parent.
    const scoped = [...new Set([...orgTables, ...fks.map((f) => f.child)])]
      .filter((t) => !NEVER.has(t) && scopeOf(t) !== null);
    const depth = new Map<string, number>();
    const depthOf = (t: string, seen = new Set<string>()): number => {
      if (depth.has(t)) return depth.get(t)!;
      if (seen.has(t)) return 0;
      seen.add(t);
      const d = 1 + Math.max(0, ...fks.filter((f) => f.parent === t && f.child !== t).map((f) => depthOf(f.child, seen)));
      depth.set(t, d);
      return d;
    };
    scoped.sort((a, b) => depthOf(b) - depthOf(a));

    // each DELETE under a savepoint; on FK violation retry next round until
    // convergence (covers non-self FK cycles the topo sort can't order)
    const pending = new Set([...scoped, "users", "items"]);
    for (let round = 0; round < 8 && pending.size; round++) {
      let progress = false;
      for (const t of [...pending]) {
        const scope = t === "users" || t === "items" ? `org_id = $1` : scopeOf(t);
        if (!scope) { pending.delete(t); continue; }
        try {
          await c.query("SAVEPOINT orgdel");
          const n = await del(`DELETE FROM ${t} WHERE ${scope}`, [orgId]);
          await c.query("RELEASE SAVEPOINT orgdel");
          pending.delete(t);
          if (t === "users") stats.users = n;
          progress = true;
        } catch {
          await c.query("ROLLBACK TO SAVEPOINT orgdel");
        }
      }
      if (!progress) break;
    }
    if (pending.size)
      throw new Error(`org delete blocked by FK: ${[...pending].join(", ")}`);

    stats.files = fileIds.length;
    await del("DELETE FROM orgs WHERE id = $1", [orgId]);
    return keys;
  });

  stats.blobs = await unlinkOrphanedBlobs(blobKeys);
  return stats;
}
