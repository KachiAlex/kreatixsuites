import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "@kreatix/shared";
import { api, getToken, setToken } from "./api";
import { isDesktop } from "./platform";
import { clearEntitlement, refreshEntitlement } from "./offline/license";

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
  const [loading, setLoading] = useState(!!getToken());

  useEffect(() => {
    if (!getToken()) return;
    api.get<{ user: User }>("/api/auth/me")
      .then((r) => setUser(r.user))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string) => {
    // desktop sessions get a 30d token so the 14-day offline grace can't
    // strand a signed-in user mid-offline-period
    const r = await api.post<{ token: string; user: User }>("/api/auth/login",
      { email, password, ...(isDesktop ? { client: "desktop" } : {}) });
    setToken(r.token);
    setUser(r.user);
    if (isDesktop) void refreshEntitlement();
  };

  const register = async (email: string, password: string, displayName: string, orgName?: string, invite?: string) => {
    const r = await api.post<{ token: string; user: User }>("/api/auth/register", {
      email, password, displayName, orgName, invite,
    });
    setToken(r.token);
    setUser(r.user);
    if (isDesktop) void refreshEntitlement();
  };

  /** SSO: server already issued a token — store it and resolve the user. */
  const loginWithToken = async (token: string) => {
    setToken(token);
    const r = await api.get<{ user: User }>("/api/auth/me");
    setUser(r.user);
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    if (isDesktop) void clearEntitlement();
  };

  return <Ctx.Provider value={{ user, loading, login, register, loginWithToken, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
