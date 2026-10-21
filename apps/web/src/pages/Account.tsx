import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useToast } from "../lib/hooks";

interface Session {
  id: string; client: string; userAgent: string | null; ip: string | null;
  createdAt: string; lastSeenAt: string; current: boolean;
}

const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
};

const uaLabel = (ua: string | null) => {
  if (!ua) return "Unknown device";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad/i.test(ua)) return "iOS";
  if (/Linux/i.test(ua)) return "Linux";
  return ua.slice(0, 40);
};

export function Account() {
  const { user, logout } = useAuth();
  const { msg, toast } = useToast();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  const load = () => api.get<{ sessions: Session[] }>("/api/me/sessions")
    .then((r) => setSessions(r.sessions)).catch((e) => toast(e instanceof Error ? e.message : "Load failed"));
  useEffect(() => { void load(); }, []);

  const revoke = async (id: string, current: boolean) => {
    setBusy(id);
    try {
      await api.del(`/api/me/sessions/${id}`);
      if (current) { logout(); navigate("/login"); return; }
      toast("Session signed out");
      void load();
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(null); }
  };

  const logoutAll = async () => {
    setBusy("all");
    try {
      await api.post("/api/auth/logout-all", {});
      logout(); navigate("/login");
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); setBusy(null); }
  };

  return (
    <div className="page account-page">
      <header className="page-head">
        <h1>Account security</h1>
        <p className="d-sub">Sessions, sign-in protection, and account data.</p>
      </header>

      <section className="admin-card">
        <h2>Profile</h2>
        <div className="acct-row"><span>Email</span><b>{user?.email}</b>
          {user?.emailVerified
            ? <span className="flag on"><i />Verified</span>
            : <button className="btn-primary btn-sm" onClick={async () => {
                try { await api.post("/api/auth/resend-verification", {}); toast("Verification email sent — check your inbox"); }
                catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
              }}>Resend verification</button>}
        </div>
        <div className="acct-row"><span>Two-factor (TOTP)</span>
          <b>{user?.mfaEnabled ? "Enabled" : "Not set up"}</b>
          {user?.mfaEnabled && <span className="flag on"><i />On</span>}
        </div>
      </section>

      <section className="admin-card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h2 style={{ margin: 0 }}>Active sessions</h2>
          {!confirmAll
            ? <button className="btn-sm" onClick={() => setConfirmAll(true)}>Sign out everywhere…</button>
            : <span style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                This device too?
                <button className="btn-primary btn-sm" disabled={busy === "all"} onClick={logoutAll}>Yes, all</button>
                <button className="btn-sm" onClick={() => setConfirmAll(false)}>Cancel</button>
              </span>}
        </div>
        <p className="d-sub">Every device signed in to your account. Revoking one signs it out immediately.</p>
        {sessions.length === 0 && <p className="d-sub">No session records yet — sessions are tracked from this release onward.</p>}
        <div className="sess-list">
          {sessions.map((s) => (
            <div key={s.id} className={`sess-row${s.current ? " current" : ""}`}>
              <span className="sess-ico">{s.client === "desktop" ? "🖥" : "🌐"}</span>
              <div className="sess-info">
                <b>{uaLabel(s.userAgent)}{s.current && <em className="sess-current"> · this device</em>}</b>
                <small>{s.client} · {s.ip ?? "unknown ip"} · active {fmtWhen(s.lastSeenAt)}</small>
              </div>
              <button className="btn-sm" disabled={busy === s.id}
                onClick={() => void revoke(s.id, s.current)}>
                {s.current ? "Sign out" : "Revoke"}
              </button>
            </div>
          ))}
        </div>
      </section>

      {msg && <div className="toast" role="status">{msg}</div>}
    </div>
  );
}
