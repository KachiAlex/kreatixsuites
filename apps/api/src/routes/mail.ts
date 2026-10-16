import type { FastifyInstance } from "fastify";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { mailEnabled, mailFetch, mailStatus } from "../mailBridge.js";

/** Paths the suite session may reach on the mail service — everything user-
 *  facing; admin/auth internals are never proxied. */
const BLOCKED = /^(admin|auth)(\/|$)/;

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
