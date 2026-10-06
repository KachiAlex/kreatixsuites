// Bundled-shell wiring: desktop file-open events (argv / second instance /
// "Open with") → import to Drive → open in the editor; offline sync loop;
// subscription entitlement. On the native mobile shell this also owns the
// kx:// deep-link handler (SSO callback) and the shared toast bus
// (kreatix:toast — file saves in the WebView can't use <a download>).
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { desktop, isDesktop, isNativeMobile } from "../lib/platform";
import { api } from "../lib/api";
import { startSyncLoop } from "../lib/offline/sync";
import { canEditOffline, entitlement, refreshEntitlement } from "../lib/offline/license";
import { anonDaysLeft, isAnonymous } from "../lib/offline/trial";
import { importLocalFile, importLocalPath, kindForPath } from "../lib/offline/openLocal";
import { useToast } from "../lib/hooks";
import { useAuth } from "../lib/auth";

export function DesktopBootstrap() {
  const navigate = useNavigate();
  const { loginWithToken } = useAuth();
  const { msg, toast } = useToast();

  // toast bus — saveFile() and friends broadcast here
  useEffect(() => {
    const h = (e: Event) => toast((e as CustomEvent<string>).detail);
    window.addEventListener("kreatix:toast", h);
    return () => window.removeEventListener("kreatix:toast", h);
  }, [toast]);

  // offline mirror sync — both bundled shells
  useEffect(() => {
    if (!isDesktop && !isNativeMobile) return;
    return startSyncLoop();
  }, []);

  // desktop: OS file-open events → Drive import
  useEffect(() => {
    if (!isDesktop) return;
    const openPath = async (p: string) => {
      if (!kindForPath(p)) {
        toast(`Can't open "${p.split(/[\\/]/).pop()}" — unsupported file type`);
        return;
      }
      try {
        const id = await importLocalPath(p);
        toast("Imported to Drive");
        navigate(`/edit/${id}`);
      } catch (err) {
        toast(`Couldn't open file — ${(err as Error).message}`);
      }
    };
    void desktop!.pendingFiles().then((ps) => ps.forEach((p) => void openPath(p)));
    return desktop!.onOpenFile((p) => void openPath(p));
  }, [navigate, toast]);

  // mobile: kx://auth?code=… deep links returning from the SSO/SAML browser
  // flow — swap the one-time code for the session token
  useEffect(() => {
    if (!isNativeMobile) return;
    let sub: { remove: () => void } | null = null;
    void import("@capacitor/app").then(({ App }) => {
      void App.addListener("appUrlOpen", ({ url }) => {
        let u: URL;
        try { u = new URL(url); } catch { return; }
        if (u.protocol !== "kx:") return;
        const code = u.searchParams.get("code");
        const err = u.searchParams.get("sso_error") ?? u.searchParams.get("error");
        if (err) { toast(`Sign-in failed — ${err.replaceAll("_", " ")}`); return; }
        if (!code) return;
        api.post<{ token: string }>("/api/auth/sso/mobile-exchange", { code })
          .then((r) => loginWithToken(r.token))
          .then(() => navigate("/home", { replace: true }))
          .catch(() => toast("Sign-in link expired — try again"));
      }).then((s) => { sub = s; });
    });
    return () => { void sub?.remove(); };
  }, [navigate, toast, loginWithToken]);

  // mobile: "Open with Kreatix" / "Share to" — KxDocOpen plugin hands us a
  // content:// URI; receive() copies it into app storage so fetch() can read
  // it, then it goes through the same Drive import as the desktop flow
  useEffect(() => {
    if (!isNativeMobile) return;
    let sub: { remove: () => void } | null = null;
    type KxDoc = {
      receive(o: { uri: string }): Promise<{ path: string; name: string; mime?: string }>;
      addListener(ev: "docOpen", cb: (e: { uri: string }) => void): Promise<{ remove(): void }>;
      getPending(): Promise<{ uris?: string[] }>;
    };
    const openUri = async (Kx: KxDoc, uri: string) => {
      try {
        const { Capacitor } = await import("@capacitor/core");
        const f = await Kx.receive({ uri });
        if (!kindForPath(f.name)) {
          toast(`Can't open "${f.name}" — unsupported file type`);
          return;
        }
        const blob = await fetch(Capacitor.convertFileSrc(f.path)).then((r) => r.blob());
        const id = await importLocalFile(new File([blob], f.name, { type: f.mime || blob.type }));
        toast("Imported to Drive");
        navigate(`/edit/${id}`);
      } catch (err) {
        toast(`Couldn't open file — ${(err as Error).message}`);
      }
    };
    void import("@capacitor/core").then(({ registerPlugin }) => {
      const Kx = registerPlugin<KxDoc>("KxDocOpen");
      void Kx.addListener("docOpen", ({ uri }) => void openUri(Kx, uri)).then((s) => { sub = s; });
      void Kx.getPending().then((r) => (r.uris ?? []).forEach((u) => void openUri(Kx, u)));
    });
    return () => { void sub?.remove(); };
  }, [navigate, toast]);

  return msg ? <div className="toast" role="status" aria-live="polite">{msg}</div> : null;
}

