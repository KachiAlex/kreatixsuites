// One-shot SQLite → Postgres data migration.
// Reads KREATIX_SQLITE_PATH (default <DATA_DIR>/kreatix.db) and inserts all rows
// into the Postgres database at KREATIX_DATABASE_URL, in FK-safe order.
// Encrypted field values (enc:v1:…) and blobs copy verbatim — the same
// KREATIX_DATA_KEY must be configured on the new deployment.
// Idempotent: rows that already exist (by PK) are skipped.
//
//   node scripts/migrate-sqlite-to-pg.mjs
// or inside the app container:
//   docker compose exec app node scripts/migrate-sqlite-to-pg.mjs
import Database from "better-sqlite3";
import pg from "pg";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.KREATIX_DATA_DIR ?? join(process.cwd(), ".data");
const SQLITE = process.env.KREATIX_SQLITE_PATH ?? join(DATA_DIR, "kreatix.db");
const PG_URL = process.env.KREATIX_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/kreatix";

if (!existsSync(SQLITE)) {
  console.log(`No SQLite database at ${SQLITE} — nothing to migrate.`);
  process.exit(0);
}

const lite = new Database(SQLITE, { readonly: true });
const pool = new pg.Pool({ connectionString: PG_URL, max: 4 });

const has = (t) =>
  !!lite.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type IN ('table','view')").get(t);
const all = (t) => lite.prepare(`SELECT * FROM ${t}`).all();
const b = (v) => (v === 1 || v === true ? true : v === 0 || v === false ? false : null); // 0/1 → boolean

// [table, columns, row → params]
const TABLES = [
  ["orgs", ["id", "name", "created_at"], (r) => [r.id, r.name, r.created_at]],
  ["users", ["id", "org_id", "email", "password_hash", "display_name", "initials", "role", "created_at"],
    (r) => [r.id, r.org_id, r.email, r.password_hash, r.display_name, r.initials, r.role, r.created_at]],
  ["items", ["id", "org_id", "parent_id", "owner_id", "name", "kind", "mime", "size", "starred", "trashed", "label", "created_at", "updated_at"],
    (r) => [r.id, r.org_id, r.parent_id, r.owner_id, r.name, r.kind, r.mime, r.size, b(r.starred), b(r.trashed), r.label ?? "internal", r.created_at, r.updated_at]],
  ["versions", ["id", "file_id", "number", "label", "blob_key", "size", "created_by", "created_at"],
    (r) => [r.id, r.file_id, r.number, r.label, r.blob_key, r.size, r.created_by, r.created_at]],
  ["shares", ["id", "file_id", "user_id", "permission", "created_at"],
    (r) => [r.id, r.file_id, r.user_id, r.permission, r.created_at]],
  ["share_links", ["id", "file_id", "token", "permission", "expires_at", "password_hash", "block_download", "created_at"],
    (r) => [r.id, r.file_id, r.token, r.permission, r.expires_at, r.password_hash, b(r.block_download), r.created_at]],
  ["comments", ["id", "file_id", "author_id", "anchor", "body", "resolved", "parent_id", "created_at"],
    (r) => [r.id, r.file_id, r.author_id, r.anchor, r.body, b(r.resolved), r.parent_id, r.created_at]],
  ["activity", ["id", "org_id", "actor_id", "file_id", "action", "detail", "created_at"],
    (r) => [r.id, r.org_id, r.actor_id, r.file_id, r.action, r.detail, r.created_at]],
  ["collab_states", ["file_id", "state", "updated_at"], (r) => [r.file_id, r.state, r.updated_at]],
  ["mentions", ["id", "comment_id", "file_id", "from_user_id", "to_user_id", "read_at", "created_at"],
    (r) => [r.id, r.comment_id, r.file_id, r.from_user_id, r.to_user_id, r.read_at, r.created_at]],
  ["ai_actions", ["id", "file_id", "user_id", "mode", "prompt", "ops", "applied", "created_at"],
    (r) => [r.id, r.file_id, r.user_id, r.mode, r.prompt, r.ops, b(r.applied), r.created_at]],
  ["search_index", ["file_id", "body"], (r) => [r.file_id, r.body]],
  ["org_policies", ["org_id", "json", "updated_at"],
    (r) => [r.org_id, typeof r.json === "string" ? r.json : JSON.stringify(r.json), r.updated_at]],
];

let total = 0;
for (const [table, cols, map] of TABLES) {
  if (!has(table)) { console.log(`- ${table}: no sqlite table, skipped`); continue; }
  const rows = all(table);
  const pk = { orgs: "id", users: "id", items: "id", versions: "id", shares: "id",
    share_links: "id", comments: "id", activity: "id", collab_states: "file_id",
    mentions: "id", ai_actions: "id", search_index: "file_id", org_policies: "org_id" }[table];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
  const sql = `INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders}) ON CONFLICT(${pk}) DO NOTHING`;
  for (const r of rows) await pool.query(sql, map(r));
  total += rows.length;
  console.log(`✓ ${table}: ${rows.length} rows`);
}

// sanity: report counts on both sides
for (const [table] of TABLES) {
  if (!has(table)) continue;
  const s = all(table).length;
  const p = Number((await pool.query(`SELECT COUNT(*) c FROM ${table}`)).rows[0].c);
  if (p < s) console.warn(`⚠ ${table}: sqlite=${s} pg=${p} — ${s - p} rows missing (already existed?)`);
}
await pool.end();
console.log(`\nDone — ${total} sqlite rows migrated/verified.`);
