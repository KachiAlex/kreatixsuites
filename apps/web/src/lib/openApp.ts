import { api } from "./api";
import { isDesktop, isNativeMobile } from "./platform";

/** Web opens each app in its own tab; the desktop and mobile shells have no
 *  tabs, so they navigate in place. */
export const appInNewTab = !(isDesktop || isNativeMobile);

/** Open Kreatix Mail in its own browser window. Web uses the cookie-backed SSO
 *  redirect; desktop/mobile fetch the handoff URL with their bearer token and
 *  open it in the system browser (the shell routes https links there). Returns
 *  false when the browser blocked the new window. */
export async function openMail(): Promise<boolean> {
  if (appInNewTab) return !!window.open("/api/mail/sso", "_blank", "noopener");
  const { url } = await api.get<{ url: string }>("/api/mail/sso-url");
  window.open(url, "_blank", "noopener");
  return true;
}

export function openAppPath(to: string, navigate: (to: string) => void) {
  // Mail goes through the SSO handoff directly, so a click produces one window,
  // not a launcher page plus the real one
  if (to === "/mail") void openMail();
  else if (appInNewTab) window.open(to, "_blank", "noopener");
  else navigate(to);
}
