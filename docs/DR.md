# Disaster Recovery Runbook

**Targets:** RPO ≤ 24 h (nightly backups), RTO ≤ 4 h.
**Owner:** whoever holds the VPS root + `KREATIX_DATA_KEY`.

## What's backed up

Nightly job (`backup.ts`, advisory-locked): `pg_dump` of Postgres + tarball
of `KREATIX_DATA_DIR/blobs` → `KREATIX_BACKUP_DIR` (default
`<DATA_DIR>/backups`). Every run is gzip + tar verified before it's marked
`ok`, and optionally mirrored to an S3-compatible bucket
(`KREATIX_BACKUP_S3_*`) — the `offloaded_at` column records off-site copies.

**Not** in the backup: `.env` (JWT_SECRET, KREATIX_DATA_KEY, provider keys).
Keep these in a password manager — **without `KREATIX_DATA_KEY` all restored
ciphertext is unrecoverable**, it is as important as the backup itself.

## Quarterly restore drill (do this — an untested backup is not a backup)

```bash
cd /opt/kreatix
./deploy/restore.sh --verify-only          # restores into the live stack
```

Record the time-to-restore; if it exceeds 4 h, split blob restore (largest
term) from db restore or pre-stage a warm standby.

## Full-loss recovery (new host)

1. Provision host, install docker, clone repo → `/opt/kreatix`.
2. Copy `.env` (secrets manager) + fetch latest backup pair
   (`db-*.sql.gz` + `blobs-*.tar.gz`) from `KREATIX_BACKUP_DIR` or the S3
   bucket (`aws s3 cp s3://<bucket>/…` / `rclone`).
3. `docker compose up -d db` — wait healthy, **do not** start `app` yet.
4. `./deploy/restore.sh` — integrity-checks, restores db + blobs, smokes.
5. `docker compose up -d --build` → verify `/api/health` + `/api/status`
   (backup-freshness check should report the restored run).
6. Point DNS / nginx at the host; re-issue TLS (certbot).

## Zero-downtime deploys

`deploy/roll.sh` is the blue-green path: build → start a second app
container on the alternate port (3017↔3018) → health-check → flip host
nginx → drain → stop the old container. HTTP requests see no downtime;
collab WebSockets reconnect (Yjs re-syncs). Constraint: boot-time DDL must
stay additive-only — new columns/tables fine, renames/drops need a
two-release expand/contract split.

```bash
cd /opt/kreatix && ./deploy/roll.sh        # or: ./deploy/roll.sh <git-ref>
```

## Blob storage (S3 mirror)

Set `KREATIX_BLOB_S3_*` to mirror objects to S3/R2/MinIO — new writes go to
both stores, reads fall back to S3 and rehydrate the local cache. Then run
the one-time backfill: SuperPortal → Ops → **Sync to S3** (advisory-locked,
progress in the app log). Benefits: survives local-disk loss without a
restore window, and is a prerequisite for running a second app node.

## Failure modes

| Symptom | Likely cause | Action |
|---|---|---|
| `psql` FK errors during restore | dump ordering | dumps are FK-ordered; if hit, `--disable-triggers` restore then re-enable |
| Blobs return `[encrypted]`/auth errors | wrong `KREATIX_DATA_KEY` | restore the key that wrote the backup (see key-ring note below) |
| `/api/status` backup `never:true` | fresh DB without `backup_runs` rows | run one manual backup to re-seed |
| Old sessions still work after restore | `sessions`/`token_version` rows also restored | have all users hit `/api/auth/logout-all`, or `UPDATE users SET token_version = token_version + 1` |

## Key rotation (data key)

`KREATIX_DATA_KEY` accepts a comma-separated ring: `NEW,OLD`. New writes use
the first key; decrypts try every key (GCM auth tag = wrong-key detection).
Rotation procedure: prepend new key → restart → re-encrypt lazily or via a
rekey sweep → remove the old key once verified.
