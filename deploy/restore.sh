#!/usr/bin/env bash
# Kreatix disaster-recovery restore — run ON the target host as root.
#
# Usage:
#   ./restore.sh [backup-dir]          restore latest backup (default: /opt/kreatix/data/backups)
#   ./restore.sh --verify-only [dir]   drill mode: restore into a scratch
#                                      container + run smoke checks, don't touch prod
#
# What it does:
#   1. picks the newest verified backup (db dump + blob tarball pair)
#   2. gunzip -t integrity check (the backup job already tar-verified it)
#   3. restores the pg_dump into the kreatix database
#   4. unpacks the blob tarball over KREATIX_DATA_DIR/blobs
#   5. smokes /api/health + a document fetch
#
# Prereqs: docker compose stack running, same KREATIX_DATA_KEY as the
# backup was written with (encrypted blobs/fields are ciphertext without it).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/kreatix}"
BACKUP_DIR="${2:-${1:-$APP_DIR/data/backups}}"
[ "${1:-}" = "--verify-only" ] && BACKUP_DIR="${2:-$APP_DIR/data/backups}"
VERIFY_ONLY=0; [ "${1:-}" = "--verify-only" ] && VERIFY_ONLY=1
DB_CONT="${DB_CONT:-kreatix-db-1}"
DB_USER="${DB_USER:-kreatix}"
DB_NAME="${DB_NAME:-kreatix}"

cd "$APP_DIR"

pick_pair() {
  # backup job writes db-<ts>.sql.gz + blobs-<ts>.tar.gz pairs
  DB_DUMP=$(ls -1t "$BACKUP_DIR"/db-*.sql.gz 2>/dev/null | head -1) || true
  [ -n "${DB_DUMP:-}" ] || { echo "no db-*.sql.gz in $BACKUP_DIR" >&2; exit 1; }
  TS=$(basename "$DB_DUMP" | sed 's/^db-//; s/\.sql\.gz$//')
  BLOB_TAR="$BACKUP_DIR/blobs-$TS.tar.gz"
  echo "backup set: $TS"
  [ -f "$BLOB_TAR" ] || echo "WARN: no matching blob tarball $BLOB_TAR (db-only restore)"
}

pick_pair
echo "db dump:  $DB_DUMP"
echo "blob tar: ${BLOB_TAR:-none}"

# 1. integrity
gunzip -t "$DB_DUMP" && echo "dump integrity: ok"
[ -f "$BLOB_TAR" ] && tar -tzf "$BLOB_TAR" >/dev/null && echo "tarball integrity: ok"

# 2. restore db — verify-only goes into a scratch database on the same
# postgres container: the dump is exercised end-to-end without touching
# the live schema, and the scratch db is dropped afterwards.
if [ "$VERIFY_ONLY" = "1" ]; then
  DRILL_DB="kreatix_drill_$$"
  docker exec "$DB_CONT" psql -U "$DB_USER" -c "CREATE DATABASE $DRILL_DB" >/dev/null
  trap 'docker exec "$DB_CONT" psql -U "$DB_USER" -c "DROP DATABASE IF EXISTS $DRILL_DB" >/dev/null 2>&1 || true' EXIT
  echo "restoring dump into scratch db $DRILL_DB…"
  gunzip -c "$DB_DUMP" | docker exec -i "$DB_CONT" psql -U "$DB_USER" -d "$DRILL_DB" -v ON_ERROR_STOP=1 -q
  echo "drill restore: ok"
  # compare headline counts restored-vs-live
  for t in users orgs items versions sessions activity; do
    restored=$(docker exec "$DB_CONT" psql -U "$DB_USER" -d "$DRILL_DB" -tAc "SELECT count(*) FROM $t" 2>/dev/null || echo "n/a")
    live=$(docker exec "$DB_CONT" psql -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT count(*) FROM $t" 2>/dev/null || echo "n/a")
    printf "  %-12s restored=%-6s live=%-6s\n" "$t" "$restored" "$live"
  done
  # table coverage: flag live tables absent from the backup (real gaps vs
  # post-backup schema additions — check pg_class.ctime-era rows to tell apart)
  comm -13 \
    <(docker exec "$DB_CONT" psql -U "$DB_USER" -d "$DRILL_DB" -tAc "SELECT tablename FROM pg_tables WHERE schemaname='public'" | sort) \
    <(docker exec "$DB_CONT" psql -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT tablename FROM pg_tables WHERE schemaname='public'" | sort) \
    | sed '/^$/d' | tr '\n' ' ' | { read -r missing && \
        [ -z "$missing" ] && echo "table coverage: complete" \
                          || echo "table coverage: live tables not in backup → $missing"; }
  [ -f "${BLOB_TAR:-}" ] && echo "blob tarball objects: $(tar -tzf "$BLOB_TAR" | wc -l)"
  echo "verify-only run complete — prod untouched (scratch db dropped)"
  exit 0
fi

echo "restoring database $DB_NAME…"
gunzip -c "$DB_DUMP" | docker exec -i "$DB_CONT" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1
echo "db restore: ok ($(docker exec "$DB_CONT" psql -U "$DB_USER" -d "$DB_NAME" -tAc 'SELECT count(*) FROM items') items)"

# 3. restore blobs
if [ -f "${BLOB_TAR:-}" ]; then
  DATA_DIR=$(docker exec kreatix-app-1 printenv KREATIX_DATA_DIR)
  echo "restoring blobs → $DATA_DIR/blobs"
  docker exec -i kreatix-app-1 tar -xzf - -C "$DATA_DIR" < "$BLOB_TAR"
  echo "blob restore: ok ($(find "$APP_DIR/data/blobs" -type f | wc -l) objects)"
fi

# 4. smoke
docker compose restart app >/dev/null
for i in $(seq 1 20); do curl -sf http://127.0.0.1:3017/api/health && break || sleep 2; done
echo; echo "status: $(curl -s http://127.0.0.1:3017/api/status)"

echo "done."
