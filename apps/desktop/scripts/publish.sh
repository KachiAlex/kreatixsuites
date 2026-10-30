#!/usr/bin/env bash
# Build the Windows installer and publish it to the public download page.
#
#   bash apps/desktop/scripts/publish.sh
#
# Bump "version" in apps/desktop/package.json first. The download page
# (/download, /api/downloads) serves the newest installer on the VPS, so the
# upload is the whole release. Needs ssh access to the VPS.
set -euo pipefail
cd "$(dirname "$0")/../../.."

VPS=${KX_VPS:-root@67.211.210.8}
DIR=/var/lib/docker/volumes/kreatix_kreatix-data/_data/downloads
SITE=${KX_SITE:-https://suites.kreatixtech.com}
VERSION=$(node -p "require('./apps/desktop/package.json').version")
EXE="apps/desktop/release/Kreatix Suites-${VERSION}-x64.exe"

step() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

step "build web app"
pnpm --filter @kreatix/web build
step "build installer ${VERSION}"
(cd apps/desktop && pnpm dist)
[ -f "$EXE" ] || { echo "missing $EXE" >&2; exit 1; }
step "upload to $VPS"
scp "$EXE" "$VPS:$DIR/"
step "check download page"
ADVERTISED=$(curl -s "$SITE/api/downloads" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).desktop.version")
if [ "$ADVERTISED" != "$VERSION" ]; then
  echo "download page still shows $ADVERTISED, expected $VERSION" >&2
  exit 1
fi
echo "published Kreatix Suites $VERSION: $SITE/download"
