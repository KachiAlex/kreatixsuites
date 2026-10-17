import { Component, type ErrorInfo, type ReactNode } from "react";
import { api } from "../lib/api";

interface State { crashed: boolean; message: string }

/** App-level crash containment — without it a render exception anywhere in a
 *  lazy route white-screens the whole suite. Reports to /api/client-error so
 *  production bugs aren't invisible. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { crashed: false, message: "" };

  static getDerivedStateFromError(err: Error): State {
    return { crashed: true, message: err.message };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    api.post("/api/client-error", {
      message: err.message.slice(0, 500),
      stack: (err.stack ?? "").slice(0, 4000),
      componentStack: (info.componentStack ?? "").slice(0, 2000),
      url: location.pathname,
      ua: navigator.userAgent.slice(0, 200),
    }).catch(() => { /* reporting is best-effort */ });
  }

  render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <div className="auth-wrap"><div>
        <div className="auth-card" style={{ textAlign: "center" }}>
          <h1>Something went wrong</h1>
          <p style={{ color: "var(--text-2)", fontSize: 14 }}>
            The app hit an unexpected error. Reloading usually fixes it — your work is saved server-side.
          </p>
          <p style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text-3)" }}>{this.state.message}</p>
          <button className="btn-primary" onClick={() => location.reload()}>Reload</button>
        </div>
      </div></div>
    );
  }
}

/** Swallow async errors that escape React — unhandledrejection +
 *  window.onerror report to the same endpoint. */
export function installGlobalErrorReporting() {
  window.addEventListener("unhandledrejection", (ev) => {
    const err = ev.reason;
    api.post("/api/client-error", {
      message: String(err?.message ?? err).slice(0, 500),
      stack: String(err?.stack ?? "").slice(0, 4000),
      url: location.pathname,
      kind: "unhandledrejection",
    }).catch(() => {});
  });
}
