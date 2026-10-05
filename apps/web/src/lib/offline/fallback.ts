// Offline API fallback — used by request() when fetch throws (desktop only).
// GETs serve the local mirror; mutations update the mirror and queue an
// outbox op for replay. Unknown paths rethrow the original network error.
import { isDesktop, isNativeMobile } from "../platform";
import { isAnonymous } from "./trial";
import { enqueue } from "./sync";
import { b64, store, type CachedFile } from "./store";

const fileIdOf = (path: string, re: RegExp) => re.exec(path)?.[1];

const localId = () => `local:${crypto.randomUUID()}`;

/**
 * Handle a failed network request offline. Returns a synthetic result matching
 * the endpoint's shape, or rethrows when the path isn't mirrorable.
 */
export async function offlineFallback<T>(path: string, init: RequestInit, cause: unknown): Promise<T> {
  if (!isDesktop && !isNativeMobile && !isAnonymous()) throw cause;
  const method = (init.method ?? "GET").toUpperCase();

  // ---------- reads ----------
  if (method === "GET") {
    if (/^\/api\/drive(\?|$)/.test(path)) {
      // mirror the server's view semantics — trashed items must not leak
      // into home/recent/folder lists
      const url = new URL(path, "http://x");
      const view = url.searchParams.get("view");
      const parent = url.searchParams.get("parent");
      const byNewest = (a: CachedFile, b: CachedFile) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      let items = await store.files.all();
      if (parent !== null) {
        const pid = parent === "" ? null : parent;
        items = items.filter((f) => !f.trashed && (f.parentId ?? null) === pid);
        items.sort((a, b) => (b.kind === "folder" ? 1 : 0) - (a.kind === "folder" ? 1 : 0) || byNewest(a, b));
      } else if (view === "trash") {
        items = items.filter((f) => !!f.trashed).sort(byNewest);
      } else if (view === "starred") {
        items = items.filter((f) => !f.trashed && f.starred).sort(byNewest);
      } else if (view === "mirror") {
        items = items.filter((f) => !f.trashed).sort(byNewest);
      } else {
        // home + recent — files only, newest first, same caps as the server
        items = items.filter((f) => !f.trashed && f.kind !== "folder").sort(byNewest)
          .slice(0, view === "home" ? 8 : 50);
      }
      return { items } as T;
    }
    const id = fileIdOf(path, /^\/api\/files\/([^/]+)\/content/);
    if (id) {
      const b = await store.blobs.get(id);
      if (!b) throw cause;
      if (b.binary) return new Blob([b64.from(b.data)], { type: b.mime }) as T;
      return { version: 0, content: JSON.parse(b.data), offline: true } as T;
    }
    const rawId = fileIdOf(path, /^\/api\/files\/([^/]+)\/(raw|pdf-bytes)/);
    if (rawId) {
      const b = await store.blobs.get(rawId);
      if (!b || !b.binary) throw cause;
      return new Blob([b64.from(b.data)], { type: b.mime ?? "application/octet-stream" }) as T;
    }
    if (path.startsWith("/api/auth/me")) {
      const user = await store.meta.get("me");
      if (!user) throw cause;
      return { user } as T;
    }
    if (path.startsWith("/api/billing/summary")) {
      const s = await store.meta.get("billingSummary");
      if (!s) throw cause;
      return s as T;
    }
    if (path.startsWith("/api/drive/")) {
      const f = await store.files.get(path.split("/")[3]);
      if (!f) throw cause;
      return { item: f } as T;
    }
    throw cause;
  }

  // ---------- writes → mirror + queue ----------
  if (method === "PUT" && path.match(/^\/api\/files\/[^/]+\/content/)) {
    const id = fileIdOf(path, /^\/api\/files\/([^/]+)\/content/)!;
    const body = JSON.parse(init.body as string) as { content: unknown };
    await store.blobs.put({ fileId: id, data: JSON.stringify(body.content), binary: false, updatedAt: Date.now() });
    await enqueue({ method, path, body, fileId: id });
    return {} as T;
  }
  if (method === "PUT" && path.match(/^\/api\/files\/[^/]+\/pdf-bytes/)) {
    const id = fileIdOf(path, /^\/api\/files\/([^/]+)\/pdf-bytes/)!;
    const buf = await (init.body as Blob).arrayBuffer();
    await store.blobs.put({ fileId: id, data: b64.to(buf), binary: true, mime: "application/pdf", updatedAt: Date.now() });
    await enqueue({ method, path, blob: b64.to(buf), contentType: "application/pdf", fileId: id });
    return {} as T;
  }
  if (method === "POST" && path.startsWith("/api/drive/upload")) {
    const url = new URL(path, "http://x");
    const name = url.searchParams.get("name") ?? "file";
    const kind = url.searchParams.get("kind") ?? "file";
    const buf = await (init.body as Blob).arrayBuffer();
    const id = localId();
    const item: CachedFile = {
      id, name, kind, mimeType: (init.body as Blob).type, synced: false,
      updatedAt: new Date().toISOString(), parentId: null,
    };
    await store.files.put(item);
    await store.blobs.put({ fileId: id, data: b64.to(buf), binary: true, mime: (init.body as Blob).type, updatedAt: Date.now() });
    await enqueue({ method, path, blob: b64.to(buf), contentType: (init.body as Blob).type, localFileId: id, name });
    return { item } as T;
  }
  if (method === "PATCH" && path.startsWith("/api/drive/")) {
    const id = path.split("/")[3];
    const f = await store.files.get(id);
    if (f) await store.files.put({ ...f, ...(init.body ? JSON.parse(init.body as string) : {}) });
    await enqueue({ method, path, body: JSON.parse(init.body as string), fileId: id });
    return {} as T;
  }
  if (method === "DELETE" && path.startsWith("/api/drive/")) {
    const id = path.split("/")[3];
    if (id.startsWith("local:")) {
      // never reached the server — drop it and every queued op for it
      await store.files.del(id);
      await store.blobs.del(id);
      for (const o of await store.outbox.all()) {
        if (o.fileId === id || o.localFileId === id) await store.outbox.del(o.id!);
      }
      return {} as T;
    }
    const f = await store.files.get(id);
    if (new URL(path, "http://x").searchParams.get("permanent") === "true") {
      // permanent delete — drop from the mirror entirely, not just trashed
      await store.files.del(id);
      await store.blobs.del(id);
    } else if (f) {
      await store.files.put({ ...f, trashed: true });
    }
    await enqueue({ method, path, fileId: id });
    return {} as T;
  }
  if (method === "POST" && /^\/api\/drive\/[^/]+\/restore/.test(path)) {
    const id = path.split("/")[3];
    const f = await store.files.get(id);
    if (f) {
      await store.files.put({ ...f, trashed: false });
      await enqueue({ method, path, fileId: id });
      return { item: { ...f, trashed: false } } as T;
    }
  }
  if (method === "POST" && path === "/api/drive") {
    const body = JSON.parse(init.body as string);
    const id = localId();
    const item = { id, name: body.name, kind: body.kind, synced: false, updatedAt: new Date().toISOString(), parentId: body.parentId ?? null } as CachedFile;
    await store.files.put(item);
    await enqueue({ method, path, body, localFileId: id, name: body.name });
    return { item } as T;
  }
  throw cause;
}
