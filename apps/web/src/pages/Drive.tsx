import { useEffect } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import type { DriveItem } from "@kreatix/shared";
import { useFiles, useItemActions } from "./Home";
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
        {view !== "trash" && (
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
