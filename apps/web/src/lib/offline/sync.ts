// Desktop offline sync — pull Drive metadata + blobs into the local mirror,
// drain the outbox FIFO when connectivity returns. Conflicts: server wins,
// the local copy is preserved as "name (conflict copy)".
import { api, getToken } from "../api";
import { API_BASE, isDesktop, isNativeMobile } from "../platform";
import { isAnonymous } from "./trial";
import { refreshEntitlement } from "./license";
import { b64, store, type CachedFile, type OutboxOp } from "./store";

let running = false;
let listeners: ((s: { online: boolean; pending: number }) => void)[] = [];
export const onSyncState = (cb: (s: { online: boolean; pending: number }) => void) => {
  listeners.push(cb);
  return () => { listeners = listeners.filter((l) => l !== cb); };
};
const emit = async () => {
  const s = { online: navigator.onLine, pending: await store.outbox.count() };
  listeners.forEach((l) => l(s));
};

/** local: → server id remap discovered while draining upload ops. */
const idMap = async (): Promise<Record<string, string>> =>
  (await store.meta.get<Record<string, string>>("idMap")) ?? {};
const setIdMap = async (local: string, real: string) => {
  const m = await idMap(); m[local] = real; await store.meta.set("idMap", m);
  const f = await store.files.get(local);
  if (f) { await store.files.del(local); await store.files.put({ ...f, id: real, synced: true }); }
  const b = await store.blobs.get(local);
  if (b) { await store.blobs.del(local); await store.blobs.put({ ...b, fileId: real }); }
};

const remapPath = async (path: string): Promise<string> => {
  const m = await idMap();
  let p = path;
  for (const [local, real] of Object.entries(m)) p = p.replaceAll(local, real);
  return p;
};

/** One queued op → real API call via raw fetch (request() would re-enqueue on
 *  network failure → infinite loop). Throws on network failure → stop draining. */
const runOp = async (op: OutboxOp): Promise<void> => {
  const path = await remapPath(op.path);
  const isBinary = op.blob !== undefined;
  const body = isBinary
    ? new Blob([b64.from(op.blob!)], { type: op.contentType ?? "application/octet-stream" })
    : op.body !== undefined ? JSON.stringify(op.body) : undefined;
  const res = await fetch(`${API_BASE}${path}`, {
    method: op.method,
    headers: {
      authorization: `Bearer ${getToken() ?? ""}`,
      ...(body ? { "content-type": isBinary ? (body as Blob).type : "application/json" } : {}),
    },
    body: body as BodyInit | undefined,
  });
  if (res.ok && op.localFileId && (path.includes("/api/drive/upload") || path === "/api/drive")) {
    const r = await res.json() as { item: { id: string } };
    await setIdMap(op.localFileId, r.item.id);
    return;
  }
  if (!res.ok) {
    // conflict on a content write → keep local as a conflict copy instead of losing work
    if ((res.status === 409 || res.status === 412) && op.fileId) {
      const f = await store.files.get(op.fileId);
      if (f) await store.files.put({ ...f, id: `conflict:${op.fileId}:${Date.now()}`, name: `${f.name} (conflict copy)` });
      const b = await store.blobs.get(op.fileId);
      if (b) await store.blobs.put({ ...b, fileId: `conflict:${op.fileId}:${Date.now()}` });
      return; // consume the op — the conflict copy preserves local state
    }
    // 4xx = server rejected (locked workspace, gone item) — consume, don't retry
    if (res.status >= 400 && res.status < 500) return;
    throw new Error(`sync op failed: ${res.status}`);
  }
};

/** Push queued ops then refresh the mirror. Safe to call repeatedly. */
export async function syncNow(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // ---- push (needs a token — anonymous outbox ops wait for sign-in;
    // draining untokened would eat every op as a 401 and lose the work) ----
    if (getToken()) {
      for (const op of await store.outbox.all()) {
        await runOp(op); // throws on network failure → abort, retry later
        if (op.id != null) await store.outbox.del(op.id);
        await emit();
      }
    }
    // ---- pull ----
    const { items } = await api.get<{ items: CachedFile[] }>("/api/drive?view=mirror");
    const localOnly = (await store.files.all()).filter((f) => f.id.startsWith("local:") || f.id.startsWith("conflict:"));
    const map = await idMap();
    const serverIds = new Set(items.map((i) => i.id));
    // purge mirrored items deleted elsewhere (trashed/purged on another
    // device) — upsert alone leaves them visible forever
    for (const f of await store.files.all()) {
      if (serverIds.has(f.id) || f.id.startsWith("local:") || f.id.startsWith("conflict:")) continue;
      await store.files.del(f.id);
      await store.blobs.del(f.id);
    }
    await store.files.bulk([
      ...items.map((i) => ({ ...i, synced: true })),
      ...localOnly.filter((f) => !map[f.id] || !serverIds.has(map[f.id])),
    ]);
    await store.meta.set("lastSync", Date.now());
    void refreshEntitlement();
  } finally {
    running = false;
    await emit();
  }
}

/** Record a mutation for replay. Callers also update the local mirror
 *  themselves so the UI reflects the write immediately. */
export async function enqueue(op: Omit<OutboxOp, "ts">): Promise<void> {
  await store.outbox.add({ ...op, ts: Date.now() });
  await emit();
}

/** Cache the file list + open-blob so offline opens hit the mirror. */
export async function cacheFileList(items: CachedFile[]): Promise<void> {
  await store.files.bulk(items.map((i) => ({ ...i, synced: true })));
}

export async function cacheBlob(fileId: string, data: string, binary: boolean, mime?: string): Promise<void> {
  await store.blobs.put({ fileId, data, binary, mime, updatedAt: Date.now() });
}

/** Background loop — sync on reconnect, window focus, and every 60s.
 *  Runs for the bundled shells (desktop/Android/iOS) and anonymous sessions;
 *  signed-in browser users call syncNow() once after login to replay any
 *  anonymous work. */
export function startSyncLoop(): () => void {
  if (!isDesktop && !isNativeMobile && !isAnonymous()) return () => {};
  const tick = () => { if (navigator.onLine) void syncNow().catch(() => {}); };
  const onOnline = () => tick();
  window.addEventListener("online", onOnline);
  window.addEventListener("focus", tick);
  const iv = setInterval(tick, 60_000);
  tick();
  return () => { window.removeEventListener("online", onOnline); window.removeEventListener("focus", tick); clearInterval(iv); };
}
