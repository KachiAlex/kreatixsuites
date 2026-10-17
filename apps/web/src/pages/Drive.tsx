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
      <FileList items={items} onOpen={open} onRefresh={refresh} onShare={setSharing} onVersions={setVersions} toast={toast} />

      {sharing && <ShareDialog item={sharing} onClose={() => setSharing(null)} toast={toast} />}
      {versions && <VersionsPanel item={versions} onClose={() => setVersions(null)} onRestore={refresh} toast={toast} />}
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
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
