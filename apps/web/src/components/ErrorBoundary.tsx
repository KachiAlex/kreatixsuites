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

  // Stale-chunk self-heal: a deploy replaces hashed /assets/*.js while open
  // tabs still reference the previous build's manifest — dynamic imports
  // then 404 with "error loading dynamically imported module". Vite emits
  // vite:preloadError for exactly this; reloading once picks up the new
  // index.html → new chunk graph. The sessionStorage flag stops a reload
  // loop when the *new* bundle itself is broken.
  const isStaleChunk = (m: string) =>
    /dynamically imported module|Failed to fetch dynamically|Importing a module script failed|vite:preloadError/i.test(m);
  const reloadOnce = (reportUrl: string) => {
    // sessionStorage survives the reload — a 90s window breaks the loop if
    // the freshly deployed bundle itself is broken (still crashy, but once)
    const last = Number(sessionStorage.getItem("kx.chunkReloadAt") ?? 0);
    if (Date.now() - last < 90_000) return;
    sessionStorage.setItem("kx.chunkReloadAt", String(Date.now()));
    api.post("/api/client-error", {
      message: "stale chunk — auto reload",
      url: reportUrl,
      kind: "stale-chunk",
    }).catch(() => {});
    location.reload();
  };
  window.addEventListener("vite:preloadError", () => reloadOnce(location.pathname));
  window.addEventListener("unhandledrejection", (ev) => {
    if (isStaleChunk(String(ev.reason?.message ?? ev.reason ?? ""))) reloadOnce(location.pathname);
  });
}
