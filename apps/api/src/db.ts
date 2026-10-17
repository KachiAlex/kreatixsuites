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

-- Sites (SharePoint-style): a site is a security + navigation boundary inside
-- an org; it owns document libraries. visibility 'org' = every org member is
-- an implicit visitor; 'private' = members only (org owner/admin still manage).
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL DEFAULT 'team',          -- team | project | department | communication
  visibility TEXT NOT NULL DEFAULT 'org',     -- org | private
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sites_org ON sites(org_id);

CREATE TABLE IF NOT EXISTS site_members (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',        -- owner | member | visitor
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_site_members_user ON site_members(user_id);

CREATE TABLE IF NOT EXISTS libraries (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'documents',     -- documents | media | form
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_libraries_site ON libraries(site_id);

-- Custom metadata columns on a document library (SharePoint "site columns").
CREATE TABLE IF NOT EXISTS library_columns (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',          -- text | number | date | choice | person | yesno
  required BOOLEAN NOT NULL DEFAULT false,
  choices JSONB,                              -- allowed values for type='choice'
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_library_columns_lib ON library_columns(library_id);

-- Per-item values for custom columns.
CREATE TABLE IF NOT EXISTS item_metadata (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  column_id TEXT NOT NULL REFERENCES library_columns(id) ON DELETE CASCADE,
  value TEXT,
  PRIMARY KEY (item_id, column_id)
);
CREATE INDEX IF NOT EXISTS idx_item_metadata_col ON item_metadata(column_id);

-- Saved views on a library: named filter/sort/group presets.
CREATE TABLE IF NOT EXISTS library_views (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  shared BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_library_views_lib ON library_views(library_id);
`);
  // additive columns for existing databases (CREATE TABLE IF NOT EXISTS is a no-op there)
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS media_for TEXT REFERENCES items(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS library_id TEXT REFERENCES libraries(id) ON DELETE SET NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_items_library ON items(library_id)`);
  // check-in/check-out lock (library docmgmt) — NULL = not checked out
  await pool.query(`ALTER TABLE libraries ADD COLUMN IF NOT EXISTS versioning TEXT NOT NULL DEFAULT 'major'`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS checked_out_by TEXT REFERENCES users(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS checked_out_at TIMESTAMPTZ`);
  // major.minor display versioning + draft flag on top of the monotonic `number`
  await pool.query(`ALTER TABLE versions ADD COLUMN IF NOT EXISTS major INTEGER`);
  await pool.query(`ALTER TABLE versions ADD COLUMN IF NOT EXISTS minor INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE versions ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT true`);
  await pool.query(`UPDATE versions SET major = number WHERE major IS NULL`);
  // content approval (SharePoint "Require content approval") — member publish
  // requests mark the head draft pending until a site owner approves/rejects
  await pool.query(`ALTER TABLE libraries ADD COLUMN IF NOT EXISTS approval BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE versions ADD COLUMN IF NOT EXISTS pending BOOLEAN NOT NULL DEFAULT false`);
  // multi-step approval: libraries can pin an ordered chain of approver user
  // ids; a pending version snapshots the chain and tracks the current step
  await pool.query(`ALTER TABLE versions ADD COLUMN IF NOT EXISTS approval_step INTEGER`);
  await pool.query(`ALTER TABLE versions ADD COLUMN IF NOT EXISTS approval_chain JSONB`);
  await pool.query(`ALTER TABLE libraries ADD COLUMN IF NOT EXISTS approval_chain JSONB`);
  // unique library permissions (SharePoint "stop inheriting") — when
  // inherit_permissions is false, only library_permissions grants + site
  // owner / org admins can reach the library's items
  await pool.query(`ALTER TABLE libraries ADD COLUMN IF NOT EXISTS inherit_permissions BOOLEAN NOT NULL DEFAULT true`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS library_permissions (
      library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',        -- owner | member | visitor
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (library_id, user_id)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_library_perms_user ON library_permissions(user_id)`);
  // site-level activity scoping — site events (member add, settings) carry the
  // site id; file events inside libraries resolve their site via the item join
  await pool.query(`ALTER TABLE activity ADD COLUMN IF NOT EXISTS site_id TEXT`);
  // content types (SharePoint reusable document schemas)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_types (
      id TEXT PRIMARY KEY,
      site_id TEXT REFERENCES sites(id) ON DELETE CASCADE,
      library_id TEXT REFERENCES libraries(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      template_blob_key TEXT,
      allowed_kinds JSONB NOT NULL DEFAULT '["writer","sheets","present","pdf","board","file"]'::jsonb,
      is_default BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_content_types_site ON content_types(site_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_content_types_library ON content_types(library_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_type_columns (
      content_type_id TEXT NOT NULL REFERENCES content_types(id) ON DELETE CASCADE,
      column_id TEXT NOT NULL REFERENCES library_columns(id) ON DELETE CASCADE,
      required BOOLEAN NOT NULL DEFAULT false,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (content_type_id, column_id)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_content_type_columns_type ON content_type_columns(content_type_id)`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS content_type_id TEXT REFERENCES content_types(id) ON DELETE SET NULL`);
  // document sets — a content type flagged doc_set turns a folder into a
  // work-product container; bound columns marked 'shared' propagate their
  // values to items created or moved inside
  await pool.query(`ALTER TABLE content_types ADD COLUMN IF NOT EXISTS doc_set BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE content_type_columns ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT false`);
  // per-library retention (SharePoint information management policies) —
  // items untouched for retention_days get auto-trashed by the daily sweep
  await pool.query(`ALTER TABLE libraries ADD COLUMN IF NOT EXISTS retention_days INTEGER`);
  // term store (SharePoint managed metadata) — org-wide reusable term sets;
  // a library column of type 'managed' binds to a set and its values must be
  // terms from that set
  await pool.query(`
    CREATE TABLE IF NOT EXISTS term_sets (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_term_sets_org ON term_sets(org_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS terms (
      id TEXT PRIMARY KEY,
      set_id TEXT NOT NULL REFERENCES term_sets(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES terms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_terms_set ON terms(set_id)`);
  await pool.query(`ALTER TABLE library_columns ADD COLUMN IF NOT EXISTS term_set_id TEXT REFERENCES term_sets(id) ON DELETE SET NULL`);
  // hub sites (SharePoint hub sites) — sites. hub_id associates a site with
  // a hub; hubs themselves can't join another hub (single level)
  await pool.query(`ALTER TABLE sites ADD COLUMN IF NOT EXISTS hub_id TEXT REFERENCES sites(id) ON DELETE SET NULL`);
  // site templates — a saved blueprint of libraries/columns/content types
  // that new sites can be provisioned from
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_templates (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      blueprint JSONB NOT NULL,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_site_templates_org ON site_templates(org_id)`);
  // library alerts (SharePoint "Alert me") — subscribers get a notification
  // row when items are created, uploaded, or trashed in the library
  await pool.query(`
    CREATE TABLE IF NOT EXISTS library_subscriptions (
      library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (library_id, user_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'library',
      file_id TEXT REFERENCES items(id) ON DELETE CASCADE,
      library_id TEXT REFERENCES libraries(id) ON DELETE CASCADE,
      actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      message TEXT,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at DESC)`);
  // org-level groups (SharePoint groups) — admins define named sets of people;
  // a group can hold a site role or a library grant as a unit, so membership
  // changes flow everywhere the group is granted
  await pool.query(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_groups_org ON groups(org_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (group_id, user_id)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_group_members (
      site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',        -- owner | member | visitor
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (site_id, group_id)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_site_group_members_group ON site_group_members(group_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS library_group_permissions (
      library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',        -- owner | member | visitor
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (library_id, group_id)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_library_group_perms_group ON library_group_permissions(group_id)`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT false`);
  // TOTP second factor — secret stored field-encrypted; backups are sha256 hashes
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backups TEXT`);
  // SCIM externalId correlation (IdP-side user id)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS scim_external_id TEXT`);
  // onboarding wizard — null until an owner/admin finishes or skips setup
  await pool.query(`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ`);

  // Custom mail domains per org — DNS-TXT verified before mailboxes use them
  await pool.query(`CREATE TABLE IF NOT EXISTS org_domains (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    verify_token TEXT NOT NULL,
    is_primary BOOLEAN NOT NULL DEFAULT false,
    mx_ok BOOLEAN NOT NULL DEFAULT false,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(org_id, domain)
  )`);
  await pool.query(`ALTER TABLE org_domains ADD COLUMN IF NOT EXISTS brevo_records JSONB`);
  await pool.query(`ALTER TABLE org_domains ADD COLUMN IF NOT EXISTS brevo_ok BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_org_domains_org ON org_domains(org_id)`);
  // at most one verified claimant per domain, one primary per org
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_domains_verified ON org_domains(domain) WHERE status = 'verified'`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_domains_primary ON org_domains(org_id) WHERE is_primary`);

  // Kreatix Meet — scheduled/instant meetings per org
  await pool.query(`CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    title TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    scheduled_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'scheduled',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    UNIQUE(org_id, code)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_meetings_org ON meetings(org_id, created_at DESC)`);

  // Kreatix Chat — Teams-style channels + DMs per org. 'channel' rows are
  // org-wide (visible to every member); 'dm'/'group' rows are member-scoped
  // via chat_members. dm_key is the sorted participant set for 1:1 dedupe.
  await pool.query(`CREATE TABLE IF NOT EXISTS chat_channels (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'channel',
    name TEXT,
    description TEXT,
    dm_key TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    last_message_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_channels_org ON chat_channels(org_id)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_channels_dmkey ON chat_channels(org_id, dm_key) WHERE dm_key IS NOT NULL`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_members (
      channel_id TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (channel_id, user_id)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    reply_to TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
    edited_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(channel_id, created_at DESC)`);
  await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS file_id TEXT REFERENCES items(id) ON DELETE SET NULL`);
  // pinned messages + channel topics
  await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS pinned_by TEXT`);
  await pool.query(`ALTER TABLE chat_channels ADD COLUMN IF NOT EXISTS topic TEXT`);
  // emoji reactions — toggle model, one row per (message, user, emoji)
  await pool.query(`CREATE TABLE IF NOT EXISTS chat_reactions (
    message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_reactions_msg ON chat_reactions(message_id)`);

  // Shared/delegate mailboxes — owner grants a suite member full access to
  // their mailbox; the suite mints the owner's mail JWT for the delegate.
  await pool.query(`CREATE TABLE IF NOT EXISTS mail_shares (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delegate_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_user_id, delegate_user_id)
  )`);

  // Kreatix Calendar — org events. Visibility = creator + attendees;
  // meeting_id links to a Kreatix Meet room when the event has a call.
  await pool.query(`CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    location TEXT,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    all_day BOOLEAN NOT NULL DEFAULT false,
    meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cal_events_range ON calendar_events(org_id, starts_at, ends_at)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendar_attendees (
      event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending | accepted | declined | tentative
      PRIMARY KEY (event_id, user_id)
    )`);
  // RFC5545 recurrence rule string (FREQ=...;INTERVAL=...) — expanded at read
  await pool.query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS rrule TEXT`);

  // Meet recordings — finalized Jibri .mp4s ingested from a host-mounted
  // recordings dir; path is relative to KREATIX_MEET_RECORDINGS_DIR
  await pool.query(`CREATE TABLE IF NOT EXISTS meeting_recordings (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    size BIGINT,
    duration_sec INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (meeting_id, path)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_meeting_recordings_org ON meeting_recordings(org_id, created_at DESC)`);
  // recording polish: saved playback clip + optional transcript
  await pool.query(`ALTER TABLE meeting_recordings ADD COLUMN IF NOT EXISTS clip_start REAL`);
  await pool.query(`ALTER TABLE meeting_recordings ADD COLUMN IF NOT EXISTS clip_end REAL`);
  await pool.query(`ALTER TABLE meeting_recordings ADD COLUMN IF NOT EXISTS transcript TEXT`);
  // meeting ↔ suite chat channel link + join roster
  await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS channel_id TEXT`);
  // AI-generated meeting summary (encrypted at rest)
  await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS summary TEXT`);
  // AI mail triage — per-user priority annotations keyed by mail-service id
  await pool.query(`CREATE TABLE IF NOT EXISTS mail_priority (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    priority TEXT NOT NULL,                    -- high | normal | low
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, message_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS meeting_attendance (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    left_at TIMESTAMPTZ,
    PRIMARY KEY (meeting_id, user_id)
  )`);

  // Calendar depth: occurrence exceptions, bookable resources, delegates
  await pool.query(`CREATE TABLE IF NOT EXISTS calendar_exceptions (
    event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
    occurrence_start TIMESTAMPTZ NOT NULL,
    cancelled BOOLEAN NOT NULL DEFAULT false,
    title TEXT, location TEXT, starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, occurrence_start)
  )`);
  await pool.query(`ALTER TABLE calendar_exceptions ADD COLUMN IF NOT EXISTS created_by TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS calendar_resources (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'room',
    capacity INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`ALTER TABLE calendar_resources ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'room'`);
  await pool.query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS resource_id TEXT REFERENCES calendar_resources(id) ON DELETE SET NULL`);
  await pool.query(`CREATE TABLE IF NOT EXISTS calendar_delegates (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delegate_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    can_edit BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, delegate_id)
  )`);
  // Governance depth — legal hold flag blocks all delete paths; DLP flag is
  // stamped by the save-time scanner (policies.dlpPatterns).
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS dlp_flagged BOOLEAN NOT NULL DEFAULT false`);
  // a site-level hold covers every item in every library under the site
  await pool.query(`ALTER TABLE sites ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`CREATE TABLE IF NOT EXISTS legal_holds (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS legal_hold_items (
    hold_id TEXT NOT NULL REFERENCES legal_holds(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    PRIMARY KEY (hold_id, item_id)
  )`);
  // Custodian graph: attaching a user to an active hold preserves everything
  // they own (files) — matter-scoped exports aggregate per custodian.
  await pool.query(`CREATE TABLE IF NOT EXISTS legal_hold_custodians (
    hold_id TEXT NOT NULL REFERENCES legal_holds(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (hold_id, user_id)
  )`);
  // DLP engine — named rules scanned by the pipeline (file save/upload, chat
  // posts) plus a reviewable violation event queue for admins.
  await pool.query(`CREATE TABLE IF NOT EXISTS dlp_rules (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    pattern TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium',        -- low | medium | high
    action TEXT NOT NULL DEFAULT 'flag',            -- flag | block
    applies_to TEXT NOT NULL DEFAULT 'files',       -- files | chat | all
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS dlp_events (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    rule_id TEXT REFERENCES dlp_rules(id) ON DELETE SET NULL,
    rule_name TEXT NOT NULL,                        -- snapshot survives rule deletion
    ref_type TEXT NOT NULL,                         -- item | chat_message
    ref_id TEXT NOT NULL,
    excerpt TEXT,                                   -- short match context (encrypted at rest)
    actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,                           -- flagged | blocked
    status TEXT NOT NULL DEFAULT 'open',            -- open | confirmed | dismissed
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS dlp_events_org ON dlp_events (org_id, status, created_at)`);

  await pool.query(`CREATE TABLE IF NOT EXISTS forms (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    schema TEXT NOT NULL,                  -- JSON [{id,label,type,required,options}]
    open BOOLEAN NOT NULL DEFAULT true,
    token TEXT NOT NULL UNIQUE,            -- public share slug
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS form_responses (
    id TEXT PRIMARY KEY,
    form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    answers TEXT NOT NULL,                 -- JSON {fieldId: value}
    respondent TEXT,                       -- optional free-text name/email
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_form_responses_form ON form_responses(form_id)`);

  // Kreatix Notes — org wiki pages (OneNote-lite; markdown-ish body)
  await pool.query(`CREATE TABLE IF NOT EXISTS wiki_pages (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_wiki_org ON wiki_pages(org_id, updated_at DESC)`);

  // Kreatix Tasks — Planner-lite kanban; org-shared board
  await pool.query(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'todo',        -- todo | doing | done
    assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    due_at TIMESTAMPTZ,
    position INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_org ON tasks(org_id, status, position)`);

  // Automation rules — trigger → action wiring between apps
  await pool.query(`CREATE TABLE IF NOT EXISTS automation_rules (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    trigger TEXT NOT NULL,                 -- form.submitted | file.created | task.status | meeting.ended
    match JSONB,                           -- optional {key: value} ctx filter
    action TEXT NOT NULL,                  -- task.create | notify
    config JSONB NOT NULL DEFAULT '{}',
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rules_org ON automation_rules(org_id, trigger) WHERE enabled`);
  // dedupe for scheduled/repeating triggers — (rule, key) fires at most once
  await pool.query(`CREATE TABLE IF NOT EXISTS automation_fires (
    rule_id TEXT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
    dedupe_key TEXT NOT NULL,
    fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    detail JSONB,
    ok BOOLEAN,
    PRIMARY KEY (rule_id, dedupe_key)
  )`);
  await pool.query(`ALTER TABLE automation_fires ADD COLUMN IF NOT EXISTS detail JSONB`);
  await pool.query(`ALTER TABLE automation_fires ADD COLUMN IF NOT EXISTS ok BOOLEAN`);

  // multi-step approval extras: when the draft went pending, which entries
  // of an "all"-mode step have already signed off
  await pool.query(`ALTER TABLE versions ADD COLUMN IF NOT EXISTS pending_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE versions ADD COLUMN IF NOT EXISTS approval_done JSONB`);
  // approval delegation — an active delegate may act on your chain steps
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS delegate_id TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS delegate_until TIMESTAMPTZ`);

  // public API — org-scoped service keys (app-only access; the key sees the
  // org, not the creator's ACL — documented as service-principal semantics)
  await pool.query(`CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,                    -- "kx_ab12cd" — shown in lists
    key_hash TEXT NOT NULL,                  -- sha256 hex of the full token
    scopes JSONB NOT NULL DEFAULT '["read"]',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_apikeys_org ON api_keys(org_id) WHERE revoked_at IS NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_apikeys_hash ON api_keys(key_hash)`);

  // white-labeling — org display name + logo (blob key into the blob store)
  await pool.query(`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS brand_name TEXT`);
  await pool.query(`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS brand_logo TEXT`);

  // outbound webhooks — signed deliveries on the same events the automation
  // engine emits; failed deliveries retry from the sweep
  await pool.query(`CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events JSONB NOT NULL DEFAULT '[]',      -- empty = all events
    active BOOLEAN NOT NULL DEFAULT true,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhooks(org_id) WHERE active`);
  await pool.query(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,
    event TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered | failed
    attempts INTEGER NOT NULL DEFAULT 0,
    response_code INTEGER,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at TIMESTAMPTZ,
    next_retry_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_whdel_due ON webhook_deliveries(next_retry_at) WHERE status = 'pending'`);

  // Kreatix Mail bridge — suite user ↔ kreatix-mail account mapping
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mail_user_id INTEGER`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mail_email TEXT`);
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
  // ops: backup bookkeeping + sweep coordination state (see backup.ts / monitor.ts)
  await pool.query(`CREATE TABLE IF NOT EXISTS backup_runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,               -- db | blobs
    file TEXT,                        -- filename inside BACKUP_DIR
    bytes BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running',  -- running | ok | error
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sweep_state (
    name TEXT PRIMARY KEY,
    last_run TIMESTAMPTZ NOT NULL,
    ok BOOLEAN NOT NULL,
    detail TEXT
  )`);
  // seed the default billing config row (idempotent)
  await pool.query(`INSERT INTO billing_config (id) VALUES ('default') ON CONFLICT (id) DO NOTHING`);
  // seed the plan catalog (idempotent — superadmin edits are never overwritten)
  await pool.query(`
    INSERT INTO plans (slug, name, price_ngn, member_price_ngn, features, limits, sort) VALUES
    ('free', 'Free', 0, 0,
      '{"ai":true,"export":true,"pdf_sign":false,"pdf_edit":false,"share_protect":false,"writer_comments":true,"writer_version_history":true,"writer_advanced":false,"sso":false,"scim":false,"priority_support":false,"docmgmt":false}',
      '{"ai_daily":20,"ai_per_min":5,"ai_tokens_base":300000,"ai_tokens_per_seat":0,"storage_mb":1024,"max_members":3,"version_days":30,"sites":1}', 0),
    ('pro', 'Pro', 1000, 0,
      '{"ai":true,"export":true,"pdf_sign":true,"pdf_edit":true,"share_protect":true,"writer_comments":true,"writer_version_history":true,"writer_advanced":true,"sso":false,"scim":false,"priority_support":true,"docmgmt":true}',
      '{"ai_daily":300,"ai_per_min":20,"ai_tokens_base":3000000,"ai_tokens_per_seat":1000000,"storage_mb":51200,"max_members":5,"version_days":0,"sites":10}', 1),
    ('business', 'Business', 2000, 500,
      '{"ai":true,"export":true,"pdf_sign":true,"pdf_edit":true,"share_protect":true,"writer_comments":true,"writer_version_history":true,"writer_advanced":true,"sso":true,"scim":true,"priority_support":true,"docmgmt":true}',
      '{"ai_daily":1000,"ai_per_min":40,"ai_tokens_base":12000000,"ai_tokens_per_seat":4000000,"storage_mb":512000,"max_members":0,"version_days":0,"sites":0}', 2)
    -- stored values win on shared keys; newly introduced seed keys get added
    ON CONFLICT (slug) DO UPDATE SET features = EXCLUDED.features || plans.features,
      limits = EXCLUDED.limits || plans.limits`);
}

export const now = () => new Date().toISOString();

/** Multi-instance sweep coordination: take a session-scoped advisory lock on a
 *  dedicated connection so only one API instance runs a given sweep, then
 *  record the outcome in sweep_state for /api/admin/health. Returns null when
 *  another instance holds the lock. */
export async function runSweep<T>(name: string, lockKey: number, fn: () => Promise<T>): Promise<T | null> {
  const c = await pool.connect();
  try {
    const got = (await c.query(`SELECT pg_try_advisory_lock($1) AS got`, [lockKey])).rows[0]?.got;
    if (!got) return null;
    try {
      const detail = await fn();
      await c.query(
        `INSERT INTO sweep_state (name, last_run, ok, detail) VALUES ($1, now(), true, $2)
         ON CONFLICT (name) DO UPDATE SET last_run = now(), ok = true, detail = $2`,
        [name, JSON.stringify(detail ?? null)],
      );
      return detail;
    } catch (e) {
      await c.query(
        `INSERT INTO sweep_state (name, last_run, ok, detail) VALUES ($1, now(), false, $2)
         ON CONFLICT (name) DO UPDATE SET last_run = now(), ok = false, detail = $2`,
        [name, String(e instanceof Error ? e.message : e)],
      ).catch(() => {});
      throw e;
    } finally {
      await c.query(`SELECT pg_advisory_unlock($1)`, [lockKey]).catch(() => {});
    }
  } finally {
    c.release();
  }
}
