import { useNavigate, useParams, Link } from "react-router-dom";
import type { DriveItem } from "@kreatix/shared";
import { useFiles, useItemActions } from "./Home";
import { FileList } from "../components/FileList";
import { ShareDialog } from "../components/ShareDialog";
import { VersionsPanel } from "../components/VersionsPanel";

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

  return (
    <>
      <div className="crumbs">
        <Link to="/">Home</Link> <span>/</span>
        {folderId ? <><Link to="/drive/all">Kreatix Drive</Link> <span>/</span> <b>Folder</b></> : <b>{TITLES[view] ?? view}</b>}
      </div>
      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>{folderId ? "Folder" : TITLES[view] ?? view}</h2>
      </div>
      <FileList items={items} onOpen={open} onRefresh={refresh} onShare={setSharing} onVersions={setVersions} toast={toast} />

      {sharing && <ShareDialog item={sharing} onClose={() => setSharing(null)} toast={toast} />}
      {versions && <VersionsPanel item={versions} onClose={() => setVersions(null)} onRestore={refresh} toast={toast} />}
      {msg && <div className="toast">{msg}</div>}
    </>
  );
}
