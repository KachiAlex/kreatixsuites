import { useState } from "react";
import { importMailArchive, type ImportProgress, type ImportStats } from "../lib/mailImport";
import { useToast } from "../lib/hooks";

interface Member { id: string; displayName: string; email: string }

/** Upload .mbox / .eml archives into a mailbox. Members import into their own
 *  mailbox; pass `members` (org admins) to also import into a member's. */
export function MailImportTool({ members }: { members?: Member[] }) {
  const { msg, toast } = useToast();
  const [files, setFiles] = useState<File[]>([]);
  const [folder, setFolder] = useState("Imported");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<ImportStats | null>(null);

  const run = async () => {
    if (!files.length) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await importMailArchive(files, { folder: folder.trim() || "Imported", memberId: target || undefined }, setProgress);
      setResult(r);
      setFiles([]);
      toast(`Imported ${r.imported} message${r.imported === 1 ? "" : "s"}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const pct = progress && progress.total ? Math.round((progress.sent / progress.total) * 100) : 0;

  return (
    <div>
      <div className="audit-bar" style={{ marginBottom: 8, flexWrap: "wrap" }}>
        {members && (
          <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy}
            style={{ border: "1px solid var(--line)", borderRadius: 9, padding: "7px 10px", fontSize: 12, background: "var(--surface)", maxWidth: 260 }}>
            <option value="">My mailbox</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.displayName} — {m.email}</option>)}
          </select>
        )}
        <input style={{ width: 130 }} placeholder="Folder" value={folder} disabled={busy}
          onChange={(e) => setFolder(e.target.value)} />
        <input type="file" multiple accept=".mbox,.eml,message/rfc822,application/mbox" style={{ fontSize: 12 }} disabled={busy}
          onChange={(e) => { setFiles(Array.from(e.target.files ?? [])); setResult(null); }} />
        <button className="btn-primary" disabled={!files.length || busy} onClick={() => void run()}>
          {busy ? "Importing…" : files.length ? `Import ${files.length} file${files.length === 1 ? "" : "s"}` : "Import"}
        </button>
      </div>
      {files.length > 0 && !busy && (
        <p className="d-sub" style={{ margin: "0 0 6px" }}>
          {files.map((f) => `${f.name} (${(f.size / 1048576).toFixed(1)} MB)`).join(" · ")}
        </p>
      )}
      {busy && progress && (
        <div style={{ margin: "8px 0" }}>
          <p className="d-sub" style={{ margin: "0 0 4px" }}>
            {progress.stage === "upload"
              ? `Uploading ${progress.name} (${progress.file} of ${progress.files}) — ${pct}%`
              : `Importing ${progress.name} (${progress.file} of ${progress.files}) — messages are being filed`}
          </p>
          <div style={{ height: 6, background: "var(--line)", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${progress.stage === "upload" ? pct : 100}%`, background: "var(--k-orange, #F2782E)", transition: "width .2s" }} />
          </div>
        </div>
      )}
      {msg && <p className="d-sub" style={{ margin: "6px 0 0" }}>{msg}</p>}
      {result && (
        <p className="d-sub" style={{ margin: 0 }}>
          {result.imported} imported into “{result.folder}” · {result.skipped} already there
          {result.failed ? ` · ${result.failed} could not be read` : ""}
        </p>
      )}
    </div>
  );
}
