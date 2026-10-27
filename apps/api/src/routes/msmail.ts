// Microsoft 365 → Kreatix Mail tenant migration (admin-only).
//
// Flow: org admin clicks Connect → we hand back an Azure admin-consent URL →
// the customer's M365 admin consents → Microsoft redirects to the PUBLIC
// /consent endpoint → the admin UI then POSTs /complete (authenticated), we
// prove consent works by fetching a client-credentials token + the tenant
// org name, and store the connection. From there the admin maps M365
// mailboxes to Kreatix addresses and syncs on demand or via the sweep.
import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { q, one, run } from "../db.js";
import { postInbound } from "../mailBridge.js";
import {
  consentUrl, fetchDeltaMessages, fetchMime, graphGet, inboundSecret,
  listTenantUsers, msMailEnabled, publicUrl,
} from "../msGraph.js";

interface ConnRow {
  id: string; org_id: string; tenant_id: string; tenant_name: string | null;
  consented_by: string | null; created_at: string;
}
interface MapRow {
  id: string; org_id: string; ms_user_id: string; upn: string | null;
  mail: string | null; display_name: string | null; target_email: string | null;
  enabled: boolean; state: string; delta_link: string | null;
  imported_count: number; error: string | null; last_sync_at: string | null;
}

const mapOut = (m: MapRow) => ({
  id: m.id, msUserId: m.ms_user_id, upn: m.upn, mail: m.mail,
  displayName: m.display_name, targetEmail: m.target_email,
  enabled: m.enabled, state: m.state, importedCount: m.imported_count,
  error: m.error, lastSyncAt: m.last_sync_at,
});
const connOut = (c: ConnRow) => ({
  tenantId: c.tenant_id, tenantName: c.tenant_name,
  consentedBy: c.consented_by, createdAt: c.created_at,
});

const SYNC_CAP_PER_MAILBOX = 200; // messages per mailbox per run — bounds sweep time

/**
 * Import one org's mapped M365 mailboxes into Kreatix Mail. Delta-based:
 * first run pulls the whole mailbox, later runs only the changes. Each
 * injected message is recorded in ms_mail_imported so a crashed page never
 * double-delivers.
 */
