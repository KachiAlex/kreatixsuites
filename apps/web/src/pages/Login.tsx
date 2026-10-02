import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";
import { BrandLockup } from "../components/AppIcon";

export function Login({ mode }: { mode: "login" | "register" }) {
  const { login, register, loginWithToken, enterAnonymous, completeMfaLogin } = useAuth();
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
        .catch(() => setError("SSO sign-in failed"));
    } else if (ssoError) {
      setError(`Single sign-on failed: ${ssoError}`);
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
        .catch(() => setError("This invite link is expired or invalid"));
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
      setError(err instanceof Error ? err.message : "Something went wrong");
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
        <h1>{mfaToken ? "Two-factor authentication" : mode === "login" ? "Welcome back" : inviteOrg ? `Join ${inviteOrg}` : "Create your workspace"}</h1>
        <p>{mfaToken ? "Enter the code from your authenticator app, or a backup code." : "Kreatix Suites · Writer · Sheets · Present · PDF"}</p>
        {error && <div className="auth-error">{error}</div>}
        {mfaToken ? (
          <>
            <div className="field"><label>Authentication code</label>
              <input value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} required autoFocus
                inputMode="numeric" autoComplete="one-time-code" placeholder="123456 or abcd-ef01" /></div>
            <button className="btn-primary" disabled={busy}>{busy ? "Verifying…" : "Verify"}</button>
            <button type="button" className="btn-ghost anon-btn"
              onClick={() => { setMfaToken(null); setMfaCode(""); setError(""); }}>
              Back to sign in
            </button>
          </>
        ) : (
          <>
        {mode === "register" && (
          <>
            <div className="field"><label>Full name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Bolanle Johnson" /></div>
            {!invite && (
              <div className="field"><label>Organization (optional)</label>
                <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Kreatix Technologies" /></div>
            )}
          </>
        )}
        <div className="field"><label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@company.com" /></div>
        <div className="field"><label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} placeholder="••••••••" /></div>
        <button className="btn-primary" disabled={busy}>
          {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
          </>
        )}
        {sso && mode === "login" && (
          <a className="btn-secondary sso-btn" href="/api/auth/sso">Continue with single sign-on</a>
        )}
        {saml && mode === "login" && (
          <a className="btn-secondary sso-btn" href="/api/auth/saml">Continue with SAML SSO</a>
        )}
        <button type="button" className="btn-ghost anon-btn"
          onClick={() => { void enterAnonymous().then(() => navigate("/home")); }}>
          Continue without an account — 14 days free
        </button>
        <div className="auth-switch">
          {mode === "login"
            ? <>New to Kreatix? <Link to="/register">Create an account</Link></>
            : <>Already have an account? <Link to="/login">Sign in</Link></>}
        </div>
      </form>
      </div>
    </div>
  );
}
