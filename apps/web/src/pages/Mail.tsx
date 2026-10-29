import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { openMail } from "../lib/openApp";

// Kreatix Mail launches the full mail app (mail.kreatixtech.com) in its own
// window via openMail(). This page is the deep-link fallback: it launches on
// mount and shows a manual button when the browser blocked the window.

export function Mail() {
  const [state, setState] = useState<"opening" | "blocked" | "unavailable">("opening");
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void openMail().then((ok) => {
      if (!ok) setState("blocked");
    }).catch(() => setState("unavailable"));
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
            <button className="btn-primary" style={{ marginTop: 10, padding: "9px 22px" }}
              onClick={() => void openMail()}>
              Open Kreatix Mail
            </button>
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
