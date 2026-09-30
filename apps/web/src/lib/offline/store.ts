// Desktop offline mirror — IndexedDB backing store.
// Stores: files (drive metadata), blobs (file contents), outbox (queued
// mutations to replay), meta (sync cursor, entitlement, source paths).

const DB = "kreatix-offline";
const V = 1;

export interface CachedFile {
  id: string;           // server id, or "local:<uuid>" for items created offline
  name: string;
  kind: string;
  mimeType?: string;
  parentId?: string | null;
  starred?: boolean;
  trashed?: boolean;
  updatedAt: string;
  ownerName?: string;
  permission?: string;
  sourcePath?: string;  // local disk path this file was opened from (write-back)
  synced?: boolean;     // false → never reached the server yet
}

export interface BlobEntry {
  fileId: string;
  data: string;         // JSON string (textual content) or base64 (binary)
  binary: boolean;
  mime?: string;
  updatedAt: number;
}

export interface OutboxOp {
  id?: number;          // autoincrement
  method: string;
  path: string;         // api path e.g. /api/files/x/content
  body?: unknown;       // JSON body
  blob?: string;        // base64 payload for binary puts/uploads
  contentType?: string;
  fileId?: string;      // convenience for UI badges
  localFileId?: string; // local: id to remap after upload
  name?: string;        // for uploads
  ts: number;
}

export function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, V);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("files")) d.createObjectStore("files", { keyPath: "id" });
      if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs", { keyPath: "fileId" });
      if (!d.objectStoreNames.contains("outbox")) d.createObjectStore("outbox", { keyPath: "id", autoIncrement: true });
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const tx = async <T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const d = await openStore();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  });
};

export const store = {
  files: {
    all: () => tx<CachedFile[]>("files", "readonly", (s) => s.getAll()),
    get: (id: string) => tx<CachedFile | undefined>("files", "readonly", (s) => s.get(id)),
    put: (f: CachedFile) => tx("files", "readwrite", (s) => s.put(f)),
    bulk: async (fs: CachedFile[]) => {
      const d = await openStore();
      await new Promise<void>((res, rej) => {
        const t = d.transaction("files", "readwrite");
        for (const f of fs) t.objectStore("files").put(f);
        t.oncomplete = () => res(); t.onerror = () => rej(t.error);
      });
    },
    del: (id: string) => tx("files", "readwrite", (s) => s.delete(id)),
  },
  blobs: {
    get: (id: string) => tx<BlobEntry | undefined>("blobs", "readonly", (s) => s.get(id)),
    put: (b: BlobEntry) => tx("blobs", "readwrite", (s) => s.put(b)),
    del: (id: string) => tx("blobs", "readwrite", (s) => s.delete(id)),
  },
  outbox: {
    all: () => tx<OutboxOp[]>("outbox", "readonly", (s) => s.getAll()),
    add: (op: OutboxOp) => tx("outbox", "readwrite", (s) => s.add(op)),
    del: (id: number) => tx("outbox", "readwrite", (s) => s.delete(id)),
    count: async () => (await tx<OutboxOp[]>("outbox", "readonly", (s) => s.getAll())).length,
  },
  meta: {
    get: <T>(k: string) => tx<T | undefined>("meta", "readonly", (s) => s.get(k) as IDBRequest<T | undefined>),
    set: (k: string, v: unknown) => tx("meta", "readwrite", (s) => s.put(v, k)),
    del: (k: string) => tx("meta", "readwrite", (s) => s.delete(k)),
  },
};

export const b64 = {
  to: (buf: ArrayBuffer | Uint8Array) => {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192));
    return btoa(s);
  },
  from: (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0)),
};
