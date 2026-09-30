// Desktop-only wiring: file-open events from Windows (argv / second instance)
// → import to Drive → open in the editor; sync loop; subscription entitlement.
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { desktop, isDesktop } from "../lib/platform";
import { startSyncLoop } from "../lib/offline/sync";
import { canEditOffline, entitlement, refreshEntitlement } from "../lib/offline/license";
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
 * Offline-grace gate: within the signed entitlement window the desktop edits
 * freely; past it, editing is blocked until the app reconnects and the server
 * issues a fresh entitlement. Online or unverifiable-token states never block.
 */
export function EntitlementGate({ children }: { children: ReactNode }) {
  const [blocked, setBlocked] = useState(false);
  const [expiredDays, setExpiredDays] = useState(0);

  useEffect(() => {
    if (!isDesktop) return;
    const check = async () => {
      const ok = await canEditOffline();
      const e = await entitlement();
      setBlocked(!ok);
      setExpiredDays(e && e.daysLeft < 0 ? -e.daysLeft : 0);
    };
    void check();
    const iv = setInterval(() => void check(), 60_000);
    const onOnline = () => { void refreshEntitlement().then(check); };
    window.addEventListener("online", onOnline);
    return () => { clearInterval(iv); window.removeEventListener("online", onOnline); };
  }, []);

  if (!blocked) return children;
  return (
    <div className="entitlement-gate">
      <div className="entitlement-card">
        <h2>Reconnect to continue</h2>
        <p>
          Kreatix Suites has been offline{expiredDays > 0 ? ` for ${expiredDays} day${expiredDays === 1 ? "" : "s"} past` : " beyond"} the
          14-day offline grace period. Connect to the internet once so we can
          verify your subscription — your documents and pending changes are
          safe on this device and will sync automatically.
        </p>
        <button className="btn-primary" onClick={() => void refreshEntitlement().then(() => window.location.reload())}>
          I'm online — retry
        </button>
      </div>
    </div>
  );
}
