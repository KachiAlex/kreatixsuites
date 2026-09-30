// Desktop-only wiring: file-open events from Windows (argv / second instance)
// → import to Drive → open in the editor; sync loop; subscription entitlement.
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { desktop, isDesktop } from "../lib/platform";
import { startSyncLoop } from "../lib/offline/sync";
import { canEditOffline, entitlement, refreshEntitlement } from "../lib/offline/license";
import { anonDaysLeft, isAnonymous } from "../lib/offline/trial";
import { importLocalPath, kindForPath } from "../lib/offline/openLocal";
import { useToast } from "../pages/Home";

export function DesktopBootstrap() {
  const navigate = useNavigate();
  const { msg, toast } = useToast();

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
    const off = desktop!.onOpenFile((p) => void openPath(p));
    const stopSync = startSyncLoop();
    return () => { off(); stopSync(); };
  }, [navigate, toast]);

  return msg ? <div className="toast">{msg}</div> : null;
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
