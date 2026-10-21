import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { api, ApiError } from "../lib/api";
import { API_BASE, desktop, isDesktop, isNativeMobile } from "../lib/platform";
import { useI18n, LOCALES } from "../lib/i18n";
import { BrandLockup } from "../components/AppIcon";
import { PasswordInput } from "../components/PasswordInput";

/** Minimal Google Identity Services surface used by the sign-in button. */
interface GoogleGsi {
  accounts: {
    id: {
      initialize: (cfg: { client_id: string; callback: (r: { credential: string }) => void }) => void;
      renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
    };
  };
}
const gis = () => (window as unknown as { google?: GoogleGsi }).google;

export function Login({ mode }: { mode: "login" | "register" | "forgot" }) {
  const { login, register, loginWithGoogle, loginWithToken, enterAnonymous, completeMfaLogin } = useAuth();
  const { t, locale, setLocale } = useI18n();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // post-auth target — ?next=/f/<token> sends respondents back to the form
  // they were gated from; only same-origin absolute paths are honored
  const nextTarget = () => {
    const n = new URLSearchParams(location.search).get("next");
    return n && n.startsWith("/") && !n.startsWith("//") ? n : "/";
  };
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState(false);
  const [saml, setSaml] = useState(false);
  const [inviteOrg, setInviteOrg] = useState<string | null>(null);
  const [inviteBrand, setInviteBrand] = useState<{ name: string; logoUrl: string | null } | null>(null);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [forgotSent, setForgotSent] = useState(false);
  const [kind, setKind] = useState<"personal" | "family" | "business">("personal");
  const [wsHint, setWsHint] = useState<{ nameTaken: boolean; domainOrg: string | null; domain: string | null } | null>(null);
  const [jrState, setJrState] = useState<"idle" | "sending" | "code" | "verifying" | "sent" | "err">("idle");
  const [jrCode, setJrCode] = useState("");
  const [emailTaken, setEmailTaken] = useState(false);
  const [unverified, setUnverified] = useState(false);
  const [resendSent, setResendSent] = useState(false);
  // sso_required → swap the form for IdP buttons (direct ssoUrl from the 403
  // plus lookup results for managed-domain/JIT matches)
  const [ssoRequired, setSsoRequired] = useState<{ url: string; label: string }[] | null>(null);
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);
  const [googleDesktop, setGoogleDesktop] = useState(false);
  const googleBtnRef = useRef<HTMLDivElement>(null);
  const invite = params.get("invite") ?? undefined;
  // latest signup context for the GIS callback (initialize runs once)
  const gParams = useRef({ invite, kind, org });
  gParams.current = { invite, kind, org };

  // Join-vs-create hint: as they type the workspace name/email, check whether
  // a workspace already exists (exact name) or their email domain is claimed
  // by a verified org — the people who hit this almost always meant to JOIN.
  useEffect(() => {
    if (mode !== "register" || invite) { setWsHint(null); return; }
    const domain = email.split("@")[1]?.trim().toLowerCase() ?? "";
    const body: { name?: string; domain?: string } = {};
    if (kind === "business" && org.trim().length >= 2) body.name = org.trim();
    if (domain.includes(".")) body.domain = domain;
    if (!body.name && !body.domain) { setWsHint(null); return; }
    const id = setTimeout(() => {
      api.post<{ nameTaken: boolean; domainOrg: string | null }>("/api/auth/workspace-lookup", body)
        .then((r) => setWsHint({ ...r, domain: r.domainOrg ? domain : null }))
        .catch(() => setWsHint(null));
    }, 400);
    return () => clearTimeout(id);
  }, [org, email, kind, mode, invite]);

  // Join-request flow: step 1 emails a 6-digit ownership code to the
  // requester; step 2 submits it. Once queued (or already pending) the
  // server answers idempotently — no repeat requests.
  const requestJoinCode = () => {
    if (!wsHint?.domain) return;
    setJrState("sending");
    api.post<{ ok: boolean; already?: boolean }>("/api/auth/join-request/code", {
      email: email.trim(), displayName: name.trim(), domain: wsHint.domain,
    }).then((r) => {
      if (r?.already) setJrState("sent");
      else setJrState("code");
    }).catch((e) => {
      setJrState("idle");
      setError(e instanceof Error ? e.message : t("auth.wsRequestErr"));
    });
  };

  const submitJoinCode = () => {
    if (!wsHint?.domain || jrCode.length !== 6) return;
    setJrState("verifying");
    api.post("/api/auth/join-request", {
      email: email.trim(), displayName: name.trim(), domain: wsHint.domain, code: jrCode,
    }).then(() => setJrState("sent")).catch((e) => {
      setJrState("code");
      setError(e instanceof Error ? e.message : t("auth.wsRequestErr"));
    });
  };

  // warm the app-shell chunks while auth state settles — the /home
  // navigation then renders instantly instead of hitting a lazy boundary
  const prefetchAppShell = () => {
    void import("./Home");
    void import("../components/Shell");
  };

  // SSO callback lands here: ?sso=1 (token in HttpOnly cookie) or ?sso_error=<msg>
  useEffect(() => {
    const ssoDone = params.get("sso");
    const ssoError = params.get("sso_error");
    if (ssoDone) {
      setParams({}, { replace: true });
      api.post<{ token: string }>("/api/auth/sso/exchange", {})
        .then((r) => loginWithToken(r.token))
        .then(() => { prefetchAppShell(); navigate(nextTarget(), { replace: true }); })
        .catch(() => setError(t("auth.ssoExchangeFailed")));
    } else if (ssoError) {
      setError(t("auth.ssoFailed", { msg: ssoError }));
      setParams({}, { replace: true });
    }
    api.get<{ enabled: boolean }>("/api/auth/sso/status")
      .then((r) => setSso(r.enabled))
      .catch(() => setSso(false));
    api.get<{ enabled: boolean }>("/api/auth/saml/status")
      .then((r) => setSaml(r.enabled))
      .catch(() => setSaml(false));
    api.get<{ enabled: boolean; clientId: string | null; desktopEnabled?: boolean }>("/api/auth/google/status")
      .then((r) => {
        setGoogleClientId(r.enabled ? r.clientId : null);
        setGoogleDesktop(!!r.desktopEnabled);
      })
      .catch(() => setGoogleClientId(null));
    if (invite) {
      api.get<{ orgName: string; brand?: { name: string; logoUrl: string | null } }>(`/api/auth/invite/${invite}`)
        .then((r) => { setInviteOrg(r.orgName); setInviteBrand(r.brand ?? null); })
        .catch(() => setError(t("auth.inviteExpired")));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onGoogle = async (credential: string) => {
    setError("");
    try {
      const mfa = await loginWithGoogle(credential, {
        invite: gParams.current.invite,
        kind: gParams.current.kind,
        orgName: gParams.current.org || undefined,
      });
      if (mfa) { setMfaToken(mfa); return; }
      prefetchAppShell();
      navigate(nextTarget());
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.genericError"));
    }
  };

  // Desktop shell — Electron drives a system-browser + loopback flow and
  // returns the auth code; the API exchanges it with the desktop secret.
  const googleDesktopSignIn = async () => {
    if (!desktop) return;
    setError("");
    try {
      const r = await desktop.googleSignIn();
      const resp = await api.post<{ token?: string; mfaRequired?: boolean; mfaToken?: string }>(
        "/api/auth/google/code",
        { ...r, invite: gParams.current.invite, kind: gParams.current.kind, orgName: gParams.current.org || undefined });
      if (resp.mfaRequired) { setMfaToken(resp.mfaToken ?? null); return; }
      await loginWithToken(resp.token!);
      prefetchAppShell();
      navigate(nextTarget());
    } catch (err) {
      if (err instanceof Error && /cancel/i.test(err.message)) return;
      setError(err instanceof Error ? err.message : t("auth.genericError"));
    }
  };

  // Native shells can't run the GIS popup — use the Capacitor plugin, which
  // returns the same id_token and reuses onGoogle → /api/auth/google.
  const googleNative = async () => {
    if (!googleClientId) return;
    setError("");
    try {
      const { SocialLogin } = await import("@capgo/capacitor-social-login");
      await SocialLogin.initialize({ google: { webClientId: googleClientId, mode: "online" } });
      const r = await SocialLogin.login({ provider: "google", options: {} });
      const idToken = (r.result as { idToken?: string | null }).idToken;
      if (!idToken) throw new Error("Google sign-in failed");
      await onGoogle(idToken);
    } catch (err) {
      if (err instanceof Error && /cancel/i.test(err.message)) return;
      setError(err instanceof Error ? err.message : t("auth.genericError"));
    }
  };

  // "Sign in with Google" — load the GIS script once the backend reports a
  // client id, then render Google's own button into the placeholder div.
  useEffect(() => {
    if (!googleClientId || isNativeMobile) return;
    const init = () => {
      const g = gis();
      if (!g || !googleBtnRef.current || googleBtnRef.current.hasChildNodes()) return;
      g.accounts.id.initialize({ client_id: googleClientId, callback: (r) => void onGoogle(r.credential) });
      g.accounts.id.renderButton(googleBtnRef.current, { theme: "outline", size: "large", width: 320, text: "continue_with" });
    };
    if (gis()) init();
    else {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.onload = init;
      document.head.appendChild(s);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleClientId, mode, mfaToken]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mfaToken) {
        await completeMfaLogin(mfaToken, mfaCode);
      } else if (mode === "forgot") {
        await api.post("/api/auth/forgot", { email });
        setForgotSent(true);
        setBusy(false);
        return;
      } else if (mode === "login") {
        const pending = await login(email, password);
        if (pending) { setMfaToken(pending); setBusy(false); return; }
      } else {
        await register(email, password, name, org || undefined, invite, kind);
      }
      prefetchAppShell();
      navigate(nextTarget());
    } catch (err) {
      // duplicate email → actionable notice with sign-in/reset links, not a
      // dead-end "already registered" string
      if (err instanceof ApiError && err.status === 409) {
        setEmailTaken(true);
        setError("");
      } else if (err instanceof ApiError && err.code === "email_unverified") {
        // account exists but the mailbox was never confirmed — swap the
        // form for a resend-the-link card instead of a bare error
        setUnverified(true);
        setError("");
      } else if (err instanceof ApiError && err.code === "sso_required") {
        // org enforces SSO — swap the form for IdP buttons: the 403 carries
        // the org's direct entry point; the lookup adds managed-domain hits
        const direct = typeof err.body.ssoUrl === "string" ? err.body.ssoUrl : null;
        const links = direct ? [{ url: direct, label: "identity provider" }] : [];
        try {
          const lu = await api.get<{ providers: { url: string; label: string }[] }>(
            `/api/auth/orgsso/lookup?email=${encodeURIComponent(email)}`);
          for (const p of lu.providers) if (!links.some((l) => l.url === p.url)) links.push(p);
        } catch { /* lookup best-effort */ }
        setSsoRequired(links);
        setError("");
      // a dead connection surfaces as TypeError("Failed to fetch") — say so
      // plainly instead of dumping the raw network error on the user
      } else if (!navigator.onLine || (err instanceof TypeError && /fetch|network|resolve/i.test(err.message))) {
        setError(t("auth.offline"));
      } else {
        setError(err instanceof Error ? err.message : t("auth.genericError"));
      }
      if (mfaToken && err instanceof Error && /expired/i.test(err.message)) setMfaToken(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div>
        <div className="auth-brand">
          {inviteBrand?.logoUrl
            ? <img src={inviteBrand.logoUrl} alt={inviteBrand.name} style={{ height: 64, width: "auto", maxWidth: 280, objectFit: "contain" }} />
            : inviteBrand
              ? <span style={{ color: "#fff", fontSize: 30, fontWeight: 800, letterSpacing: -1 }}>{inviteBrand.name}</span>
              : <BrandLockup light size={64} />}
        </div>
        <form className="auth-card" onSubmit={submit}>
        <h1>{mfaToken ? t("auth.mfaTitle") : mode === "login" ? t("auth.welcomeBack") : mode === "forgot" ? "Reset password" : inviteOrg ? t("auth.joinOrg", { org: inviteOrg })
          : kind === "family" ? t("auth.createFamily") : kind === "personal" ? t("auth.createAccount2") : t("auth.createWorkspace")}</h1>
        <p>{mfaToken ? t("auth.mfaPrompt") : mode === "forgot" ? "We'll email you a reset link." : t("auth.tagline")}</p>
        {error && <div className="auth-error">{error}</div>}
        {unverified ? (
          <>
            <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.55 }}>
              {t("auth.unverifiedBody", { email })}
            </p>
            {resendSent
              ? <p className="ws-hint-ok">{t("auth.unverifiedSent")}</p>
              : <button type="button" className="btn-secondary" style={{ width: "100%" }}
                  onClick={() => { void api.post("/api/auth/resend-verification", { email }).then(() => setResendSent(true)).catch(() => {}); }}>
                  {t("auth.unverifiedResend")}
                </button>}
            <button type="button" className="btn-ghost anon-btn" style={{ width: "100%" }}
              onClick={() => { setUnverified(false); setResendSent(false); }}>
              {t("auth.unverifiedBack")}
            </button>
          </>
        ) : ssoRequired ? (
          <>
            <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.55 }}>
              This workspace requires single sign-on. Continue through your
              identity provider:
            </p>
            {ssoRequired.length === 0 && (
              <p style={{ color: "var(--muted)", fontSize: 12 }}>
                No SSO provider is linked to this account yet — ask your admin
                to configure one under Admin → Single sign-on, or check for a
                workspace invitation.
              </p>
            )}
            {ssoRequired.map((l) => (
              <a key={l.url} className="btn-primary sso-btn" style={{ textAlign: "center", textDecoration: "none" }}
                href={`${API_BASE}${l.url}${isNativeMobile ? (l.url.includes("?") ? "&" : "?") + "client=mobile" : ""}`}>
                Continue with {l.label}
              </a>
            ))}
            <button type="button" className="btn-ghost anon-btn" style={{ width: "100%" }}
              onClick={() => setSsoRequired(null)}>
              Back to password sign-in
            </button>
          </>
        ) : mode === "forgot" ? (
          forgotSent
            ? <p style={{ color: "var(--text-2)", fontSize: 14 }}>If that email has an account, a reset link is on its way. Check your inbox (and spam).</p>
            : <>
                <div className="field"><label>{t("auth.email")}</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@company.com" /></div>
                <button className="btn-primary" disabled={busy}>{busy ? t("auth.pleaseWait") : "Send reset link"}</button>
              </>
        ) : mfaToken ? (
          <>
            <div className="field"><label>{t("auth.mfaCode")}</label>
              <input value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} required autoFocus
                inputMode="numeric" autoComplete="one-time-code" placeholder="123456 or abcd-ef01" /></div>
            <button className="btn-primary" disabled={busy}>{busy ? t("auth.verifying") : t("auth.verify")}</button>
            <button type="button" className="btn-ghost anon-btn"
              onClick={() => { setMfaToken(null); setMfaCode(""); setError(""); }}>
              {t("auth.backToSignIn")}
            </button>
          </>
        ) : (
          <>
        {mode === "register" && (
          <>
            <div className="field"><label>{t("auth.fullName")}</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Bolanle Johnson" /></div>
            {!invite && (
              <>
                <div className="field"><label>{t("auth.forWho")}</label>
                  <div className="kind-pick">
                    {(["personal", "family", "business"] as const).map((k) => (
                      <button type="button" key={k} className={`kind-chip${kind === k ? " on" : ""}`}
                        onClick={() => setKind(k)}>{t(`auth.kind.${k}`)}</button>
                    ))}
                  </div>
                </div>
                {kind !== "personal" && (
                  <div className="field"><label>{kind === "family" ? t("auth.familyName") : t("auth.orgOptional")}</label>
                    <input value={org} onChange={(e) => setOrg(e.target.value)}
                      placeholder={kind === "family" ? "The Adebayos" : "Kreatix Technologies"} />
                    {kind === "business" && wsHint?.nameTaken && (
                      <div className="ws-hint">{t("auth.wsExists", { org: org.trim() })}</div>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}
        <div className="field"><label>{t("auth.email")}</label>
          <input type="email" value={email} onChange={(e) => { setEmail(e.target.value); setEmailTaken(false); setJrState("idle"); }} required placeholder="you@company.com" /></div>
        {mode === "register" && !invite && wsHint?.domainOrg && (
          <div className="ws-hint">
            <div>{t("auth.wsDomain", { org: wsHint.domainOrg })}</div>
            {jrState === "sent" ? (
              <div className="ws-hint-ok">{t("auth.wsRequestSent", { org: wsHint.domainOrg })}</div>
            ) : jrState === "code" || jrState === "verifying" ? (
              <div className="ws-code">
                <div className="ws-code-msg">{t("auth.wsCodeSent", { email: email.trim() })}</div>
                <div className="ws-code-row">
                  <input value={jrCode} inputMode="numeric" autoComplete="one-time-code"
                    placeholder="000000" maxLength={6}
                    onChange={(e) => setJrCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    onKeyDown={(e) => { if (e.key === "Enter" && jrCode.length === 6) { e.preventDefault(); submitJoinCode(); } }} />
                  <button type="button" className="ws-hint-btn"
                    disabled={jrState === "verifying" || jrCode.length !== 6}
                    onClick={submitJoinCode}>
                    {jrState === "verifying" ? t("auth.pleaseWait") : t("auth.wsVerifySend")}
                  </button>
                </div>
                <button type="button" className="ws-code-resend" onClick={() => requestJoinCode()}>
                  {t("auth.wsResendCode")}
                </button>
              </div>
            ) : (
              <button type="button" className="ws-hint-btn"
                disabled={jrState === "sending" || !name.trim()}
                title={!name.trim() ? t("auth.wsRequestNeedsName") : undefined}
                onClick={requestJoinCode}>
                {jrState === "sending" ? t("auth.pleaseWait") : t("auth.wsRequestJoin", { org: wsHint.domainOrg })}
              </button>
            )}
          </div>
        )}
        {mode === "register" && emailTaken && (
          <div className="auth-error">
            {t("auth.emailTaken")}{" "}
            <Link to="/login">{t("auth.signInLink")}</Link> · <Link to="/forgot">{t("auth.resetLink")}</Link>
          </div>
        )}
        <div className="field"><label>{t("auth.password")}</label>
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} placeholder="••••••••" /></div>
        <button className="btn-primary" disabled={busy}>
          {busy ? t("auth.pleaseWait") : mode === "login" ? t("auth.signIn") : t("auth.createAccount")}
        </button>
          </>
        )}
        {/* "Sign in with Google" — GIS-rendered button on web, Capacitor
            plugin on Android, Electron loopback flow on desktop (embedded
            shells can't run Google's consent UI) */}
        {(googleClientId || (isDesktop && googleDesktop)) && mode !== "forgot" && !mfaToken && (
          <>
            <div className="auth-or"><span>{t("auth.orContinue")}</span></div>
            {isDesktop
              ? <button type="button" className="btn-secondary sso-btn" onClick={() => void googleDesktopSignIn()}>{t("auth.googleContinue")}</button>
              : isNativeMobile
                ? <button type="button" className="btn-secondary sso-btn" onClick={() => void googleNative()}>{t("auth.googleContinue")}</button>
                : <div ref={googleBtnRef} className="google-btn" />}
          </>
        )}
        {/* native shell: absolute API URL + client=mobile → IdP dance runs in
            the system browser and the callback returns via a kx:// deep link */}
        {sso && mode === "login" && (
          <a className="btn-secondary sso-btn" href={`${API_BASE}/api/auth/sso${isNativeMobile ? "?client=mobile" : ""}`}>{t("auth.ssoContinue")}</a>
        )}
        {saml && mode === "login" && (
          <a className="btn-secondary sso-btn" href={`${API_BASE}/api/auth/saml${isNativeMobile ? "?client=mobile" : ""}`}>{t("auth.samlContinue")}</a>
        )}
        {/* Enterprise SSO by email — resolves managed domains and org IdP
            configs, including JIT users with no account yet */}
        {mode === "login" && !mfaToken && (
          <button type="button" className="btn-ghost anon-btn" style={{ width: "100%", fontSize: 12 }}
            onClick={async () => {
              if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setError("Enter your work email first"); return; }
              setBusy(true); setError("");
              try {
                const lu = await api.get<{ providers: { url: string; label: string }[] }>(
                  `/api/auth/orgsso/lookup?email=${encodeURIComponent(email)}`);
                if (lu.providers.length === 0) { setError("No single sign-on is configured for that email"); }
                else if (lu.providers.length === 1) {
                  location.href = `${API_BASE}${lu.providers[0].url}${isNativeMobile ? "&client=mobile" : ""}`;
                } else setSsoRequired(lu.providers);
              } catch { setError("SSO lookup failed — try again"); }
              finally { setBusy(false); }
            }}>
            Workplace sign-in (SSO)
          </button>
        )}
        <button type="button" className="btn-ghost anon-btn"
          onClick={() => { void enterAnonymous().then(() => { prefetchAppShell(); navigate("/home"); }); }}>
          {t("auth.anon")}
        </button>
        <div className="auth-switch">
          {mode === "login"
            ? <>{t("auth.newToKreatix")} <Link to="/register">{t("auth.createAccountLink")}</Link></>
            : <><Link to="/login">{t("auth.signInLink")}</Link></>}
          {mode === "login" && <><br /><Link to="/forgot" style={{ fontSize: 13 }}>Forgot password?</Link></>}
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label>{t("shell.language")}</label>
          <select value={locale} onChange={(e) => setLocale(e.target.value)}>
            {LOCALES.map((l) => <option key={l.tag} value={l.tag}>{l.label}</option>)}
          </select>
        </div>
      </form>
      </div>
    </div>
  );
}
