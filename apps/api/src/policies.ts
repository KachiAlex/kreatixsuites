// Org-scoped admin policies: sensitivity labels, DLP rules, retention.
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR, q, one, run } from "./db.js";
import { indexBody } from "./indexer.js";
import { decryptField, encryptField } from "./crypto.js";
import { logActivity } from "./items.js";

export const LABELS = ["internal", "public", "confidential", "restricted"] as const;
export type Label = (typeof LABELS)[number];
export const isLabel = (v: unknown): v is Label => LABELS.includes(v as Label);

export interface OrgPolicies {
  /** Files labeled confidential|restricted cannot get public share links. */
  blockPublicLinksForConfidential: boolean;
  /** Files labeled restricted cannot be downloaded via share links at all. */
  blockRestrictedShareLinks: boolean;
  /** Days after which trashed items are permanently purged (0 = never). */
  trashRetentionDays: number;
  /** Regex patterns (one per entry) — share links are blocked when a file's
   *  name or indexed text matches any of them. */
  dlpPatterns: string[];
  /** What happens when a save matches a DLP pattern: flag (audit + item flag)
   *  or block (save rejected). */
  dlpOnSave: "off" | "flag" | "block";
  /** Downloads/exports of confidential+restricted files get a watermark
   *  footer stamped by the export pipeline. */
  watermarkConfidentialExports: boolean;
  /** CIDR ranges (e.g. "203.0.113.0/24") or literal IPs the org's members may
   *  sign in from. Empty = no restriction. */
  allowedIpRanges: string[];
  /** Device posture — sessions must come from the desktop app (the token's
   *  `client` claim). Web/mobile sessions are rejected when enabled. */
  requireDesktopClient: boolean;
  /** Kill switch — admins can disable Kreatix AI workspace-wide. */
  aiDisabled: boolean;
  /** SSO enforcement — when set, org members cannot log in with passwords;
   *  they must arrive via SAML/OIDC (owner + superadmin keep password access
   *  as the break-glass path for IdP outages). */
  ssoRequired: boolean;
  /** External-sharing control — no anonymous share links on ANY file in the
   *  org (the label-scoped rules above still apply when this is off). */
  blockPublicLinks: boolean;
  /** External-sharing control — non-empty list = files may only be shared
   *  with users whose email domain matches (exact or "x.example.com" suffix
   *  of an allowlisted "example.com"). Direct shares are checked at grant
   *  time; links are governed by blockPublicLinks. */
  shareDomainAllowlist: string[];
  /** Minimum password length for members' passwords (register-via-invite and
   *  password reset; 0 = platform default of 8). */
  passwordMinLength: number;
  /** SIEM export — every org audit/activity event is POSTed to this HTTPS
   *  endpoint as JSON (Splunk HEC, Sentinel ingestion, or any webhook).
   *  Empty = disabled. */
  siemWebhook: string;
  /** Maximum session lifetime in days — new tokens (web + desktop + SSO)
   *  are clamped to this TTL at issue time. 0 = platform defaults
   *  (7d web / 30d desktop). Conditional-access "sign-in frequency". */
  maxSessionDays: number;
  /** Force TOTP enrollment — members get a session that can only reach the
   *  MFA setup endpoints until they complete enrollment. */
  mfaRequired: boolean;
  /** Viewers cannot download raw bytes of confidential|restricted files —
   *  they may view native docs in-app but never pull the bytes. MAM-lite. */
  blockConfidentialDownloads: boolean;
  /** Passwords must contain lower+upper+digit (beyond passwordMinLength). */
  passwordComplexity: boolean;
}

const DEFAULTS: OrgPolicies = {
  blockPublicLinksForConfidential: false,
  blockRestrictedShareLinks: false,
  trashRetentionDays: 0,
  dlpPatterns: [],
  dlpOnSave: "off",
  watermarkConfidentialExports: false,
  allowedIpRanges: [],
  requireDesktopClient: false,
  aiDisabled: false,
  ssoRequired: false,
  blockPublicLinks: false,
  shareDomainAllowlist: [],
  passwordMinLength: 0,
  siemWebhook: "",
  maxSessionDays: 0,
  mfaRequired: false,
  blockConfidentialDownloads: false,
  passwordComplexity: false,
};