export async function syncMsMailOrg(orgId: string, log?: { info: (o: object, m: string) => void }) {
  const conn = await one<ConnRow>("SELECT * FROM ms_mail_connections WHERE org_id = $1", [orgId]);
  if (!conn || !msMailEnabled() || !inboundSecret()) return { skipped: true };
  const maps = await q<MapRow>(
    "SELECT * FROM ms_mail_maps WHERE org_id = $1 AND enabled AND target_email IS NOT NULL", [orgId]);
  let imported = 0;
  const errors: string[] = [];
  for (const m of maps) {
    await run("UPDATE ms_mail_maps SET state = 'syncing', error = NULL WHERE id = $1", [m.id]);
    try {
      const { ids, deltaLink } = await fetchDeltaMessages(
        conn.tenant_id, m.ms_user_id, m.delta_link, SYNC_CAP_PER_MAILBOX);
      let n = 0;
      for (const mid of ids) {
        // claim the slot first — a retry after a crash sees the row and skips
        const claimed = await one<{ ms_message_id: string }>(
          `INSERT INTO ms_mail_imported (map_id, ms_message_id) VALUES ($1,$2)
           ON CONFLICT (map_id, ms_message_id) DO NOTHING RETURNING ms_message_id`,
          [m.id, mid]);
        if (!claimed) continue;
        try {
          const mime = await fetchMime(conn.tenant_id, m.ms_user_id, mid);
          await postInbound(m.target_email!, mime);
          n++;
        } catch (e) {
          // release the claim so the next run retries this message
          await run("DELETE FROM ms_mail_imported WHERE map_id = $1 AND ms_message_id = $2", [m.id, mid]);
          throw e;
        }
      }
      await run(
        `UPDATE ms_mail_maps SET state = 'done', imported_count = imported_count + $2,
           last_sync_at = now(), delta_link = COALESCE($3, delta_link) WHERE id = $1`,
        [m.id, n, deltaLink]);
      imported += n;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${m.upn ?? m.ms_user_id}: ${msg}`);
      await run("UPDATE ms_mail_maps SET state = 'error', error = $2 WHERE id = $1", [m.id, msg]);
    }
  }
  log?.info({ orgId, imported, errors: errors.length }, "msmail sync run");
  return { imported, errors: errors.slice(0, 10) };
}

export function msMailRoutes(app: FastifyInstance) {
  // ── PUBLIC: Microsoft's admin-consent redirect target. Writes nothing —
  // it just bounces the admin back into the app with the tenant id; the
  // authenticated /complete call is what actually stores the connection.
  app.get("/api/admin/msmail/consent", async (req, reply) => {
    const qy = req.query as { tenant?: string; admin_consent?: string; error?: string };
    const dest = new URL(`${publicUrl()}/admin`);
    if (qy.admin_consent === "True" && qy.tenant) dest.searchParams.set("msmail", qy.tenant);
    if (qy.error) dest.searchParams.set("msmail_error", qy.error);
    return reply.redirect(dest.toString());
  });

  app.addHook("preHandler", requireAuth);

  const orgAdmin = (req: AuthedRequest, reply: FastifyReply) => {
    if (req.user.role !== "owner" && req.user.role !== "admin") {
      reply.code(403).send({ error: "forbidden", message: "Org owner/admin only" });
      return false;
    }
    return true;
  };

  app.get("/api/admin/msmail", async (req) => {
    const { user } = req as AuthedRequest;
    const conn = await one<ConnRow>("SELECT * FROM ms_mail_connections WHERE org_id = $1", [user.orgId]);
    const maps = conn
      ? await q<MapRow>("SELECT * FROM ms_mail_maps WHERE org_id = $1 ORDER BY upn", [user.orgId])
      : [];
    return {
      enabled: msMailEnabled() && !!inboundSecret(),
      connection: conn ? connOut(conn) : null,
      maps: maps.map(mapOut),
    };
  });

  app.post("/api/admin/msmail/connect", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!orgAdmin(req as AuthedRequest, reply)) return;
    if (!msMailEnabled()) {
      return reply.code(503).send({ error: "disabled", message: "Microsoft 365 import isn't configured on this platform" });
    }
    const { tenant } = z.object({ tenant: z.string().trim().min(3).max(253) }).parse(req.body);
    return { consentUrl: consentUrl(tenant, `${user.orgId}:${randomUUID()}`) };
  });

  /** Called by the admin UI after Microsoft redirects back — proves consent
   *  by fetching a token + the tenant name, then stores the connection. */
  app.post("/api/admin/msmail/complete", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!orgAdmin(req as AuthedRequest, reply)) return;
    if (!msMailEnabled()) return reply.code(503).send({ error: "disabled", message: "Microsoft 365 import isn't configured" });
    const { tenantId } = z.object({ tenantId: z.string().trim().min(10).max(64) }).parse(req.body);
    let orgName: string | null = null;
    try {
      const org = await graphGet<{ value?: { displayName?: string }[] }>(
        tenantId, "/organization?$select=displayName&$top=1");
      orgName = org.value?.[0]?.displayName ?? null;
    } catch (e) {
      return reply.code(400).send({
        error: "consent_failed",
        message: `Couldn't read the tenant — consent may not have completed: ${e instanceof Error ? e.message : e}`,
      });
    }
    const row = await one<ConnRow>(
      `INSERT INTO ms_mail_connections (id, org_id, tenant_id, tenant_name, consented_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (org_id) DO UPDATE SET tenant_id = $3, tenant_name = $4, consented_by = $5
       RETURNING *`,
      [randomUUID(), user.orgId, tenantId, orgName, user.email]);
    return { connection: connOut(row!) };
  });

  /** Enumerate M365 mailboxes for the mapping UI. */
  app.get("/api/admin/msmail/mailboxes", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!orgAdmin(req as AuthedRequest, reply)) return;
    const conn = await one<ConnRow>("SELECT * FROM ms_mail_connections WHERE org_id = $1", [user.orgId]);
    if (!conn) return reply.code(404).send({ error: "not_connected", message: "Connect a Microsoft 365 tenant first" });
    const users = await listTenantUsers(conn.tenant_id);
    return {
      mailboxes: users.map((u) => ({
        msUserId: u.id, upn: u.userPrincipalName ?? null,
        mail: u.mail ?? null, displayName: u.displayName ?? null,
        active: u.accountEnabled ?? true,
      })),
    };
  });

  /** Auto-map: M365 address already on one of the org's verified domains →
   *  same address; otherwise local-part on the primary verified domain. */
  app.post("/api/admin/msmail/automap", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!orgAdmin(req as AuthedRequest, reply)) return;
    const conn = await one<ConnRow>("SELECT * FROM ms_mail_connections WHERE org_id = $1", [user.orgId]);
    if (!conn) return reply.code(404).send({ error: "not_connected", message: "Connect a Microsoft 365 tenant first" });
    const domains = await q<{ domain: string; is_primary: boolean }>(
      "SELECT domain, is_primary FROM org_domains WHERE org_id = $1 AND status = 'verified'", [user.orgId]);
    const primary = domains.find((d) => d.is_primary)?.domain ?? domains[0]?.domain ?? null;
    if (!primary) {
      return reply.code(400).send({ error: "no_domain", message: "Verify an email domain first — Admin → Email domains" });
    }
    const verified = new Set(domains.map((d) => d.domain.toLowerCase()));
    const users = await listTenantUsers(conn.tenant_id);
    let created = 0;
    for (const u of users) {
      if (u.accountEnabled === false) continue;
      const addr = (u.mail ?? u.userPrincipalName ?? "").toLowerCase();
      const [local, dom] = addr.split("@");
      if (!local) continue;
      const target = verified.has(dom) ? addr : `${local}@${primary}`;
      const r = await one<{ id: string }>(
        `INSERT INTO ms_mail_maps (id, org_id, ms_user_id, upn, mail, display_name, target_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (org_id, ms_user_id) DO UPDATE SET upn = $4, mail = $5, display_name = $6
         RETURNING id`,
        [randomUUID(), user.orgId, u.id, u.userPrincipalName ?? null, u.mail ?? null,
         u.displayName ?? null, target]);
      if (r) created++;
    }
    const maps = await q<MapRow>("SELECT * FROM ms_mail_maps WHERE org_id = $1 ORDER BY upn", [user.orgId]);
    return { processed: created, maps: maps.map(mapOut) };
  });

  app.patch("/api/admin/msmail/maps/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!orgAdmin(req as AuthedRequest, reply)) return;
    const { id } = req.params as { id: string };
    const m = await one<MapRow>("SELECT * FROM ms_mail_maps WHERE id = $1 AND org_id = $2", [id, user.orgId]);
    if (!m) return reply.code(404).send({ error: "not_found", message: "Mapping not found" });
    const patch = z.object({
      targetEmail: z.string().email().nullable().optional(),
      enabled: z.boolean().optional(),
    }).parse(req.body);
    if (patch.targetEmail !== undefined) {
      await run("UPDATE ms_mail_maps SET target_email = $2 WHERE id = $1", [id, patch.targetEmail]);
    }
    if (patch.enabled !== undefined) {
      await run("UPDATE ms_mail_maps SET enabled = $2, state = CASE WHEN $2 THEN 'pending' ELSE 'disabled' END WHERE id = $1",
        [id, patch.enabled]);
    }
    const fresh = await one<MapRow>("SELECT * FROM ms_mail_maps WHERE id = $1", [id]);
    return { map: mapOut(fresh!) };
  });

  app.delete("/api/admin/msmail/maps/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!orgAdmin(req as AuthedRequest, reply)) return;
    const { id } = req.params as { id: string };
    const n = await run("DELETE FROM ms_mail_maps WHERE id = $1 AND org_id = $2", [id, user.orgId]);
    if (!n) return reply.code(404).send({ error: "not_found", message: "Mapping not found" });
    return { ok: true };
  });

  /** Kick an import run for this org now (async — poll GET /msmail for state). */
  app.post("/api/admin/msmail/sync", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!orgAdmin(req as AuthedRequest, reply)) return;
    if (!inboundSecret()) {
      return reply.code(503).send({ error: "disabled", message: "Mail inbound endpoint isn't configured" });
    }
    void syncMsMailOrg(user.orgId).catch(() => {});
    return { started: true };
  });

  app.delete("/api/admin/msmail", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!orgAdmin(req as AuthedRequest, reply)) return;
    await run("DELETE FROM ms_mail_connections WHERE org_id = $1", [user.orgId]);
    return { ok: true };
  });
}
