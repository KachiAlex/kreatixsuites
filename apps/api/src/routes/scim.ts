// SCIM 2.0 provisioning endpoints (RFC 7643/7644 subset): Users CRUD,
// userName-eq filter, PATCH replace ops, list pagination. Bearer auth via
// per-org provisioning tokens (scim_tokens, SHA-256 hashed).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { one, q, run, now } from "../db.js";
import { hashPassword, initials, type UserRow } from "../auth.js";
import { logActivity } from "../items.js";

const CORE_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERR = "urn:ietf:params:scim:api:messages:2.0:Error";
const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

interface ScimReq extends FastifyRequest { scimOrg?: string }

function scimError(reply: FastifyReply, status: number, detail: string, scimType?: string) {
  return reply.code(status).type("application/scim+json")
    .send({ schemas: [ERR], status: String(status), detail, ...(scimType ? { scimType } : {}) });
}

function toScimUser(u: UserRow & { scim_external_id?: string | null }, base: string) {
  const nameParts = u.display_name.trim().split(/\s+/);
  return {
    schemas: [CORE_USER],
    id: u.id,
    externalId: u.scim_external_id ?? undefined,
    userName: u.email,
    displayName: u.display_name,
    name: {
      formatted: u.display_name,
      givenName: nameParts.slice(0, -1).join(" ") || undefined,
      familyName: nameParts.length > 1 ? nameParts[nameParts.length - 1] : undefined,
    },
    emails: [{ value: u.email, primary: true, type: "work" }],
    active: !u.disabled,
    meta: { resourceType: "User", created: u.created_at, location: `${base}/Users/${u.id}` },
  };
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const scimStr = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) ? str(v[0]) : undefined);
const b = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;

