// Desktop bridge — window.kxDesktop is injected by the Electron preload
// (apps/desktop/src/preload.ts). Absent in the browser build.
export interface KxDesktop {
  isDesktop: true;
  platform: string;
  apiBase: () => Promise<string>;
  readFile: (path: string) => Promise<{ ok: boolean; name?: string; data?: string; size?: number; error?: string }>;
  writeFile: (path: string, dataBase64: string) => Promise<{ ok: boolean; error?: string }>;
  openDialog: () => Promise<string | null>;
  saveDialog: (defaultName: string) => Promise<string | null>;
  showInFolder: (path: string) => Promise<void>;
  pendingFiles: () => Promise<string[]>;
  onOpenFile: (cb: (path: string) => void) => () => void;
  entitlement: {
    get: () => Promise<{ ok: boolean; token?: string }>;
    set: (token: string) => Promise<{ ok: boolean; error?: string }>;
    clear: () => Promise<{ ok: boolean }>;
  };
}

export const desktop: KxDesktop | undefined =
  typeof window !== "undefined" ? (window as unknown as { kxDesktop?: KxDesktop }).kxDesktop : undefined;

export const isDesktop = !!desktop?.isDesktop;

/** Capacitor WebView (Android/iOS shells) — no kxDesktop bridge, but the app is
 *  still served from a local origin so API traffic needs the absolute host. */
const capacitor = typeof window !== "undefined"
  ? (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  : undefined;
export const isNativeMobile = !!capacitor?.isNativePlatform?.();

/** Origin for API/WS traffic. The desktop bundle runs on the kx:// scheme and
 *  the Android shell on https://localhost, so both must call the production
 *  origin explicitly; the browser app is same-origin. */
export const API_BASE = (isDesktop || isNativeMobile) ? "https://suites.kreatixtech.com" : "";

/** Public-facing origin for links shared OUT of the app (share links, invites,
 *  media inside exported files). location.origin on web; the API origin on
 *  bundled shells where the local origin (kx://, https://localhost) is
 *  unreachable by anyone else. */
export const PUBLIC_ORIGIN = API_BASE || (typeof location !== "undefined" ? location.origin : "");

/**
 * Desktop/mobile only: rewrite <img src="/api/…"> (relative media URLs stored inside
 * document JSON) to the API origin with an auth token so they resolve from the
 * kx:// / capacitor shell. Document JSON stays portable — only the rendered DOM is patched.
 */
export function installDesktopMediaRewrite(): void {
  if (!isDesktop && !isNativeMobile) return;
  const fix = (el: Element) => {
    if (el instanceof HTMLImageElement && el.src.startsWith(`${location.origin}/api/`)) {
      const t = localStorage.getItem("kreatix.token") ?? "";
      el.src = `${API_BASE}${el.getAttribute("src")}${el.src.includes("?") ? "&" : "?"}t=${encodeURIComponent(t)}`;
    }
  };
  const scan = (root: ParentNode) => root.querySelectorAll("img").forEach(fix);
  scan(document);
  new MutationObserver((muts) => {
    for (const m of muts) m.addedNodes.forEach((n) => {
      if (n instanceof HTMLElement) { fix(n); scan(n); }
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
}
