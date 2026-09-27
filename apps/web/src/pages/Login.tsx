import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";

export function Login({ mode }: { mode: "login" | "register" }) {
  const { login, register, loginWithToken } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState(false);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "login") await login(email, password);
      else await register(email, password, name, org || undefined);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-mark">K</div>
        <h1>{mode === "login" ? "Welcome back" : "Create your workspace"}</h1>
        <p>Kreatix Business Suite · Writer · Sheets · Present · PDF</p>
        {error && <div className="auth-error">{error}</div>}
        {mode === "register" && (
          <>
            <div className="field"><label>Full name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Bolanle Johnson" /></div>
            <div className="field"><label>Organization (optional)</label>
              <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Kreatix Technologies" /></div>
          </>
        )}
        <div className="field"><label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@company.com" /></div>
        <div className="field"><label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} placeholder="••••••••" /></div>
        <button className="btn-primary" disabled={busy}>
          {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
        {sso && mode === "login" && (
          <a className="btn-secondary sso-btn" href="/api/auth/sso">Continue with single sign-on</a>
        )}
        <div className="auth-switch">
          {mode === "login"
            ? <>New to Kreatix? <Link to="/register">Create an account</Link></>
            : <>Already have an account? <Link to="/login">Sign in</Link></>}
        </div>
      </form>
    </div>
  );
}
