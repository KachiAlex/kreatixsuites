// End-to-end Sites test against a live server (default http://127.0.0.1:3017).
// Exercises the site-scoped recent rollup (?view=recent&site=<id>), inline
// metadata patching (PATCH /api/drive/:id/metadata), and saved-view
// groupBy/sortColumnId round-trip. Saved views need a paid plan — when run on
// the VPS the throwaway org is bumped via docker exec psql.
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";

const BASE = process.env.KX_BASE ?? "http://127.0.0.1:3017";
let pass = 0, fail = 0, skip = 0;
const ok = (cond: boolean, name: string) => { cond ? pass++ : fail++; console.log(`${cond ? "✓" : "✗ FAIL"} ${name}`); };
const skipT = (name: string) => { skip++; console.log(`- SKIP ${name}`); };

async function req(method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> };
}
const get = (p: string, t?: string) => req("GET", p, undefined, t);
const post = (p: string, b: unknown, t?: string) => req("POST", p, b, t);
const patch = (p: string, b: unknown, t?: string) => req("PATCH", p, b, t);

const suffix = randomBytes(4).toString("hex");
const password = "testpass-1234";

// ── two orgs: A owns a site; B is a stranger (tenant isolation) ─────────
const regA = await post("/api/auth/register", { email: `site-a-${suffix}@test.kreatix.local`, password, displayName: "A" });
ok(regA.status === 200 && typeof regA.body.token === "string", "register org A owner");
const tokA = regA.body.token as string;
const regB = await post("/api/auth/register", { email: `site-b-${suffix}@test.kreatix.local`, password, displayName: "B" });
const tokB = regB.body.token as string;

// bump plan so saved views (docmgmt entitlement) can be exercised on the VPS
const meA = await get("/api/auth/me", tokA);
const orgId = (meA.body.user as { orgId?: string } | undefined)?.orgId;
let paid = false;
try {
  execSync(
    `docker exec kreatix-db-1 psql -U kreatix -d kreatix -c "UPDATE subscriptions SET plan='biz_basic', status='active', period_start=now(), period_end=now()+interval '100 years' WHERE org_id='${orgId}'"`,
    { stdio: "pipe" });
  paid = true;
} catch { /* off-box — skip entitled checks */ }

// ── site + library + item ────────────────────────────────────────────────
const site = await post("/api/sites", { name: `Site ${suffix}`, type: "team" }, tokA);
ok(site.status === 200 && typeof (site.body.site as { id?: string })?.id === "string", "create site");
const siteId = (site.body.site as { id: string }).id;

const lib = await post(`/api/sites/${siteId}/libraries`, { name: "Docs", kind: "documents" }, tokA);
ok(lib.status === 200, "create library");
const libId = (lib.body.library as { id: string }).id;

const item = await post("/api/drive", { name: `spec-${suffix}`, kind: "writer", libraryId: libId }, tokA);
ok(item.status === 200, "create item in library");
const itemId = (item.body.item as { id: string }).id;

// ── site-scoped recent rollup ────────────────────────────────────────────
const recent = await get(`/api/drive?view=recent&site=${siteId}`, tokA);
ok(recent.status === 200 && (recent.body.items as { id: string }[]).some((i) => i.id === itemId),
  "site recent lists the library item");
const recentForeign = await get(`/api/drive?view=recent&site=${siteId}`, tokB);
ok(recentForeign.status === 404, "site recent hidden from other tenants");
const recentBogus = await get(`/api/drive?view=recent&site=nonexistent`, tokA);
ok(recentBogus.status === 404, "site recent 404s for unknown site");

// ── inline metadata patch (grid editing) ─────────────────────────────────
const col = await post(`/api/sites/${siteId}/libraries/${libId}/columns`, { name: "Status", type: "choice", choices: ["draft", "done"] }, tokA);
ok(col.status === 200, "create choice column");
const colId = (col.body.column as { id: string }).id;
const badMeta = await patch(`/api/drive/${itemId}/metadata`, { values: { [colId]: "bogus" } }, tokA);
ok(badMeta.status === 400, "invalid choice value rejected");
const meta = await patch(`/api/drive/${itemId}/metadata`, { values: { [colId]: "draft" } }, tokA);
ok(meta.status === 200, "patch metadata value");
const fetched = await get(`/api/drive/${itemId}`, tokA);
ok((fetched.body.item as { metadata?: Record<string, string> })?.metadata?.[colId] === "draft",
  "metadata value round-trips");
const metaForeign = await patch(`/api/drive/${itemId}/metadata`, { values: { [colId]: "done" } }, tokB);
ok(metaForeign.status === 403 || metaForeign.status === 404, "metadata patch denied cross-tenant");

