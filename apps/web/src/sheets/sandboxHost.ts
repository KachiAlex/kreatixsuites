// Script sandbox host — runs inside the sandboxed iframe (opaque origin, so
// user code can neither reach the app's DOM/cookies/storage nor make
// authenticated requests). Receives {id, code, workbook, active} via
// postMessage, executes against a structured clone, and posts back only the
// mutated sheets/names — the parent applies them inside mutate() so undo,
// collab sync and autosave behave exactly like manual edits.
import { runScript } from "./script";

window.addEventListener("message", (ev) => {
  const d = ev.data as { id?: unknown; code?: unknown; workbook?: unknown; active?: unknown };
  if (!d || typeof d.id !== "string" || typeof d.workbook !== "object" || !d.workbook) return;
  const reply = (msg: Record<string, unknown>) =>
    (ev.source as Window | null)?.postMessage(msg, { targetOrigin: ev.origin === "null" ? "*" : ev.origin });
  try {
    const wb = structuredClone(d.workbook) as Parameters<typeof runScript>[0];
    const log = runScript(wb, String(d.code ?? ""), String(d.active ?? ""));
    reply({ id: d.id, ok: true, sheets: wb.sheets, names: wb.names ?? null, log });
  } catch (e) {
    reply({ id: d.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