// ---- ReDoS guard ------------------------------------------------------------
// Admins write DLP patterns by hand; a hostile or careless pattern
// ((a+)+$, (\d|\w)+$ …) scanned over up-to-500KB of text can park the event
// loop. The guard below rejects the dangerous shapes statically — it's a
// heuristic, not a proof, but it catches realistic bombs while letting
// ordinary patterns ((jpg|png|pdf)$, \b\d{4}[- ]\d{4}\b, SSNs) through.

/** First-token descriptor of an alternation branch, for overlap checks. */
type FirstTok =
  | { k: "any" }
  | { k: "cls"; cls: string }
  | { k: "set"; chars: Set<string> }
  | { k: "lit"; ch: string };

const SHORTHAND = /\\[dwsDWS]/;

function clsCovers(cls: string, ch: string): boolean {
  switch (cls) {
    case "\\d": return /[0-9]/.test(ch);
    case "\\w": return /[\w]/.test(ch);
    case "\\s": return /\s/.test(ch);
    case "\\D": return !/[0-9]/.test(ch);
    case "\\W": return !/\w/.test(ch);
    case "\\S": return !/\s/.test(ch);
    default: return false;
  }
}

/** Expand a bracket class like [a-z0-9_-] into a capped char set. */
function expandSet(src: string): Set<string> | null {
  const inner = src.replace(/^\[\^?/, "").replace(/\]$/, "");
  const chars = new Set<string>();
  for (let i = 0; i < inner.length && chars.size < 300; i++) {
    const a = inner[i], dash = inner[i + 1], b = inner[i + 2];
    if (dash === "-" && b !== undefined && b !== "]") {
      if (a > b) return null;
      for (let c = a.charCodeAt(0); c <= b.charCodeAt(0) && chars.size < 300; c++)
        chars.add(String.fromCharCode(c));
      i += 2;
    } else {
      chars.add(a);
    }
  }
  return chars;
}

function firstTok(branch: string): FirstTok {
  const t = branch.replace(/^\^+/, "");
  if (!t) return { k: "lit", ch: "" };
  if (t[0] === ".") return { k: "any" };
  if (t[0] === "\\") {
    const cls = t.slice(0, 2);
    return SHORTHAND.test(cls) ? { k: "cls", cls } : { k: "lit", ch: t[1] ?? "" };
  }
  if (t[0] === "[") {
    const end = t.indexOf("]");
    const chars = expandSet(end > 0 ? t.slice(0, end + 1) : t);
    return chars ? { k: "set", chars } : { k: "any" };
  }
  if (t[0] === "(") return { k: "any" }; // nested group — conservative
  return { k: "lit", ch: t[0] };
}

function tokOverlap(a: FirstTok, b: FirstTok): boolean {
  if (a.k === "any" || b.k === "any") return true;
  if (a.k === "lit" && b.k === "lit") return a.ch === b.ch;
  if (a.k === "cls" && b.k === "cls") {
    // sample chars probing both classes — shorthand classes are closed under
    // these test points for all practical inputs
    const samples = "09azAZ_ \t\n\r-.,@:;";
    return [...samples].some((c) => clsCovers(a.cls, c) && clsCovers(b.cls, c));
  }
  if (a.k === "set" && b.k === "set") return [...a.chars].some((c) => b.chars.has(c));
  if (a.k === "cls" && b.k === "set") return [...b.chars].some((c) => clsCovers(a.cls, c));
  if (a.k === "set" && b.k === "cls") return [...a.chars].some((c) => clsCovers(b.cls, c));
  if (a.k === "cls" && b.k === "lit") return clsCovers(a.cls, b.ch);
  if (a.k === "lit" && b.k === "cls") return clsCovers(b.cls, a.ch);
  if (a.k === "set" && b.k === "lit") return a.chars.has(b.ch);
  if (a.k === "lit" && b.k === "set") return b.chars.has(a.ch);
  return true;
}