export async function scimRoutes(app: FastifyInstance) {
  app.addContentTypeParser("application/scim+json", { parseAs: "string" }, (_req, body, done) => {
    try { done(null, body === "" ? {} : JSON.parse(body as string)); }
    catch (e) { done(e as Error); }
  });

  app.addHook("preHandler", async (req, reply) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    const token = m?.[1];
    if (!token) return scimError(reply, 401, "Bearer provisioning token required");
    const hash = createHash("sha256").update(token).digest("hex");
    const row = await one<{ org_id: string }>("SELECT org_id FROM scim_tokens WHERE token_hash = $1", [hash]);
    if (!row) return scimError(reply, 401, "Invalid provisioning token");
    (req as ScimReq).scimOrg = row.org_id;
  });

  const base = (req: FastifyRequest) => `${req.protocol}://${req.host}/scim/v2`;

  // ---------- discovery ----------

  app.get("/scim/v2/ServiceProviderConfig", async (req) => ({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: "oauthbearertoken", name: "Provisioning token", description: "Bearer token generated in Admin → SCIM" }],
    meta: { resourceType: "ServiceProviderConfig", location: `${base(req)}/ServiceProviderConfig` },
  }));

  app.get("/scim/v2/ResourceTypes", async (req) => ({
    schemas: [LIST], totalResults: 1, itemsPerPage: 1, startIndex: 1,
    Resources: [{
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "User", name: "User", endpoint: "/Users", schema: CORE_USER,
      meta: { resourceType: "ResourceType", location: `${base(req)}/ResourceTypes/User` },
    }],
  }));

  app.get("/scim/v2/Schemas", async (req) => ({
    schemas: [LIST], totalResults: 1, itemsPerPage: 1, startIndex: 1,
    Resources: [{
      id: CORE_USER, name: "User",
      meta: { resourceType: "Schema", location: `${base(req)}/Schemas/${CORE_USER}` },
    }],
  }));

  // ---------- users ----------

  app.get("/scim/v2/Users", async (req, reply) => {
    const org = (req as ScimReq).scimOrg!;
    const query = req.query as { filter?: string; startIndex?: string; count?: string };
    const startIndex = Math.max(1, Number(query.startIndex) || 1);
    const count = Math.min(Math.max(Number(query.count) || 100, 1), 200);
    const params: unknown[] = [org];
    let where = "org_id = $1";
    // support the filter IdPs actually send: userName eq "x" / externalId eq "x"
    const fm = /^(userName|externalId)\s+eq\s+"([^"]*)"$/i.exec(query.filter?.trim() ?? "");
    if (query.filter && !fm) return scimError(reply, 400, "Only 'userName eq' and 'externalId eq' filters are supported", "invalidFilter");
    if (fm) {
      params.push(fm[2]);
      where += fm[1].toLowerCase() === "username" ? " AND email = $2" : " AND scim_external_id = $2";
    }
    const total = (await one<{ n: string }>(`SELECT COUNT(*) n FROM users WHERE ${where}`, params))?.n ?? "0";
    const rows = await q<UserRow & { scim_external_id: string | null }>(
      `SELECT * FROM users WHERE ${where} ORDER BY created_at LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, count, startIndex - 1]);
    return reply.type("application/scim+json").send({
      schemas: [LIST], totalResults: Number(total), startIndex, itemsPerPage: rows.length,
      Resources: rows.map((u) => toScimUser(u, base(req))),
    });
  });

  app.get("/scim/v2/Users/:id", async (req, reply) => {
    const org = (req as ScimReq).scimOrg!;
    const u = await one<UserRow & { scim_external_id: string | null }>(
      "SELECT * FROM users WHERE id = $1 AND org_id = $2", [(req.params as { id: string }).id, org]);
    if (!u) return scimError(reply, 404, "User not found");
    return reply.type("application/scim+json").send(toScimUser(u, base(req)));
  });

  app.post("/scim/v2/Users", async (req, reply) => {
    const org = (req as ScimReq).scimOrg!;
    const body = b(req);
    const userName = str(body.userName);
    if (!userName || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(userName))
      return scimError(reply, 400, "userName must be an email address", "invalidValue");
    const existing = await one("SELECT id FROM users WHERE email = $1", [userName]);
    if (existing) return scimError(reply, 409, "userName already exists", "uniqueness");
    const name = body.name as Record<string, unknown> | undefined;
    const display = str(body.displayName)
      ?? str(name?.formatted)
      ?? ([str(name?.givenName), str(name?.familyName)].filter(Boolean).join(" ")
        || userName.split("@")[0]);
    const pw = str(body.password) ?? randomBytes(18).toString("base64url");
    const active = body.active !== false;
    const id = randomUUID();
    await run(
      `INSERT INTO users (id, org_id, email, password_hash, display_name, initials, role, disabled, scim_external_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'member',$7,$8,$9)`,
      [id, org, userName, hashPassword(pw), display, initials(display), !active, str(body.externalId) ?? null, now()]);
    const u = (await one<UserRow & { scim_external_id: string | null }>("SELECT * FROM users WHERE id = $1", [id]))!;
    void logActivity(org, id, null, "scim-provision", `SCIM create ${userName}`);
    return reply.code(201).type("application/scim+json").send(toScimUser(u, base(req)));
  });

  /** shared replace logic for PUT + PATCH */
  const applyUpdate = async (req: FastifyRequest, reply: FastifyReply, fields: {
    userName?: string; display?: string; active?: boolean; externalId?: string | null;
  }) => {
    const org = (req as ScimReq).scimOrg!;
    const id = (req.params as { id: string }).id;
    const u = await one<UserRow>("SELECT * FROM users WHERE id = $1 AND org_id = $2", [id, org]);
    if (!u) return scimError(reply, 404, "User not found");
    if (fields.userName && fields.userName.toLowerCase() !== u.email.toLowerCase()) {
      const clash = await one("SELECT id FROM users WHERE email = $1 AND id <> $2", [fields.userName, id]);
      if (clash) return scimError(reply, 409, "userName already exists", "uniqueness");
    }
    await run(
      `UPDATE users SET email = COALESCE($3, email), display_name = COALESCE($4, display_name),
        initials = COALESCE($5, initials), disabled = COALESCE($6, disabled),
        scim_external_id = COALESCE($7, scim_external_id) WHERE id = $1 AND org_id = $2`,
      [id, org, fields.userName ?? null, fields.display ?? null,
       fields.display ? initials(fields.display) : null,
       fields.active === undefined ? null : !fields.active,
       fields.externalId === undefined ? null : fields.externalId]);
    void logActivity(org, id, null, "scim-update", "SCIM update");
    const fresh = await one<UserRow & { scim_external_id: string | null }>("SELECT * FROM users WHERE id = $1", [id]);
    return reply.type("application/scim+json").send(toScimUser(fresh!, base(req)));
  };

  app.put("/scim/v2/Users/:id", async (req, reply) => {
    const body = b(req);
    const name = body.name as Record<string, unknown> | undefined;
    return applyUpdate(req, reply, {
      userName: str(body.userName),
      display: str(body.displayName)
        ?? ([str(name?.givenName), str(name?.familyName)].filter(Boolean).join(" ") || undefined),
      active: typeof body.active === "boolean" ? body.active : undefined,
      externalId: body.externalId === null ? null : str(body.externalId),
    });
  });

  app.patch("/scim/v2/Users/:id", async (req, reply) => {
    const body = b(req);
    const ops = Array.isArray(body.Operations) ? body.Operations as Record<string, unknown>[] : [];
    if (!ops.length) return scimError(reply, 400, "No Operations supplied", "invalidValue");
    const fields: Parameters<typeof applyUpdate>[2] = {};
    for (const op of ops) {
      const path = str(op.path)?.toLowerCase();
      const val = op.value;
      const values = typeof val === "object" && val !== null ? val as Record<string, unknown> : undefined;
      // two shapes: {path:"active", value:false} and {value:{active:false}}
      const get = (k: string) => values?.[k] ?? (path === k ? val : undefined);
      const act = get("active");
      if (typeof act === "boolean") fields.active = act;
      if (typeof act === "string") fields.active = act.toLowerCase() === "true";
      const un = get("userName") ?? scimStr(get("userName"));
      if (un) fields.userName = String(un);
      const dn = get("displayName");
      if (str(dn)) fields.display = str(dn);
      const nm = get("name");
      if (nm && typeof nm === "object") {
        const o = nm as Record<string, unknown>;
        const joined = [str(o.givenName), str(o.familyName)].filter(Boolean).join(" ");
        if (joined) fields.display = joined;
      }
      if (path === "name.givenname" || path === "name.familyname") {
        fields.display = fields.display ?? str(val);
      }
      const ext = get("externalId");
      if (ext !== undefined) fields.externalId = ext === null ? null : String(ext);
      const emails = get("emails");
      if (Array.isArray(emails)) {
        const primary = (emails as Record<string, unknown>[]).find((e) => e.primary) ?? emails[0] as Record<string, unknown>;
        if (str(primary?.value)) fields.userName = str(primary!.value);
      }
    }
    return applyUpdate(req, reply, fields);
  });

  app.delete("/scim/v2/Users/:id", async (req, reply) => {
    const org = (req as ScimReq).scimOrg!;
    const id = (req.params as { id: string }).id;
    try {
      const n = await run("DELETE FROM users WHERE id = $1 AND org_id = $2", [id, org]);
      if (!n) return scimError(reply, 404, "User not found");
    } catch (e) {
      // FK constraints (owned items etc.) — fall back to deactivation
      if ((e as { code?: string }).code !== "23503") throw e;
      await run("UPDATE users SET disabled = true WHERE id = $1 AND org_id = $2", [id, org]);
    }
    return reply.code(204).send();
  });
}
