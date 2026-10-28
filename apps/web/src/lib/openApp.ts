import { isDesktop, isNativeMobile } from "./platform";

/** Web opens each app in its own tab; the desktop and mobile shells have no
 *  tabs, so they navigate in place. */
export const appInNewTab = !(isDesktop || isNativeMobile);

export function openAppPath(to: string, navigate: (to: string) => void) {
  if (appInNewTab) window.open(to, "_blank", "noopener");
  else navigate(to);
}
