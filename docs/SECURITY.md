# Kreatix Business Suite — Security & Compliance Overview

This document describes the security architecture of Kreatix Business Suite as
implemented in this repository. It is intended for IT administrators, security
reviewers, and procurement questionnaires.

## 1. Data Encryption

### At rest

- **Content blobs** (documents, attachments, form signatures, recordings) are
  stored in a content-addressed store and encrypted with **AES-256-GCM** when
  `KREATIX_DATA_KEY` is set. Ciphertext is self-identifying (`KX1\0` magic
  header + per-object nonce + auth tag); plaintext objects from older installs
  remain readable.
- **Sensitive database free-text** — item names, full-text search bodies,
  comments, AI prompts and generated ops, audit-log details, stored OAuth/Paystack
  secrets — are AES-256-GCM encrypted field-by-field (`enc:v1:` marker). Encrypted
  search bodies are never queried with `ILIKE`; candidates are fetched bounded
  and org-scoped, then decrypted and matched in application code.
- **Database dumps** produced by the backup job contain the same ciphertext —
  the data key is required to read them.

### In transit

- All production traffic terminates TLS 1.2+ at the edge (nginx + Let's Encrypt;
  optionally Cloudflare). The application itself binds to a private loopback
  interface and is never directly exposed.
- HSTS is served by the edge proxy.

### Key management

- The data-encryption key is supplied via `KREATIX_DATA_KEY` (32-byte hex),
  generated with `openssl rand -hex 32`, and exists only in the server
  environment — never in the database, in client code, or in git.
