import { store } from "./offline/store";
import { listDrafts } from "./drafts";

const OWNER_KEY = "kx.localOwner";
const DBS = ["kreatix-drafts", "kreatix-offline"];
const CONTENT_KEYS = ["kreatix.clipboard", "kx.signature", "kreatix.customDict"];

const dropDb = (name: string) => new Promise<void>((resolve) => {
  const r = indexedDB.deleteDatabase(name);
  r.onsuccess = r.onerror = r.onblocked = () => resolve();
});

const clearContentKeys = () => {
  for (const k of Object.keys(localStorage)) {
    if (CONTENT_KEYS.includes(k) || k.startsWith("formedit.")) localStorage.removeItem(k);
  }
};

const unsyncedCount = async () => {
  const [drafts, queued] = await Promise.all([
    listDrafts().then((d) => d.length).catch(() => 0),
    store.outbox.count().catch(() => 0),
  ]);
  return drafts + queued;
};

export async function releaseLocalData() {
  clearContentKeys();
  if (await unsyncedCount()) return;
  await Promise.all(DBS.map(dropDb));
  localStorage.removeItem(OWNER_KEY);
}

export async function claimLocalData(userId: string) {
  if (localStorage.getItem(OWNER_KEY) === userId) return;
  clearContentKeys();
  await Promise.all(DBS.map(dropDb));
  localStorage.setItem(OWNER_KEY, userId);
}
