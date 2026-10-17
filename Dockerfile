# Kreatix Business Suite — all-in-one image (API + built SPA + SQLite + blob store)
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY patches ./patches
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY . .
# desktop is built/packaged separately (CI) — not part of the server image
RUN pnpm --filter @kreatix/shared --filter @kreatix/web --filter @kreatix/api build

FROM node:24-bookworm-slim
# postgresql-client-17 (PGDG) — pg_dump for the automated backup sweep; tar for the blob archive
RUN apt-get update && apt-get install -y --no-install-recommends wget gnupg ca-certificates \
 && echo "deb http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && wget -qO- https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 tar gzip \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
COPY --from=build /app /app
WORKDIR /app/apps/api
# KREATIX_DATA_DIR holds the blob store — mount a volume at /data.
# Metadata lives in Postgres (compose `db` service / KREATIX_DATABASE_URL).
ENV KREATIX_DATA_DIR=/data
ENV KREATIX_WEB_DIST=/app/apps/web/dist
VOLUME /data
EXPOSE 3001
CMD ["node", "dist/server.cjs"]
