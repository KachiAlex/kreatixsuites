import { useState } from "react";
import QRCode from "qrcode";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

/** Blocking full-screen gate rendered by Protected when the org mandates MFA
 *  and the user hasn't enrolled. The API already confines the session to the
 *  setup endpoints — this is the UX side of the same wall. Mirrors the
 *  SecurityDialog TOTP flow (setup → scan → verify → backup codes). */
export default function MfaEnrollScreen() {
  const { refreshUser, logout, org } = useAuth();
  const [secret, setSecret] = useState("");
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [started, setStarted] = useState(false);

  const start = async () => {
    setBusy(true); setError("");
    try {
      const r = await api.post<{ secret: string; uri: string }>("/api/auth/mfa/setup", {});
      setSecret(r.secret);
      setQr(await QRCode.toDataURL(r.uri, { width: 180, margin: 1, color: { dark: "#26221F", light: "#FFFFFF" } }));
      setStarted(true);
    } catch { setError("Could not start setup — try again"); } finally { setBusy(false); }
  };

  const finish = async () => {
    setBusy(true); setError("");
    try {
      const r = await api.post<{ backupCodes: string[] }>("/api/auth/mfa/enable", { secret, code: code.trim() });
      setCodes(r.backupCodes);
    } catch (e) { setError(e instanceof Error ? e.message : "Invalid code"); } finally { setBusy(false); }
  };

  const done = async () => { await refreshUser(); };

  return (
    <div className="auth-wrap">
      <div className="auth-card" style={{ maxWidth: 440 }}>
        <h1>Secure your account</h1>
        <p className="muted">
          {org?.name ? `${org.name} requires` : "Your workspace requires"} two-factor
          authentication. Set up an authenticator app (Google Authenticator,
          Authy, 1Password…) to continue.
        </p>
        {!started && !codes && (
          <button className="btn-primary" onClick={start} disabled={busy}>
            {busy ? "Starting…" : "Set up two-factor"}
          </button>
        )}
        {started && !codes && (
          <>
            {qr && <img src={qr} alt="Scan with your authenticator app" style={{ display: "block", margin: "8px auto" }} />}
            <p className="muted" style={{ wordBreak: "break-all", fontSize: 12 }}>
              Can't scan? Enter this key manually: <code>{secret}</code>
            </p>
            <input className="input" placeholder="6-digit code" inputMode="numeric" maxLength={6}
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            <button className="btn-primary" onClick={finish} disabled={busy || code.length !== 6}>
              {busy ? "Verifying…" : "Verify & enable"}
            </button>
          </>
        )}
        {codes && (
          <>
            <p><b>Save these backup codes</b> — each works once if you lose your phone:</p>
            <pre style={{ background: "var(--k-surface-2, #f5f3f0)", padding: 12, borderRadius: 8, fontSize: 13, userSelect: "all" }}>
              {codes.join("\n")}
            </pre>
            <button className="btn-primary" onClick={done}>I've saved them — continue</button>
          </>
        )}
        {error && <p className="error-text">{error}</p>}
        <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
          <a href="#" onClick={(e) => { e.preventDefault(); logout(); }}>Sign out</a>
        </p>
      </div>
    </div>
  );
}
