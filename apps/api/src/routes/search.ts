import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { toDriveItem, type ItemRow } from "../items.js";
import { requireAuth, permissionFor, type AuthedRequest } from "../auth.js";

export function searchRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /** Permission-trimmed name search (KBS-SHARED-009; content/OCR indexing is P1) */
  app.get("/api/search", async (req) => {
    const { user } = req as AuthedRequest;
    const { q } = req.query as { q?: string };
    if (!q?.trim()) return { items: [] };
    const rows = db
      .prepare(
        `SELECT DISTINCT i.* FROM items i
         LEFT JOIN shares s ON s.file_id = i.id AND s.user_id = :uid
         WHERE i.trashed = 0 AND (i.owner_id = :uid OR s.user_id IS NOT NULL)
           AND i.name LIKE :q ESCAPE '\\'
         ORDER BY i.updated_at DESC LIMIT 30`,
      )
      .all({ uid: user.id, q: `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%` }) as ItemRow[];
    return { items: rows.map((r) => toDriveItem(r, permissionFor(user.id, r) ?? undefined)) };
  });
}