// ── saved view with grid config (groupBy / sortColumnId) ─────────────────
if (paid) {
  const view = await post(`/api/sites/${siteId}/libraries/${libId}/views`,
    { name: "Grouped", config: { sort: "name", dir: "asc", sortColumnId: colId, groupBy: colId } }, tokA);
  ok(view.status === 200, "save grouped view");
  const cfg = (view.body.view as { config?: { groupBy?: string; sortColumnId?: string } })?.config;
  ok(cfg?.groupBy === colId && cfg?.sortColumnId === colId, "groupBy/sortColumnId survive round-trip");
} else skipT("saved-view round-trip (needs paid plan)");

// ── activity feed ────────────────────────────────────────────────────────
const activity = await get(`/api/sites/${siteId}/activity`, tokA);
ok(activity.status === 200 && Array.isArray(activity.body.events), "site activity feed");
const activityForeign = await get(`/api/sites/${siteId}/activity`, tokB);
ok(activityForeign.status === 404, "site activity hidden from other tenants");

// ── list libraries (rows CRUD + schema-driven values) ───────────────────
const llib = await post(`/api/sites/${siteId}/libraries`, { name: "Tracker", kind: "list" }, tokA);
ok(llib.status === 200, "create list library");
const llibId = (llib.body.library as { id: string }).id;
const lcol = await post(`/api/sites/${siteId}/libraries/${llibId}/columns`,
  { name: "Stage", type: "choice", choices: ["todo", "doing", "done"] }, tokA);
ok(lcol.status === 200, "list library column");
const lcolId = (lcol.body.column as { id: string }).id;
const row = await post(`/api/sites/${siteId}/libraries/${llibId}/rows`,
  { title: "First task", values: { [lcolId]: "todo" } }, tokA);
ok(row.status === 200, "create list row");
const rowId = (row.body.row as { id: string }).id;
const badRow = await post(`/api/sites/${siteId}/libraries/${llibId}/rows`,
  { title: "Bad", values: { [lcolId]: "nope" } }, tokA);
ok(badRow.status === 400, "invalid list choice value rejected");
const rowsList = await get(`/api/sites/${siteId}/libraries/${llibId}/rows`, tokA);
ok(rowsList.status === 200
  && (rowsList.body.rows as { id: string; data: Record<string, string> }[])
    .some((r) => r.id === rowId && r.data[lcolId] === "todo"), "list row round-trips values");
const rowPatch = await patch(`/api/sites/${siteId}/libraries/${llibId}/rows/${rowId}`,
  { values: { [lcolId]: "done" } }, tokA);
ok(rowPatch.status === 200, "patch list row");
const rowForeign = await patch(`/api/sites/${siteId}/libraries/${llibId}/rows/${rowId}`,
  { values: { [lcolId]: "doing" } }, tokB);
ok(rowForeign.status === 403 || rowForeign.status === 404, "list row patch denied cross-tenant");

// ── site pages (blocks + home flag) ──────────────────────────────────────
const pg = await post(`/api/sites/${siteId}/pages`,
  { title: "Home", blocks: [{ type: "heading", text: "Welcome" }, { type: "activity", limit: 5 }] }, tokA);
ok(pg.status === 200, "create site page");
const pageId = (pg.body.page as { id: string }).id;
const pgHome = await patch(`/api/sites/${siteId}/pages/${pageId}`, { isHome: true }, tokA);
ok(pgHome.status === 200 && (pgHome.body.page as { isHome?: boolean })?.isHome === true, "set page as home");
const pgList = await get(`/api/sites/${siteId}/pages`, tokA);
ok(pgList.status === 200 && (pgList.body.pages as { id: string }[]).some((p) => p.id === pageId),
  "pages list includes new page");
const pgForeign = await get(`/api/sites/${siteId}/pages`, tokB);
ok(pgForeign.status === 404, "pages hidden from other tenants");
const badBlock = await patch(`/api/sites/${siteId}/pages/${pageId}`,
  { blocks: [{ type: "library", libraryId: llibId }] }, tokA);
ok(badBlock.status === 400, "library block must reference a library in this site");

// ── site copilot + auto-tag (503 when AI isn't configured) ───────────────
const ask = await post(`/api/sites/${siteId}/ask`, { question: "What is in this site?" }, tokA);
ok(ask.status === 200 || ask.status === 503, "site copilot answers or reports ai_disabled");
if (ask.status === 200) {
  ok(typeof (ask.body as { answer?: string }).answer === "string", "copilot answer shape");
}
const sugg = await post(`/api/sites/${siteId}/libraries/${libId}/items/${itemId}/suggest-metadata`, {}, tokA);
ok(sugg.status === 200 || sugg.status === 503, "suggest-metadata runs or reports ai_disabled");

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
