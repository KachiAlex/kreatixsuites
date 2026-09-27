# Kreatix Business Suite

AI-native office productivity suite per `Kreatix_Business_Suite_SRS_v1.0.docx`
(Writer · Sheets · Present · PDF · Drive · Kreatix AI). Brand: `Kreatix_Business_Suite_Brand_UI_v2.html`.

## Stack (VPS-targeted)

- `apps/web` — React 19 + Vite + TypeScript SPA. Design system in `src/styles.css` (tokens ported from Brand UI: `--k-orange:#F2782E`, Inter, rail+sidebar+topbar shell).
- `apps/api` — Fastify 5 + TypeScript, bundled by esbuild to `dist/server.js`.
- `packages/shared` — domain types (`@kreatix/shared`), imported as TS source.
- DB: **Postgres** via `pg` Pool — thin helpers (`q`/`one`/`run`/`tx`) in `apps/api/src/db.ts`; schema is boot-time idempotent DDL, auto-creates the database. `KREATIX_DATABASE_URL` overrides (default `postgres://postgres:postgres@localhost:5432/kreatix`).
- Migration from legacy SQLite installs: `apps/api/scripts/migrate-sqlite-to-pg.mjs` (idempotent, FK-safe order).
- Files: content-addressed blob store under `KREATIX_DATA_DIR/blobs` (S3/MinIO-swappable interface in `apps/api/src/blobs.ts`).
- Auth: scrypt password hash + HS256 JWT (`jose`), 7d tokens.

## Runbook

```bash
pnpm install                       # first time
docker compose up -d db            # Postgres on 127.0.0.1:5432 (POSTGRES_PASSWORD in .env)
pnpm dev:api                       # API on :3001 (KREATIX_DATABASE_URL to override)
pnpm dev:web                       # Vite on :5173 (proxies /api → :3001)
pnpm build                         # builds web dist + api bundle
pnpm typecheck
pnpm --filter @kreatix/web test:roundtrip   # OOXML DOCX/XLSX/PPTX export→import harness
```

API serves `apps/web/dist` automatically in production (single process on `:3001`).

## Data layout

Metadata in Postgres (tables mirror the old SQLite schema; names/comments/AI/audit/index bodies are `enc:v1:` ciphertext when `KREATIX_DATA_KEY` is set). `KREATIX_DATA_DIR` still holds blob storage: `blobs/<2-hex>/<sha256>`.
Every content save writes an **immutable version** (SRS §19) — never mutate blobs.

## Deploy (VPS)

```bash
cp .env.example .env   # set JWT_SECRET (+ APP_PORT / APP_BIND if behind a proxy)
docker compose up -d --build        # app only, on ${APP_BIND:-127.0.0.1}:${APP_PORT:-3001}
SITE_ADDRESS=suite.example.com docker compose --profile tls up -d   # + Caddy managed TLS
```

### Live deployment (67.211.210.8)

- **URL**: https://kreatixsuite.67-211-210-8.sslip.io (sslip.io → box IP, LetsEncrypt cert via certbot)
- App: `docker compose` in `/opt/kreatix` (git clone of this repo), bound to `127.0.0.1:3017`
- nginx site: `/etc/nginx/sites-enabled/kreatixsuite` → `127.0.0.1:3017` (copy in `deploy/`)
- Shared host: only 22/80/443 public (ufw); all apps route through host nginx — do NOT open extra ports
- Redeploy: `cd /opt/kreatix && git pull && docker compose up -d --build`

## Implemented (SRS refs)

- KBS-SHARED-001/002/003/004/007/008: auth+tenancy, home hub, autosave→versions, perm modes, share links
- KBS-DRIVE-001/003/004/005/007: folders, versions+restore, named shares, 5 roles, recycle bin
- KBS-SHARED-009: permission-trimmed name + full-text search (encrypted `search_index`, JS-side matching)
- Encryption at rest: `KREATIX_DATA_KEY` → AES-256-GCM on blobs + sensitive DB free-text (item names, index bodies, comments, AI prompts/ops, audit details). `enc:v1:`/`KX1\0` markers keep plaintext rows readable.
- KBS-WRITER-001/003/005/013/017/018: TipTap editor, styles/tables/images, comments+anchors, find/replace, word count, DOCX import (mammoth) / export (docx)
- KBS-SEC-004/005: RBAC, per-file permissions

## Roadmap (SRS §23 order)

Sheets engine → Present canvas → PDF renderer → Yjs CRDT collab (WS) → AI tool layer → enterprise governance. See todo list.
