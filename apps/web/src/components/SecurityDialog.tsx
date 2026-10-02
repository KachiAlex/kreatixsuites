// Two-factor authentication (TOTP) management — enroll via authenticator-app
// QR/secret, show one-time backup codes, disable with password + code.
import { useState } from "react";
import QRCode from "qrcode";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Modal } from "./Modal";

type View = "status" | "enroll" | "codes" | "disable" | "regen" | "delete";

export function SecurityDialog({ onClose, toast }: { onClose: () => void; toast: (m: string) => void }) {
  const { user, refreshUser, logout } = useAuth();
  const [view, setView] = useState<View>("status");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [secret, setSecret] = useState("");
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[]>([]);

  const startEnroll = async () => {
    setBusy(true); setError("");
    try {
      const r = await api.post<{ secret: string; uri: string }>("/api/auth/mfa/setup", {});
      setSecret(r.secret);
      setQr(await QRCode.toDataURL(r.uri, { width: 180, margin: 1, color: { dark: "#26221F", light: "#FFFFFF" } }));
      setView("enroll");
    } catch { setError("Could not start setup"); } finally { setBusy(false); }
  };

  const finishEnroll = async () => {
    setBusy(true); setError("");
    try {
      const r = await api.post<{ backupCodes: string[] }>("/api/auth/mfa/enable", { secret, code: code.trim() });
      setCodes(r.backupCodes);
      void refreshUser();
      setView("codes");
    } catch (e) { setError(e instanceof Error ? e.message : "Invalid code"); } finally { setBusy(false); }
  };

  const disable = async () => {
    setBusy(true); setError("");
    try {
      await api.post("/api/auth/mfa/disable", { password, code: code.trim() });
      void refreshUser();
      toast("Two-factor authentication disabled");
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed"); } finally { setBusy(false); }
  };

  const regen = async () => {
    setBusy(true); setError("");
    try {
      const r = await api.post<{ backupCodes: string[] }>("/api/auth/mfa/codes", { code: code.trim() });
      setCodes(r.backupCodes);
      setView("codes");
    } catch (e) { setError(e instanceof Error ? e.message : "Invalid code"); } finally { setBusy(false); }
  };

  const exportData = async () => {
    setBusy(true); setError("");
    try {
      const blob = await api.get<Blob>("/api/me/export");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `kreatix-export-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast("Data export downloaded");
    } catch { setError("Export failed"); } finally { setBusy(false); }
  };

  const deleteAccount = async () => {
    setBusy(true); setError("");
    try {
      await api.post("/api/me/delete", { password, code: code.trim() || undefined });
      toast("Account deleted");
      onClose();
      logout();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed"); } finally { setBusy(false); }
  };

  const copyCodes = () => {
    navigator.clipboard.writeText(codes.join("\n")).then(() => toast("Backup codes copied")).catch(() => {});
  };
  const downloadCodes = () => {
    const blob = new Blob([`Kreatix Suites backup codes for ${user?.email}\nKeep these somewhere safe — each works once.\n\n${codes.join("\n")}\n`],
      { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "kreatix-backup-codes.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Modal onClose={onClose} label="Security settings">
        <h2>Security</h2>
        <p className="d-sub">Two-factor authentication for {user?.email}</p>
        {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}

        {view === "status" && (
          <>
            <div className="link-box" style={{ marginBottom: 14 }}>
              <span>{user?.mfaEnabled ? "✅ Enabled — sign-in requires an authenticator code" : "Not enabled"}</span>
            </div>
            <div className="d-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {user?.mfaEnabled ? (
                <>
                  <button className="btn-ghost" onClick={() => { setView("regen"); setCode(""); }}>New backup codes</button>
                  <button className="btn-ghost" onClick={() => { setView("disable"); setCode(""); setPassword(""); }}>Disable…</button>
                </>
              ) : (
                <button className="btn-primary btn-sm" onClick={startEnroll} disabled={busy}>
                  {busy ? "Starting…" : "Set up two-factor"}
                </button>
              )}
              <button className="btn-ghost" onClick={onClose}>Close</button>
            </div>
            <div style={{ borderTop: "1px solid var(--line)", marginTop: 18, paddingTop: 14 }}>
              <p className="d-sub" style={{ marginBottom: 8 }}>Your data</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn-ghost btn-sm" onClick={exportData} disabled={busy}>
                  {busy ? "Working…" : "Export my data (.zip)"}
                </button>
                <button className="btn-ghost btn-sm" style={{ color: "#C0392B" }}
                  onClick={() => { setView("delete"); setPassword(""); setCode(""); }}>
                  Delete account…
                </button>
              </div>
            </div>
          </>
        )}

        {view === "enroll" && (
          <>
            <p className="d-sub" style={{ marginBottom: 10 }}>
              1. Scan with your authenticator app (Google/Microsoft Authenticator, 1Password…)
            </p>
            {qr && <img src={qr} alt="Authenticator QR code" width={180} height={180}
              style={{ display: "block", margin: "0 auto 10px", borderRadius: 8, border: "1px solid var(--line)" }} />}
            <p className="d-sub" style={{ marginBottom: 6 }}>Or enter this key manually:</p>
            <div className="link-box" style={{ marginBottom: 14 }}>
              <code style={{ letterSpacing: 1 }}>{secret.match(/.{4}/g)?.join(" ") ?? secret}</code>
              <button className="btn-ghost btn-sm" onClick={() => { navigator.clipboard.writeText(secret); toast("Key copied"); }}>Copy</button>
            </div>
            <div className="field">
              <label>2. Enter the 6-digit code</label>
              <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus
                inputMode="numeric" autoComplete="one-time-code" placeholder="123456"
                onKeyDown={(e) => e.key === "Enter" && finishEnroll()} />
            </div>
            <div className="d-actions" style={{ display: "flex", gap: 8 }}>
              <button className="btn-primary btn-sm" onClick={finishEnroll} disabled={busy || code.trim().length < 6}>
                {busy ? "Verifying…" : "Enable"}
              </button>
              <button className="btn-ghost" onClick={() => setView("status")}>Back</button>
            </div>
          </>
        )}

        {view === "codes" && (
          <>
            <p className="d-sub" style={{ marginBottom: 10 }}>
              Backup codes — each works once if you lose your authenticator. Save them now; they won't be shown again.
            </p>
            <div className="link-box" style={{ display: "block", marginBottom: 12 }}>
              <pre style={{ margin: 0, fontSize: 13, lineHeight: 1.9, columns: 2 }}>{codes.join("\n")}</pre>
            </div>
            <div className="d-actions" style={{ display: "flex", gap: 8 }}>
              <button className="btn-ghost" onClick={copyCodes}>Copy</button>
              <button className="btn-ghost" onClick={downloadCodes}>Download .txt</button>
              <button className="btn-primary btn-sm" onClick={() => { toast("Two-factor enabled"); onClose(); }}>Done</button>
            </div>
          </>
        )}

        {view === "delete" && (
          <>
            <p className="d-sub" style={{ marginBottom: 10, color: "#C0392B" }}>
              Permanently delete your account and all files you own. This can't be undone.
            </p>
            <div className="field">
              <label>Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            </div>
            {user?.mfaEnabled && (
              <div className="field">
                <label>Authenticator or backup code</label>
                <input value={code} onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric" autoComplete="one-time-code" placeholder="123456" />
              </div>
            )}
            <div className="d-actions" style={{ display: "flex", gap: 8 }}>
              <button className="btn-primary btn-sm" style={{ background: "#C0392B" }}
                disabled={busy || !password || (!!user?.mfaEnabled && !code.trim())}
                onClick={deleteAccount}>
                {busy ? "Deleting…" : "Delete my account"}
              </button>
              <button className="btn-ghost" onClick={() => setView("status")}>Back</button>
            </div>
          </>
        )}

        {(view === "disable" || view === "regen") && (
          <>
            {view === "disable" && (
              <div className="field">
                <label>Password</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
              </div>
            )}
            <div className="field">
              <label>{view === "disable" ? "Authenticator or backup code" : "Current authenticator code"}</label>
              <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus={view === "regen"}
                inputMode="numeric" autoComplete="one-time-code" placeholder="123456" />
            </div>
            <div className="d-actions" style={{ display: "flex", gap: 8 }}>
              <button className="btn-primary btn-sm" disabled={busy || !code.trim() || (view === "disable" && !password)}
                onClick={view === "disable" ? disable : regen}>
                {busy ? "Checking…" : view === "disable" ? "Disable two-factor" : "Generate new codes"}
              </button>
              <button className="btn-ghost" onClick={() => setView("status")}>Back</button>
            </div>
          </>
        )}
    </Modal>
  );
}
