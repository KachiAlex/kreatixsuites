import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

// Kreatix Mail now launches the full mail app (mail.kreatixtech.com) in its
// own tab — the suite mints a short-lived exchange JWT server-side at
// /api/mail/sso, the mail service swaps it for a real session. This page is
// the deep-link fallback: it auto-launches on mount and shows a manual
// button when the popup was blocked.

export function Mail() {
  const [state, setState] = useState<"opening" | "blocked" | "unavailable">("opening");
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    const win = window.open("/api/mail/sso", "_blank", "noopener");
    if (!win) {
      // popup blocked — surface the manual launch
      setState("blocked");
      return;
    }
    // the SSO endpoint can still 503 server-side — cheap probe so the card
    // can say so instead of silently landing on an error page
    api.get<{ enabled?: boolean }>("/api/mail/status").then((s) => {
      if (!s?.enabled) setState("unavailable");
    }).catch(() => {});
  }, []);

  return (
    <div className="page" style={{ display: "grid", placeItems: "center", minHeight: "70vh" }}>
      <div className="admin-card" style={{ maxWidth: 420, textAlign: "center", padding: "36px 32px" }}>
        <div style={{ fontSize: 34, marginBottom: 10 }}>✉</div>
        <h2 style={{ marginTop: 0 }}>Kreatix Mail</h2>
        {state === "opening" && (
          <p className="d-sub">Opening your mailbox in a new tab…</p>
        )}
        {state === "blocked" && (
          <>
            <p className="d-sub">Your browser blocked the new tab. Open the full mail app directly:</p>
            <a className="btn-primary" style={{ display: "inline-block", marginTop: 10, textDecoration: "none", padding: "9px 22px" }}
              href="/api/mail/sso" target="_blank" rel="noopener noreferrer">
              Open Kreatix Mail
            </a>
          </>
        )}
        {state === "unavailable" && (
          <p className="d-sub">Mail isn't configured for this workspace yet — ask your admin.</p>
        )}
        <p className="d-sub" style={{ marginTop: 18 }}>
          Moving from Gmail, Outlook or another provider?{" "}
          <Link to="/mail/migrate">Import your mail</Link>
        </p>
      </div>
    </div>
  );
}
