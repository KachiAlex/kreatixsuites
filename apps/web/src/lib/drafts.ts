// Crash recovery + offline save queue. Before each save attempt the doc's
// canonical JSON is written to IndexedDB; a successful PUT clears it. If the
// browser crashes or goes offline, the draft survives and Editor.tsx offers
// to restore it on next open. Pending drafts retry automatically on 'online'.
import { api } from "./api";

export interface Draft {
  fileId: string;
  content: string; // canonical JSON
  savedAt: number;
}

const DB = "kreatix-drafts";
const STORE = "drafts";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "fileId" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function saveDraft(fileId: string, content: unknown): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ fileId, content: JSON.stringify(content), savedAt: Date.now() } satisfies Draft);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getDraft(fileId: string): Promise<Draft | null> {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const r = d.transaction(STORE).objectStore(STORE).get(fileId);
      r.onsuccess = () => resolve((r.result as Draft) ?? null);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return null;
  }
}

export async function clearDraft(fileId: string): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((resolve) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(fileId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { /* best effort */ }
}

export async function listDrafts(): Promise<Draft[]> {
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const r = d.transaction(STORE).objectStore(STORE).getAll();
      r.onsuccess = () => resolve(r.result as Draft[]);
      r.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

const inflight = new Set<string>();

/**
 * Save canonical content: stage the draft first (crash-safe), then PUT.
 * On failure the draft stays and retried via retryPendingDrafts on reconnect.
 * Returns true when the server accepted the save.
 */
export async function saveContent(fileId: string, content: unknown, collab: boolean, label?: string): Promise<boolean> {
  await saveDraft(fileId, content);
  try {
    await api.put(`/api/files/${fileId}/content${collab ? "?collab=1" : ""}`, { content, ...(label ? { label } : {}) });
    await clearDraft(fileId);
    return true;
  } catch {
    return false;
  }
}

/** Retry any staged draft for this file (e.g. on reconnect). */
export async function retryDraft(fileId: string): Promise<boolean> {
  const d = await getDraft(fileId);
  if (!d || inflight.has(fileId)) return false;
  inflight.add(fileId);
  try {
    await api.put(`/api/files/${fileId}/content`, { content: JSON.parse(d.content) });
    await clearDraft(fileId);
    return true;
  } catch {
    return false;
  } finally {
    inflight.delete(fileId);
  }
}
