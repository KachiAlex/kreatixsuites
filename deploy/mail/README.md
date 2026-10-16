# Custom-domain inbound mail (VPS)

Customers set `MX <domain> -> mail.kreatixtech.com`. Postfix on the host
accepts only domains the suite has marked `verified` in `org_domains`,
then pipes the raw message to the kreatix-mail webhook, which matches the
envelope recipient against provisioned mailboxes.

## Host layout (already installed)

- `kreatixmail` system user — runs the pipe
- `/opt/kreatix-mail/inbound.sh` — pipe script (copy of `inbound.sh`)
- `/opt/kreatix-mail/sync-domains.sh` — org_domains -> postfix maps (cron `* * * * *`)
- `/etc/postfix/kreatix_domains`   -> `relay_domains` map (domain -> OK)
- `/etc/postfix/kreatix_transport` -> `transport_maps` map (domain -> `kreatixmail:`)
- `/etc/kreatix-inbound-secret`    — webhook secret (0600, kreatixmail); re-synced from the mail `.env` each run
- `/var/log/kreatix-inbound.log`   — pipe errors

## main.cf / master.cf deltas

    transport_maps = hash:/etc/postfix/kreatix_transport
    relay_domains  = hash:/etc/postfix/kreatix_domains
    message_size_limit = 52428800
    kreatixmail_destination_recipient_limit = 1

    kreatixmail unix - n n - - pipe
      flags=ORhu user=kreatixmail argv=/opt/kreatix-mail/inbound.sh

## Firewall

`ufw allow 25/tcp` — required; customer MX records point at this host.
External senders may address any mailbox on a verified domain; the webhook
returns `ignored` for unknown recipients (silent drop, no backscatter).
