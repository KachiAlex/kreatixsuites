import type { FastifyInstance } from "fastify";
import { q as dbq, one } from "../db.js";
import { toDriveItem, type ItemRow } from "../items.js";
import { requireAuth, permissionFor, hasPermission, type AuthedRequest } from "../auth.js";
import { indexBody } from "../indexer.js";
import { getSite, getLibrary, siteRoleFor, visibleLibraryIds } from "../sites.js";

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

/** True when the item has at least one published version — the visibility
 *  floor for viewer-level readers (draft-only files are invisible to them). */
async function hasPublished(fileId: string): Promise<boolean> {
  return !!(await one<{ n: number }>(
    "SELECT 1 AS n FROM versions WHERE file_id = $1 AND published LIMIT 1", [fileId]));
}

export function searchRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /**
   * Permission-trimmed search. Index bodies and names are encrypted at rest,
   * so matching runs JS-side over only the files this user can see — org-scale
   * bounded, same result shape as before. `?site=` / `?library=` scope the
   * search to a SharePoint-style site or document library (site search also
   * covers every library inside it).
   */
  app.get("/api/search", async (req, reply) => {
    const { user } = req as AuthedRequest;
    const { q, site: siteId, library: libId } =
      req.query as { q?: string; site?: string; library?: string };
    if (!q?.trim()) return { items: [] };

    const terms = q.trim().toLowerCase().split(/\s+/);
    const needle = q.trim().toLowerCase();

    let rows: ItemRow[];
    if (libId !== undefined) {
      // library scope — access check first, then everything stamped into it
      const lib = await getLibrary(libId);
      const site = lib ? await getSite(lib.site_id) : undefined;
      const role = site ? await siteRoleFor(user, site) : null;
      if (!lib || !site || !role) {
        return reply.code(404).send({ error: "not_found", message: "Library not found" });
      }
      rows = await dbq<ItemRow>(
        "SELECT * FROM items WHERE trashed = false AND media_for IS NULL AND library_id = $1 ORDER BY updated_at DESC",
        [libId],
      );
    } else if (siteId !== undefined) {
      const site = await getSite(siteId);
      const role = site ? await siteRoleFor(user, site) : null;
      if (!site || !role) {
        return reply.code(404).send({ error: "not_found", message: "Site not found" });
      }
      rows = await dbq<ItemRow>(
        `SELECT * FROM items WHERE trashed = false AND media_for IS NULL
         AND library_id IN (SELECT id FROM libraries WHERE site_id = $1)
         ORDER BY updated_at DESC`,
        [siteId],
      );
    } else {
      // global: everything owned, shared, or in a library the user can see
      const libIds = await visibleLibraryIds(user);
      rows = await dbq<ItemRow>(
        `SELECT DISTINCT i.* FROM items i
         LEFT JOIN shares s ON s.file_id = i.id AND s.user_id = $1
         WHERE i.trashed = false AND i.media_for IS NULL
           AND (i.owner_id = $1 OR s.user_id IS NOT NULL OR i.library_id = ANY($2))
         ORDER BY i.updated_at DESC`,
        [user.id, libIds],
      );
    }

    type ResultItem = Awaited<ReturnType<typeof toDriveItem>> & { match: "name" | "content"; snippet?: string };
    const items: ResultItem[] = [];
    const contentQueue: { row: ItemRow; perm: Awaited<ReturnType<typeof permissionFor>> }[] = [];

    for (const r of rows) {
      const perm = await permissionFor(user.id, r);
      if (!perm) continue; // scoped listings can include items the user can't open
      // viewer-level readers never see draft-only files (SharePoint rule)
      if (!hasPermission(perm, "editor") && !(await hasPublished(r.id))) continue;
      const name = (await toDriveItem(r)).name; // decrypted
      if (terms.every((t) => name.toLowerCase().includes(t))) {
        items.push({ ...(await toDriveItem(r, perm ?? undefined)), match: "name" });
        if (items.length >= 15) break;
      } else {
        contentQueue.push({ row: r, perm });
      }
    }

    const seen = new Set(items.map((i) => i.id));
    for (const { row: r, perm } of contentQueue) {
      if (items.length >= 30) break;
      if (seen.has(r.id)) continue;
      // the index holds the latest (possibly draft) body — viewers only get
      // content matches on items whose head is published
      if (!hasPermission(perm, "editor")) {
        const head = await one<{ published: boolean }>(
          "SELECT published FROM versions WHERE file_id = $1 ORDER BY number DESC LIMIT 1", [r.id]);
        if (!head?.published) continue;
      }
      const body = await indexBody(r.id);
      if (!body) continue;
      const lower = body.toLowerCase();
      if (!terms.every((t) => lower.includes(t))) continue;
      const pos = Math.max(0, lower.indexOf(needle) !== -1 ? lower.indexOf(needle) : lower.indexOf(terms[0]));
      seen.add(r.id);
      items.push({
        ...(await toDriveItem(r, perm ?? undefined)),
        match: "content",
        snippet: snippet(body, terms, pos),
      });
    }
    return { items };
  });
}
