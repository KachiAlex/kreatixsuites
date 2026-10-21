#!/usr/bin/env bash
# Zero-downtime deploy for the kreatix VPS (67.211.210.8 layout).
#
#   blue  = the container host nginx currently proxies to (port 3017 or 3018)
#   green = a freshly-built container on the OTHER port, health-checked,
#           nginx flipped, then blue is stopped.
#
# Boot-time DDL is additive-only (CREATE ... IF NOT EXISTS / ADD COLUMN IF
# NOT EXISTS), so green can migrate the shared database while blue still
# serves — keep it that way (expand/contract, never rename/drop in one
# release) or this script is unsafe.
#
# Caveat: Yjs collab WebSockets drop when blue stops — clients reconnect and
# the CRDT re-syncs automatically. HTTP requests never see downtime.
#
# Usage:  sudo bash deploy/roll.sh [git-ref]     (default: current branch pull)
set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR=$(pwd)
NGINX_CONF=/etc/nginx/sites-enabled/kreatixsuite
STATE=$APP_DIR/.active-slot
NET=kreatix_default
# blue = whichever port nginx actually proxies to right now (config is
# ground truth; state file is only a fallback for first run)
BLUE_PORT=$(grep -oP 'proxy_pass http://127\.0\.0\.1:\K[0-9]+' "$NGINX_CONF" | head -1)
BLUE_PORT=${BLUE_PORT:-$(cat "$STATE" 2>/dev/null || echo 3017)}
GREEN_PORT=$([ "$BLUE_PORT" = "3017" ] && echo 3018 || echo 3017)
GREEN_NAME=kreatix-app-green
SRC=${1:-}

step() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }

step "pull ${SRC:-HEAD} + build"
if [ -n "$SRC" ]; then git fetch --all --quiet && git checkout --quiet "$SRC"; else git pull --ff-only --quiet; fi
docker compose build --quiet app
IMAGE=$(docker compose config --images app | head -1)
[ -n "$IMAGE" ] || die "could not resolve app image"

# The live container is the config source of truth — find it by the port
# nginx proxies to, then replay its resolved env + mounts verbatim so green
# is identical to blue minus the port.
LIVE=$(docker ps --format '{{.Names}} {{.Ports}}' | grep "127.0.0.1:$BLUE_PORT->" | awk '{print $1}' | head -1)
[ -n "$LIVE" ] || LIVE=$(docker ps --format '{{.Names}}' | grep -E '^kreatix-app' | head -1)
[ -n "$LIVE" ] || die "no live app container found"
step "mirroring env+mounts from $LIVE"
docker inspect "$LIVE" --format '{{range .Config.Env}}{{println}}{{.}}{{end}}' > /tmp/kx-green.env
MOUNTS=$(docker inspect "$LIVE" --format \
  '{{range .Mounts}}{{if eq .Type "volume"}}-v {{.Name}}:{{.Destination}} {{end}}{{if eq .Type "bind"}}-v {{.Source}}:{{.Destination}}:ro {{end}}{{end}}')

step "start green ($GREEN_NAME :$GREEN_PORT) on $IMAGE"
docker rm -f "$GREEN_NAME" >/dev/null 2>&1 || true
# shellcheck disable=SC2086
docker run -d --name "$GREEN_NAME" --network "$NET" --restart unless-stopped \
  --env-file /tmp/kx-green.env $MOUNTS \
  -p "127.0.0.1:$GREEN_PORT:3001" "$IMAGE" >/dev/null

step "health-check green"
ok=""
for i in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:$GREEN_PORT/api/health" 2>/dev/null | grep -q '"ok":true'; then ok=1; break; fi
  sleep 2
done
if [ -z "$ok" ]; then
  docker logs --tail 30 "$GREEN_NAME" >&2 || true
  docker rm -f "$GREEN_NAME" >/dev/null 2>&1 || true
  die "green never became healthy — blue untouched, deploy aborted"
fi

step "flip nginx $BLUE_PORT -> $GREEN_PORT"
cp "$NGINX_CONF" "${NGINX_CONF}.bak"
sed -i "s/127\.0\.0\.1:$BLUE_PORT/127.0.0.1:$GREEN_PORT/g" "$NGINX_CONF"
nginx -t >/dev/null 2>&1 || { mv "${NGINX_CONF}.bak" "$NGINX_CONF"; die "nginx -t failed — config restored"; }
systemctl reload nginx
echo "$GREEN_PORT" > "$STATE"

step "drain + stop old ($BLUE_PORT) — collab sockets reconnect here"
sleep 8
docker stop "$LIVE" >/dev/null 2>&1 || true
docker rm "$LIVE" >/dev/null 2>&1 || true
# NOTE: green keeps its name — the next run locates it via the nginx port
# above. A manual `docker compose up -d app` still works as the emergency
# path but recreates the compose container on :3017, so re-run roll.sh
# (or flip the proxy_pass back) after using it.

step "verifying through nginx"
sleep 2
curl -fsS https://localhost/api/health -k 2>/dev/null | grep -q '"ok":true' \
  || curl -fsS "http://127.0.0.1:$GREEN_PORT/api/health" | grep -q '"ok":true' \
  || die "post-flip health check failed"
printf '\033[1;32mDeployed — serving on :%s (%s)\033[0m\n' "$GREEN_PORT" "$IMAGE"
