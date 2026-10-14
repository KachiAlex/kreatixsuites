import { useState } from "react";
import type { Site, SiteType } from "@kreatix/shared";
import { api } from "../lib/api";
import { Modal } from "./Modal";

const TYPES: { id: SiteType; label: string; hint: string }[] = [
  { id: "team", label: "Team site", hint: "Shared documents and collaboration for a group" },
  { id: "project", label: "Project site", hint: "Files and resources for a specific project" },
  { id: "department", label: "Department site", hint: "A home for a department's files" },
  { id: "communication", label: "Communication site", hint: "Broadcast content to a wide audience" },
];

export function NewSiteDialog({ onClose, onCreated, toast }: {
  onClose: () => void;
  onCreated: (site: Site) => void;
  toast: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<SiteType>("team");
  const [visibility, setVisibility] = useState<"org" | "private">("org");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ site: Site }>("/api/sites", {
        name: name.trim(), description: description.trim() || null, type, visibility,
      });
      window.dispatchEvent(new Event("kreatix:sites"));
      onCreated(r.site);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not create site");
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label="New site">
      <h2>New site</h2>
      <p className="d-sub">A site is a shared space with its own document libraries, members and permissions.</p>
      <div className="field">
        <label>Site name</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Marketing, Acme project" onKeyDown={(e) => e.key === "Enter" && void create()} />
      </div>
      <div className="field">
        <label>Description <span style={{ color: "var(--muted)", fontWeight: 400 }}>(optional)</span></label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this site for?" />
      </div>
      <div className="field">
        <label>Type</label>
        <select value={type} onChange={(e) => setType(e.target.value as SiteType)}>
          {TYPES.map((tp) => <option key={tp.id} value={tp.id}>{tp.label} — {tp.hint}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Visibility</label>
        <select value={visibility} onChange={(e) => setVisibility(e.target.value as "org" | "private")}>
          <option value="org">Organization — everyone in the workspace can view</option>
          <option value="private">Private — members only</option>
        </select>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={!name.trim() || busy} onClick={() => void create()}>
          {busy ? "Creating…" : "Create site"}
        </button>
      </div>
    </Modal>
  );
}