- **Key rotation is supported natively**: `KREATIX_DATA_KEY` accepts a
  comma-separated key ring (`NEW,OLD,…`). The first key encrypts; every key
  is tried on decrypt (GCM's auth tag doubles as wrong-key detection), so
  rotation is a prepend-and-restart, then lazy re-wrap or a rekey sweep.

## 2. Authentication

- **Passwords** are hashed with **scrypt** (Node `crypto.scrypt`) with per-user
  random salts and constant-time comparison. Minimum 8 characters.
- **Sessions** are HS256 JWTs (7-day expiry) carrying a **token version**
  (`tkv`) and a **session id** (`jti`). Every request loads the user row once
  and compares `tkv` against `users.token_version`, then checks the `jti`
  against the `sessions` table — giving two revocation layers:
  - **per-device**: `GET/DELETE /api/me/sessions` lists every live session
    (client, IP, UA, last-seen) and revokes any one of them instantly,
  - **global**: password resets, admin disable, SCIM deactivation, and
    `POST /api/auth/logout-all` bump the version and mark all rows revoked.
- **MFA**: TOTP authenticator enrollment with one-time backup codes; required
  for sensitive operations (account deletion). The `mfaRequired` org policy
  confines non-enrolled members' sessions to the setup endpoints
  (`/api/auth|health|client-error|org/brand`) until enrollment completes —
  enforced in the global conditional-access hook, `/me` flags it, and the
  web app renders a blocking enroll screen.
- **New-sign-in alerts**: `signToken` records every session's IP; a returning
  account authenticating from a first-seen IP writes an `auth.new-ip` audit
  event and emails the account owner (IP, device, client, time). Applies to
  all issue paths — password, TOTP, Google, SAML/OIDC.
- **Email verification**: password signups receive a signed verification link;
  accounts flagged `email_verify_required` cannot log in until verified
  (`403 email_unverified`, with an unauthenticated resend endpoint).
- **Federated sign-in**: Google OAuth2 (authorization-code flow with state +
  nonce), plus enterprise **SAML 2.0** SP per organization (IdP metadata, signed
  assertion validation, clock-skew tolerance, attribute mapping) — see §5.
- **Rate limiting**: auth endpoints are rate-limited per IP
  (`@fastify/rate-limit`); global abuse limits guard public surfaces (public
  forms, share links, AI endpoints).

## 3. Authorization & Multi-Tenancy

- Every request resolves the session **once** (`resolveSession`) and all
  subsequent checks reuse it; there is no per-handler re-verification drift.
- **Five-role model**: owner → admin → member → plus per-resource share roles
  (editor/viewer). Shares are explicit grants on items; share links carry
  expirable random tokens.
- **Sites & libraries** implement SharePoint-style permission scopes with
  inheritance and break-inheritance grants; effective access is always computed
  from the same `permissionFor`/`permissionsFor` helpers used by the UI.
- **Permission-trimmed search & AI**: full-text search indexes and the AI
  workspace-Q&A retrieval pipeline filter candidates through the same
  permission checks — the model only sees content the requesting user can
  already read.
- **Query-token auth** (`?t=`) is restricted to a small allowlist of
  blob-serving GET routes; it never authorizes mutations.

## 4. AI Security

- The LLM key lives **only server-side**; the browser talks to
  `/api/ai/*` endpoints that enforce auth, per-user daily request quotas, and
  per-org monthly token budgets (actual provider usage metered, cost recorded).
- **Document AI** operations pass through a per-kind Zod allowlist — the model
  can only emit valid, schema-checked edit ops (never arbitrary writes). Every
  accepted op is recorded in `ai_actions` for provenance/undo.
- **Workspace Q&A** retrieves only permission-trimmed sources; the system
  prompt treats retrieved text as untrusted data and requires inline citations.
- Provider failover (429/5xx → retry → secondary provider) avoids availability
  coupling to a single vendor. Embeddings are opt-in and disabled by default.

## 5. Enterprise Identity

- **SAML 2.0 + OIDC per org** (`/api/auth/orgsso/…`): each workspace federates
  to its own IdP — admins paste the IdP entry point + signing cert (SAML) or
  issuer + client credentials (OIDC, encrypted at rest). Managed email domains
  route sign-ins at the login page; JIT provisioning creates seat-checked
  members, and orgs can enforce SSO-only sign-in via policy.
- **SCIM 2.0** per org (`/scim/v2/…`): user + **group** provisioning —
  create/read/patch/delete, bearer-token auth, IdP-filtered listing,
  `externalId` upserts, member add/remove/replace ops (Entra and Okta
  shapes). Pushed groups land in the same tables that drive site and
  library permission grants, so IdP membership changes flow straight into
  access. User deactivation revokes sessions and anonymizes rather than
  hard-deleting.
- **Conditional access**: per-org IP allowlists (CIDR), desktop-client
  posture requirement, and `maxSessionDays` — every issued token
  (password, MFA, SAML/OIDC) is clamped to the org's sign-in frequency.
- **IP allowlists** and **superadmin confinement** are enforced as global
  request hooks.
- **Org security policies** (`/api/admin/policies`): SSO enforcement
  (password login disabled for members, owner keeps break-glass), external
  sharing controls (block all anonymous links; email-domain allowlist for
  named shares), minimum password length + complexity (enforced at join +
  reset), device posture (desktop-client-only sessions), DLP patterns,
  watermarking, `mfaRequired`, and `blockConfidentialDownloads` —
  viewer-level sessions get 403 on raw bytes of confidential/restricted
  files across `/content`, `/raw`, version content, and share-link
  downloads while native in-app viewing stays available.
- **Access review** (`/api/admin/access-review`, JSON + CSV): every
  externally-reachable grant in the org — live anonymous links and
  cross-org named shares — for periodic recertification.
- **Metrics** (`/api/metrics`): Prometheus text exposition (uptime,
  request counts by status class, 5xx, pg pool state, process memory,
  S3 backend flag). Authenticated by a `KREATIX_METRICS_TOKEN` bearer
  when configured, otherwise superadmin sessions only.

## 6. Data Lifecycle & Governance

- **Immutable versioning**: every save writes a new immutable blob + version
  row; version blob keys are never mutated — enabling restore, diff, and legal
  hold semantics.
- **Retention sweeps**: org-configurable retention policies run under
  PostgreSQL advisory locks (`runSweep`), expiring content on schedule.
- **DLP**: outbound form submissions are scanned against configurable patterns;
  AI prompts pass through the same screen.
- **Audit log**: administrative and security-relevant actions append to a
  tamper-evident audit table (details encrypted at rest). Org admins can
  filter/export it and configure a **SIEM webhook** — every event is mirrored
  as JSON to the org's HTTPS collector (Splunk HEC, Sentinel, …).
- **Recycle bin**: soft-delete with restore before permanent purge.
- **User deletion is non-destructive by design**: erasure anonymizes the user
  and transfers ownership so shared workspaces stay coherent; org deletion
  derives its cascade from `pg_constraint` order.
- **eDiscovery-style admin access**: org admins can inspect content inside
  their own tenancy boundary; there is no cross-tenant read path.

## 7. Availability & Disaster Recovery

- **Nightly backups**: `pg_dump` + blob tarball into `KREATIX_BACKUP_DIR`
  (oldest pruned past `KREATIX_BACKUP_KEEP`, default 14).
- **Integrity verification**: every backup is gzip-tested and tar-listed before
  it is marked successful; failures surface in the admin backup dashboard and
  the health monitor.
- **Optional off-site copy**: any S3-compatible bucket (AWS S3, Cloudflare R2,
  MinIO) via SigV4 `PUT` — a backup isn't considered done until both the local
  archive verifies and the remote copy lands.
- **Health monitoring**: hourly checks on DB, disk, and backup freshness;
  alerts go to org owners by mail (Brevo) and/or an ops webhook
  (`KREATIX_ALERT_WEBHOOK`). A public status probe is available at
  `GET /api/status` (uptime, DB latency, last-good-backup age — no auth, no
  sensitive data).
- **Restore procedure**: documented + scripted in `deploy/restore.sh` and
  `docs/DR.md` (integrity check → db restore → blob restore → smoke).

## 8. Application Security

- Zod schema validation on every request body; parameterized SQL only (no
  string-interpolated queries).
- XSS surface reduced by design: rich text is sanitized at the render layer;
  Sheets macro execution is confined to an **opaque-origin sandboxed iframe**
  (`sandbox="allow-scripts"`, its own CSP) — user code can never reach the main
  origin or its storage.
- Security headers at the edge (frame options, content-type sniffing, referrer
  policy); CSP served by the SPA.
- Upload pipeline enforces per-org storage quotas before any blob write.
- No secrets in the repository; deployment secrets come from `.env` (see
  `.env.example`).

## 9. Responsible Disclosure

Report vulnerabilities privately to security@kreatixtech.com. Please do not
test against accounts or data that are not yours.
