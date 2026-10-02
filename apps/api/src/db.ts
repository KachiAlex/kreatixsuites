// Postgres data layer — pg Pool behind thin async helpers (q/one/run/tx).
// Blobs stay on the filesystem under DATA_DIR; this module only owns metadata.
import pg from "pg";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const DATA_DIR = process.env.KREATIX_DATA_DIR ?? join(process.cwd(), ".data");
mkdirSync(join(DATA_DIR, "blobs"), { recursive: true });

export const DATABASE_URL =
  process.env.KREATIX_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/kreatix";

// bigint (COUNT(*), sizes) → number; timestamptz → ISO 8601 string so JSON
// responses keep the same shape the SQLite layer produced.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString());
pg.types.setTypeParser(1114, (v) => new Date(v + "Z").toISOString());

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

export async function q<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
  return (await pool.query(text, params)).rows as T[];
}
export async function one<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T | undefined> {
  return (await q<T>(text, params))[0];
}
/** INSERT/UPDATE/DELETE — resolves with the affected row count. */
export async function run(text: string, params?: unknown[]): Promise<number> {
  return (await pool.query(text, params)).rowCount ?? 0;
}
/** Multi-statement transaction — callback gets a client; COMMIT/ROLLBACK handled. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Create the target database if it doesn't exist (dev/test convenience).
 * Connects to the `postgres` maintenance db on the same server.
 */
async function ensureDatabase() {
  const url = new URL(DATABASE_URL);
  const dbName = decodeURIComponent(url.pathname.slice(1));
  if (!dbName || dbName === "postgres") return;
  try {
    await pool.query("SELECT 1");
    return; // database reachable
  } catch (e) {
    if ((e as { code?: string }).code !== "3D000") return; // let real errors surface later
  }
  const admin = new pg.Client({
    // url.origin is "null" for the postgres: scheme — build host part manually
    connectionString: `${url.protocol}//${url.host}/postgres${url.search}`,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
  } catch (e) {
    if ((e as { code?: string }).code !== "42P04") throw e; // ignore "already exists" race
  } finally {
    await admin.end();
  }
}

/** Idempotent schema — runs at boot. Flags are real BOOLEANs; timestamps are
 *  TIMESTAMPTZ; emails are CITEXT (case-insensitive unique). */
export async function migrate() {
  await ensureDatabase();
  await pool.query(`
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  email CITEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  initials TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  parent_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size BIGINT NOT NULL DEFAULT 0,
  starred BOOLEAN NOT NULL DEFAULT false,
  trashed BOOLEAN NOT NULL DEFAULT false,
  label TEXT NOT NULL DEFAULT 'internal',
  media_for TEXT REFERENCES items(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_items_owner ON items(owner_id, trashed, updated_at);
CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id);
CREATE INDEX IF NOT EXISTS idx_items_org ON items(org_id, trashed);

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  label TEXT,
  blob_key TEXT NOT NULL,
  size BIGINT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(file_id, number)
);
CREATE INDEX IF NOT EXISTS idx_versions_file ON versions(file_id, number DESC);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(file_id, user_id)
);

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  permission TEXT NOT NULL DEFAULT 'viewer',
  expires_at TIMESTAMPTZ,
  password_hash TEXT,
  block_download BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  anchor TEXT,
  body TEXT NOT NULL,
  resolved BOOLEAN NOT NULL DEFAULT false,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comments_file ON comments(file_id, resolved);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  file_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_org ON activity(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS collab_states (
  file_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  state BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mentions (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  from_user_id TEXT NOT NULL REFERENCES users(id),
  to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mentions_to ON mentions(to_user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_actions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL,
  prompt TEXT NOT NULL,
  ops TEXT,
  applied BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_actions_file ON ai_actions(file_id, created_at DESC);

-- document text index — body is AES-256-GCM encrypted when KREATIX_DATA_KEY is
-- set, so full-text search runs JS-side over permission-scoped candidates
-- (indexer.ts / routes/search.ts). Populated on save + at boot.
CREATE TABLE IF NOT EXISTS search_index (
  file_id TEXT PRIMARY KEY,
  body TEXT NOT NULL
);

-- per-org admin policies (DLP/retention/etc.) — JSON document, one row per org
CREATE TABLE IF NOT EXISTS org_policies (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id),
  json JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- workspace invites — admin-generated links that join an existing org on register
CREATE TABLE IF NOT EXISTS org_invites (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  max_uses INTEGER NOT NULL DEFAULT 25,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- superadmin-editable plan/pricing — a single row ('default'), one plan per workspace
CREATE TABLE IF NOT EXISTS billing_config (
  id TEXT PRIMARY KEY,
  base_price_ngn INTEGER NOT NULL DEFAULT 2000,    -- workspace admin seat / month
  member_price_ngn INTEGER NOT NULL DEFAULT 1000,  -- each additional member / month
  trial_months INTEGER NOT NULL DEFAULT 3,
  currency TEXT NOT NULL DEFAULT 'NGN',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- one subscription per org — trial → active → past_due → locked
CREATE TABLE IF NOT EXISTS subscriptions (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'trialing',  -- trialing | active | past_due | canceled
  trial_ends_at TIMESTAMPTZ,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  amount_ngn INTEGER,                        -- amount of the last confirmed period
  seats INTEGER NOT NULL DEFAULT 1,          -- seat count at last pricing
  override_until TIMESTAMPTZ,                -- superadmin comp/extension, wins over all
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- payment ledger — every charge/confirmation is a row (audit trail)
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  amount_ngn INTEGER NOT NULL,
  seats INTEGER NOT NULL,
  months INTEGER NOT NULL DEFAULT 1,
  method TEXT NOT NULL DEFAULT 'manual',     -- paystack | manual | comp
  reference TEXT,                            -- paystack reference or bank-transfer note
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | confirmed | rejected
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  confirmed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_org ON payments(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
`);
  // additive columns for existing databases (CREATE TABLE IF NOT EXISTS is a no-op there)
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS media_for TEXT REFERENCES items(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT false`);
  // TOTP second factor — secret stored field-encrypted; backups are sha256 hashes
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backups TEXT`);
  // email-notice bookkeeping — prevents the daily sweep from re-sending
  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_warned_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS locked_notified_at TIMESTAMPTZ`);
  // seed the default billing config row (idempotent)
  await pool.query(`INSERT INTO billing_config (id) VALUES ('default') ON CONFLICT (id) DO NOTHING`);
}

export const now = () => new Date().toISOString();
