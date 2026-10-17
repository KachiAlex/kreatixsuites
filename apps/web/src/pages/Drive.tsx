import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import type { DriveItem } from "@kreatix/shared";
import { api } from "../lib/api";
import { useFiles, useItemActions } from "../lib/hooks";
import { FileList } from "../components/FileList";
import { ShareDialog } from "../components/ShareDialog";
import { VersionsPanel } from "../components/VersionsPanel";
import { prefetchEditorsFor } from "./editors";
import { openLocalFile } from "../lib/offline/openLocal";
import { isDesktop, isNativeMobile } from "../lib/platform";
import { listConflicts, resolveConflict, type ConflictEntry } from "../lib/offline/sync";

const TITLES: Record<string, string> = {
  recent: "Recent",
  starred: "Starred",
  all: "Kreatix Drive",
  shared: "Shared with me",
  approvals: "Pending approvals",
  trash: "Recycle bin",
};

export function Drive() {
  const { view = "recent", folderId } = useParams();
  const navigate = useNavigate();
  const { items, refresh } = useFiles(view, folderId ?? (view === "all" ? "" : undefined));
  const { sharing, setSharing, versions, setVersions, msg, toast } = useItemActions(refresh);

  const open = (it: DriveItem) =>
    navigate(it.kind === "folder" ? `/drive/folder/${it.id}` : `/edit/${it.id}`);

  // warm editor chunks for the kinds actually in this list (idle time)
  useEffect(() => { prefetchEditorsFor(items.map((i) => i.kind)); }, [items]);

  return (
    <>
      <div className="crumbs">
        <Link to="/home">Home</Link> <span>/</span>
        {folderId ? <><Link to="/drive/all">Kreatix Drive</Link> <span>/</span> <b>Folder</b></> : <b>{TITLES[view] ?? view}</b>}
      </div>
      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>{folderId ? "Folder" : TITLES[view] ?? view}</h2>
        {view === "approvals" && <DelegateButton toast={toast} />}
        {view !== "trash" && view !== "approvals" && (
          <button className="btn-ghost" style={{ marginLeft: "auto" }}
            onClick={() => void openLocalFile()
              .then((id) => { if (id) navigate(`/edit/${id}`); })
              .catch((e) => toast((e as Error).message))}>
            📂 Open from this computer…
          </button>
        )}
      </div>
      <ConflictsBanner toast={toast} onChanged={refresh} />
      <FileList items={items} onOpen={open} onRefresh={refresh} onShare={setSharing} onVersions={setVersions} toast={toast} />

      {sharing && <ShareDialog item={sharing} onClose={() => setSharing(null)} toast={toast} />}
      {versions && <VersionsPanel item={versions} onClose={() => setVersions(null)} onRestore={refresh} toast={toast} />}
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </>
  );
}

/** Offline-edit conflicts — appears when the sync engine preserved a local
 *  copy because the server version changed. "Keep copy" uploads it as a new
 *  file; "Discard" drops the local version (the server copy already won). */
function ConflictsBanner({ toast, onChanged }: { toast: (m: string) => void; onChanged: () => void }) {
  const [conflicts, setConflicts] = useState<ConflictEntry[]>([]);
  const [open, setOpen] = useState(false);
  const bundled = isDesktop || isNativeMobile;

  useEffect(() => {
    if (!bundled) return;
    const load = () => void listConflicts().then(setConflicts).catch(() => {});
    load();
    window.addEventListener("kreatix:conflict", load);
    return () => window.removeEventListener("kreatix:conflict", load);
  }, [bundled]);

  if (!bundled || conflicts.length === 0) return null;
  const act = async (c: ConflictEntry, a: "keep" | "discard") => {
    try {
      await resolveConflict(c, a);
      setConflicts((cs) => cs.filter((x) => x.id !== c.id));
      toast(a === "keep" ? "Saved as a new file in Drive" : "Conflict copy discarded");
      onChanged();
    } catch (e) { toast((e as Error).message); }
  };

  return (
    <>
      <div className="billing-banner warn">
        <span><strong>{conflicts.length}</strong> offline edit{conflicts.length === 1 ? "" : "s"} conflicted with newer server changes.</span>
        <button onClick={() => setOpen(true)}>Review</button>
      </div>
      {open && (
        <div className="dlg-wrap" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="dlg modal-card">
            <h3>Conflict copies</h3>
            <p className="d-sub">These files changed on the server while you were editing offline. Your version was kept as a separate copy — nothing was lost.</p>
            {conflicts.map((c) => (
              <div key={c.id} className="conflict-row">
                <div className="conflict-main">
                  <b>{c.name}</b>
                  {c.at > 0 && <span className="d-sub">{new Date(c.at).toLocaleString()}</span>}
                </div>
                <button className="btn-ghost btn-sm" onClick={() => void act(c, "discard")}>Discard copy</button>
                <button className="btn-primary btn-sm" onClick={() => void act(c, "keep")}>Keep as new file</button>
              </div>
            ))}
            <div className="dlg-actions">
              <button className="btn-ghost" onClick={() => setOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Out-of-office delegation for approval steps — the delegate can act on
 *  your behalf while the delegation is active. */
function DelegateButton({ toast }: { toast: (m: string) => void }) {
  const [cur, setCur] = useState<{ delegateId: string | null; delegateName: string | null; until: string | null } | null>(null);
  const [people, setPeople] = useState<{ id: string; displayName: string }[]>([]);
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState("");
  useEffect(() => {
    void api.get<{ delegateId: string | null; delegateName: string | null; until: string | null }>("/api/me/delegate")
      .then(setCur).catch(() => {});
    void api.get<{ people: { id: string; displayName: string }[] }>("/api/chat/people")
      .then((r) => setPeople(r.people)).catch(() => {});
  }, []);

  const save = async (delegateId: string | null) => {
    try {
      await api.put("/api/me/delegate", { delegateId, days: 30 });
      const r = await api.get<{ delegateId: string | null; delegateName: string | null; until: string | null }>("/api/me/delegate");
      setCur(r);
      setEditing(false);
      toast(delegateId ? `Approvals delegated to ${r.delegateName} for 30 days` : "Delegation cleared");
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  if (editing) {
    return (
      <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
        <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ fontSize: 13 }}>
          <option value="">Delegate to…</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
        </select>
        <button className="btn-secondary btn-sm" disabled={!pick} onClick={() => void save(pick)}>Set</button>
        <button className="btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>
      </span>
    );
  }
  return (
    <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
      {cur?.delegateName && (
        <span className="d-sub">⇒ {cur.delegateName} until {cur.until ? new Date(cur.until).toLocaleDateString() : "—"}</span>
      )}
      <button className="btn-ghost" onClick={() => cur?.delegateId ? void save(null) : setEditing(true)}
        title="Hand your approval steps to someone while away">
        {cur?.delegateId ? "Clear delegation" : "⇒ Delegate my approvals"}
      </button>
    </span>
  );
}
