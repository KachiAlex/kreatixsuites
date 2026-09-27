import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { toDriveItem, getItem, type ItemRow } from "../items.js";
import { requireAuth, permissionFor, hasPermission, type AuthedRequest } from "../auth.js";

const LIKE_ESC = (s: string) => s.replace(/[%_\\]/g, (m) => `\\${m}`);
/** Terms → FTS5 phrase-AND query ("foo" "bar"); quotes inside terms escaped. */
const ftsQuery = (q: string) =>
  q.trim().split(/\s+/).map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");

export function searchRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /** Permission-trimmed search: name matches first, then FTS5 content hits
   *  with snippets. Permission = owner or shared row (same as Drive lists). */
  app.get("/api/search", async (req) => {
    const { user } = req as AuthedRequest;
    const { q } = req.query as { q?: string };
    if (!q?.trim()) return { items: [] };

    const perm = `LEFT JOIN shares s ON s.file_id = i.id AND s.user_id = :uid`;
    const visible = `i.trashed = 0 AND (i.owner_id = :uid OR s.user_id IS NOT NULL)`;

    const nameRows = db
      .prepare(
        `SELECT DISTINCT i.* FROM items i ${perm}
         WHERE ${visible} AND i.name LIKE :q ESCAPE '\\'
         ORDER BY i.updated_at DESC LIMIT 15`,
      )
      .all({ uid: user.id, q: `%${LIKE_ESC(q.trim())}%` }) as ItemRow[];

    type ResultItem = ReturnType<typeof toDriveItem> & { match: "name" | "content"; snippet?: string };
    const seen = new Set(nameRows.map((r) => r.id));
    const items: ResultItem[] = nameRows.map((r) => ({
      ...toDriveItem(r, permissionFor(user.id, r) ?? undefined),
      match: "name",
    }));

    let hitRows: { file_id: string; snip: string }[] = [];
    try {
      hitRows = db
        .prepare(
          `SELECT file_id, snippet(search_index, 1, '«', '»', '…', 18) AS snip
           FROM search_index WHERE search_index MATCH ? ORDER BY rank LIMIT 40`,
        )
        .all(ftsQuery(q)) as { file_id: string; snip: string }[];
    } catch { /* malformed FTS query — name matches still returned */ }

    for (const h of hitRows) {
      if (items.length >= 30) break;
      if (seen.has(h.file_id)) continue;
      const item = getItem(h.file_id);
      if (!item || item.trashed || !hasPermission(permissionFor(user.id, item), "viewer")) continue;
      seen.add(h.file_id);
      items.push({
        ...toDriveItem(item, permissionFor(user.id, item) ?? undefined),
        match: "content", snippet: h.snip,
      });
    }
    return { items };
  });
}
