// Unified export dialog — one consistent surface across Writer / Sheets /
// Present. Each format can produce a file (Download or Save-to-Drive) or run
// an interactive action (print dialogs, layout pickers). Long-running
// producers report progress text under the row.
import { useState } from "react";
import { api } from "../lib/api";
import { saveFile } from "../lib/saveFile";
import { Modal } from "./Modal";

export interface ExportResult { name: string; blob: Blob }

export interface ExportFormat {
  id: string;
  label: string;
  hint?: string;
  /** Produces file bytes — enables Download + Save to Drive. */
  produce?: (progress: (m: string) => void) => Promise<ExportResult>;
  /** Interactive path (print dialog, layout picker…). */
  action?: { label: string; run: () => void | Promise<void> };
}

const base = (n: string) => n.replace(/\.[^.]+$/, "");

export function ExportDialog({ docName, formats, onClose, toast }: {
  docName: string;
  formats: ExportFormat[];
  onClose: () => void;
  toast: (m: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [prog, setProg] = useState("");

  const go = async (f: ExportFormat, target: "download" | "drive" | "action") => {
    if (busy) return;
    setBusy(`${f.id}:${target}`);
    setProg("");
    try {
      if (target === "action") {
        await f.action!.run();
        onClose();
        return;
      }
      // a stuck producer used to leave the dialog greyed out with no message
      const out = await Promise.race([
        f.produce!((m) => setProg(m)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out — try again")), 300_000)),
      ]);
      if (target === "download") {
        if (await saveFile(out.blob, out.name)) toast(`Downloaded ${out.name}`);
      } else {
        const kind = /\.pdf$/i.test(out.name) ? "pdf" : "file";
        await api.upload(`/api/drive/upload?name=${encodeURIComponent(out.name)}&kind=${kind}`, out.blob);
        toast(`Saved to Drive — ${out.name}`);
      }
    } catch (e) {
      toast(e instanceof Error && e.message ? `Export failed: ${e.message.slice(0, 80)}` : "Export failed");
    } finally {
      setBusy(null);
      setProg("");
    }
  };

  return (
    <Modal onClose={onClose} label={`Export ${docName}`} className="export-dlg">
      <h2>Export "{base(docName)}"</h2>
      <p className="d-sub">Download a copy or save it straight into Drive.</p>
      <div className="export-list">
        {formats.map((f) => (
          <div className="export-row" key={f.id}>
            <div className="export-info">
              <b>{f.label}</b>
              {f.hint && <small>{f.hint}</small>}
              {busy?.startsWith(`${f.id}:`) && prog && <small className="export-prog">{prog}</small>}
            </div>
            <div className="export-actions">
              {f.produce && <>
                <button className="rb" disabled={!!busy} onClick={() => void go(f, "download")}
                  title={`Download ${f.label}`}>⤓ Download</button>
                <button className="rb" disabled={!!busy} onClick={() => void go(f, "drive")}
                  title="Upload a copy into Kreatix Drive">⤴ Drive</button>
              </>}
              {f.action &&
                <button className="rb" disabled={!!busy} onClick={() => void go(f, "action")}>{f.action.label}</button>}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
