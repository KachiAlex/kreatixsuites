// Org-scoped admin policies: sensitivity labels, DLP rules, retention.
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, q, one, run } from "./db.js";
import { indexBody } from "./indexer.js";

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
  /** Kill switch — admins can disable Kreatix AI workspace-wide. */
  aiDisabled: boolean;
}

const DEFAULTS: OrgPolicies = {
  blockPublicLinksForConfidential: false,
  blockRestrictedShareLinks: false,
  trashRetentionDays: 0,
  dlpPatterns: [],
  aiDisabled: false,
};

/** Compile policy DLP regexes safely — bad patterns are skipped, not fatal. */
export function compileDlp(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns.slice(0, 10)) {
    try {
      out.push(new RegExp(p.slice(0, 300), "i"));
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
    for (const { id } of doomed) await purgeItem(id);
    purged += doomed.length;
  }
  return purged;
}

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
