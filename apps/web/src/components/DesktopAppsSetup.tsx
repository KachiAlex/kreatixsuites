// Desktop only: which suite apps this install adds as their own shortcuts. Shown
// once after the first sign-in, and again from the account menu. Each ticked app
// opens in its own window and claims its file types under "Open with".
import { useEffect, useState } from "react";
import { SUITE_APPS, appEnabled } from "@kreatix/shared";
import { desktop, desktopApp, isDesktop } from "../lib/platform";
import { useAuth } from "../lib/auth";

export function DesktopAppsSetup() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const apps = SUITE_APPS.filter((a) => appEnabled(user?.disabledApps, a.slug));
  const enabled = !!isDesktop && !desktopApp && !!user;

  const show = (selected: string[]) => {
    setPicked(Object.fromEntries(apps.map((a) => [a.slug, selected.includes(a.slug)])));
    setError("");
    setOpen(true);
  };

  useEffect(() => {
    if (!enabled) return;
    void desktop!.apps.status().then((s) => { if (!s.configured) show(apps.map((a) => a.slug)); }).catch(() => {});
    const reopen = () => void desktop!.apps.status().then((s) => show(s.apps));
    window.addEventListener("kx:desktop-apps", reopen);
    return () => window.removeEventListener("kx:desktop-apps", reopen);
  }, [enabled]);

  if (!open) return null;

  const save = async (slugs: string[]) => {
    setBusy(true);
    const r = await desktop!.apps.configure(slugs);
    setBusy(false);
    if (!r.ok) { setError(r.error ?? "Couldn't set up apps"); return; }
    setOpen(false);
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="kx-apps-title"
      style={{ position: "fixed", inset: 0, background: "rgba(20,14,10,.35)", display: "grid", placeItems: "center", zIndex: 1000 }}>
      <div className="admin-card" style={{ maxWidth: 480, width: "calc(100% - 32px)", padding: "24px 26px" }}>
        <h2 id="kx-apps-title" style={{ marginTop: 0 }}>Choose your apps</h2>
        <p className="d-sub">Each app you tick gets its own shortcut and opens in its own window, and its file types open there.</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, margin: "14px 0" }}>
          {apps.map((a) => (
            <label key={a.slug} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" checked={!!picked[a.slug]}
                onChange={(e) => setPicked({ ...picked, [a.slug]: e.target.checked })} />
              {a.name}
            </label>
          ))}
        </div>
        {error && <p className="d-sub" style={{ color: "#B42318" }}>{error}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
          <button className="btn-ghost" disabled={busy} onClick={() => void save([])}>Not now</button>
          <button className="btn-primary" disabled={busy}
            onClick={() => void save(Object.keys(picked).filter((k) => picked[k]))}>
            {busy ? "Setting up…" : "Add selected apps"}
          </button>
        </div>
      </div>
    </div>
  );
}
