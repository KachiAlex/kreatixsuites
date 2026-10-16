import { useEffect, useState } from "react";
import type { AccessEntry, DriveItem } from "@kreatix/shared";
import { api } from "../lib/api";
import { Modal } from "./Modal";

const PERM_LABEL: Record<string, string> = {
  owner: "Full control", editor: "Can edit", reviewer: "Can review",
  commenter: "Can comment", viewer: "Can view",
};

/** "Check access" panel (SharePoint Manage Access) — resolves every principal
 *  that can reach the item and shows *why*: site membership, group grants,
 *  library grants, direct shares, and folder-share inheritance. Type a name
 *  or email to check one person's effective access. */
export function AccessDialog({ item, onClose }: { item: DriveItem; onClose: () => void }) {
  const [access, setAccess] = useState<AccessEntry[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [check, setCheck] = useState("");

  useEffect(() => {
    void api.get<{ access: AccessEntry[]; notes: string[] }>(`/api/drive/${item.id}/access`)
      .then((r) => { setAccess(r.access); setNotes(r.notes); })
      .catch(() => setAccess([]));
  }, [item.id]);

  const needle = check.trim().toLowerCase();
  const shown = (access ?? []).filter((e) =>
    !needle || e.name.toLowerCase().includes(needle) || (e.email ?? "").toLowerCase().includes(needle));

  return (
    <Modal onClose={onClose} label="Check access">
      <h2>Access — {item.name}</h2>
      <input className="lib-search" style={{ width: "100%", marginBottom: 8 }}
        placeholder="Check a person or group — type a name or email…"
        value={check} onChange={(e) => setCheck(e.target.value)} />
      {!access && <p className="d-sub">Loading…</p>}
      {access && !shown.length && (
        <p className="empty" style={{ margin: "8px 0" }}>
          {needle ? "No access found for that person or group." : "No additional access beyond the owner."}
        </p>
      )}
      {shown.map((e) => (
        <div className="share-row" key={`${e.kind}:${e.id}`} style={{ alignItems: "flex-start" }}>
          <div className="c-av">{e.kind === "group" ? "👥" : (e.initials ?? "?")}</div>
          <div style={{ flex: 1 }}>
            <b style={{ fontSize: 12.5 }}>{e.name}</b>
            {e.kind === "group" && e.memberCount !== undefined && (
              <span style={{ fontSize: 11, color: "var(--muted)" }}> · {e.memberCount} members</span>
            )}
            {e.email && <div style={{ fontSize: 11, color: "var(--muted)" }}>{e.email}</div>}
            <div style={{ fontSize: 11, color: "var(--muted)" }}>{e.via.join(" · ")}</div>
          </div>
          <span className="perm-badge">{PERM_LABEL[e.permission] ?? e.permission}</span>
        </div>
      ))}
      {notes.length > 0 && (
        <p className="d-sub" style={{ marginTop: 10 }}>{notes.join(" ")}</p>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn-ghost btn-sm" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
