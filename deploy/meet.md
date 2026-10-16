# Kreatix Meet (docker-jitsi-meet on the VPS)

Self-hosted Jitsi at `/opt/kreatix-meet` (clone of jitsi/docker-jitsi-meet
`stable-11248`). Prosody runs `AUTH_TYPE=jwt` — only tokens minted by the
suite API (`/api/meet/*/join`) can open rooms; guest links carry a 6h
guest JWT in the URL.

## Host layout

- `/opt/kreatix-meet/.env` — JWT_APP_ID/SECRET (shared with suite), PUBLIC_URL,
  DOCKER_HOST_ADDRESS=67.211.210.8, JVB_COLIBRI_PORT=8480 (8080 was taken)
- `/opt/kreatix-meet/cfg` — prosody/jicofo/jvb/web state (uid 1000)
- web → `127.0.0.1:3030` behind host nginx `meet.67-211-210-8.sslip.io`
- JVB media → public `10000/udp` (ufw) — required, media can't ride 443

## Suite env

    KREATIX_MEET_BASE=https://meet.67-211-210-8.sslip.io
    KREATIX_MEET_APP_ID=<jitsi JWT_APP_ID>
    KREATIX_MEET_SECRET=<jitsi JWT_APP_SECRET>

## Pretty hostname

`meet.kreatixtech.com` needs a DNS-only (gray cloud) A record → 67.211.210.8
in the zone's Cloudflare account. Once it resolves: add an nginx server_name
+ certbot cert, then set PUBLIC_URL + KREATIX_MEET_BASE to it and restart both
stacks. The JWT `sub` is the internal XMPP domain (meet.jitsi) so tokens are
hostname-agnostic.
