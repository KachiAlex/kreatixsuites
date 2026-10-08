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

-- SCIM 2.0 provisioning bearer tokens (per-org, SHA-256 hashed)
CREATE TABLE IF NOT EXISTS scim_tokens (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

-- AI token metering — one row per completed chat request. Cost is USD × 1e6
-- (integer microdollars) so monthly aggregates are exact. No prompt text here
-- — content stays in ai_actions, field-encrypted.
CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  mode TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  estimated BOOLEAN NOT NULL DEFAULT false,  -- true when provider omitted usage
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_org_month ON ai_usage(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_day ON ai_usage(user_id, created_at);

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
  business_multiplier INTEGER NOT NULL DEFAULT 2, -- business plan = ×N the standard price
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
  ai_token_budget BIGINT,                    -- superadmin AI quota override (null = computed)
  ai_budget_warned_at TIMESTAMPTZ,           -- 80%-of-budget notice, once per month
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

-- in-app user feedback — mini chat widget submissions, reviewed in superadmin
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sentiment TEXT NOT NULL DEFAULT 'ok',   -- good | ok | bad
  message TEXT NOT NULL,
  page TEXT,                              -- app route the user was on
  reply TEXT,                             -- superadmin response shown back in the widget
  replied_at TIMESTAMPTZ,
  replied_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);

-- superadmin audit log — append-only record of every platform mutation.
-- Deliberately no FKs: the trail must survive deletion of the org/user it
-- references (that's the point — "who deleted X" stays answerable).
CREATE TABLE IF NOT EXISTS sa_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,                            -- org/payment/user name or id
  detail TEXT,                            -- JSON payload or human summary
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sa_audit_created ON sa_audit(created_at DESC);

-- plan catalog — superadmin-editable pricing tiers. features = entitlement
-- flags (client + server gates), limits = numeric caps (quotas/retention).
CREATE TABLE IF NOT EXISTS plans (
  slug TEXT PRIMARY KEY,              -- free | pro | business | <custom>
  name TEXT NOT NULL,
  price_ngn INTEGER NOT NULL DEFAULT 0,        -- base/month, includes owner seat
  member_price_ngn INTEGER NOT NULL DEFAULT 0, -- per additional enabled member
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true,
  sort INTEGER NOT NULL DEFAULT 0
);
`);
  // additive columns for existing databases (CREATE TABLE IF NOT EXISTS is a no-op there)
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS media_for TEXT REFERENCES items(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT false`);
  // TOTP second factor — secret stored field-encrypted; backups are sha256 hashes
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backups TEXT`);
  // SCIM externalId correlation (IdP-side user id)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS scim_external_id TEXT`);
  // email-notice bookkeeping — prevents the daily sweep from re-sending
  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_warned_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS locked_notified_at TIMESTAMPTZ`);
  // superadmin-set AI token budget override — null = computed (base + per-seat)
  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ai_token_budget BIGINT`);
  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free'`);
  await pool.query(`ALTER TABLE subscriptions ALTER COLUMN plan SET DEFAULT 'free'`);
  // per-plan pricing + AI budgets: payments carry the tier purchased
  await pool.query(`ALTER TABLE billing_config ADD COLUMN IF NOT EXISTS business_multiplier INTEGER NOT NULL DEFAULT 2`);
  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'standard'`);
  // retired BYOK columns — the platform key is the only provider
  await pool.query(`ALTER TABLE subscriptions DROP COLUMN IF EXISTS ai_key`);
  await pool.query(`ALTER TABLE subscriptions DROP COLUMN IF EXISTS ai_base_url`);
  await pool.query(`ALTER TABLE subscriptions DROP COLUMN IF EXISTS ai_model`);
  // 80%-of-AI-budget notice bookkeeping for the daily sweep
  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ai_budget_warned_at TIMESTAMPTZ`);
  // superadmin replies to in-app feedback
  await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS reply TEXT`);
  await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS replied_by TEXT REFERENCES users(id) ON DELETE SET NULL`);
  // messenger-style threads: each feedback row is a message — sender marks who
  // wrote it, read_at is the admin's read receipt, seen_at the user's
  await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS sender TEXT NOT NULL DEFAULT 'user'`);
  await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ`);
  // fold legacy single-reply rows into threaded admin messages, then drop the column
  const legacyReply = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'feedback' AND column_name = 'reply'`);
  if (legacyReply.rowCount) {
    await pool.query(`INSERT INTO feedback (id, org_id, user_id, sender, sentiment, message, created_at, replied_by)
      SELECT gen_random_uuid()::text, org_id, user_id, 'admin', 'ok', reply, replied_at, replied_by
      FROM feedback f WHERE f.reply IS NOT NULL`);
    await pool.query(`ALTER TABLE feedback DROP COLUMN reply, DROP COLUMN replied_at`);
  }
  // pgvector — semantic retrieval for workspace Q&A (no-op on non-pgvector images)
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await pool.query(`ALTER TABLE search_index ADD COLUMN IF NOT EXISTS embedding vector`);
  } catch {
    console.warn("[db] pgvector extension unavailable — semantic search disabled");
  }
  // seed the default billing config row (idempotent)
  await pool.query(`INSERT INTO billing_config (id) VALUES ('default') ON CONFLICT (id) DO NOTHING`);
  // seed the plan catalog (idempotent — superadmin edits are never overwritten)
  await pool.query(`
    INSERT INTO plans (slug, name, price_ngn, member_price_ngn, features, limits, sort) VALUES
    ('free', 'Free', 0, 0,
      '{"ai":true,"export":true,"pdf_sign":false,"pdf_edit":false,"share_protect":false,"writer_comments":true,"writer_version_history":true,"writer_advanced":false,"sso":false,"scim":false,"priority_support":false}',
      '{"ai_daily":20,"ai_per_min":5,"ai_tokens_base":300000,"ai_tokens_per_seat":0,"storage_mb":1024,"max_members":3,"version_days":30}', 0),
    ('pro', 'Pro', 1000, 0,
      '{"ai":true,"export":true,"pdf_sign":true,"pdf_edit":true,"share_protect":true,"writer_comments":true,"writer_version_history":true,"writer_advanced":true,"sso":false,"scim":false,"priority_support":true}',
      '{"ai_daily":300,"ai_per_min":20,"ai_tokens_base":3000000,"ai_tokens_per_seat":1000000,"storage_mb":51200,"max_members":5,"version_days":0}', 1),
    ('business', 'Business', 2000, 500,
      '{"ai":true,"export":true,"pdf_sign":true,"pdf_edit":true,"share_protect":true,"writer_comments":true,"writer_version_history":true,"writer_advanced":true,"sso":true,"scim":true,"priority_support":true}',
      '{"ai_daily":1000,"ai_per_min":40,"ai_tokens_base":12000000,"ai_tokens_per_seat":4000000,"storage_mb":512000,"max_members":0,"version_days":0}', 2)
    -- stored values win on shared keys; newly introduced seed keys get added
    ON CONFLICT (slug) DO UPDATE SET features = EXCLUDED.features || plans.features,
      limits = EXCLUDED.limits || plans.limits`);
}

export const now = () => new Date().toISOString();
