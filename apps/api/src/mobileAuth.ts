// One-time codes for mobile SSO/SAML return. The IdP dance finishes in the
// system browser; the callback redirects to kx://auth?code=<otp> which the
// Capacitor shell catches (appUrlOpen) and swaps here for the real JWT.
// Codes are single-use, 60s TTL — same posture as the kx_sso exchange cookie
// on the web path, except the code travels the deep link instead of a cookie
// (a custom scheme can't carry cookies).
import { randomBytes } from "node:crypto";

const codes = new Map<string, { token: string; exp: number }>();
const TTL = 60_000;

export function issueMobileCode(token: string): string {
  const code = randomBytes(24).toString("base64url");
  codes.set(code, { token, exp: Date.now() + TTL });
  for (const [k, v] of codes) if (v.exp < Date.now()) codes.delete(k);
  return code;
}

export function consumeMobileCode(code: string): string | null {
  const e = codes.get(code);
  codes.delete(code);
  return e && e.exp > Date.now() ? e.token : null;
}

/** Deep-link target back into the app. */
export const mobileAuthRedirect = (params: Record<string, string>): string =>
  `kx://auth?${new URLSearchParams(params).toString()}`;
