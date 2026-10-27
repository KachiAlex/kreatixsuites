// Microsoft Graph client for tenant-level mail migration.
//
// A single multi-tenant app registration (Kreatix side) with APPLICATION
// permissions — User.Read.All + Mail.Read — is what powers "import my whole
// org from Microsoft 365": the customer's M365 admin grants admin consent
// once (POST /connect → consentUrl → /consent callback → /complete), and
// afterwards we can read every mailbox in their tenant with
// client-credentials tokens. No per-user passwords, no IMAP.
//
// Env: KREATIX_MS_CLIENT_ID / KREATIX_MS_CLIENT_SECRET (the multi-tenant
// app registration), KREATIX_MAIL_INBOUND_SECRET (shared with the mail
// service's /api/inbound-email), KREATIX_PUBLIC_URL (consent redirect).

const GRAPH = "https://graph.microsoft.com/v1.0";

export const msClientId = () => process.env.KREATIX_MS_CLIENT_ID ?? "";
const msClientSecret = () => process.env.KREATIX_MS_CLIENT_SECRET ?? "";
export const msMailEnabled = () => !!(msClientId() && msClientSecret());
export const inboundSecret = () => process.env.KREATIX_MAIL_INBOUND_SECRET ?? "";
export const publicUrl = () =>
  (process.env.KREATIX_PUBLIC_URL || "https://suites.kreatixtech.com").replace(/\/$/, "");

export function consentRedirectUri() {
  return `${publicUrl()}/api/admin/msmail/consent`;
}

/** v2 admin-consent URL — the customer's M365 admin opens this, reviews the
 *  app permissions, and consents for their whole tenant. */
export function consentUrl(tenant: string, state: string) {
  const u = new URL(
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/v2.0/adminconsent`);
  u.searchParams.set("client_id", msClientId());
  u.searchParams.set("redirect_uri", consentRedirectUri());
  u.searchParams.set("scope", "https://graph.microsoft.com/.default");
  u.searchParams.set("state", state);
  return u.toString();
}

const tokenCache = new Map<string, { token: string; exp: number }>();

export async function graphToken(tenantId: string): Promise<string> {
  const hit = tokenCache.get(tenantId);
  if (hit && Date.now() < hit.exp - 60_000) return hit.token;
  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: msClientId(), client_secret: msClientSecret(),
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    });
  const j = await res.json().catch(() => ({})) as
    { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) {
    throw new Error(j.error_description ?? j.error ?? `Graph token request failed (${res.status})`);
  }
  tokenCache.set(tenantId, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}

export async function graphGet<T>(tenantId: string, path: string): Promise<T> {
  const token = await graphToken(tenantId);
  const res = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const j = await res.json().catch(() => ({})) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(j.error?.message ?? `Graph request failed (${res.status})`);
  return j;
}

/** Raw body fetch — used for the MIME `$value` export. */
export async function graphGetBuffer(tenantId: string, path: string): Promise<Buffer> {
  const token = await graphToken(tenantId);
  const res = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Graph request failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export interface MsUser {
  id: string;
  userPrincipalName?: string;
  mail?: string;
  displayName?: string;
  accountEnabled?: boolean;
}

/** All user accounts in the customer tenant (paged). */
export async function listTenantUsers(tenantId: string): Promise<MsUser[]> {
  const out: MsUser[] = [];
  let url: string | undefined =
    "/users?$select=id,userPrincipalName,mail,displayName,accountEnabled&$top=100";
  while (url && out.length < 5000) {
    const page: { value?: MsUser[]; "@odata.nextLink"?: string } =
      await graphGet<{ value?: MsUser[]; "@odata.nextLink"?: string }>(tenantId, url);
    out.push(...(page.value ?? []));
    url = page["@odata.nextLink"];
  }
  return out;
}

interface DeltaPage {
  value?: { id: string; "@removed"?: { reason?: string } }[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

/**
 * Walk a mailbox's message delta — returns messages to import plus the new
 * delta link for incremental sync. `since` is the stored delta link
 * (undefined = full initial import). Bounded by `limit` messages per call.
 */
export async function fetchDeltaMessages(tenantId: string, msUserId: string, since: string | null, limit: number) {
  const ids: string[] = [];
  let url: string | undefined = since
    ?? `/users/${encodeURIComponent(msUserId)}/messages/delta?$top=50`;
  let deltaLink: string | null = null;
  while (url && ids.length < limit) {
    const page: DeltaPage = await graphGet<DeltaPage>(tenantId, url);
    for (const m of page.value ?? []) {
      if (m["@removed"]) continue;
      if (ids.length >= limit) break;
      ids.push(m.id);
    }
    if (page["@odata.deltaLink"]) { deltaLink = page["@odata.deltaLink"]; break; }
    if (ids.length >= limit) break;
    url = page["@odata.nextLink"];
  }
  return { ids, deltaLink };
}

/** Raw RFC822 for one message — feeds /api/inbound-email untouched. */
export const fetchMime = (tenantId: string, msUserId: string, messageId: string) =>
  graphGetBuffer(tenantId,
    `/users/${encodeURIComponent(msUserId)}/messages/${encodeURIComponent(messageId)}/$value`);
