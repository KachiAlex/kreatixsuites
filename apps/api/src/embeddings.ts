// Optional semantic embeddings for workspace Q&A — a `vector` column on
// search_index stores an embedding per file body, and /api/ai/ask blends
// cosine similarity with the lexical term score. Entirely opt-in: without
// KREATIX_AI_EMBED_MODEL + a provider that serves /embeddings (Groq doesn't),
// everything stays dormant and retrieval falls back to lexical ranking.
//
// Note: embeddings are stored as plaintext vectors — they can leak partial
// content even when KREATIX_DATA_KEY encrypts the body column. Enable only
// if that trade-off is acceptable.
import { q, run } from "./db.js";

const KEY = process.env.KREATIX_AI_EMBED_KEY || process.env.KREATIX_AI_KEY || "";
const BASE = (process.env.KREATIX_AI_EMBED_BASE_URL || process.env.KREATIX_AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const MODEL = process.env.KREATIX_AI_EMBED_MODEL || "";

let disabled = !KEY || !MODEL;
let warned = false;

export function embeddingsEnabled(): boolean {
  return !disabled;
}

const pgVector = (v: number[]) => `[${v.map((n) => Number(n.toFixed(6))).join(",")}]`;

/** Embed one text — returns null (and disables for the process lifetime on
 *  first provider failure so a bad config doesn't stall every ask). */
export async function embedText(text: string): Promise<number[] | null> {
  if (disabled) return null;
  try {
    const res = await fetch(`${BASE}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, input: text.slice(0, 8000) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`embed provider returned ${res.status}`);
    const data = await res.json() as { data?: { embedding?: number[] }[] };
    const v = data.data?.[0]?.embedding;
    if (!Array.isArray(v) || !v.length) throw new Error("empty embedding");
    return v;
  } catch (e) {
    disabled = true;
    if (!warned) {
      warned = true;
      console.warn(`[ai-embed] embeddings disabled: ${(e as Error).message.slice(0, 120)}`);
    }
    return null;
  }
}

/** Index-time embedding — best-effort, fire-and-forget from indexFile. */
export async function embedIndex(fileId: string, body: string): Promise<void> {
  const v = await embedText(body);
  if (!v) return;
  await run("UPDATE search_index SET embedding = $1::vector WHERE file_id = $2", [pgVector(v), fileId]).catch(() => {});
}

/** Semantic rank over a permission-filtered candidate set — returns
 *  file_id → rank points (12..1) or null when embeddings are off/unavailable. */
export async function semanticRank(question: string, fileIds: string[]): Promise<Map<string, number> | null> {
  if (disabled || !fileIds.length) return null;
  const vec = await embedText(question);
  if (!vec) return null;
  try {
    const rows = await q<{ file_id: string; d: number }>(
      `SELECT file_id, (embedding <=> $1::vector)::float8 AS d FROM search_index
       WHERE file_id = ANY($2::text[]) AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector LIMIT 12`,
      [pgVector(vec), fileIds],
    );
    if (!rows.length) return null;
    return new Map(rows.map((r, i) => [r.file_id, 12 - i]));
  } catch {
    return null; // vector column/extension absent — lexical fallback
  }
}
