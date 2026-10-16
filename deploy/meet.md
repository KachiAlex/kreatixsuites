# Kreatix Meet (docker-jitsi-meet on the VPS)

Self-hosted Jitsi at `/opt/kreatix-meet` (clone of jitsi/docker-jitsi-meet
`stable-11248`). Prosody runs `AUTH_TYPE=jwt` — only tokens minted by the
suite API (`/api/meet/*/join`) can open rooms; guest links carry a 6h
guest JWT in the URL.

## Host layout

- `/opt/kreatix-meet/.env` — JWT_APP_ID/SECRET (shared with suite), PUBLIC_URL,
  DOCKER_HOST_ADDRESS=67.211.210.8, JVB_COLIBRI_PORT=8480 (8080 was taken)
- `/opt/kreatix-meet/cfg` — prosody/jicofo/jvb/web state (uid 1000)
- web → `127.0.0.1:3030` behind host nginx `meet.kreatixtech.com` (+ legacy
  alias `meet.67-211-210-8.sslip.io` on the same server block/cert)
- JVB media → public `10000/udp` (ufw) — required, media can't ride 443

## Suite env

    KREATIX_MEET_BASE=https://meet.kreatixtech.com
    KREATIX_MEET_APP_ID=<jitsi JWT_APP_ID>
    KREATIX_MEET_SECRET=<jitsi JWT_APP_SECRET>

## Pretty hostname

`meet.kreatixtech.com` → A record → 67.211.210.8 (Cloudflare zone). The cert
covers both names (`certbot --nginx --expand --cert-name meet.67-211-210-8.sslip.io
-d meet.67-211-210-8.sslip.io -d meet.kreatixtech.com`). If the record was left
proxied (orange cloud), flip it to DNS-only to remove the extra TLS hop — UDP
media is unaffected either way (JVB advertises the IP literal). The JWT `sub`
is the internal XMPP domain (meet.jitsi) so tokens are hostname-agnostic.
