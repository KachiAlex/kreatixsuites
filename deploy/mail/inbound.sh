#!/bin/bash
# postfix pipe -> kreatix-mail /api/inbound-email  (installed at /opt/kreatix-mail/inbound.sh)
# env from pipe(8): ORIGINAL_RECIPIENT (or RECIPIENT), SENDER
SECRET_FILE=/etc/kreatix-inbound-secret
SECRET=$(cat "$SECRET_FILE" 2>/dev/null)
[ -z "$SECRET" ] && { echo "no inbound secret" >&2; exit 75; } # EX_TEMPFAIL -> postfix retries
TO="${ORIGINAL_RECIPIENT:-$RECIPIENT}"
exec curl -fsS -m 30 -X POST http://127.0.0.1:3020/api/inbound-email \
  -H "x-inbound-secret: $SECRET" \
  -H "x-envelope-to: $TO" \
  -H "content-type: message/rfc822" \
  --data-binary @- 2>>/var/log/kreatix-inbound.log
