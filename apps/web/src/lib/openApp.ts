import { isDesktop, isNativeMobile } from "./platform";

/** Web opens each app in its own tab; the desktop and mobile shells have no
 *  tabs, so they navigate in place. */
export const appInNewTab = !(isDesktop || isNativeMobile);

export function openAppPath(to: string, navigate: (to: string) => void) {
  // Mail's /mail page would open its own tab; open the SSO handoff directly so a
  // click produces one tab, not a launcher tab plus the real one
  if (appInNewTab) window.open(to === "/mail" ? "/api/mail/sso" : to, "_blank", "noopener");
  else navigate(to);
}
