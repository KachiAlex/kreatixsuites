import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { BrandLockup } from "../components/AppIcon";

/** /reset-password?token=… — consumes the emailed single-use token. */
export function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    if (password !== confirm) { setErr("Passwords don't match"); return; }
    setBusy(true);
    try {
      await api.post("/api/auth/reset", { token, password });
      setDone(true);
      setTimeout(() => navigate("/login"), 1800);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Reset failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="auth-wrap"><div>
      <div className="auth-brand"><BrandLockup light size={64} /></div>
      <form className="auth-card" onSubmit={submit}>
        <h1>Choose a new password</h1>
        {!token && <div className="auth-error">This reset link is missing its token.</div>}
        {err && <div className="auth-error">{err}</div>}
        {done
          ? <p>Password updated — taking you to sign in…</p>
          : <>
              <div className="field"><label>New password</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} /></div>
              <div className="field"><label>Confirm password</label>
                <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} /></div>
              <button className="btn-primary" disabled={busy || !token}>{busy ? "Saving…" : "Reset password"}</button>
            </>}
        <div className="auth-switch"><Link to="/login">Back to sign in</Link></div>
      </form>
    </div></div>
  );
}

/** /verify-email?token=… — consumes the emailed verification token. */
export function VerifyEmail() {
  const [params] = useSearchParams();
  const { refreshUser } = useAuth();
  const [state, setState] = useState<"working" | "ok" | "bad">("working");

  useEffect(() => {
    const token = params.get("token");
    if (!token) { setState("bad"); return; }
    api.get(`/api/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then(() => {
        setState("ok");
        // the auth context may have fetched /auth/me before the verify call
        // landed — refresh so the flag is true everywhere this session
        void refreshUser().catch(() => {});
      })
      .catch(() => setState("bad"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="auth-wrap"><div>
      <div className="auth-brand"><BrandLockup light size={64} /></div>
      <div className="auth-card">
        <h1>{state === "ok" ? "Email verified" : state === "bad" ? "Link expired" : "Verifying…"}</h1>
        <p>{state === "ok"
          ? "Your email is confirmed — you're all set."
          : state === "bad"
            ? "This verification link is expired or already used. Sign in and request a new one."
            : "One moment…"}</p>
        <div className="auth-switch"><Link to="/home">Continue to Kreatix</Link></div>
      </div>
    </div></div>
  );
}