/** Heuristic ReDoS rejection. Unsafe shapes:
 *   (x+)+ / (x*)* style nested quantified groups
 *   (a|b)+ where the branches' leading char sets overlap
 *  Everything else passes — false negatives are possible but rare in admin
 *  hand-written rules; false positives only cost a "pattern rejected" error. */
export function isSafePattern(p: string): boolean {
  // quantified group whose body contains a quantifier or another quantified
  // group — the classic exponential blowup
  if (/\([^()]*[+*][^()]*\)\s*(?:[+*]|\{\d)/.test(p)) return false;
  if (/\([^()]*\([^()]*[+*][^()]*\)[^()]*\)\s*(?:[+*]|\{\d)/.test(p)) return false;
  // quantified alternation with overlapping branch starts, e.g. (\d|\w)+
  const alt = p.match(/\(([^()]*)\)\s*(?:[+*]|\{\d)/);
  if (alt && alt[1].includes("|")) {
    const toks = alt[1].split("|").map(firstTok);
    for (let i = 0; i < toks.length; i++)
      for (let j = i + 1; j < toks.length; j++)
        if (tokOverlap(toks[i], toks[j])) return false;
  }
  return true;
}

/** Compile policy DLP regexes safely — invalid or ReDoS-shaped patterns are
 *  skipped, never fatal. */
export function compileDlp(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns.slice(0, 10)) {
    try {
      const src = p.slice(0, 300);
      if (!isSafePattern(src)) continue;
      out.push(new RegExp(src, "i"));
    } catch { /* invalid regex — ignore */ }
  }
  return out;
}

/** True if the file's name or indexed text matches any DLP pattern. */
export async function dlpHit(fileId: string, fileName: string, orgId: string): Promise<boolean> {
  const patterns = compileDlp((await getPolicies(orgId)).dlpPatterns);
  if (!patterns.length) return false;
  const haystack = `${fileName}\n${await indexBody(fileId)}`;
  return patterns.some((re) => re.test(haystack));
}

/** Scan a name + body against the org's DLP patterns — save-time variant of
 *  dlpHit that takes the text directly (the index may lag the write). */
export function dlpScanText(name: string, body: string, policies: OrgPolicies): string | null {
  for (const re of compileDlp(policies.dlpPatterns)) {
    if (re.test(name) || re.test(body)) return re.source;
  }
  return null;
}

/* ── DLP engine ──────────────────────────────────────────── */

export interface DlpRule {
  id: string; org_id: string; name: string; pattern: string;
  severity: "low" | "medium" | "high"; action: "flag" | "block";
  applies_to: "files" | "chat" | "all"; enabled: boolean;
}

export async function dlpRules(orgId: string): Promise<DlpRule[]> {
  return q<DlpRule>(
    "SELECT id, org_id, name, pattern, severity, action, applies_to, enabled FROM dlp_rules WHERE org_id = $1",
    [orgId]);
}

/** 60 chars of context around the first match — enough for review without
 *  leaking the whole secret into the events table. */
function matchExcerpt(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  if (!m) return null;
  const s = Math.max(0, m.index - 30);
  const e = Math.min(text.length, m.index + m[0].length + 30);
  return (s > 0 ? "…" : "") + text.slice(s, e).replace(/\s+/g, " ") + (e < text.length ? "…" : "");
}

/** Pipeline scan: run the org's enabled DLP rules against a piece of content.
 *  Records one event per rule hit (encrypted excerpt), stamps items.dlp_flagged,
 *  and returns the name of the first blocking rule if the write must be
 *  rejected. ref: {type:'item'|'chat', id} — chat events never stamp items. */
export async function scanDlp(
  orgId: string, ref: { type: "item" | "chat" | "form"; id: string },
  name: string, text: string, actorId: string | null,
): Promise<{ blockedBy: string | null; hits: number }> {
  // applies_to "all" covers every ref kind; "files"/"chat" stay scoped so a
  // files-only rule doesn't silently start scanning form submissions
  const rules = (await dlpRules(orgId)).filter((r) =>
    r.enabled && (r.applies_to === "all" ||
      (r.applies_to === "chat" && ref.type === "chat") ||
      (r.applies_to === "files" && ref.type === "item")));
  if (!rules.length) return { blockedBy: null, hits: 0 };
  const haystack = `${name}\n${text.slice(0, 500_000)}`;
  let blockedBy: string | null = null;
  let hits = 0;
  for (const rule of rules) {
    let re: RegExp;
    try {
      const src = rule.pattern.slice(0, 300);
      if (!isSafePattern(src)) continue;
      re = new RegExp(src, "i");
    } catch { continue; }
    if (!re.test(haystack)) continue;
    hits++;
    const action = rule.action === "block" ? "blocked" : "flagged";
    if (rule.action === "block" && !blockedBy) blockedBy = rule.name;
    await run(
      `INSERT INTO dlp_events (id, org_id, rule_id, rule_name, ref_type, ref_id, excerpt, actor_id, action)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [randomUUID(), orgId, rule.id, rule.name,
       ref.type === "chat" ? "chat_message" : ref.type === "form" ? "form_response" : "item", ref.id,
       encryptField(matchExcerpt(haystack, re) ?? ""), actorId, action]);
  }
  if (hits && ref.type === "item" && !blockedBy) {
    await run("UPDATE items SET dlp_flagged = true WHERE id = $1", [ref.id]);
  }
  return { blockedBy, hits };
}

/** IPv4 CIDR/literal check. IPv6 + malformed entries never match (fail-closed
 *  is wrong here — an admin typo shouldn't lock everyone out, so only
 *  well-formed IPv4 entries are enforced). */
export function ipAllowed(ip: string, ranges: string[]): boolean {
  if (!ranges.length) return true;
  const norm = ip.replace(/^::ffff:/, "");
  const toNum = (s: string) => {
    const p = s.split(".");
    if (p.length !== 4 || p.some((x) => !/^\d+$/.test(x) || +x > 255)) return null;
    return p.reduce((n, x) => n * 256 + +x, 0);
  };
  const ipN = toNum(norm);
  if (ipN === null) return ranges.includes(ip); // non-v4 literal match only
  for (const r of ranges) {
    const [base, bits] = r.split("/");
    const baseN = toNum(base ?? "");
    if (baseN === null) continue;
    const mask = bits === undefined ? 0xffffffff : bits === "0" ? 0 : (0xffffffff << (32 - +bits)) >>> 0;
    if (((ipN & mask) >>> 0) === ((baseN & mask) >>> 0)) return true;
  }
  return false;
}

/** An item is held if its own flag is set OR it's attached to an active
 *  legal hold OR any ancestor folder is held OR its site is held OR its
 *  owner (or an ancestor's owner) is a custodian on an active hold. */
export async function isHeld(itemId: string): Promise<boolean> {
  const hit = await one(
    `WITH RECURSIVE anc AS (
       SELECT id, parent_id, library_id, owner_id, legal_hold FROM items WHERE id = $1
       UNION ALL SELECT i.id, i.parent_id, i.library_id, i.owner_id, i.legal_hold
         FROM items i JOIN anc a ON i.id = a.parent_id)
     SELECT 1 AS x FROM anc WHERE legal_hold
     UNION
     SELECT 1 FROM legal_hold_items lhi
       JOIN legal_holds lh ON lh.id = lhi.hold_id AND lh.active
       WHERE lhi.item_id = $1 OR lhi.item_id IN (SELECT id FROM anc)
     UNION
     SELECT 1 FROM sites s
       WHERE s.legal_hold AND EXISTS (
         SELECT 1 FROM anc a JOIN libraries l ON l.id = a.library_id
         WHERE l.site_id = s.id)
     UNION
     SELECT 1 FROM legal_hold_custodians lhc
       JOIN legal_holds lh ON lh.id = lhc.hold_id AND lh.active
       WHERE lhc.user_id IN (SELECT owner_id FROM anc)
     LIMIT 1`, [itemId]);
  return !!hit;
}

/** Combined password-policy check for credential-setting paths (invite
 *  joins, resets). Returns the 400 message or null when acceptable. */
export function passwordPolicyMessage(
  pol: Pick<OrgPolicies, "passwordMinLength" | "passwordComplexity">,
  password: string,
): string | null {
  if (pol.passwordMinLength > 0 && password.length < pol.passwordMinLength)
    return `Workspace policy requires passwords of at least ${pol.passwordMinLength} characters`;
  if (pol.passwordComplexity
      && !(/[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password)))
    return "Workspace policy requires passwords to include uppercase, lowercase and a number";
  return null;
}

export async function getPolicies(orgId: string): Promise<OrgPolicies> {
  const row = await one<{ json: string | Partial<OrgPolicies> }>(
    "SELECT json FROM org_policies WHERE org_id = $1",
    [orgId],
  );
  try {
    const parsed = typeof row?.json === "string" ? JSON.parse(row.json) : (row?.json ?? {});
    return { ...DEFAULTS, ...(parsed as Partial<OrgPolicies>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function setPolicies(orgId: string, patch: Partial<OrgPolicies>): Promise<OrgPolicies> {
  const merged = { ...(await getPolicies(orgId)), ...patch };
  await run(
    `INSERT INTO org_policies (org_id, json, updated_at) VALUES ($1,$2,now())
     ON CONFLICT(org_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    [orgId, JSON.stringify(merged)],
  );
  return merged;
}

// ---- SIEM export ------------------------------------------------------------
// Every org audit event is mirrored to the org's configured webhook (Splunk
// HEC, Sentinel ingestion, a SIEM bridge, …) as JSON. Fire-and-forget: the
// request path never waits on a customer's SIEM, and a failing endpoint warns
// once per org per process instead of spamming logs.
const siemWarned = new Set<string>();

export function pushSiemEvent(orgId: string, event: Record<string, unknown>) {
  void (async () => {
    const url = (await getPolicies(orgId)).siemWebhook;
    if (!url) return;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "kreatix-suite", orgId, at: new Date().toISOString(), ...event }),
        signal: AbortSignal.timeout(4000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      if (!siemWarned.has(orgId)) {
        siemWarned.add(orgId);
        console.warn(`[siem] webhook push failed for org ${orgId}: ${(e as Error).message}`);
      }
    }
  })();
}

/**
 * Permanently purge trashed items whose trash date exceeds the org's retention
 * window. Returns number of items purged. Called at boot and daily.
 */
export async function sweepRetention(): Promise<number> {
  const orgs = await q<{ org_id: string; json: string | Partial<OrgPolicies> }>(
    "SELECT org_id, json FROM org_policies",
  );
  let purged = 0;
  for (const { org_id, json } of orgs) {
    const parsed = typeof json === "string" ? JSON.parse(json) : json;
    const p = { ...DEFAULTS, ...parsed } as OrgPolicies;
    if (p.trashRetentionDays <= 0) continue;
    const cutoff = new Date(Date.now() - p.trashRetentionDays * 86400_000).toISOString();
    const doomed = await q<{ id: string }>(
      "SELECT id FROM items WHERE org_id = $1 AND trashed AND updated_at < $2",
      [org_id, cutoff],
    );
    for (const { id } of doomed) {
      if (await isHeld(id)) continue; // legal hold wins over retention
      await purgeItem(id);
      purged++;
    }
  }
  return purged;
}

/**
 * Per-library retention: libraries.retention_days > 0 auto-trashes items
 * untouched for that many days (SharePoint "Information management policy").
 * Stale items go to the site recycle bin — permanent purge stays with the
 * org-level trashRetentionDays sweep above. A trashed folder covers its
 * whole subtree (trash views already hide trashed ancestors).
 */
export async function sweepLibraryRetention(): Promise<number> {
  const libs = await q<{ id: string; retention_days: number }>(
    "SELECT id, retention_days FROM libraries WHERE retention_days IS NOT NULL AND retention_days > 0",
  );
  let trashed = 0;
  for (const lib of libs) {
    const cutoff = new Date(Date.now() - lib.retention_days * 86400_000).toISOString();
    // only items not already inside a trashed subtree — descendants of a
    // trashed folder are covered by it, no need to stamp each row
    const stale = await q<{ id: string; owner_id: string; org_id: string; name: string }>(
      `WITH RECURSIVE binned AS (
         SELECT id FROM items WHERE library_id = $1 AND trashed
         UNION ALL SELECT i.id FROM items i JOIN binned b ON i.parent_id = b.id)
       SELECT id, owner_id, org_id, name FROM items
       WHERE library_id = $1 AND NOT trashed AND updated_at < $2
         AND id NOT IN (SELECT id FROM binned)`,
      [lib.id, cutoff],
    );
    for (const item of stale) {
      if (await isHeld(item.id)) continue; // held items are exempt
      await run("UPDATE items SET trashed = true, updated_at = $1 WHERE id = $2", [new Date().toISOString(), item.id]);
      void logActivity(item.org_id, item.owner_id, item.id, "trash-retention", decryptField(item.name) ?? undefined);
      trashed++;
    }
  }
  return trashed;
}

// text/* only — JSON-family mimes would be corrupted by an appended stamp
const WATERMARKABLE = /^text\//i;

/** Stamp a confidentiality footer on downloadable text content when the org
 *  enables watermarking and the file is labeled confidential|restricted.
 *  Binary formats (pdf/docx/…) can't be stamped inline — callers add the
 *  X-Kreatix-Watermark header so clients can overlay it instead. */
export function watermarkIfNeeded(
  blob: Buffer, mime: string, label: string, policies: OrgPolicies, who: string,
): { blob: Buffer; watermarked: boolean } {
  const labeled = label === "confidential" || label === "restricted";
  if (!policies.watermarkConfidentialExports || !labeled) return { blob, watermarked: false };
  const stamp = `\n\n— ${label.toUpperCase()} — exported ${new Date().toISOString()} by ${who} — Kreatix Suites —\n`;
  if (WATERMARKABLE.test(mime)) {
    return { blob: Buffer.concat([blob, Buffer.from(stamp)]), watermarked: true };
  }
  return { blob, watermarked: true }; // header-only for binary
}

export const WATERMARK_HEADER = "X-Kreatix-Watermark";

/** Permanently delete an item: row (cascades), index, collab state, AI log, orphan blobs. */
export async function purgeItem(itemId: string): Promise<void> {
  const versions = await q<{ blob_key: string }>(
    "SELECT blob_key FROM versions WHERE file_id = $1",
    [itemId],
  );
  await run("DELETE FROM items WHERE id = $1", [itemId]); // cascades versions, shares, comments
  await run("DELETE FROM search_index WHERE file_id = $1", [itemId]);
  await run("DELETE FROM collab_states WHERE file_id = $1", [itemId]);
  await run("DELETE FROM ai_actions WHERE file_id = $1", [itemId]);
  // orphan blobs are only removed if no remaining version references them
  for (const { blob_key } of versions) {
    const stillUsed = await one("SELECT 1 FROM versions WHERE blob_key = $1 LIMIT 1", [blob_key]);
    if (!stillUsed) {
      try {
        unlinkSync(join(DATA_DIR, "blobs", blob_key.slice(0, 2), blob_key));
      } catch {
        /* already gone */
      }
    }
  }
}
