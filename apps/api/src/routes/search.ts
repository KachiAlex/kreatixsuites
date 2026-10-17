import type { FastifyInstance } from "fastify";
import { q as dbq } from "../db.js";
import { toDriveItem, type ItemRow } from "../items.js";
import { requireAuth, permissionsFor, hasPermission, type AuthedRequest } from "../auth.js";
import { indexBody } from "../indexer.js";
import { getSite, getLibrary, siteRoleFor, libraryPermission, visibleLibraryIds } from "../sites.js";
import { decryptField } from "../crypto.js";
import { mailEnabled, mailFetch } from "../mailBridge.js";

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

    // candidate pool is bounded — an unbounded fetch + per-row decrypt turns
    // every keystroke into an org-scale table scan on large tenants
    const LIMIT = 600;
    let rows: ItemRow[];
    if (libId !== undefined) {
      // library scope — grant-aware access check, then everything stamped in
      const lib = await getLibrary(libId);
      const perm = lib ? await libraryPermission(user.id, lib.id) : null;
      if (!lib || !perm) {
        return reply.code(404).send({ error: "not_found", message: "Library not found" });
      }
      rows = await dbq<ItemRow>(
        "SELECT * FROM items WHERE trashed = false AND media_for IS NULL AND library_id = $1 ORDER BY updated_at DESC LIMIT $2",
        [libId, LIMIT],
      );
    } else if (siteId !== undefined) {
      const site = await getSite(siteId);
      const role = site ? await siteRoleFor(user, site) : null;
      if (!site || !role) {
        return reply.code(404).send({ error: "not_found", message: "Site not found" });
      }
      // site search trims libraries with broken inheritance the user can't
      // see — site owners/admins bypass via the $3 flag
      rows = await dbq<ItemRow>(
        `SELECT i.* FROM items i JOIN libraries l ON l.id = i.library_id
         WHERE i.trashed = false AND i.media_for IS NULL AND l.site_id = $1
           AND (l.inherit_permissions OR $3::boolean
                OR EXISTS (SELECT 1 FROM library_permissions lp
                           WHERE lp.library_id = l.id AND lp.user_id = $2)
                OR EXISTS (SELECT 1 FROM library_group_permissions lgp
                           JOIN group_members gm ON gm.group_id = lgp.group_id
                           WHERE lgp.library_id = l.id AND gm.user_id = $2))
         ORDER BY i.updated_at DESC LIMIT $4`,
        [siteId, user.id, role === "owner", LIMIT],
      );
    } else {
      // global: everything owned, shared, or in a library the user can see
      const libIds = await visibleLibraryIds(user);
      rows = await dbq<ItemRow>(
        `SELECT DISTINCT i.* FROM items i
         LEFT JOIN shares s ON s.file_id = i.id AND s.user_id = $1
         WHERE i.trashed = false AND i.media_for IS NULL
           AND (i.owner_id = $1 OR s.user_id IS NOT NULL OR i.library_id = ANY($2))
         ORDER BY i.updated_at DESC LIMIT $3`,
        [user.id, libIds, LIMIT],
      );
    }

    type ResultItem = Awaited<ReturnType<typeof toDriveItem>> & { match: "name" | "content"; snippet?: string };
    type Ctx = { row: ItemRow; perm: NonNullable<Awaited<ReturnType<typeof permissionsFor>>[number]>; name: string };

    // bulk permission resolution — ~3 queries + one per distinct library/
    // parent instead of 4–7 sequential queries per candidate; name decryption
    // is pure CPU
    const perms = await permissionsFor(user.id, rows);
    const ctxs: Ctx[] = rows.flatMap((r, i) => {
      const perm = perms[i];
      return perm ? [{ row: r, perm, name: decryptField(r.name) ?? r.name }] : [];
    });
    const CONC = 20;

    // viewer-level readers never see draft-only files — one batch query for
    // "has any published version" instead of a lookup per candidate
    const readerIds = ctxs.filter((c) => !hasPermission(c.perm, "editor")).map((c) => c.row.id);
    const anyPublished = new Set(readerIds.length
      ? (await dbq<{ file_id: string }>(
        "SELECT DISTINCT file_id FROM versions WHERE file_id = ANY($1) AND published", [readerIds]))
        .map((r) => r.file_id)
      : []);
    const visible = ctxs.filter((c) => hasPermission(c.perm, "editor") || anyPublished.has(c.row.id));

    const items: ResultItem[] = [];
    const contentQueue: Ctx[] = [];
    for (const c of visible) {
      if (terms.every((t) => c.name.toLowerCase().includes(t))) {
        items.push({ ...(await toDriveItem(c.row, c.perm)), match: "name" });
        if (items.length >= 15) break;
      } else {
        contentQueue.push(c);
      }
    }

    // content matches for viewers additionally require a published HEAD
    // (the index stores the possibly-draft body) — batched like above
    const readerIds2 = contentQueue.filter((c) => !hasPermission(c.perm, "editor")).map((c) => c.row.id);
    const headPublished = new Set(readerIds2.length
      ? (await dbq<{ file_id: string; published: boolean }>(
        `SELECT DISTINCT ON (file_id) file_id, published FROM versions
         WHERE file_id = ANY($1) ORDER BY file_id, number DESC`, [readerIds2]))
        .filter((r) => r.published).map((r) => r.file_id)
      : []);

    const seen = new Set(items.map((i) => i.id));
    for (let i = 0; i < contentQueue.length && items.length < 30; i += CONC) {
      const part = await Promise.all(contentQueue.slice(i, i + CONC).map(async (c) => {
        if (seen.has(c.row.id)) return null;
        if (!hasPermission(c.perm, "editor") && !headPublished.has(c.row.id)) return null;
        const body = await indexBody(c.row.id);
        if (!body) return null;
        const lower = body.toLowerCase();
        if (!terms.every((t) => lower.includes(t))) return null;
        return { c, body, lower };
      }));
      for (const m of part) {
        if (!m || items.length >= 30 || seen.has(m.c.row.id)) continue;
        seen.add(m.c.row.id);
        const pos = Math.max(0, m.lower.indexOf(needle) !== -1 ? m.lower.indexOf(needle) : m.lower.indexOf(terms[0]));
        items.push({
          ...(await toDriveItem(m.c.row, m.c.perm)),
          match: "content",
          snippet: snippet(m.body, terms, pos),
        });
      }
    }
    return { items };
  });

  /**
   * Unified cross-app search — the suite-wide counterpart to /api/search
   * (which stays files-only for the Drive/palette callers). Groups:
   *   chats    — messages in channels + DMs the user can see
   *   events   — calendar events they created or attend
   *   meetings — Meet rooms (title/code match)
   *   people   — org members (for "chat with" jumps)
   *   mails    — proxied through the mail bridge when Mail is wired
   * Bodies/titles are field-encrypted so matching runs JS-side on bounded
   * recent sets — same model as the file index.
   */
  app.get("/api/search/all", async (req) => {
    const { user } = req as AuthedRequest;
    const { q: query } = req.query as { q?: string };
    const needle = query?.trim().toLowerCase();
    if (!needle) return { chats: [], events: [], meetings: [], people: [], mails: [], tasks: [], forms: [], notes: [] };
    const terms = needle.split(/\s+/);
    const hit = (text: string | null | undefined) =>
      !!text && terms.every((t) => text.toLowerCase().includes(t));

    // the group queries are independent — one round-trip window instead of
    // seven sequential ones. Chat cap dropped 1500→800 (each row costs a
    // field decrypt; 800 recent messages still covers real usage).
    const [chatRows, evRows, mtRows, pplRows, taskRows, formRows, pageRows] = await Promise.all([
      dbq<{
        id: string; channel_id: string; body: string; created_at: string;
        ch_name: string | null; ch_kind: string; author: string | null;
      }>(
        `SELECT m.id, m.channel_id, m.body, m.created_at, c.name AS ch_name, c.kind AS ch_kind,
                u.display_name AS author
         FROM chat_messages m
         JOIN chat_channels c ON c.id = m.channel_id
         JOIN users u ON u.id = m.user_id
         WHERE c.org_id = $1 AND (c.kind = 'channel'
           OR EXISTS (SELECT 1 FROM chat_members cm WHERE cm.channel_id = c.id AND cm.user_id = $2))
         ORDER BY m.created_at DESC LIMIT 800`,
        [user.orgId, user.id]),
      dbq<{
        id: string; title: string; description: string | null; location: string | null;
        starts_at: string; ends_at: string; meeting_id: string | null;
      }>(
        `SELECT e.* FROM calendar_events e
         WHERE e.org_id = $1 AND (e.created_by = $2
           OR EXISTS (SELECT 1 FROM calendar_attendees a WHERE a.event_id = e.id AND a.user_id = $2))
         ORDER BY e.starts_at DESC LIMIT 400`,
        [user.orgId, user.id]),
      dbq<{ id: string; code: string; title: string; status: string; scheduled_at: string | null }>(
        `SELECT id, code, title, status, scheduled_at FROM meetings
         WHERE org_id = $1 ORDER BY created_at DESC LIMIT 300`, [user.orgId]),
      dbq<{ id: string; display_name: string; email: string; initials: string }>(
        `SELECT id, display_name, email, initials FROM users
         WHERE org_id = $1 AND disabled = false AND id != $2
           AND (lower(display_name) LIKE $3 OR lower(email) LIKE $3)
         LIMIT 8`, [user.orgId, user.id, `%${needle}%`]),
      dbq<{ id: string; title: string; notes: string | null; status: string; due_at: string | null }>(
        `SELECT id, title, notes, status, due_at FROM tasks WHERE org_id = $1 ORDER BY updated_at DESC LIMIT 400`,
        [user.orgId]),
      dbq<{ id: string; title: string; description: string | null }>(
        "SELECT id, title, description FROM forms WHERE org_id = $1 ORDER BY updated_at DESC LIMIT 200",
        [user.orgId]),
      dbq<{ id: string; title: string; body: string | null }>(
        "SELECT id, title, body FROM wiki_pages WHERE org_id = $1 ORDER BY updated_at DESC LIMIT 400",
        [user.orgId]),
    ]);

    const chats = chatRows
      .filter((m) => hit(decryptField(m.body) ?? m.body))
      .slice(0, 10)
      .map((m) => {
        const text = decryptField(m.body) ?? m.body;
        const pos = Math.max(0, text.toLowerCase().indexOf(terms[0]));
        return { id: m.id, channelId: m.channel_id, channel: m.ch_name ?? "Chat",
          author: m.author, snippet: snippet(text, terms, pos), createdAt: m.created_at };
      });

    const events = evRows
      .filter((e) => hit(decryptField(e.title) ?? e.title) || hit(decryptField(e.description)) || hit(decryptField(e.location)))
      .slice(0, 10)
      .map((e) => ({ id: e.id, title: decryptField(e.title) ?? e.title,
        startsAt: e.starts_at, endsAt: e.ends_at, meetingId: e.meeting_id }));

    // meetings — title or join code
    const meetings = mtRows
      .filter((m) => hit(m.title) || hit(m.code))
      .slice(0, 10)
      .map((m) => ({ id: m.id, code: m.code, title: m.title, status: m.status, scheduledAt: m.scheduled_at }));

    // people — org members for "message" jumps
    const people = pplRows.map((p) => ({ id: p.id, displayName: p.display_name, email: p.email, initials: p.initials }));

    // tasks — org board; title/notes match
    const tasks = taskRows
      .filter((t) => hit(decryptField(t.title) ?? t.title) || hit(decryptField(t.notes)))
      .slice(0, 10)
      .map((t) => ({ id: t.id, title: decryptField(t.title) ?? t.title, status: t.status, dueAt: t.due_at }));

    // forms + wiki pages — title/description/body match
    const forms = formRows
      .filter((f) => hit(decryptField(f.title) ?? f.title) || hit(decryptField(f.description)))
      .slice(0, 8)
      .map((f) => ({ id: f.id, title: decryptField(f.title) ?? f.title }));
    const notes = pageRows
      .filter((p) => hit(decryptField(p.title) ?? p.title) || hit(decryptField(p.body)))
      .slice(0, 8)
      .map((p) => {
        const body = decryptField(p.body) ?? "";
        const pos = Math.max(0, body.toLowerCase().indexOf(terms[0]));
        return { id: p.id, title: decryptField(p.title) ?? p.title,
          snippet: body ? snippet(body, terms, pos) : undefined };
      });

    // mail — through the SSO bridge; skipped silently when unconfigured
    let mails: { id: number; subject: string; from: string; date: string | null }[] = [];
    if (mailEnabled()) {
      try {
        const res = await mailFetch(user, `/emails?search=${encodeURIComponent(needle)}&limit=10`);
        if (res.ok) {
          const j = await res.json() as { emails?: { id: number; subject?: string; from_address?: string; from_name?: string; created_at?: string }[] };
          mails = (j.emails ?? []).slice(0, 10).map((e) => ({
            id: e.id, subject: e.subject ?? "(no subject)",
            from: e.from_name || e.from_address || "", date: e.created_at ?? null }));
        }
      } catch { /* mail service unreachable — other groups still return */ }
    }

    return { chats, events, meetings, people, mails, tasks, forms, notes };
  });
}
