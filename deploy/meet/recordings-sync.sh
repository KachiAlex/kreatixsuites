#!/usr/bin/env bash
# recordings-sync — runs on the VPS host (cron */1). Finds finalized Jibri
# recordings under $REC_DIR and registers them with the suite's ingest
# endpoint; the suite reads the .mp4 straight off its shared mount, so no
# multi-hundred-MB HTTP upload happens. A .ingested marker prevents repeats.
set -uo pipefail

REC_DIR="${REC_DIR:-/opt/kreatix-meet/cfg/jibri/recordings}"
SUITE_URL="${SUITE_URL:-http://127.0.0.1:3017}"
SECRET_FILE="${SECRET_FILE:-/opt/kreatix-meet/ingest.secret}"
SECRET="$(cat "$SECRET_FILE" 2>/dev/null)"
[ -n "$SECRET" ] || exit 0
[ -d "$REC_DIR" ] || exit 0

for f in "$REC_DIR"/*/*.mp4 "$REC_DIR"/*.mp4; do
  [ -f "$f" ] || continue
  [ -f "$f.ingested" ] && continue
  # skip files still being written (mtime < 20s ago)
  [ -n "$(find "$f" -mmin -0.33 2>/dev/null)" ] && continue
  rel="${f#$REC_DIR/}"
  code=$(curl -sf -X POST "$SUITE_URL/api/meet/recordings/ingest" \
    -H "content-type: application/json" -H "x-ingest-secret: $SECRET" \
    --data "{\"path\":\"$rel\"}" -o /dev/null -w '%{http_code}') || code=000
  case "$code" in
    200|201) touch "$f.ingested" ;;
    404|422) touch "$f.ingested" ;;   # no meeting/code match — don't retry forever
  esac
done
