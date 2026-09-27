// Org-scoped admin policies: sensitivity labels, DLP rules, retention.
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, db } from "./db.js";

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
}

const DEFAULTS: OrgPolicies = {
  blockPublicLinksForConfidential: false,
  blockRestrictedShareLinks: false,
  trashRetentionDays: 0,
};

export function getPolicies(orgId: string): OrgPolicies {
  const row = db.prepare("SELECT json FROM org_policies WHERE org_id = ?").get(orgId) as
    | { json: string }
    | undefined;
  try {
    return { ...DEFAULTS, ...(row ? (JSON.parse(row.json) as Partial<OrgPolicies>) : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setPolicies(orgId: string, patch: Partial<OrgPolicies>): OrgPolicies {
  const merged = { ...getPolicies(orgId), ...patch };
  db.prepare(
    `INSERT INTO org_policies (org_id, json, updated_at) VALUES (?,?,datetime('now'))
     ON CONFLICT(org_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
  ).run(orgId, JSON.stringify(merged));
  return merged;
}

/**
 * Permanently purge trashed items whose trash date exceeds the org's retention
 * window. Returns number of items purged. Called at boot and daily.
 */
export function sweepRetention(): number {
  const orgs = db.prepare("SELECT org_id, json FROM org_policies").all() as {
    org_id: string;
    json: string;
  }[];
  let purged = 0;
  for (const { org_id, json } of orgs) {
    const p = { ...DEFAULTS, ...JSON.parse(json) } as OrgPolicies;
    if (p.trashRetentionDays <= 0) continue;
    const cutoff = new Date(Date.now() - p.trashRetentionDays * 86400_000).toISOString();
    const doomed = db
      .prepare("SELECT id FROM items WHERE org_id = ? AND trashed = 1 AND updated_at < ?")
      .all(org_id, cutoff) as { id: string }[];
    for (const { id } of doomed) purgeItem(id);
    purged += doomed.length;
  }
  return purged;
}

/** Permanently delete an item: row (cascades), index, collab state, AI log, orphan blobs. */
export function purgeItem(itemId: string): void {
  const versions = db.prepare("SELECT blob_key FROM versions WHERE file_id = ?").all(itemId) as {
    blob_key: string;
  }[];
  db.prepare("DELETE FROM items WHERE id = ?").run(itemId); // cascades versions, shares, comments
  db.prepare("DELETE FROM search_index WHERE file_id = ?").run(itemId);
  db.prepare("DELETE FROM collab_states WHERE file_id = ?").run(itemId);
  db.prepare("DELETE FROM ai_actions WHERE file_id = ?").run(itemId);
  // orphan blobs are only removed if no remaining version references them
  for (const { blob_key } of versions) {
    const stillUsed = db.prepare("SELECT 1 FROM versions WHERE blob_key = ? LIMIT 1").get(blob_key);
    if (!stillUsed) {
      try {
        unlinkSync(join(DATA_DIR, "blobs", blob_key.slice(0, 2), blob_key));
      } catch {
        /* already gone */
      }
    }
  }
}
