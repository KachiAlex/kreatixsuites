#!/usr/bin/env bash
# Enable PSTN dial-in for Kreatix Meet — run on the VPS after buying a SIP
# trunk (Twilio/SignalWire/etc). Prereqs in /opt/kreatix-meet/.env:
#
#   JIGASI_SIP_URI=sip:you@trunk.provider.com
#   JIGASI_SIP_PASSWORD=<trunk password>
#   JIGASI_SIP_SERVER=<trunk sip proxy host>
#   JIGASI_SIP_PORT=5060
#   JIGASI_SIP_TRANSPORT=UDP|TCP|TLS
#
# Then:  MEET_DIALIN_NUMBER="+1xxxxxxxxxx" ./enable-dialin.sh
#
# What it does:
#   1. starts the jigasi container (jigasi.yml overlay — registers the SIP acct)
#   2. sets KREATIX_MEET_DIALIN_NUMBER / KREATIX_MEET_DIALOUT in the suite .env
#      and restarts the app so the Meet UI shows number + per-meeting PIN
#
# The suite already serves the Jitsi-protocol endpoints an IVR needs:
#   GET <public-url>/api/meet/dialin-map?id=<pin>          → { id, conference, name }
#   GET <public-url>/api/meet/dialin-map?conference=<r@m>  → same (reverse)
#   GET <public-url>/api/meet/dialin-numbers             → phoneNumberList
#
# PIN routing caveat: Jigasi has no IVR. Inbound PIN routing needs an IVR box
# (Asterisk/FreeSWITCH, or your trunk's webhook) that prompts for the PIN,
# calls GET $PUBLIC_URL/api/meet/dialin-map?id=<pin>, and forwards the call to
# Jigasi with header "Jitsi-Conference-Room: <conference>". If the trunk can't
# do that, set JIGASI_SIP_DEFAULT_ROOM=<room@muc.meet.jitsi> to land all inbound
# calls in one standing room.
set -euo pipefail

MEET_DIR=/opt/kreatix-meet
SUITE_ENV=/opt/kreatix/.env
DIALIN="${MEET_DIALIN_NUMBER:?Set MEET_DIALIN_NUMBER to the trunk's DID, e.g. +15551234567}"
MUC_DOMAIN="${KREATIX_MEET_MUC_DOMAIN:-muc.meet.jitsi}"

# --- sanity: SIP account must be configured first ---
for v in JIGASI_SIP_URI JIGASI_SIP_PASSWORD JIGASI_SIP_SERVER; do
  if ! grep -q "^$v=" "$MEET_DIR/.env"; then
    echo "ERROR: $v not set in $MEET_DIR/.env — configure the SIP trunk first" >&2
    exit 1
  fi
done

cd "$MEET_DIR"
docker compose -f docker-compose.yml -f jigasi.yml up -d jigasi

# --- suite env: show the number in Meet UI, enable moderator dial-out ---
upsert() { grep -q "^$1=" "$SUITE_ENV" && sed -i "s|^$1=.*|$1=$2|" "$SUITE_ENV" || echo "$1=$2" >> "$SUITE_ENV"; }
upsert KREATIX_MEET_DIALIN_NUMBER "$DIALIN"
upsert KREATIX_MEET_DIALOUT 1
upsert KREATIX_MEET_MUC_DOMAIN "$MUC_DOMAIN"
docker compose -f /opt/kreatix/docker-compose.yml up -d --force-recreate app

echo "Dial-in enabled: $DIALIN — meetings show number + PIN. Inbound PIN routing still needs the IVR described in this script's header."
