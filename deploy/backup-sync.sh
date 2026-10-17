#!/bin/bash
# Off-site mirror for Kreatix Suite backups — runs on the VPS host (cron).
# The app's ops sweep writes pg_dump + blob tarballs into
# KREATIX_BACKUP_DIR inside the kreatix-data volume; this script mirrors that
# directory to an rclone remote (S3-compatible: Cloudflare R2, B2, Wasabi,
# AWS S3, MinIO…). Deletions propagate, so remote retention == local retention.
#
# Install (host):
#   1. rclone config   → create a remote, e.g. "r2" pointing at your bucket
#   2. echo 'OFFSITE_REMOTE=r2:kreatix-backups' > /opt/kreatix/backup.env
#   3. (crontab -l; echo "30 3 * * * /opt/kreatix/backup-sync.sh") | crontab -
set -uo pipefail

SRC="${BACKUP_SRC:-/var/lib/docker/volumes/kreatix_kreatix-data/_data/backups}"
[ -d "$SRC" ] || exit 0

[ -f /opt/kreatix/backup.env ] && . /opt/kreatix/backup.env
if [ -n "${OFFSITE_REMOTE:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone sync "$SRC" "$OFFSITE_REMOTE" --log-level INFO \
      --log-file /var/log/kreatix-backup-sync.log \
      || echo "$(date -Is) WARN: offsite sync failed" >&2
  else
    echo "$(date -Is) WARN: OFFSITE_REMOTE set but rclone not installed" >&2
  fi
fi
