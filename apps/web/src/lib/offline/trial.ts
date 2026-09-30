// Anonymous tier — 14 days of full local usage with no account, shared by
// every app shell (Electron desktop today; the same module works for a
// Capacitor/mobile shell later — it only needs IndexedDB + localStorage).
// Signing in unlocks the workspace's free 3-month plan (server-side
// trial_months), after which the normal subscription gate applies.
import { store } from "./store";

const ANON_FLAG = "kx.anon";
const INSTALL_AT = "kx.installAt";
export const ANON_TRIAL_DAYS = 14;

const hasToken = () => !!localStorage.getItem("kreatix.token");

/** Anonymous mode = flag set AND not signed in. Signing in ends it. */
export const isAnonymous = () => localStorage.getItem(ANON_FLAG) === "1" && !hasToken();

/**
 * Enter anonymous mode. The install timestamp is recorded once (localStorage
 * + IndexedDB backup) — deleting site data resets it, which is an accepted
 * client-side limitation (the server gate is the authoritative layer anyway).
 */
export async function startAnonymousSession(): Promise<void> {
  const persisted = await store.meta.get<number>("installAt").catch(() => undefined);
  const at = Number(localStorage.getItem(INSTALL_AT)) || persisted || Date.now();
  localStorage.setItem(ANON_FLAG, "1");
  localStorage.setItem(INSTALL_AT, String(at));
  await store.meta.set("installAt", at);
}

export function endAnonymousSession(): void {
  localStorage.removeItem(ANON_FLAG);
}

/** Days left in the anonymous tier; null when not anonymous. Negative = expired. */
export async function anonDaysLeft(): Promise<number | null> {
  if (!isAnonymous()) return null;
  let at = Number(localStorage.getItem(INSTALL_AT));
  if (!at) {
    // restore from the IDB backup (survives a localStorage clear)
    at = (await store.meta.get<number>("installAt")) ?? 0;
    if (at) localStorage.setItem(INSTALL_AT, String(at));
  }
  if (!at) return ANON_TRIAL_DAYS;
  return ANON_TRIAL_DAYS - Math.floor((Date.now() - at) / 86400000);
}

/** Pseudo-user for anonymous mode — local identity only, never sent upward. */
export const ANON_USER = {
  id: "local",
  orgId: "local",
  email: "",
  displayName: "You",
  initials: "YO",
  role: "owner",
  isSuper: false,
  createdAt: "",
} as const;
