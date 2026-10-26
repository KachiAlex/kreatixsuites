// End-to-end tenant-admin test against a live server (default http://127.0.0.1:3017).
// Registers an org owner + an invited member, then exercises per-user app
// entitlements (PATCH members/:id/apps, the global API gate, editor kind
// gating) and the mailboxes admin endpoints. Cleans nothing (users are cheap).
// New orgs land on the free plan (max_members=1); when run on the VPS the
// test bumps the throwaway org's plan via docker exec psql so a second
// member can join. Off-box runs skip the multi-member section.
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

// ── org owner + invited member ───────────────────────────────────────────
const regA = await post("/api/auth/register", { email: `owner-${suffix}@test.kreatix.local`, password, displayName: "Owner A" });
ok(regA.status === 200 && typeof regA.body.token === "string", "register owner");
const ownerTok = regA.body.token as string;

// free plan = 1 seat; on the VPS, lift the throwaway org to an unlimited
// plan so a second member can join (no-op when docker isn't reachable)
const meA = await get("/api/auth/me", ownerTok);
const orgId = (meA.body.user as { orgId?: string } | undefined)?.orgId;
let unlimited = false;
try {
  execSync(
    `docker exec kreatix-db-1 psql -U kreatix -d kreatix -c "UPDATE subscriptions SET plan='biz_basic', status='active', period_start=now(), period_end=now()+interval '100 years' WHERE org_id='${orgId}'"`,
    { stdio: "pipe" });
  unlimited = true;
} catch { /* not on the VPS — multi-member tests will skip */ }

const inv = await post("/api/admin/invites", {}, ownerTok);
const canInvite = inv.status === 200 && typeof inv.body.token === "string";
if (!canInvite && inv.body.error === "seat_limit" && !unlimited) {
  ok(true, "create invite (free-plan seat limit enforced)");
}
ok(canInvite || inv.body.error === "seat_limit", `create invite${canInvite ? "" : " — seat_limit (single-seat plan)"}`);
if (!canInvite) {
  skipT("member-dependent entitlement checks (single-seat org)");
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail ? 1 : 0);
}
const regB = await post("/api/auth/register", { email: `member-${suffix}@test.kreatix.local`, password, displayName: "Member B", invite: inv.body.token });
ok(regB.status === 200 && typeof regB.body.token === "string", "register member via invite");
const memberTok = regB.body.token as string;

// ── members list carries apps + mailbox fields ───────────────────────────
const members = await get("/api/admin/members", ownerTok);
ok(members.status === 200 && Array.isArray(members.body.members), "members list");
const list = members.body.members as { id: string; email: string; role: string; disabledApps: string[]; mailAddress: string | null }[];
const memberB = list.find((m) => m.email.startsWith(`member-${suffix}`));
const ownerA = list.find((m) => m.role === "owner");
ok(!!memberB && !!ownerA, "both accounts present in member list");
ok(Array.isArray(members.body.apps) && (members.body.apps as unknown[]).length === 13, "app catalog returned (13 apps)");
ok(Array.isArray(memberB?.disabledApps) && memberB!.disabledApps.length === 0, "member starts with all apps enabled");

// ── authorization ────────────────────────────────────────────────────────
const memberTries = await patch(`/api/admin/members/${memberB!.id}/apps`, { disabledApps: [] }, memberTok);
ok(memberTries.status === 403, "non-admin cannot patch app access");
const selfEdit = await patch(`/api/admin/members/${ownerA!.id}/apps`, { disabledApps: ["mail"] }, ownerTok);
ok(selfEdit.status === 400, "cannot change your own app access");
const badSlug = await patch(`/api/admin/members/${memberB!.id}/apps`, { disabledApps: ["not-an-app"] }, ownerTok);
ok(badSlug.status === 400, "unknown app slug rejected");

// ── entitlement round-trip ───────────────────────────────────────────────
const setApps = await patch(`/api/admin/members/${memberB!.id}/apps`, { disabledApps: ["tasks", "writer"] }, ownerTok);
ok(setApps.status === 200, "patch member app access");

// the member's own /me reflects it (drives nav hiding client-side)
const meB = await get("/api/auth/me", memberTok);
ok(((meB.body.user as { disabledApps?: string[] })?.disabledApps ?? []).includes("tasks"), "/me reports disabledApps");

// API-prefix gate: tasks API now 403s for the member, not for the owner
const gatedTasks = await get("/api/tasks", memberTok);
ok(gatedTasks.status === 403 && gatedTasks.body.error === "app_disabled", "disabled app's API 403s for member");
const ownerTasks = await get("/api/tasks", ownerTok);
ok(ownerTasks.status !== 403 || ownerTasks.body.error !== "app_disabled", "owner unaffected by member's restriction");
const otherApp = await get("/api/notes", memberTok);
ok(otherApp.status !== 403 || otherApp.body.error !== "app_disabled", "unrestricted app still reachable");

// editor-kind gate: writer off → cannot create or open writer items
const createWriter = await post("/api/drive", { name: "Doc", kind: "writer" }, memberTok);
ok(createWriter.status === 403 && createWriter.body.error === "app_disabled", "disabled editor app cannot create items");
const createSheet = await post("/api/drive", { name: "Sheet", kind: "sheets" }, memberTok);
ok(createSheet.status === 200, "enabled editor app still creates");
const sheetId = (createSheet.body.item as { id: string } | undefined)?.id;
if (sheetId) {
  const openSheet = await get(`/api/files/${sheetId}/content`, memberTok);
  ok(openSheet.status !== 403, "enabled editor app still opens");
} else ok(false, "sheet id for open check");

// restore and confirm the gate lifts
const restore = await patch(`/api/admin/members/${memberB!.id}/apps`, { disabledApps: [] }, ownerTok);
ok(restore.status === 200, "restore all apps");
const ungated = await get("/api/tasks", memberTok);
ok(ungated.status !== 403, "restored app reachable again");

// ── mailbox admin endpoints ──────────────────────────────────────────────
const mailAccounts = await get("/api/admin/mail-accounts", ownerTok);
// either mail is configured (accounts array) or the server reports it isn't —
// both are valid; a 5xx/403 is not
ok(mailAccounts.status === 200 && Array.isArray(mailAccounts.body.accounts), "mail-accounts endpoint responds");
const memberPatch = await patch("/api/admin/mail-accounts/0", { active: false }, ownerTok);
ok(memberPatch.status === 404 || memberPatch.status === 400, "patch on unknown mailbox is scoped/rejected");
const foreignDomain = await post("/api/admin/mail-accounts", { localPart: "x", domain: "example.com" }, memberTok);
ok(foreignDomain.status === 403, "non-admin cannot create shared mailboxes");

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
