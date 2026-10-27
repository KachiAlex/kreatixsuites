import type { FastifyInstance, FastifyReply } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { brevoAuthenticateDomain, brevoRegisterDomain, checkDomainDns, mailEnabled, mailFetch, mailFetchAs, mailStatus } from "../mailBridge.js";
import { q, one, run } from "../db.js";

/** Paths the suite session may reach on the mail service — everything user-
 *  facing; admin/auth internals are never proxied. */
const BLOCKED = /^(admin|auth)(\/|$)/;

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

const domainSchema = z.object({ domain: z.string().trim().toLowerCase().regex(DOMAIN_RE, "Invalid domain") });

interface DomainRow {
  id: string; org_id: string; domain: string; status: string;
  verify_token: string; is_primary: boolean; mx_ok: boolean; brevo_ok: boolean;
  spf_ok: boolean; dmarc_ok: boolean;
  brevo_records: { brevoCode?: { host_name: string; type: string; value: string; status: boolean };
                   dkim1?: { host_name: string; type: string; value: string; status: boolean };
                   dkim2?: { host_name: string; type: string; value: string; status: boolean };
                   dmarc?: { host_name: string; type: string; value: string; status: boolean } } | null;
  verified_at: string | null; created_at: string;
}

const domainOut = (r: DomainRow) => ({
  id: r.id, domain: r.domain, status: r.status, isPrimary: r.is_primary,
  mxOk: r.mx_ok, brevoOk: r.brevo_ok, spfOk: r.spf_ok, dmarcOk: r.dmarc_ok,
  verifyToken: r.status === "verified" ? null : r.verify_token,
  verifiedAt: r.verified_at, createdAt: r.created_at,
});

/** DNS records the org admin should publish — verification is the only one
 *  required now; MX/SPF/DKIM are shown so they can be added in one visit.
 *  Once the domain is registered with Brevo, its exact records are merged in. */
const dnsChecklist = (r: DomainRow) => {
  const rows = [
    { type: "TXT", host: "@", value: `kreatix-verify=${r.verify_token}`, purpose: "Domain verification", required: true, ok: (r.status === "verified") as boolean | null },
    { type: "MX", host: "@", value: "mail.kreatixtech.com (priority 10)", purpose: "Inbound mail delivery", required: false, ok: r.mx_ok as boolean | null },
    { type: "TXT", host: "@", value: "v=spf1 include:spf.brevo.com mx ~all", purpose: "SPF — authorizes our sender", required: false, ok: r.spf_ok as boolean | null },
  ];
  const br = r.brevo_records;
  if (br?.brevoCode) rows.push({ type: br.brevoCode.type, host: br.brevoCode.host_name, value: br.brevoCode.value, purpose: "Brevo domain code", required: false, ok: br.brevoCode.status });
  if (br?.dkim1) rows.push({ type: br.dkim1.type, host: br.dkim1.host_name, value: br.dkim1.value, purpose: "DKIM 1 — outbound signing", required: false, ok: br.dkim1.status });
  if (br?.dkim2) rows.push({ type: br.dkim2.type, host: br.dkim2.host_name, value: br.dkim2.value, purpose: "DKIM 2 — outbound signing", required: false, ok: br.dkim2.status });
  if (br?.dmarc) {
    rows.push({ type: br.dmarc.type, host: br.dmarc.host_name, value: br.dmarc.value, purpose: "DMARC", required: false, ok: br.dmarc.status });
  } else {
    rows.push({ type: "TXT", host: "@", value: "v=DMARC1; p=none; rua=mailto:postmaster@kreatixtech.com", purpose: "DMARC — recommended minimum", required: false, ok: r.dmarc_ok });
  }
  return rows;
};

