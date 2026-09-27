// Kreatix AI — cross-suite assistant panel: Ask / Explain / Edit / Plan modes,
// tool-constrained ops with plan + diff preview before apply, provenance log.
// Streams replies over SSE; optional auto-apply (still undoable via Ctrl+Z).
import { useCallback, useEffect, useRef, useState } from "react";
import { api, getToken } from "../lib/api";
import { timeAgo } from "../lib/format";

export type AiMode = "ask" | "explain" | "edit" | "plan";
export type AiOp = Record<string, unknown> & { op: string };

interface ChatMsg { role: "user" | "assistant"; content: string }
interface Pending {
  actionId: string; plan?: string[]; ops: AiOp[];
}
interface ActionRow { id: string; mode: string; prompt: string; applied: boolean; ops: number; by: string; createdAt: string }

const AUTOAPPLY_KEY = "kreatix.ai.autoApply";

export function AiPanel({ fileId, kind, canEdit, serialize, selection, applyOps, onClose, toast }: {
  fileId: string;
  kind: string;
  canEdit: boolean;
  serialize: () => string | Promise<string>;
  selection: () => string;
  applyOps: (ops: AiOp[]) => void;
  onClose: () => void;
  toast: (m: string) => void;
}) {
  const [mode, setMode] = useState<AiMode>(canEdit ? "edit" : "ask");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [history, setHistory] = useState<ActionRow[] | null>(null);
  const [autoApply, setAutoApply] = useState(() => localStorage.getItem(AUTOAPPLY_KEY) === "1");
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    api.get<{ enabled: boolean }>("/api/ai/status").then((r) => setEnabled(r.enabled)).catch(() => setEnabled(false));
  }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, pending, busy, streaming]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const loadHistory = useCallback(() => {
    api.get<{ actions: ActionRow[] }>(`/api/files/${fileId}/ai/actions`)
      .then((r) => setHistory(r.actions)).catch(() => setHistory([]));
  }, [fileId]);

  const apply = async (p: Pending) => {
    try {
      applyOps(p.ops);
      await api.post("/api/ai/applied", { actionId: p.actionId });
      toast(`Applied ${p.ops.length} AI change${p.ops.length === 1 ? "" : "s"} — Ctrl+Z to undo`);
    } catch (e) {
      toast(`Apply failed: ${(e as Error).message.slice(0, 80)}`);
    }
  };

  /** POST to the SSE endpoint and read the event stream manually
   *  (EventSource can't POST). Emits raw token deltas, then the
   *  server-validated final payload. */
  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput(""); setBusy(true); setPending(null); setStreaming("");
    const next = [...msgs, { role: "user" as const, content: text }];
    setMsgs(next);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const context = await serialize();
      const res = await fetch("/api/ai/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ fileId, mode, messages: next.slice(-12), context, selection: selection() }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => null) as { message?: string } | null;
        throw new Error(err?.message ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "", raw = "";
      const result: { final: { actionId: string; reply: string; plan?: string[]; ops: AiOp[] } | null } = { final: null };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const evt = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const line = evt.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let j: { t?: string; done?: boolean; error?: string } & Record<string, unknown>;
          try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (j.error) throw new Error(String(j.error));
          if (j.t) { raw += j.t; setStreaming(raw); }
          if (j.done) result.final = j as unknown as NonNullable<typeof result.final>;
        }
      }
      if (result.final) {
        const final = result.final;
        setMsgs([...next, { role: "assistant", content: final.reply }]);
        if (final.ops.length || final.plan?.length) {
          const p = { actionId: final.actionId, plan: final.plan, ops: final.ops };
          if (autoApply && canEdit && final.ops.length) await apply(p);
          else setPending(p);
        }
      } else {
        setMsgs([...next, { role: "assistant", content: "⚠ The AI stream ended without a response." }]);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setMsgs([...next, { role: "assistant", content: `⚠ ${(e as Error).message}` }]);
      }
    } finally {
      setBusy(false); setStreaming("");
    }
  };

  const MODES: { id: AiMode; label: string; hint: string }[] = [
    { id: "ask", label: "Ask", hint: "Questions about this document" },
    { id: "explain", label: "Explain", hint: "Explain the doc or selection" },
    { id: "edit", label: "Edit", hint: "Direct doc edits via previewed ops" },
    { id: "plan", label: "Plan", hint: "Step-by-step plan + edits on approval" },
  ];

  return (
    <div className="side-panel ai-side">
      <div className="sp-head">
        <h3>✨ Kreatix AI</h3>
        <button className="sp-close" onClick={onClose}>✕</button>
      </div>
      <div className="ai-modes">
        {MODES.map((m) => (
          <button key={m.id} className={`ai-mode ${mode === m.id ? "on" : ""}`} title={m.hint}
            disabled={!canEdit && (m.id === "edit" || m.id === "plan")}
            onClick={() => setMode(m.id)}>{m.label}</button>
        ))}
        <button className={`ai-mode ${history !== null ? "on" : ""}`} title="AI action log" onClick={() => history === null ? loadHistory() : setHistory(null)}>🕘</button>
      </div>

      {enabled === false && (
        <div className="ai-setup">
          AI is not configured on this server. Set <code>KREATIX_AI_KEY</code>
          (and optionally <code>KREATIX_AI_BASE_URL</code> / <code>KREATIX_AI_MODEL</code>)
          to enable the assistant.
        </div>
      )}

      {history !== null ? (
        <div className="sp-body">
          {history.length === 0 && <div className="empty">No AI actions yet.</div>}
          {history.map((a) => (
            <div key={a.id} className="ai-action">
              <div className="c-head"><b>{a.by}</b><span className="ai-badge">{a.mode}</span><span>{timeAgo(a.createdAt)}</span></div>
              <div className="ai-prompt">{a.prompt.slice(0, 90)}</div>
              {a.ops > 0 && <div className="ai-ops-count">{a.ops} op{a.ops === 1 ? "" : "s"} {a.applied ? "· applied" : "· not applied"}</div>}
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="sp-body ai-chat">
            {msgs.map((m, i) => (
              <div key={i} className={`ai-msg ${m.role}`}><div className="ai-bubble">{m.content}</div></div>
            ))}
            {busy && (
              <div className="ai-msg assistant">
                <div className={`ai-bubble ${streaming ? "" : "ai-thinking"}`}>
                  {streaming ? scrubRaw(streaming) : "Thinking…"}
                </div>
              </div>
            )}

            {pending && (
              <div className="ai-pending">
                {pending.plan && (
                  <ol className="ai-plan">
                    {pending.plan.map((s, i) => <li key={i}>{s}</li>)}
                  </ol>
                )}
                {pending.ops.map((o, i) => (
                  <div key={i} className="ai-op">{describeOp(o)}</div>
                ))}
                {pending.ops.length > 0 && (
                  <button className="btn-primary btn-sm" onClick={() => { const p = pending; setPending(null); void apply(p); }} disabled={!canEdit}>
                    Apply {pending.ops.length} change{pending.ops.length === 1 ? "" : "s"}
                  </button>
                )}
              </div>
            )}
            {!msgs.length && !busy && (
              <div className="empty">Ask about this {kindLabel(kind)}, or use Edit/Plan to have AI make changes with a preview first.</div>
            )}
            <div ref={bottomRef} />
          </div>
          {canEdit && (mode === "edit" || mode === "plan") && (
            <label className="ai-autoapply" title="Apply AI ops as soon as they arrive — still undoable with Ctrl+Z">
              <input type="checkbox" checked={autoApply}
                onChange={(e) => { setAutoApply(e.target.checked); localStorage.setItem(AUTOAPPLY_KEY, e.target.checked ? "1" : "0"); }} />
              Auto-apply (undoable)
            </label>
          )}
          <div className="ai-input">
            <input value={input} disabled={busy || enabled === false}
              placeholder={mode === "ask" ? "Ask about this document…" : mode === "explain" ? "What should I explain?" : "Describe the change…"}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()} />
            <button className="btn-primary" onClick={send} disabled={busy || !input.trim()}>↗</button>
          </div>
        </>
      )}
    </div>
  );
}

const kindLabel = (k: string) => ({ writer: "document", sheets: "spreadsheet", present: "presentation", pdf: "PDF" } as Record<string, string>)[k] ?? "file";

/** While JSON streams in, show a rough preview — strip braces/quotes/keys so
 *  the user sees generated text rather than raw JSON syntax. */
function scrubRaw(s: string): string {
  const m = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)"?/s.exec(s);
  if (m) {
    try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
  }
  return s.replace(/[{}\[\]"]/g, "").slice(-300);
}

/** Human-readable op description for the apply preview. */
export function describeOp(o: AiOp): string {
  const q = (s: unknown) => (typeof s === "string" && s.length > 40 ? s.slice(0, 37) + "…" : String(s));
  switch (o.op) {
    case "find_replace": return `Replace "${q(o.find)}" → "${q(o.replace)}"${o.all ? " (all)" : ""}`;
    case "append_paragraph": return `Append paragraph: "${q(o.text)}"`;
    case "prepend_paragraph": return `Prepend paragraph: "${q(o.text)}"`;
    case "insert_heading": return `Insert H${o.level}: "${q(o.text)}"`;
    case "insert_table": return `Insert table ${o.rows}×${o.cols}`;
    case "set_cells": return `Set ${Object.keys((o.cells as object) ?? {}).length} cell(s) on ${o.sheet}`;
    case "set_format": return `Format ${(o.refs as unknown[])?.length ?? 0} cell(s) on ${o.sheet}`;
    case "add_sheet": return `Add sheet "${o.name}"`;
    case "update_slide": return `Update slide ${(o.slide as number) + 1}${o.notes ? " (notes)" : ""}${o.bg ? " (bg)" : ""}`;
    case "add_slide": return `Add slide${o.layout ? ` (${o.layout})` : ""}`;
    case "add_text": return `Add text box on slide ${(o.slide as number) + 1}`;
    case "add_shape": return `Add ${o.shape} on slide ${(o.slide as number) + 1}`;
    case "add_table": return `Add ${(o.rows as unknown[])?.length ?? 0}-row table on slide ${(o.slide as number) + 1}`;
    case "add_chart": return `Add ${o.type} chart on slide ${(o.slide as number) + 1}`;
    case "edit_object_text": return `Edit object ${(o.index as number) + 1} on slide ${(o.slide as number) + 1}`;
    case "delete_object": return `Delete object ${(o.index as number) + 1} on slide ${(o.slide as number) + 1}`;
    case "delete_slide": return `Delete slide ${(o.slide as number) + 1}`;
    case "add_annotation": return `Add ${o.type} on page ${o.page}`;
    case "delete_annotation": return `Delete annotation ${(o.index as number) + 1}`;
    case "set_form_value": return `Set form field "${q(o.name)}"`;
    default: return String(o.op);
  }
}