/**
 * Usage gates, shared by every shell (desktop/mobile via platform layer,
 * plain browser too). Two walls:
 *  1. Anonymous 14-day tier expired → sign-in wall (sign-in unlocks the
 *     workspace's free 3-month plan; local work survives and syncs).
 *  2. Desktop offline entitlement expired → reconnect wall.
 */
export function EntitlementGate({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [wall, setWall] = useState<"none" | "anon" | "offline" | "locked">("none");

  useEffect(() => {
    const check = async () => {
      if (isAnonymous()) {
        const left = await anonDaysLeft();
        setWall(left !== null && left < 0 ? "anon" : "none");
        return;
      }
      if (!isDesktop) { setWall("none"); return; }
      const e = await entitlement();
      const ok = await canEditOffline();
      setWall(ok ? "none" : e?.status === "locked" ? "locked" : "offline");
    };
    void check();
    const iv = setInterval(() => void check(), 60_000);
    const onOnline = () => { void refreshEntitlement().then(check); };
    window.addEventListener("online", onOnline);
    return () => { clearInterval(iv); window.removeEventListener("online", onOnline); };
  }, []);

  if (wall === "none") return children;
  if (wall === "anon") {
    return (
      <div className="entitlement-gate">
        <div className="entitlement-card">
          <h2>Your 14 free days are up</h2>
          <p>
            Sign in or create an account to keep working — every new workspace
            gets <strong>3 months free</strong>. Everything you've made on this
            device is safe and will sync into your Drive the moment you sign in.
          </p>
          <button className="btn-primary" onClick={() => navigate("/login")}>
            Sign in — unlock 3 months free
          </button>
        </div>
      </div>
    );
  }
  if (wall === "locked") {
    return (
      <div className="entitlement-gate">
        <div className="entitlement-card">
          <h2>Your free 3 months have ended</h2>
          <p>
            Subscribe to keep editing and syncing across devices — your files
            are safe in Drive and on this device.
          </p>
          <button className="btn-primary" onClick={() => navigate("/admin")}>
            Subscribe
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="entitlement-gate">
      <div className="entitlement-card">
        <h2>Reconnect to continue</h2>
        <p>
          Kreatix Suites has been offline beyond the 14-day grace period.
          Connect to the internet once so we can verify your subscription —
          your documents and pending changes are safe on this device and will
          sync automatically.
        </p>
        <button className="btn-primary" onClick={() => void refreshEntitlement().then(() => window.location.reload())}>
          I'm online — retry
        </button>
      </div>
    </div>
  );
}

/**
 * Conversion nudge for the anonymous tier — "Day N of 14 free" + a sign-in
 * link. Renders nothing for signed-in users.
 */
export function AnonBanner() {
  const navigate = useNavigate();
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!isAnonymous()) return;
    void anonDaysLeft().then(setLeft);
    const iv = setInterval(() => void anonDaysLeft().then(setLeft), 60_000);
    return () => clearInterval(iv);
  }, []);
  if (left === null) return null;
  return (
    <div className="billing-banner warn">
      <span>
        Free local mode — <strong>{Math.max(left, 0)} day{Math.max(left, 0) === 1 ? "" : "s"} left</strong>.
        Sign in for 3 months free and cloud sync.
      </span>
      <button onClick={() => navigate("/login")}>Sign in</button>
    </div>
  );
}