export function mailRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/mail/status", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!mailEnabled()) return { enabled: false };
    try {
      return await mailStatus(user);
    } catch {
      return reply.code(502).send({ error: "mail_unavailable", message: "Mail service is unavailable" });
    }
  });

  // ── Org email domains (owner/admin only) ─────────────────────────────
  const requireOrgAdmin = (req: AuthedRequest, reply: FastifyReply) => {
    if (req.user.role !== "owner" && req.user.role !== "admin") {
      reply.code(403).send({ error: "forbidden", message: "Org owner/admin only" });
      return false;
    }
    return true;
  };

  app.get("/api/admin/domains", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!requireOrgAdmin(req as AuthedRequest, reply)) return;
    const rows = await q<DomainRow>(
      "SELECT * FROM org_domains WHERE org_id = $1 ORDER BY created_at", [user.orgId]);
    // domains verified before Brevo integration register lazily on first load
    for (const r of rows) {
      if (r.status === "verified" && !r.brevo_records) {
        try {
          const b = await brevoRegisterDomain(r.domain);
          if (b) {
            r.brevo_records = b.records; r.brevo_ok = b.authenticated;
            await run("UPDATE org_domains SET brevo_records = $2, brevo_ok = $3 WHERE id = $1",
              [r.id, JSON.stringify(b.records), b.authenticated]);
          }
        } catch { /* Brevo unreachable — checklist still renders */ }
      }
    }
    return { domains: rows.map((r) => ({ ...domainOut(r), dns: dnsChecklist(r) })) };
  });

  app.post("/api/admin/domains", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!requireOrgAdmin(req as AuthedRequest, reply)) return;
    const parsed = domainSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Enter a valid domain like acme.com" });
    const domain = parsed.data.domain;

    // a verified domain is claimed globally — don't let a second org queue behind it
    const taken = await one<{ org_id: string }>(
      "SELECT org_id FROM org_domains WHERE domain = $1 AND status = 'verified' AND org_id <> $2",
      [domain, user.orgId]);
    if (taken) return reply.code(409).send({ error: "conflict", message: `${domain} is already verified by another workspace` });

    const row = await one<DomainRow>(
      `INSERT INTO org_domains (id, org_id, domain, verify_token) VALUES ($1,$2,$3,$4)
       ON CONFLICT (org_id, domain) DO UPDATE SET verify_token = org_domains.verify_token
       RETURNING *`,
      [randomUUID(), user.orgId, domain, `kx-${randomBytes(12).toString("hex")}`]);
    return reply.code(201).send({ domain: { ...domainOut(row!), dns: dnsChecklist(row!) } });
  });

  app.post("/api/admin/domains/:id/verify", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!requireOrgAdmin(req as AuthedRequest, reply)) return;
    const { id } = req.params as { id: string };
    const row = await one<DomainRow>("SELECT * FROM org_domains WHERE id = $1 AND org_id = $2", [id, user.orgId]);
    if (!row) return reply.code(404).send({ error: "not_found", message: "Domain not found" });

    const dns = await checkDomainDns(row.domain, row.verify_token);
    if (!dns.txtOk) {
      await run("UPDATE org_domains SET mx_ok = $3, spf_ok = $4, dmarc_ok = $5, status = CASE WHEN status = 'verified' THEN 'failed' ELSE status END WHERE id = $1 AND org_id = $2",
        [id, user.orgId, dns.mxOk, dns.spfOk, dns.dmarcOk]);
      return reply.code(400).send({ error: "unverified", message: `Verification record not found at ${row.domain} — DNS changes can take a few minutes to propagate`, mxOk: dns.mxOk, mxTargets: dns.mxTargets });
    }
    try {
      await run(
        `UPDATE org_domains SET status = 'verified', verified_at = now(), mx_ok = $3, spf_ok = $4, dmarc_ok = $5 WHERE id = $1 AND org_id = $2`,
        [id, user.orgId, dns.mxOk, dns.spfOk, dns.dmarcOk]);
    } catch {
      return reply.code(409).send({ error: "conflict", message: `${row.domain} was verified by another workspace` });
    }
    // register the domain with the sending Brevo account and pull its
    // DKIM/DMARC/code records; also refresh authentication status so a
    // verify re-run doubles as a "recheck all DNS" button.
    let brevoOk = false;
    let brevoRecords: DomainRow["brevo_records"] = null;
    try {
      const b = await brevoRegisterDomain(row.domain);
      if (b) brevoRecords = b.records;
      brevoOk = (await brevoAuthenticateDomain(row.domain)) ?? false;
      await run("UPDATE org_domains SET brevo_records = $2, brevo_ok = $3 WHERE id = $1",
        [id, JSON.stringify(brevoRecords), brevoOk]);
    } catch { /* Brevo down/unconfigured — verification still stands */ }
    const fresh = await one<DomainRow>("SELECT * FROM org_domains WHERE id = $1", [id]);
    return { domain: { ...domainOut(fresh!), dns: dnsChecklist(fresh!) } };
  });

  /** Per-record live check — re-reads DNS for every record in the checklist
   *  (TXT verify, MX, SPF, DMARC) plus Brevo authentication, persists the
   *  results, and returns where MX currently points for the cutover view. */
  app.post("/api/admin/domains/:id/check", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!requireOrgAdmin(req as AuthedRequest, reply)) return;
    const { id } = req.params as { id: string };
    const row = await one<DomainRow>("SELECT * FROM org_domains WHERE id = $1 AND org_id = $2", [id, user.orgId]);
    if (!row) return reply.code(404).send({ error: "not_found", message: "Domain not found" });

    const dns = await checkDomainDns(row.domain, row.verify_token);
    let brevoOk = row.brevo_ok;
    try { brevoOk = (await brevoAuthenticateDomain(row.domain)) ?? brevoOk; } catch { /* Brevo unreachable */ }
    await run(
      `UPDATE org_domains SET mx_ok = $3, spf_ok = $4, dmarc_ok = $5, brevo_ok = $6 WHERE id = $1 AND org_id = $2`,
      [id, user.orgId, dns.mxOk, dns.spfOk, dns.dmarcOk, brevoOk]);
    const fresh = await one<DomainRow>("SELECT * FROM org_domains WHERE id = $1", [id]);
    return {
      domain: { ...domainOut(fresh!), dns: dnsChecklist(fresh!) },
      mxTargets: dns.mxTargets,
      verified: dns.txtOk || fresh!.status === "verified",
    };
  });

  app.post("/api/admin/domains/:id/primary", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!requireOrgAdmin(req as AuthedRequest, reply)) return;
    const { id } = req.params as { id: string };
    const row = await one<DomainRow>("SELECT * FROM org_domains WHERE id = $1 AND org_id = $2", [id, user.orgId]);
    if (!row) return reply.code(404).send({ error: "not_found", message: "Domain not found" });
    if (row.status !== "verified") return reply.code(400).send({ error: "unverified", message: "Verify the domain first" });
    await run("UPDATE org_domains SET is_primary = false WHERE org_id = $1", [user.orgId]);
    await run("UPDATE org_domains SET is_primary = true WHERE id = $1", [id]);
    return { ok: true };
  });

  app.delete("/api/admin/domains/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!requireOrgAdmin(req as AuthedRequest, reply)) return;
    const { id } = req.params as { id: string };
    const n = await run("DELETE FROM org_domains WHERE id = $1 AND org_id = $2", [id, user.orgId]);
    if (!n) return reply.code(404).send({ error: "not_found", message: "Domain not found" });
    return { ok: true };
  });

  // ── Shared/delegate mailboxes ────────────────────────────────────────
  // Grants live in the suite DB; the delegate's calls proxy to the mail
  // service with the *owner's* minted JWT (Exchange "Full Access" model).
  // Every delegate call is audited so the owner/admin can see access.

  app.get("/api/mail/shares", async (req) => {
    const { user } = req as AuthedRequest;
    const granted = await q<{ id: string; delegate_user_id: string; display_name: string; email: string }>(
      `SELECT s.id, s.delegate_user_id, u.display_name, u.email
       FROM mail_shares s JOIN users u ON u.id = s.delegate_user_id
       WHERE s.owner_user_id = $1`, [user.id]);
    const shared = await q<{ owner_user_id: string; display_name: string; email: string; mail_email: string | null }>(
      `SELECT s.owner_user_id, u.display_name, u.email, u.mail_email
       FROM mail_shares s JOIN users u ON u.id = s.owner_user_id
       WHERE s.delegate_user_id = $1`, [user.id]);
    return {
      granted: granted.map((g) => ({ id: g.id, userId: g.delegate_user_id, name: g.display_name, email: g.email })),
      sharedWithMe: shared.map((s) => ({ ownerId: s.owner_user_id, name: s.display_name, email: s.email, address: s.mail_email })),
    };
  });

  app.post("/api/mail/shares", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const delegateId = z.string().min(1).safeParse((req.body as { userId?: string })?.userId);
    if (!delegateId.success) return reply.code(400).send({ error: "invalid", message: "Pick a member" });
    // mailbox owner or org admin can grant
    const ownerId = (req.body as { ownerId?: string }).ownerId ?? user.id;
    if (ownerId !== user.id && user.role !== "owner" && user.role !== "admin")
      return reply.code(403).send({ error: "forbidden", message: "Only the mailbox owner or an admin can share it" });
    const delegate = await one<{ id: string }>(
      "SELECT id FROM users WHERE id = $1 AND org_id = $2 AND disabled = false", [delegateId.data, user.orgId]);
    if (!delegate || delegate.id === ownerId)
      return reply.code(400).send({ error: "invalid", message: "Pick another member of this workspace" });
    const owner = await one<{ id: string }>(
      "SELECT id FROM users WHERE id = $1 AND org_id = $2", [ownerId, user.orgId]);
    if (!owner) return reply.code(404).send({ error: "not_found" });
    await run(
      `INSERT INTO mail_shares (id, org_id, owner_user_id, delegate_user_id, created_by)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (owner_user_id, delegate_user_id) DO NOTHING`,
      [randomUUID(), user.orgId, ownerId, delegate.id, user.id]);
    return reply.code(201).send({ ok: true });
  });

  app.delete("/api/mail/shares/:id", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const share = await one<{ id: string; owner_user_id: string }>(
      "SELECT id, owner_user_id FROM mail_shares WHERE id = $1 AND org_id = $2",
      [(req.params as { id: string }).id, user.orgId]);
    if (!share) return reply.code(404).send({ error: "not_found" });
    if (share.owner_user_id !== user.id && user.role !== "owner" && user.role !== "admin")
      return reply.code(403).send({ error: "forbidden" });
    await run("DELETE FROM mail_shares WHERE id = $1", [share.id]);
    return { ok: true };
  });

  /** Delegate proxy: /api/mail/as/<ownerUserId>/<path> — same surface as
   *  /api/mail/* but resolved against the owner's mailbox. */
  app.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    url: "/api/mail/as/:ownerId/*",
    handler: async (req, reply) => {
      const { user } = req as AuthedRequest;
      const { ownerId } = req.params as { ownerId: string };
      const share = await one(
        "SELECT 1 AS x FROM mail_shares WHERE owner_user_id = $1 AND delegate_user_id = $2 AND org_id = $3",
        [ownerId, user.id, user.orgId]);
      if (!share) return reply.code(403).send({ error: "forbidden", message: "That mailbox is not shared with you" });
      if (!mailEnabled()) return reply.code(404).send({ error: "mail_disabled", message: "Mail is not configured" });
      const owner = await one<{ id: string; email: string; display_name: string; org_id: string }>(
        "SELECT id, email, display_name, org_id FROM users WHERE id = $1 AND org_id = $2", [ownerId, user.orgId]);
      if (!owner) return reply.code(404).send({ error: "not_found" });

      const rest = (req.params as { "*": string })["*"] ?? "";
      if (BLOCKED.test(rest)) return reply.code(403).send({ error: "forbidden", message: "Not proxied" });
      const qs = (req.raw.url ?? "").split("?")[1] ?? "";
      const path = `/${rest}${qs ? `?${qs}` : ""}`;

      let body: Buffer | undefined;
      let contentType = req.headers["content-type"] as string | undefined;
      if (req.body !== undefined && req.body !== null) {
        body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
        contentType ??= "application/json";
      } else if (req.headers["content-length"] || req.headers["transfer-encoding"]) {
        const chunks: Buffer[] = [];
        for await (const c of req.raw) chunks.push(c as Buffer);
        if (chunks.length) body = Buffer.concat(chunks);
      }

      let upstream: Response;
      try {
        upstream = await mailFetchAs(
          { id: owner.id, email: owner.email, displayName: owner.display_name, orgId: owner.org_id },
          path, { method: req.method, body, contentType });
      } catch {
        return reply.code(502).send({ error: "mail_unavailable", message: "Mail service is unavailable" });
      }
      void run(
        `INSERT INTO activity (id, org_id, actor_id, action, detail, created_at)
         VALUES ($1,$2,$3,'mail.delegate',$4,now())`,
        [randomUUID(), user.orgId, user.id, `${req.method} /as/${ownerId}${path}`.slice(0, 300)])
        .catch(() => {});
      const buf = Buffer.from(await upstream.arrayBuffer());
      const ct = upstream.headers.get("content-type");
      if (ct) reply.header("content-type", ct);
      return reply.code(upstream.status).send(buf);
    },
  });

  // Generic bridge: /api/mail/<path> → <mail>/api/<path> with a minted JWT.
  app.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    url: "/api/mail/*",
    handler: async (req, reply) => {
      const { user } = req as AuthedRequest;
      if (!mailEnabled()) return reply.code(404).send({ error: "mail_disabled", message: "Mail is not configured" });

      const rest = (req.params as { "*": string })["*"] ?? "";
      if (BLOCKED.test(rest)) return reply.code(403).send({ error: "forbidden", message: "Not proxied" });

      const qs = (req.raw.url ?? "").split("?")[1] ?? "";
      const path = `/${rest}${qs ? `?${qs}` : ""}`;

      let body: Buffer | undefined;
      let contentType = req.headers["content-type"] as string | undefined;
      if (req.body !== undefined && req.body !== null) {
        body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
        contentType ??= "application/json";
      } else if (req.headers["content-length"] || req.headers["transfer-encoding"]) {
        const chunks: Buffer[] = [];
        for await (const c of req.raw) chunks.push(c as Buffer);
        if (chunks.length) body = Buffer.concat(chunks);
      }

      let upstream: Response;
      try {
        upstream = await mailFetch(user, path, { method: req.method, body, contentType });
      } catch {
        return reply.code(502).send({ error: "mail_unavailable", message: "Mail service is unavailable" });
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      const ct = upstream.headers.get("content-type");
      if (ct) reply.header("content-type", ct);
      return reply.code(upstream.status).send(buf);
    },
  });
}
