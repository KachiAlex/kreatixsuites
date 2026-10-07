// In-app feedback — the floating widget's submissions land here; the
// superadmin portal reads them via /api/superadmin/feedback.
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { q, one, run, now } from "../db.js";
import { requireAuth, type AuthedRequest } from "../auth.js";

export function feedbackRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.post("/api/feedback", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { sentiment, message, page } = z.object({
      sentiment: z.enum(["good", "ok", "bad"]).default("ok"),
      message: z.string().min(1).max(2000),
      page: z.string().max(200).optional(),
    }).parse(req.body ?? {});

    // gentle anti-spam — 10 submissions/day per user
    const today = await one<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM feedback WHERE user_id = $1 AND created_at >= CURRENT_DATE",
      [user.id]);
    if (Number(today?.n ?? 0) >= 10) {
      return reply.code(429).send({ error: "rate_limited", message: "That's plenty of feedback for today — thank you!" });
    }

    await run(
      "INSERT INTO feedback (id, org_id, user_id, sentiment, message, page, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [randomUUID(), user.orgId, user.id, sentiment, message.trim(), page ?? null, now()],
    );
    return { ok: true };
  });

  /** The user's own thread — the widget renders history + admin replies on open. */
  app.get("/api/feedback", async (req) => {
    const { user } = req as AuthedRequest;
    const rows = await q(
      `SELECT id, sentiment, message, reply, page, created_at, replied_at
       FROM feedback WHERE user_id = $1 ORDER BY created_at ASC LIMIT 200`, [user.id]);
    return { feedback: rows };
  });
}
