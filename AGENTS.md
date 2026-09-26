# Kreatix Business Suite

AI-native office productivity suite per `Kreatix_Business_Suite_SRS_v1.0.docx`
(Writer · Sheets · Present · PDF · Drive · Kreatix AI). Brand: `Kreatix_Business_Suite_Brand_UI_v2.html`.

## Stack (VPS-targeted)

- `apps/web` — React 19 + Vite + TypeScript SPA. Design system in `src/styles.css` (tokens ported from Brand UI: `--k-orange:#F2782E`, Inter, rail+sidebar+topbar shell).
- `apps/api` — Fastify 5 + TypeScript, bundled by esbuild to `dist/server.js`.
- `packages/shared` — domain types (`@kreatix/shared`), imported as TS source.
- DB: **SQLite via better-sqlite3** (dev + self-hosted prod). Swap behind repository layer for Postgres later.
- Files: content-addressed blob store under `KREATIX_DATA_DIR/blobs` (S3/MinIO-swappable interface in `apps/api/src/blobs.ts`).
- Auth: scrypt password hash + HS256 JWT (`jose`), 7d tokens.

## Runbook

```bash
pnpm install                       # first time
pnpm rebuild better-sqlite3        # if native binding missing
pnpm dev:api                       # API on :3001
pnpm dev:web                       # Vite on :5173 (proxies /api → :3001)
pnpm build                         # builds web dist + api bundle
pnpm typecheck
```

API serves `apps/web/dist` automatically in production (single process on `:3001`).

## Data layout

`KREATIX_DATA_DIR` (default `apps/api/.data`): `kreatix.db` + `blobs/<2-hex>/<sha256>`.
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
- KBS-SHARED-009: permission-trimmed name search (content index is P1)
- KBS-WRITER-001/003/005/013/017/018: TipTap editor, styles/tables/images, comments+anchors, find/replace, word count, DOCX import (mammoth) / export (docx)
- KBS-SEC-004/005: RBAC, per-file permissions

## Roadmap (SRS §23 order)

Sheets engine → Present canvas → PDF renderer → Yjs CRDT collab (WS) → AI tool layer → enterprise governance. See todo list.
