import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "@kreatix/shared";
import { api, getToken, setToken } from "./api";
import { isDesktop } from "./platform";
import { clearEntitlement, refreshEntitlement } from "./offline/license";
import { ANON_USER, endAnonymousSession, isAnonymous, startAnonymousSession } from "./offline/trial";

/** Effective plan snapshot from /api/auth/me — the UI entitlement map. */
export interface SessionPlan {
  slug: string; name: string;
  features: Record<string, boolean>;
  limits: Record<string, number>;
  state: string;
}

/** Org snapshot from /api/auth/me — onboardedAt drives the setup wizard. */
export interface SessionOrg {
  name: string;
  onboardedAt: string | null;
  /** Tenant type — 'business' | 'family' | 'personal'. Drives consumer
   *  labeling (family orgs say "Family" instead of "Workspace"). */
  kind?: string;
  /** White-label — org display name/logo override (nulls = Kreatix brand). */
  brandName?: string | null;
  logoUrl?: string | null;
}

interface AuthState {
  user: User | null;
  org: SessionOrg | null;
  plan: SessionPlan | null;
  /** Org's per-app seat caps ({} = uncapped) — folded into user.disabledApps
   *  on load, so appEnabled() call sites stay unchanged. */
  appSeats: Record<string, number> | null;
  /** Stamp the org onboarded locally (server is told by the wizard). */
  markOnboarded: () => void;
  /** Feature gate — signed-in users resolve via their plan; anonymous/local
   *  sessions aren't gated (local processing costs nothing, server-side
   *  entitlements stay authoritative for anything that hits the API). */
  hasFeature: (key: string) => boolean;
  loading: boolean;
  /** Resolves null on success, or the short-lived mfaToken when the account
   *  requires a second factor — the caller then completes via completeMfaLogin. */
  login: (email: string, password: string) => Promise<string | null>;
  completeMfaLogin: (mfaToken: string, code: string) => Promise<void>;
  register: (email: string, password: string, displayName: string, orgName?: string, invite?: string, kind?: string) => Promise<void>;
  /** "Sign in with Google" — sends the GIS ID token; resolves null on success
   *  or the mfaToken when the account has a second factor enrolled. */
  loginWithGoogle: (idToken: string, opts?: { invite?: string; kind?: string; orgName?: string }) => Promise<string | null>;
  /** Org mandates MFA and this user hasn't enrolled — the API already gates
   *  their session to the setup endpoints; the UI renders a blocking enroll
   *  screen until this flips false. */
  mfaSetupRequired: boolean;
  loginWithToken: (token: string) => Promise<void>;
  /** Re-fetch /api/auth/me — e.g. after changing security settings. */
  refreshUser: () => Promise<void>;
  enterAnonymous: () => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthState>(null as never);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [org, setOrg] = useState<SessionOrg | null>(null);
  const [plan, setPlan] = useState<SessionPlan | null>(null);
  const [appSeats, setAppSeats] = useState<Record<string, number> | null>(null);
  const [mfaSetupRequired, setMfaSetupRequired] = useState(false);
  const [loading, setLoading] = useState(!!getToken() || isAnonymous());

  /** Merge seat-capped apps the user holds no grant for into disabledApps,
   *  so every appEnabled(disabledApps, slug) call site stays correct. */
  const withSeatGating = (u: User, seats: Record<string, number> | null): User => {
    const capped = Object.keys(seats ?? {}).filter((s) => !(u.appLicenses ?? []).includes(s));
    return capped.length ? { ...u, disabledApps: [...new Set([...(u.disabledApps ?? []), ...capped])] } : u;
  };

