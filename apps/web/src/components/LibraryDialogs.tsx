import { useEffect, useState } from "react";
import type { ColumnType, DriveItem, LibraryColumn } from "@kreatix/shared";
import { api } from "../lib/api";
import { Modal } from "./Modal";

const COL_TYPES: { id: ColumnType; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "number", label: "Number" },
  { id: "date", label: "Date" },
  { id: "choice", label: "Choice" },
  { id: "person", label: "Person" },
  { id: "yesno", label: "Yes/No" },
];

/** Manage a library's custom columns — site owners only. */
export function ColumnsDialog({ siteId, libId, columns, onClose, onChange, toast }: {
  siteId: string; libId: string;
  columns: LibraryColumn[];
  onClose: () => void;
  onChange: (cols: LibraryColumn[]) => void;
  toast: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<ColumnType>("text");
  const [required, setRequired] = useState(false);
  const [choices, setChoices] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/api/sites/${siteId}/libraries/${libId}/columns`;

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const r = await api.post<{ column: LibraryColumn }>(base, {
        name: name.trim(), type, required,
        choices: type === "choice" ? choices.split(",").map((c) => c.trim()).filter(Boolean) : undefined,
      });
      onChange([...columns, r.column]);
      setName(""); setChoices(""); setRequired(false);
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
    setBusy(false);
  };

  const remove = async (c: LibraryColumn) => {
    if (!confirm(`Delete column "${c.name}"? Its values are removed from all items.`)) return;
    try {
      await api.del(`${base}/${c.id}`);
      onChange(columns.filter((x) => x.id !== c.id));
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  return (
    <Modal onClose={onClose} label="Library columns">
      <h2>Library columns</h2>
      <p className="d-sub">Columns add SharePoint-style metadata to every file in this library.</p>
      {columns.map((c) => (
        <div key={c.id} className="dlg-row">
          <b style={{ flex: 1 }}>{c.name}</b>
          <span className="perm-badge">{c.type}{c.required ? " · required" : ""}</span>
          <button className="btn-ghost btn-sm" onClick={() => void remove(c)}>✕</button>
        </div>
      ))}
      {!columns.length && <p className="empty" style={{ margin: "8px 0" }}>No columns yet.</p>}
      <div className="field"><label>New column</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Department, Due date" />
      </div>
      <div className="dlg-row">
        <label>Type</label>
        <select value={type} onChange={(e) => setType(e.target.value as ColumnType)}>
          {COL_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </div>
      {type === "choice" && (
        <div className="dlg-row">
          <label>Choices</label>
          <input value={choices} onChange={(e) => setChoices(e.target.value)} placeholder="Comma-separated" />
        </div>
      )}
      <div className="dlg-row">
        <label>Required</label>
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)}
          style={{ flex: "none" }} />
        <span style={{ fontSize: 11, color: "var(--muted)" }}>Must be filled before check-in</span>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn-primary btn-sm" disabled={busy || !name.trim()} onClick={() => void add()}>Add column</button>
        <button className="btn-ghost btn-sm" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

/** Edit a library item's custom-column values ("Properties" in SharePoint). */
export function PropertiesDialog({ item, siteId, libId, columns, onClose, onDone, toast }: {
  item: DriveItem; siteId: string; libId: string;
  columns: LibraryColumn[];
  onClose: () => void;
  onDone: () => void;
  toast: (m: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const init: Record<string, string> = {};
    for (const c of columns) init[c.id] = item.metadata?.[c.id] ?? "";
    setValues(init);
  }, [item, columns]);
  void siteId; void libId;

  const save = async () => {
    setBusy(true);
    try {
      const payload: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(values)) payload[k] = v === "" ? null : v;
      await api.patch(`/api/drive/${item.id}/metadata`, { values: payload });
      toast("Properties saved");
      onDone();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed");
      setBusy(false);
    }
  };

  const field = (c: LibraryColumn) => {
    const v = values[c.id] ?? "";
    const set = (nv: string) => setValues((s) => ({ ...s, [c.id]: nv }));
    if (c.type === "yesno") return (
      <select value={v} onChange={(e) => set(e.target.value)}>
        <option value="">—</option><option value="yes">Yes</option><option value="no">No</option>
      </select>
    );
    if (c.type === "choice") return (
      <select value={v} onChange={(e) => set(e.target.value)}>
        <option value="">—</option>
        {(c.choices ?? []).map((ch) => <option key={ch} value={ch}>{ch}</option>)}
      </select>
    );
    return <input type={c.type === "number" ? "number" : c.type === "date" ? "date" : "text"}
      value={v} onChange={(e) => set(e.target.value)} />;
  };

  return (
    <Modal onClose={onClose} label="Properties">
      <h2>Properties — {item.name}</h2>
      {columns.map((c) => (
        <div className="dlg-row" key={c.id}>
          <label>{c.name}{c.required ? " *" : ""}</label>
          {field(c)}
        </div>
      ))}
      {!columns.length && <p className="empty" style={{ margin: "8px 0" }}>This library has no custom columns yet.</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
