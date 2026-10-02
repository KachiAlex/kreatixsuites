import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";
import { useI18n, LOCALES } from "../lib/i18n";
import { BrandLockup } from "../components/AppIcon";

export function Login({ mode }: { mode: "login" | "register" }) {
  const { login, register, loginWithToken, enterAnonymous, completeMfaLogin } = useAuth();
  const { t, locale, setLocale } = useI18n();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState(false);
  const [saml, setSaml] = useState(false);
  const [inviteOrg, setInviteOrg] = useState<string | null>(null);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const invite = params.get("invite") ?? undefined;

  // SSO callback lands here: ?sso=1 (token in HttpOnly cookie) or ?sso_error=<msg>
  useEffect(() => {
    const ssoDone = params.get("sso");
    const ssoError = params.get("sso_error");
    if (ssoDone) {
      setParams({}, { replace: true });
      api.post<{ token: string }>("/api/auth/sso/exchange", {})
        .then((r) => loginWithToken(r.token))
        .then(() => navigate("/", { replace: true }))
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
    if (invite) {
      api.get<{ orgName: string }>(`/api/auth/invite/${invite}`)
        .then((r) => setInviteOrg(r.orgName))
        .catch(() => setError(t("auth.inviteExpired")));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mfaToken) {
        await completeMfaLogin(mfaToken, mfaCode);
      } else if (mode === "login") {
        const pending = await login(email, password);
        if (pending) { setMfaToken(pending); setBusy(false); return; }
      } else {
        await register(email, password, name, org || undefined, invite);
      }
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.genericError"));
      if (mfaToken && err instanceof Error && /expired/i.test(err.message)) setMfaToken(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div>
        <div className="auth-brand"><BrandLockup light size={64} /></div>
        <form className="auth-card" onSubmit={submit}>
        <h1>{mfaToken ? t("auth.mfaTitle") : mode === "login" ? t("auth.welcomeBack") : inviteOrg ? t("auth.joinOrg", { org: inviteOrg }) : t("auth.createWorkspace")}</h1>
        <p>{mfaToken ? t("auth.mfaPrompt") : t("auth.tagline")}</p>
        {error && <div className="auth-error">{error}</div>}
        {mfaToken ? (
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
              <div className="field"><label>{t("auth.orgOptional")}</label>
                <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Kreatix Technologies" /></div>
            )}
          </>
        )}
        <div className="field"><label>{t("auth.email")}</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@company.com" /></div>
        <div className="field"><label>{t("auth.password")}</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} placeholder="••••••••" /></div>
        <button className="btn-primary" disabled={busy}>
          {busy ? t("auth.pleaseWait") : mode === "login" ? t("auth.signIn") : t("auth.createAccount")}
        </button>
          </>
        )}
        {sso && mode === "login" && (
          <a className="btn-secondary sso-btn" href="/api/auth/sso">{t("auth.ssoContinue")}</a>
        )}
        {saml && mode === "login" && (
          <a className="btn-secondary sso-btn" href="/api/auth/saml">{t("auth.samlContinue")}</a>
        )}
        <button type="button" className="btn-ghost anon-btn"
          onClick={() => { void enterAnonymous().then(() => navigate("/home")); }}>
          {t("auth.anon")}
        </button>
        <div className="auth-switch">
          {mode === "login"
            ? <>{t("auth.newToKreatix")} <Link to="/register">{t("auth.createAccountLink")}</Link></>
            : <>{t("auth.haveAccount")} <Link to="/login">{t("auth.signInLink")}</Link></>}
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
