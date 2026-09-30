import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "@kreatix/shared";
import { api, getToken, setToken } from "./api";
import { isDesktop } from "./platform";
import { clearEntitlement, refreshEntitlement } from "./offline/license";
import { ANON_USER, endAnonymousSession, isAnonymous } from "./offline/trial";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string, orgName?: string, invite?: string) => Promise<void>;
  loginWithToken: (token: string) => Promise<void>;
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

  const login = async (email: string, password: string) => {
    // desktop sessions get a 30d token so the 14-day offline grace can't
    // strand a signed-in user mid-offline-period
    const wasAnon = localStorage.getItem("kx.anon") === "1";
    const r = await api.post<{ token: string; user: User }>("/api/auth/login",
      { email, password, ...(isDesktop ? { client: "desktop" } : {}) });
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

  const logout = () => {
    setToken(null);
    setUser(null);
    if (isDesktop) void clearEntitlement();
  };

  return <Ctx.Provider value={{ user, loading, login, register, loginWithToken, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
