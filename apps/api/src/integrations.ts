// Public API keys + outbound webhooks.
//
// Keys: `kx_<40-hex>` bearer tokens stored as sha256 hashes (high-entropy →
// no scrypt needed). App-only semantics — a key sees the org's data surface,
// not the creator's personal ACL (SharePoint app-principal model).
//
// Webhooks: POST JSON to subscribed URLs on every engine event, signed with
// `x-kreatix-signature: sha256=<hmac(secret, rawBody)>`. Failed deliveries
// retry from the sweep with linear backoff, up to 10 attempts.
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { q, one, run } from "./db.js";

// ---------- API keys ----------

export const API_SCOPES = ["read", "write", "hooks"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiKey {
  id: string; org_id: string; name: string; prefix: string;
  scopes: ApiScope[]; created_by: string | null;
  created_at: string; last_used_at: string | null;
}

const hashKey = (t: string) => createHash("sha256").update(t).digest("hex");

export async function createApiKey(orgId: string, name: string, scopes: ApiScope[], userId: string) {
  const token = `kx_${randomBytes(20).toString("hex")}`;
  const id = randomUUID();
  await run(
    `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, orgId, name.slice(0, 80), token.slice(0, 8), hashKey(token), JSON.stringify(scopes), userId]);
  return { id, token }; // token shown once, never stored
}

/** Resolve an `kx_` bearer token → key row, or null. Updates last_used_at. */
export async function resolveApiKey(token: string): Promise<ApiKey | null> {
  if (!token.startsWith("kx_") || token.length < 12) return null;
  const k = await one<ApiKey>(
    `SELECT id, org_id, name, prefix, scopes, created_by, created_at, last_used_at
     FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`, [hashKey(token)]);
  if (!k) return null;
  void run("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [k.id]).catch(() => {});
  return k;
}

export const keyAllows = (k: ApiKey, scope: ApiScope) => k.scopes.includes(scope);

// ---------- webhooks ----------

export interface WebhookRow {
  id: string; org_id: string; url: string; secret: string;
  events: string[]; active: boolean;
}

/** Enqueue + fire signed deliveries for an org event. Called (unawaited)
 *  from fireTrigger so it shares every existing emit point. */
export async function deliverHooks(
  orgId: string, event: string, ctx: Record<string, string>,
  log?: { warn: (o: unknown, m: string) => void },
): Promise<void> {
  const hooks = await q<WebhookRow>(
    `SELECT * FROM webhooks WHERE org_id = $1 AND active
     AND (events = '[]'::jsonb OR events ? $2)`, [orgId, event]).catch(() => [] as WebhookRow[]);
  const body = {
    id: `evt_${randomUUID()}`,
    event,
    orgId,
    at: new Date().toISOString(),
    data: Object.fromEntries(Object.entries(ctx).filter(([k]) => !k.startsWith("_"))),
  };
  for (const h of hooks) {
    const id = randomUUID();
    await run(
      `INSERT INTO webhook_deliveries (id, webhook_id, org_id, event, payload, next_retry_at)
       VALUES ($1,$2,$3,$4,$5,now())`,
      [id, h.id, orgId, event, JSON.stringify(body)]).catch(() => {});
    void deliverOne(id, h, body).catch((e) => log?.warn({ err: String(e) }, "webhook delivery failed"));
  }
}

export async function deliverOne(deliveryId: string, hook: { url: string; secret: string }, body: unknown): Promise<void> {
  const raw = JSON.stringify(body);
  const sig = createHmac("sha256", hook.secret).update(raw).digest("hex");
  let code: number | null = null;
  let err: string | null = null;
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-kreatix-event": String((body as { event?: string }).event ?? ""),
        "x-kreatix-delivery": deliveryId,
        "x-kreatix-signature": `sha256=${sig}`,
      },
      body: raw,
      signal: AbortSignal.timeout(10_000),
    });
    code = res.status;
    if (res.ok) {
      await run(
        `UPDATE webhook_deliveries SET status='delivered', attempts=attempts+1,
         response_code=$2, delivered_at=now(), last_error=NULL, next_retry_at=NULL
         WHERE id=$1`, [deliveryId, code]);
      return;
    }
    err = `HTTP ${res.status}`;
  } catch (e) {
    err = String(e).slice(0, 300);
  }
  // retry: linear 5-minute backoff, give up after 10 attempts
  const done = await one<{ attempts: number }>(
    `UPDATE webhook_deliveries SET attempts = attempts + 1, response_code = $2,
       last_error = $3,
       status = CASE WHEN attempts + 1 >= 10 THEN 'failed' ELSE 'pending' END,
       next_retry_at = CASE WHEN attempts + 1 >= 10 THEN NULL
                            ELSE now() + ((attempts + 1) * interval '5 minutes') END
     WHERE id = $1 AND status = 'pending'
     RETURNING attempts`, [deliveryId, code, err]);
  if (!done) { /* delivered concurrently */ }
}

/** Retry due deliveries — called from the periodic sweep. */
export async function sweepWebhookDeliveries(): Promise<number> {
  const due = await q<{ id: string; webhook_id: string; payload: unknown; url: string; secret: string; event: string }>(
    `SELECT d.id, d.webhook_id, d.payload, w.url, w.secret, d.event
     FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.status = 'pending' AND d.next_retry_at <= now() AND w.active
     ORDER BY d.next_retry_at LIMIT 50`);
  for (const d of due) {
    await deliverOne(d.id, { url: d.url, secret: d.secret }, d.payload).catch(() => {});
  }
  return due.length;
}
