#!/bin/bash
# Pull verified custom domains from the suite Postgres -> postfix maps.
# Runs from cron (*/1) as root on the VPS - a verified domain starts
# accepting inbound mail ~60s after admin verification.
set -u
T=/etc/postfix/kreatix_transport
D=/etc/postfix/kreatix_domains
DOMAINS=$(docker exec kreatix-db-1 psql -U kreatix -d kreatix -tA \
  -c "SELECT domain FROM org_domains WHERE status='verified' ORDER BY domain" 2>/dev/null)
NT=$(mktemp); ND=$(mktemp)
while IFS= read -r d; do
  [ -z "$d" ] && continue
  echo "$d	kreatixmail:" >> "$NT"
  echo "$d	OK" >> "$ND"
done <<< "$DOMAINS"
changed=0
cmp -s "$NT" <(postmap -s "$T" 2>/dev/null || true) || changed=1
cmp -s "$ND" <(postmap -s "$D" 2>/dev/null || true) || changed=1
if [ "$changed" = 1 ]; then
  cp "$NT" "$T"; cp "$ND" "$D"
  postmap "$T"; postmap "$D"
  postfix reload >/dev/null 2>&1
  logger -t kreatix-domains "domain maps updated: $(echo "$DOMAINS" | tr '\n' ' ')"
fi
rm -f "$NT" "$ND"
# keep the pipe secret in sync with the mail service env
grep -oP '^INBOUND_EMAIL_SECRET=\K.*' /opt/kreatix-mail/server/.env | tr -d "\"'\r" \
  > /etc/kreatix-inbound-secret.new
if ! cmp -s /etc/kreatix-inbound-secret.new /etc/kreatix-inbound-secret 2>/dev/null; then
  mv /etc/kreatix-inbound-secret.new /etc/kreatix-inbound-secret
  chown kreatixmail:kreatixmail /etc/kreatix-inbound-secret; chmod 600 /etc/kreatix-inbound-secret
else rm -f /etc/kreatix-inbound-secret.new; fi
