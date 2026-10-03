import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "@kreatix/shared";
import { api, getToken, setToken } from "./api";
import { isDesktop } from "./platform";
import { clearEntitlement, refreshEntitlement } from "./offline/license";
import { ANON_USER, endAnonymousSession, isAnonymous, startAnonymousSession } from "./offline/trial";

interface AuthState {
  user: User | null;
  loading: boolean;
  /** Resolves null on success, or the short-lived mfaToken when the account
   *  requires a second factor — the caller then completes via completeMfaLogin. */
  login: (email: string, password: string) => Promise<string | null>;
  completeMfaLogin: (mfaToken: string, code: string) => Promise<void>;
  register: (email: string, password: string, displayName: string, orgName?: string, invite?: string) => Promise<void>;
  loginWithToken: (token: string) => Promise<void>;
  /** Re-fetch /api/auth/me — e.g. after changing security settings. */
  refreshUser: () => Promise<void>;
  enterAnonymous: () => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthState>(null as never);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(!!getToken() || isAnonymous());

  useEffect(() => {
    // anonymous tier: a local pseudo-user — everything runs off the mirror,
    // nothing authenticates until they sign in
    if (isAnonymous()) {
      setUser(ANON_USER as User);
      setLoading(false);
      return;
    }
    if (!getToken()) return;
    api.get<{ user: User }>("/api/auth/me")
      .then((r) => setUser(r.user))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  /** Anonymous → signed in: end anon mode, then replay every queued write so
   *  the user's local documents land in their new workspace's Drive. */
  const convertAnonymous = async (wasAnon: boolean) => {
    if (!wasAnon) return;
    endAnonymousSession();
    const { syncNow } = await import("./offline/sync");
    void syncNow().catch(() => {});
  };

  const login = async (email: string, password: string): Promise<string | null> => {
    // desktop sessions get a 30d token so the 14-day offline grace can't
    // strand a signed-in user mid-offline-period
    const wasAnon = localStorage.getItem("kx.anon") === "1";
    const r = await api.post<{ token?: string; user?: User; mfaRequired?: boolean; mfaToken?: string }>("/api/auth/login",
      { email, password, ...(isDesktop ? { client: "desktop" } : {}) });
    if (r.mfaRequired) return r.mfaToken ?? null;
    setToken(r.token!);
    setUser(r.user!);
    if (isDesktop) void refreshEntitlement();
    void convertAnonymous(wasAnon);
    return null;
  };

  const completeMfaLogin = async (mfaToken: string, code: string) => {
    const wasAnon = localStorage.getItem("kx.anon") === "1";
    const r = await api.post<{ token: string; user: User }>("/api/auth/mfa/login",
      { mfaToken, code, ...(isDesktop ? { client: "desktop" } : {}) });
    setToken(r.token);
    setUser(r.user);
    if (isDesktop) void refreshEntitlement();
    void convertAnonymous(wasAnon);
  };

  const register = async (email: string, password: string, displayName: string, orgName?: string, invite?: string) => {
    const wasAnon = localStorage.getItem("kx.anon") === "1";
    const r = await api.post<{ token: string; user: User }>("/api/auth/register", {
      email, password, displayName, orgName, invite,
    });
    setToken(r.token);
    setUser(r.user);
    if (isDesktop) void refreshEntitlement();
    void convertAnonymous(wasAnon);
  };

  /** SSO: server already issued a token — store it and resolve the user. */
  const loginWithToken = async (token: string) => {
    const wasAnon = localStorage.getItem("kx.anon") === "1";
    setToken(token);
    const r = await api.get<{ user: User }>("/api/auth/me");
    setUser(r.user);
    void convertAnonymous(wasAnon);
  };

  /** Anonymous tier — stamp the install clock and adopt the local pseudo-user
   *  in-place (no reload needed: Protected would bounce a null user). */
  const enterAnonymous = async () => {
    await startAnonymousSession();
    setUser(ANON_USER as User);
  };

  const refreshUser = async () => {
    const r = await api.get<{ user: User }>("/api/auth/me");
    setUser(r.user);
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    // clear the anonymous-tier flag too — otherwise the next load resurrects
    // the local pseudo-user and the user appears signed in again
    if (isAnonymous()) endAnonymousSession();
    if (isDesktop) void clearEntitlement();
  };

  return <Ctx.Provider value={{ user, loading, login, completeMfaLogin, register, loginWithToken, refreshUser, enterAnonymous, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
