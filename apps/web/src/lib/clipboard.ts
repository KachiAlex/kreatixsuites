// Unified in-app clipboard — structured payloads persisted to localStorage so
// objects can be pasted across documents and browser sessions (KBS-SHARED-013).

export interface KxClipboard {
  kind: string;
  data: unknown;
  /** human summary for status messages */
  label?: string;
  at: number;
}

const KEY = "kreatix.clipboard";

export function writeKx(kind: string, data: unknown, label?: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ kind, data, label, at: Date.now() }));
  } catch { /* quota — clipboard is best-effort */ }
}

export function readKx<T = unknown>(kind: string): T | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as KxClipboard;
    return c.kind === kind ? (c.data as T) : null;
  } catch { return null; }
}
