import { useEffect, useState } from "react";
import type { DriveItem, Library, Site } from "@kreatix/shared";
import { api } from "../lib/api";
import { Modal } from "./Modal";

interface Dest {
  key: string;
  label: string;
  parentId: string | null;
  libraryId: string | null;
  /** rename on copy (duplicate-in-place gets a " — copy" suffix) */
  name?: string;
}

/** SharePoint-style "Copy to / Move to" picker — destinations are the
 *  personal Drive root plus every site library the user can write to. */
export function CopyMoveDialog({ item, mode, onClose, onDone, toast }: {
  item: DriveItem;
  mode: "copy" | "move";
  onClose: () => void;
  onDone: () => void;
  toast: (m: string) => void;
}) {
  const [dests, setDests] = useState<Dest[] | null>(null);
  const [pick, setPick] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const out: Dest[] = [];
      if (mode === "copy") {
        out.push({
          key: "dup", label: `Here — duplicate as "${item.name} — copy"`,
          parentId: item.parentId, libraryId: item.libraryId ?? null,
          name: `${item.name} — copy`,
        });
      }
      out.push({ key: "root", label: "My Drive — root", parentId: null, libraryId: null });
      try {
        const { sites } = await api.get<{ sites: Site[] }>("/api/sites");
        const writable = sites.filter((s) => s.myRole === "owner" || s.myRole === "member");
        for (const s of writable) {
          const r = await api.get<{ libraries: Library[] }>(`/api/sites/${s.id}`);
          for (const l of r.libraries) {
            out.push({ key: l.id, label: `${s.name} / ${l.name}`, parentId: null, libraryId: l.id });
          }
        }
      } catch { /* sites list is optional — degrade to personal destinations */ }
      setDests(out);
      setPick(out[0]?.key ?? "");
    })();
  }, [item.id, item.parentId, item.libraryId, item.name, mode]);

  const submit = async () => {
    const dest = dests?.find((d) => d.key === pick);
    if (!dest || busy) return;
    setBusy(true);
    try {
      if (mode === "copy") {
        await api.post(`/api/drive/${item.id}/copy`,
          { parentId: dest.parentId, libraryId: dest.libraryId, name: dest.name });
        toast(`Copied "${item.name}"`);
      } else {
        await api.patch(`/api/drive/${item.id}`,
          { parentId: dest.parentId, libraryId: dest.libraryId });
        toast(`Moved "${item.name}"`);
      }
      onDone();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : `${mode === "copy" ? "Copy" : "Move"} failed`);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={mode === "copy" ? "Copy to" : "Move to"}>
      <h2>{mode === "copy" ? "Copy" : "Move"} “{item.name}”</h2>
      <p className="d-sub">
        {mode === "copy"
          ? "The copy starts a fresh version history and inherits the destination's permissions."
          : "Folders move with everything inside them."}
      </p>
      <div className="field">
        <label>Destination</label>
        {!dests ? <p className="d-sub">Loading destinations…</p> : (
          <select autoFocus value={pick} onChange={(e) => setPick(e.target.value)}>
            {dests.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={!dests || busy} onClick={() => void submit()}>
          {busy ? "Working…" : mode === "copy" ? "Copy" : "Move"}
        </button>
      </div>
    </Modal>
  );
}
