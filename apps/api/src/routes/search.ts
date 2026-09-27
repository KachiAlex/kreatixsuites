import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { toDriveItem, type ItemRow } from "../items.js";
import { requireAuth, permissionFor, type AuthedRequest } from "../auth.js";
import { indexBody } from "../indexer.js";

/** Highlight each term occurrence in `text` within `window` chars of `pos`. */
function snippet(text: string, terms: string[], pos: number): string {
  const half = 70;
  const start = Math.max(0, pos - half);
  const end = Math.min(text.length, pos + half);
  let seg = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
  for (const t of terms) {
    if (!t) continue;
    seg = seg.replaceAll(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `«${m}»`);
  }
  return seg;
}

export function searchRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /**
   * Permission-trimmed search. Index bodies and names are encrypted at rest,
   * so matching runs JS-side over only the files this user can see — org-scale
   * bounded, same result shape as before.
   */
  app.get("/api/search", async (req) => {
    const { user } = req as AuthedRequest;
    const { q } = req.query as { q?: string };
    if (!q?.trim()) return { items: [] };

    const terms = q.trim().toLowerCase().split(/\s+/);
    const needle = q.trim().toLowerCase();

    const rows = db
      .prepare(
        `SELECT DISTINCT i.* FROM items i
         LEFT JOIN shares s ON s.file_id = i.id AND s.user_id = :uid
         WHERE i.trashed = 0 AND (i.owner_id = :uid OR s.user_id IS NOT NULL)
         ORDER BY i.updated_at DESC`,
      )
      .all({ uid: user.id }) as ItemRow[];

    type ResultItem = ReturnType<typeof toDriveItem> & { match: "name" | "content"; snippet?: string };
    const items: ResultItem[] = [];
    const contentQueue: ItemRow[] = [];

    for (const r of rows) {
      const name = toDriveItem(r).name; // decrypted
      if (terms.every((t) => name.toLowerCase().includes(t))) {
        items.push({ ...toDriveItem(r, permissionFor(user.id, r) ?? undefined), match: "name" });
        if (items.length >= 15) break;
      } else {
        contentQueue.push(r);
      }
    }

    const seen = new Set(items.map((i) => i.id));
    for (const r of contentQueue) {
      if (items.length >= 30) break;
      if (seen.has(r.id)) continue;
      const body = indexBody(r.id);
      if (!body) continue;
      const lower = body.toLowerCase();
      if (!terms.every((t) => lower.includes(t))) continue;
      const pos = Math.max(0, lower.indexOf(needle) !== -1 ? lower.indexOf(needle) : lower.indexOf(terms[0]));
      seen.add(r.id);
      items.push({
        ...toDriveItem(r, permissionFor(user.id, r) ?? undefined),
        match: "content",
        snippet: snippet(body, terms, pos),
      });
    }
    return { items };
  });
}
