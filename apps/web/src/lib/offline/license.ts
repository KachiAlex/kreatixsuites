// Offline subscription entitlement — verifies the server-signed JWT snapshot
// cached by the desktop shell (DPAPI-encrypted in userData). Within the 14-day
// validity window the desktop stays fully functional offline; after it, edits
// are read-only until the app reconnects and refreshes.
// The embedded key only unlocks the LOCAL edit surface — the server-side 402
// write gate remains authoritative for anything reaching Drive.
import { api } from "../api";
import { desktop, isDesktop } from "../platform";
import { store } from "./store";

// Build-time key — matches KREATIX_ENTITLEMENT_SECRET on the server.
const KEY = import.meta.env.VITE_KX_ENTITLEMENT_KEY ?? "kreatix-entitlement-dev-secret";

export interface Entitlement {
  org: string;
  status: string;      // trialing | active | grace | granted | locked
  seats: number;
  periodEnd: string | null;
  exp: number;         // seconds
  daysLeft: number;
}

const b64url = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/");
const decode = (seg: string) =>
  JSON.parse(new TextDecoder().decode(
    Uint8Array.from(atob(b64url(seg)), (c) => c.charCodeAt(0)))) as Record<string, unknown>;

async function verifyJwt(token: string): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(KEY),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sig = Uint8Array.from(atob(b64url(parts[2])), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify(
      "HMAC", key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const claims = decode(parts[1]);
    if (claims.aud !== "kreatix-desktop") return null;
    return claims;
  } catch { return null; }
}

/** Current entitlement — null when none is cached or the token is forged. */
export async function entitlement(): Promise<Entitlement | null> {
  if (!isDesktop) return null;
  const { ok, token } = await desktop!.entitlement.get();
  if (!ok || !token) return null;
  const c = await verifyJwt(token);
  if (!c) return null;
  const exp = Number(c.exp ?? 0);
  const daysLeft = Math.floor((exp * 1000 - Date.now()) / 86400000);
  return {
    org: String(c.org ?? ""), status: String(c.status ?? "trialing"),
    seats: Number(c.seats ?? 1), periodEnd: (c.periodEnd as string) ?? null,
    exp, daysLeft,
  };
}

/** Pull a fresh entitlement from the server (called on login + sync). */
export async function refreshEntitlement(): Promise<Entitlement | null> {
  if (!isDesktop) return null;
  try {
    const r = await api.get<{ token: string }>("/api/billing/entitlement");
    await desktop!.entitlement.set(r.token);
    await store.meta.set("entitlementAt", Date.now());
    return entitlement();
  } catch { return null; }
}

/** Whether local editing is permitted. Within grace → true; locked status or
 *  expired token → false (read-only). Browser is never gated by this. */
export async function canEditOffline(): Promise<boolean> {
  if (!isDesktop) return true;
  const e = await entitlement();
  if (!e) return true; // no token yet (never synced) — don't block a fresh install
  if (e.status === "locked") return false;
  return e.daysLeft >= 0;
}

export async function clearEntitlement(): Promise<void> {
  if (isDesktop) await desktop!.entitlement.clear();
}
