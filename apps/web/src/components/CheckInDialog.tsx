import { useState } from "react";
import type { DriveItem } from "@kreatix/shared";
import { api } from "../lib/api";
import { Modal } from "./Modal";

/** Check-in dialog — optional comment + publish-as-major choice,
 *  mirroring SharePoint's check-in flow. */
export function CheckInDialog({ item, onClose, onDone, toast }: {
  item: DriveItem;
  onClose: () => void;
  onDone: () => void;
  toast: (m: string) => void;
}) {
  const [comment, setComment] = useState("");
  const [publish, setPublish] = useState(true);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; pending?: boolean }>(`/api/drive/${item.id}/checkin`, {
        comment: comment.trim() || undefined,
        publish,
      });
      toast(r.pending ? "Checked in and submitted for owner approval"
        : publish ? "Checked in and published" : "Checked in as draft");
      onDone();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Check-in failed");
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label="Check in">
      <h2>Check in “{item.name}”</h2>
      <p className="d-sub">Releases the editing lock so others can edit again.</p>
      <div className="field">
        <label>Check-in comment <span style={{ color: "var(--muted)", fontWeight: 400 }}>(optional)</span></label>
        <input autoFocus value={comment} onChange={(e) => setComment(e.target.value)}
          placeholder="What changed?" onKeyDown={(e) => e.key === "Enter" && void submit()} />
      </div>
      <div className="field">
        <label>Version</label>
        <select value={publish ? "major" : "draft"} onChange={(e) => setPublish(e.target.value === "major")}>
          <option value="major">Publish a major version — visible to all readers</option>
          <option value="draft">Keep as draft — only editors can see it</option>
        </select>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "Checking in…" : "Check in"}
        </button>
      </div>
    </Modal>
  );
}
