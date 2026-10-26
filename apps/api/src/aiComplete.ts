// Minimal non-streaming completion for server-side AI features that don't
// fit the chat-ops contract in routes/ai.ts (site copilot, metadata
// auto-tagging, digests). Same env config + fallback provider, same
// ai_usage metering and checkAiQuota gating as the main AI routes.
import { randomUUID } from "node:crypto";
import { q } from "./db.js";
import { checkAiQuota, modelFor, costMicros, noteAiSpend, type AiCheck } from "./aiQuota.js";

const AI_BASE = (process.env.KREATIX_AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const AI_KEY = process.env.KREATIX_AI_KEY ?? "";
const FB_KEY = process.env.KREATIX_AI_FALLBACK_KEY ?? "";
const FB_BASE = (process.env.KREATIX_AI_FALLBACK_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const FB_MODEL = process.env.KREATIX_AI_FALLBACK_MODEL ?? "";

export interface Completion {
  text: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}

export const aiEnabled = () => !!AI_KEY;

/** Quota gate — same contract as the chat endpoints. */
export async function gateAi(orgId: string, userId: string): Promise<AiCheck> {
  if (!AI_KEY) {
    return { allowed: false, http: 503, error: "ai_disabled",
      message: "AI is not configured on this server",
      quota: { plan: "free", tier: "free", orgTokensUsed: 0, orgTokensLimit: 0,
        userTodayUsed: 0, userTodayLimit: 0, resetsAt: "" } };
  }
  return checkAiQuota(orgId, userId);
}

/** One JSON-mode completion against the primary provider, with a same-
 *  provider retry on 429/5xx then the optional fallback provider. Usage is
 *  metered into ai_usage (mode='site') so budgets stay honest. */
export async function aiComplete(opts: {
  orgId: string; userId: string; fileId?: string | null;
  system: string; user: string; tier?: Parameters<typeof modelFor>[1];
}): Promise<Completion | { error: string; status: number }> {
  const model = modelFor("site", opts.tier);
  const attempt = (key: string, base: string, m: string) =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: m,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        temperature: 0.3,
        max_tokens: 2000,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(60000),
    });
  let res = await attempt(AI_KEY, AI_BASE, model);
  if (res.status === 429 || res.status >= 500) {
    await new Promise((r) => setTimeout(r, 600));
    res = await attempt(AI_KEY, AI_BASE, model);
  }
  let served = model;
  if ((res.status === 429 || res.status >= 500) && FB_KEY) {
    served = FB_MODEL || model;
    res = await attempt(FB_KEY, FB_BASE, served);
  }
  if (!res.ok) return { error: `AI provider returned ${res.status}`, status: 502 };
  const data = await res.json() as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const pt = data.usage?.prompt_tokens ?? Math.ceil((opts.system.length + opts.user.length) / 4);
  const ct = data.usage?.completion_tokens ?? 0;
  await q(
    "INSERT INTO ai_usage (id, org_id, user_id, file_id, mode, model, prompt_tokens, completion_tokens, cost_micros, estimated, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [randomUUID(), opts.orgId, opts.userId, opts.fileId ?? null, "site", served, pt, ct,
      costMicros(pt, ct), !data.usage, new Date().toISOString()],
  );
  noteAiSpend();
  return { text: data.choices?.[0]?.message?.content ?? "", model: served, promptTokens: pt, completionTokens: ct };
}

/** First balanced {...} JSON object in model output (same as ai.ts). */
export function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (!depth) {
      try { return JSON.parse(raw.slice(start, i + 1)) as Record<string, unknown>; }
      catch { return null; }
    } }
  }
  return null;
}