  useEffect(() => {
    // anonymous tier: a local pseudo-user — everything runs off the mirror,
    // nothing authenticates until they sign in
    if (isAnonymous()) {
      setUser(ANON_USER as User);
      setLoading(false);
      return;
    }
    if (!getToken()) return;
    api.get<{ user: User; org?: SessionOrg; plan?: SessionPlan; mfaSetupRequired?: boolean; appSeats?: Record<string, number> }>("/api/auth/me")
      .then((r) => { setAppSeats(r.appSeats ?? null); setUser(withSeatGating(r.user, r.appSeats ?? null)); setOrg(r.org ?? null); setPlan(r.plan ?? null); setMfaSetupRequired(!!r.mfaSetupRequired); })
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
    void refreshUser();
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
    void refreshUser();
    if (isDesktop) void refreshEntitlement();
    void convertAnonymous(wasAnon);
  };

  const register = async (email: string, password: string, displayName: string, orgName?: string, invite?: string, kind?: string) => {
    const wasAnon = localStorage.getItem("kx.anon") === "1";
    const r = await api.post<{ token: string; user: User }>("/api/auth/register", {
      email, password, displayName, orgName, invite, kind,
    });
    setToken(r.token);
    setUser(r.user);
    void refreshUser();
    if (isDesktop) void refreshEntitlement();
    void convertAnonymous(wasAnon);
  };

  const loginWithGoogle = async (idToken: string, opts?: { invite?: string; kind?: string; orgName?: string }): Promise<string | null> => {
    const wasAnon = localStorage.getItem("kx.anon") === "1";
    const r = await api.post<{ token?: string; user?: User; mfaRequired?: boolean; mfaToken?: string }>("/api/auth/google",
      { idToken, ...opts, ...(isDesktop ? { client: "desktop" } : {}) });
    if (r.mfaRequired) return r.mfaToken ?? null;
    setToken(r.token!);
    setUser(r.user!);
    void refreshUser();
    if (isDesktop) void refreshEntitlement();
    void convertAnonymous(wasAnon);
    return null;
  };

  /** SSO: server already issued a token — store it and resolve the user. */
  const loginWithToken = async (token: string) => {
    const wasAnon = localStorage.getItem("kx.anon") === "1";
    setToken(token);
    const r = await api.get<{ user: User; org?: SessionOrg; plan?: SessionPlan; mfaSetupRequired?: boolean; appSeats?: Record<string, number> }>("/api/auth/me");
    setAppSeats(r.appSeats ?? null);
    setUser(withSeatGating(r.user, r.appSeats ?? null));
    setOrg(r.org ?? null);
    setPlan(r.plan ?? null);
    setMfaSetupRequired(!!r.mfaSetupRequired);
    void convertAnonymous(wasAnon);
  };

  /** Anonymous tier — stamp the install clock and adopt the local pseudo-user
   *  in-place (no reload needed: Protected would bounce a null user). */
  const enterAnonymous = async () => {
    await startAnonymousSession();
    setUser(ANON_USER as User);
  };

  const refreshUser = async () => {
    const r = await api.get<{ user: User; org?: SessionOrg; plan?: SessionPlan; mfaSetupRequired?: boolean; appSeats?: Record<string, number> }>("/api/auth/me");
    setAppSeats(r.appSeats ?? null);
    setUser(withSeatGating(r.user, r.appSeats ?? null));
    setOrg(r.org ?? null);
    setPlan(r.plan ?? null);
    setMfaSetupRequired(!!r.mfaSetupRequired);
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    setOrg(null);
    setPlan(null);
    // clear the anonymous-tier flag too — otherwise the next load resurrects
    // the local pseudo-user and the user appears signed in again
    if (isAnonymous()) endAnonymousSession();
    if (isDesktop) void clearEntitlement();
  };

  const hasFeature = (key: string) => (plan ? plan.features?.[key] === true : true);
  const markOnboarded = () => setOrg((o) => (o ? { ...o, onboardedAt: new Date().toISOString() } : o));
  return <Ctx.Provider value={{ user, org, plan, appSeats, hasFeature, loading, login, completeMfaLogin, register, loginWithGoogle, loginWithToken, refreshUser, markOnboarded, enterAnonymous, logout, mfaSetupRequired }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
