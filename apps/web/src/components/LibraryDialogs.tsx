import { useEffect, useState } from "react";
import type { ColumnType, ContentType, DriveItem, FileKind, GroupGrant, Library, LibraryColumn, LibraryGrant, OrgGroup, SiteRole, TermSet } from "@kreatix/shared";
import { api } from "../lib/api";
import { Modal } from "./Modal";

const COL_TYPES: { id: ColumnType; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "number", label: "Number" },
  { id: "date", label: "Date" },
  { id: "choice", label: "Choice" },
  { id: "person", label: "Person" },
  { id: "yesno", label: "Yes/No" },
  { id: "managed", label: "Managed metadata" },
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
  const [termSets, setTermSets] = useState<TermSet[]>([]);
  const [termSetId, setTermSetId] = useState("");
  const [editSet, setEditSet] = useState<string | null>(null); // set being term-edited
  const [newTerm, setNewTerm] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/api/sites/${siteId}/libraries/${libId}/columns`;

  const loadTermSets = async () => {
    const r = await api.get<{ termSets: TermSet[] }>("/api/termsets");
    setTermSets(r.termSets);
    if (!termSetId && r.termSets[0]) setTermSetId(r.termSets[0].id);
  };
  useEffect(() => { void loadTermSets().catch(() => {}); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  const add = async () => {
    if (!name.trim()) return;
    if (type === "managed" && !termSetId) { toast("Pick a term set"); return; }
    setBusy(true);
    try {
      const r = await api.post<{ column: LibraryColumn }>(base, {
        name: name.trim(), type, required,
        choices: type === "choice" ? choices.split(",").map((c) => c.trim()).filter(Boolean) : undefined,
        termSetId: type === "managed" ? termSetId : undefined,
      });
      onChange([...columns, r.column]);
      setName(""); setChoices(""); setRequired(false);
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
    setBusy(false);
  };

  const createTermSet = async () => {
    const n = prompt("New term set name:", "Departments")?.trim();
    if (!n) return;
    try {
      await api.post("/api/termsets", { name: n });
      await loadTermSets();
      toast("Term set created");
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  const addTerm = async (setId: string) => {
    if (!newTerm.trim()) return;
    try {
      await api.post(`/api/termsets/${setId}/terms`, { name: newTerm.trim() });
      setNewTerm("");
      await loadTermSets();
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  const removeTerm = async (setId: string, termId: string) => {
    try {
      await api.del(`/api/termsets/${setId}/terms/${termId}`);
      await loadTermSets();
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  const removeTermSet = async (id: string, n: string) => {
    if (!confirm(`Delete term set "${n}"? Managed columns using it lose validation.`)) return;
    try {
      await api.del(`/api/termsets/${id}`);
      await loadTermSets();
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
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
          <span className="perm-badge">{c.type}
            {c.type === "managed" && c.termSetId
              ? ` · ${termSets.find((s) => s.id === c.termSetId)?.name ?? "set"}` : ""}
            {c.required ? " · required" : ""}</span>
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
      {type === "managed" && (
        <>
          <div className="dlg-row">
            <label>Term set</label>
            <select value={termSetId} onChange={(e) => setTermSetId(e.target.value)} style={{ flex: 1 }}>
              {!termSets.length && <option value="">— none yet —</option>}
              {termSets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button className="btn-ghost btn-sm" onClick={() => void createTermSet()}>＋</button>
          </div>
          {termSets.map((s) => (
            <div key={s.id} style={{ paddingLeft: 8 }}>
              <div className="dlg-row" style={{ gap: 6 }}>
                <b style={{ flex: 1, fontSize: 12.5 }}>{s.name}
                  <span style={{ color: "var(--muted)", fontWeight: 400 }}> · {s.terms?.length ?? 0} terms</span>
                </b>
                <button className="btn-ghost btn-sm" onClick={() => setEditSet(editSet === s.id ? null : s.id)}>
                  {editSet === s.id ? "Hide" : "Terms"}
                </button>
                <button className="btn-ghost btn-sm" onClick={() => void removeTermSet(s.id, s.name)}>✕</button>
              </div>
              {editSet === s.id && (
                <div style={{ padding: "6px 0 6px 14px", borderLeft: "2px solid var(--border)" }}>
                  {(s.terms ?? []).map((t) => (
                    <div className="dlg-row" key={t.id} style={{ gap: 6 }}>
                      <span style={{ flex: 1 }}>{t.name}</span>
                      <button className="btn-ghost btn-sm" onClick={() => void removeTerm(s.id, t.id)}>✕</button>
                    </div>
                  ))}
                  <div className="dlg-row" style={{ gap: 6 }}>
                    <input value={newTerm} onChange={(e) => setNewTerm(e.target.value)}
                      placeholder="New term…" style={{ flex: 1 }} />
                    <button className="btn-ghost btn-sm" onClick={() => void addTerm(s.id)}>Add</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </>
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

/** Unique-permissions manager — SharePoint's "stop inheriting permissions":
 *  toggles library inheritance and manages per-library grants. Owners only. */
export function PermsDialog({ siteId, lib, onClose, onChange, toast }: {
  siteId: string; lib: Library;
  onClose: () => void;
  onChange: (lib: Library) => void;
  toast: (m: string) => void;
}) {
  const base = `/api/sites/${siteId}/libraries/${lib.id}`;
  const [grants, setGrants] = useState<LibraryGrant[]>([]);
  const [groupGrants, setGroupGrants] = useState<GroupGrant[]>([]);
  const [allGroups, setAllGroups] = useState<OrgGroup[]>([]);
  const [pickGroup, setPickGroup] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<SiteRole>("member");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await api.get<{ inherit: boolean; grants: LibraryGrant[]; groupGrants?: GroupGrant[] }>(`${base}/permissions`);
    setGrants(r.grants);
    setGroupGrants(r.groupGrants ?? []);
  };
  useEffect(() => {
    void load().catch(() => {});
    void api.get<{ groups: OrgGroup[] }>("/api/groups")
      .then((r) => setAllGroups(r.groups)).catch(() => {});
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [base]);

  const setInherit = async (inherit: boolean) => {
    if (!inherit && !confirm(
      `Stop inheriting permissions? Only people you grant below — plus site owners — will see "${lib.name}".`)) return;
    try {
      const r = await api.patch<{ library: Library }>(base, { inherit });
      onChange(r.library);
      toast(inherit ? "Inheriting permissions from the site" : "Unique permissions enabled");
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  const add = async () => {
    if (!email.trim() || busy) return;
    setBusy(true);
    try {
      await api.post(`${base}/permissions`, { email: email.trim(), role });
      setEmail("");
      await load();
      toast("Access granted");
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
    setBusy(false);
  };

  const remove = async (g: LibraryGrant) => {
    try {
      await api.del(`${base}/permissions/${g.userId}`);
      setGrants((l) => l.filter((x) => x.userId !== g.userId));
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  const updateRole = async (g: LibraryGrant, r: SiteRole) => {
    try {
      await api.post(`${base}/permissions`, { email: g.user.email, role: r });
      setGrants((l) => l.map((x) => (x.userId === g.userId ? { ...x, role: r } : x)));
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  const addGroup = async () => {
    if (!pickGroup || busy) return;
    setBusy(true);
    try {
      await api.post(`${base}/permissions`, { groupId: pickGroup, role });
      setPickGroup("");
      await load();
      toast("Group granted");
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
    setBusy(false);
  };

  const setGroupRole = async (g: GroupGrant, r: SiteRole) => {
    try {
      await api.post(`${base}/permissions`, { groupId: g.groupId, role: r });
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  const removeGroup = async (g: GroupGrant) => {
    try {
      await api.del(`${base}/permissions/groups/${g.groupId}`);
      setGroupGrants((l) => l.filter((x) => x.groupId !== g.groupId));
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  return (
    <Modal onClose={onClose} label="Library permissions">
      <h2>Permissions — {lib.name}</h2>
      <div className="dlg-row">
        <label style={{ flex: 1 }}>Inherit permissions from the site</label>
        <input type="checkbox" checked={lib.inheritPermissions !== false}
          onChange={(e) => void setInherit(e.target.checked)} style={{ flex: "none" }} />
      </div>
      {lib.inheritPermissions !== false ? (
        <p className="d-sub">Everyone's site role applies — owners manage, members edit, visitors view.</p>
      ) : (
        <>
          <p className="d-sub">Unique permissions — only the people below (and site owners) can open this library.</p>
          <div className="field" style={{ display: "flex", gap: 8 }}>
            <input style={{ flex: 1 }} value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@company.com" onKeyDown={(e) => e.key === "Enter" && void add()} />
            <select value={role} onChange={(e) => setRole(e.target.value as SiteRole)} style={{ width: 110 }}>
              <option value="member">Member</option>
              <option value="owner">Owner</option>
              <option value="visitor">Visitor</option>
            </select>
            <button className="btn-primary btn-sm" disabled={busy} onClick={() => void add()}>Add</button>
          </div>
          {grants.map((g) => (
            <div className="share-row" key={g.userId}>
              <div className="c-av">{g.user.initials}</div>
              <div>
                <b style={{ fontSize: 12.5 }}>{g.user.displayName}</b>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>{g.user.email}</div>
              </div>
              <select value={g.role} style={{ marginLeft: "auto", width: 100, height: 30, fontSize: 11.5 }}
                onChange={(e) => void updateRole(g, e.target.value as SiteRole)}>
                <option value="owner">Owner</option>
                <option value="member">Member</option>
                <option value="visitor">Visitor</option>
              </select>
              <button className="x" onClick={() => void remove(g)}>✕</button>
            </div>
          ))}
          {groupGrants.map((g) => (
            <div className="share-row" key={g.groupId}>
              <div className="c-av">👥</div>
              <div>
                <b style={{ fontSize: 12.5 }}>{g.name}</b>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>{g.memberCount} member{g.memberCount === 1 ? "" : "s"}</div>
              </div>
              <select value={g.role} style={{ marginLeft: "auto", width: 100, height: 30, fontSize: 11.5 }}
                onChange={(e) => void setGroupRole(g, e.target.value as SiteRole)}>
                <option value="owner">Owner</option>
                <option value="member">Member</option>
                <option value="visitor">Visitor</option>
              </select>
              <button className="x" onClick={() => void removeGroup(g)}>✕</button>
            </div>
          ))}
          {allGroups.filter((g) => !groupGrants.some((x) => x.groupId === g.id)).length > 0 && (
            <div className="field" style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <select style={{ flex: 1 }} value={pickGroup} onChange={(e) => setPickGroup(e.target.value)}>
                <option value="">Grant a group…</option>
                {allGroups.filter((g) => !groupGrants.some((x) => x.groupId === g.id))
                  .map((g) => <option key={g.id} value={g.id}>{g.name} ({g.memberCount ?? 0})</option>)}
              </select>
              <button className="btn-ghost btn-sm" disabled={!pickGroup || busy} onClick={() => void addGroup()}>Add group</button>
            </div>
          )}
          {!grants.length && !groupGrants.length && <p className="empty" style={{ margin: "8px 0" }}>No grants yet — only site owners can see this library.</p>}
        </>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn-ghost btn-sm" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

/** Edit a library item's custom-column values ("Properties" in SharePoint). */
export function PropertiesDialog({ item, siteId, libId, columns, ctColumns, onClose, onDone, toast }: {
  item: DriveItem; siteId: string; libId: string;
  columns: LibraryColumn[];
  /** bound columns of the item's content type — merges into required flags */
  ctColumns?: { columnId: string; required: boolean }[];
  onClose: () => void;
  onDone: () => void;
  toast: (m: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [termSets, setTermSets] = useState<TermSet[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const init: Record<string, string> = {};
    for (const c of columns) init[c.id] = item.metadata?.[c.id] ?? "";
    setValues(init);
    if (columns.some((c) => c.type === "managed")) {
      void api.get<{ termSets: TermSet[] }>("/api/termsets")
        .then((r) => setTermSets(r.termSets)).catch(() => {});
    }
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
    if (c.type === "managed") {
      const terms = termSets.find((s) => s.id === c.termSetId)?.terms ?? [];
      return (
        <select value={v} onChange={(e) => set(e.target.value)}>
          <option value="">—</option>
          {terms.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
        </select>
      );
    }
    return <input type={c.type === "number" ? "number" : c.type === "date" ? "date" : "text"}
      value={v} onChange={(e) => set(e.target.value)} />;
  };

  return (
    <Modal onClose={onClose} label="Properties">
      <h2>Properties — {item.name}</h2>
      {columns.map((c) => {
        const req = c.required || ctColumns?.some((b) => b.columnId === c.id && b.required);
        return (
          <div className="dlg-row" key={c.id}>
            <label>{c.name}{req ? " *" : ""}</label>
            {field(c)}
          </div>
        );
      })}
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

/** Content type manager — reusable document schemas (SharePoint). Owners only.
 *  In library scope (`libraryId` set) it also manages the type's bound columns. */
export function ContentTypeDialog({ siteId, libraryId, columns, onClose, toast }: {
  siteId: string; libraryId?: string;
  /** library columns — needed to render the binding editor (library scope only) */
  columns?: LibraryColumn[];
  onClose: () => void;
  toast: (m: string) => void;
}) {
  const base = libraryId
    ? `/api/sites/${siteId}/libraries/${libraryId}/content-types`
    : `/api/sites/${siteId}/content-types`;
  const [types, setTypes] = useState<ContentType[]>([]);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [allowed, setAllowed] = useState<FileKind[]>(["writer", "sheets", "present", "pdf", "file"]);
  const [isDefault, setIsDefault] = useState(false);
  const [docSet, setDocSet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editCols, setEditCols] = useState<string | null>(null);   // ct.id being bound

  const load = async () => {
    const r = await api.get<{ contentTypes: ContentType[] }>(base);
    setTypes(r.contentTypes);
  };
  useEffect(() => { void load().catch(() => {}); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [base]);

  const add = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await api.post(base, {
        name: name.trim(), description: desc.trim() || null,
        allowedKinds: docSet ? ["folder"] : allowed, isDefault, docSet,
      });
      setName("");
      setDesc("");
      setDocSet(false);
      await load();
      toast("Content type created");
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
    setBusy(false);
  };

  const remove = async (ct: ContentType) => {
    if (!confirm(`Delete "${ct.name}"?`)) return;
    try {
      await api.del(`${base}/${ct.id}`);
      setTypes((l) => l.filter((x) => x.id !== ct.id));
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  const toggleKind = (k: FileKind) => {
    setAllowed((a) => a.includes(k) ? a.filter((x) => x !== k) : [...a, k]);
  };

  /** Persist a type's column bindings (library scope only). */
  const saveBinds = async (ct: ContentType, binds: { columnId: string; required: boolean; shared?: boolean }[]) => {
    try {
      const r = await api.put<{ columns: { columnId: string; required: boolean; shared: boolean; position: number }[] }>(
        `${base}/${ct.id}/columns`,
        { columns: binds.map((b, i) => ({ columnId: b.columnId, required: b.required, shared: !!b.shared, position: i })) });
      setTypes((l) => l.map((x) => (x.id === ct.id ? { ...x, columns: r.columns } : x)));
      toast("Columns bound");
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  return (
    <Modal onClose={onClose} label="Content types">
      <h2>Content types</h2>
      <p className="d-sub">Reusable document schemas with allowed file kinds.</p>
      <div className="field">
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Contract, Invoice" />
      </div>
      <div className="field">
        <label>Description</label>
        <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Optional description" />
      </div>
      <div className="dlg-row">
        <label>Document set (folder container with shared columns)</label>
        <input type="checkbox" checked={docSet} onChange={(e) => setDocSet(e.target.checked)} />
      </div>
      {!docSet && (
        <div className="field">
          <label>Allowed kinds</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(["writer", "sheets", "present", "pdf", "file"] as FileKind[]).map((k) => (
              <label key={k} style={{ fontSize: 12.5 }}>
                <input type="checkbox" checked={allowed.includes(k)} onChange={() => toggleKind(k)} />
                {" "}{k}
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="dlg-row">
        <label>Default for new items</label>
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
      </div>
      <button className="btn-primary btn-sm" disabled={busy || !name.trim()} onClick={() => void add()}>
        {busy ? "Creating…" : "Create"}
      </button>
      <div style={{ marginTop: 16 }}>
        {types.map((ct) => (
          <div key={ct.id}>
            <div className="share-row">
              <b style={{ fontSize: 12.5 }}>{ct.name}</b>
              <span style={{ marginLeft: 8, fontSize: 11, color: "var(--muted)" }}>
                {ct.libraryId === null ? "site · " : ""}{ct.allowedKinds.join(", ")}
              </span>
              {ct.docSet && <span className="perm-badge" style={{ marginLeft: 8 }}>🗂 set</span>}
              {ct.isDefault && <span className="perm-badge" style={{ marginLeft: 8 }}>default</span>}
              {libraryId && columns && (
                <button className="btn-ghost btn-sm" style={{ marginLeft: "auto" }}
                  onClick={() => setEditCols(editCols === ct.id ? null : ct.id)}>
                  {ct.columns?.length ? `${ct.columns.length} cols` : "Columns"}
                </button>
              )}
              <button className="x" style={libraryId && columns ? {} : { marginLeft: "auto" }}
                onClick={() => void remove(ct)}>✕</button>
            </div>
            {editCols === ct.id && libraryId && columns && (
              <div style={{ padding: "8px 0 8px 16px", borderLeft: "2px solid var(--border)" }}>
                {columns.map((c) => {
                  const bound = ct.columns?.find((b) => b.columnId === c.id);
                  return (
                    <div className="dlg-row" key={c.id} style={{ gap: 6 }}>
                      <input type="checkbox" checked={!!bound}
                        onChange={(e) => {
                          const cur = ct.columns ?? [];
                          const next = e.target.checked
                            ? [...cur, { columnId: c.id, required: false, shared: false }]
                            : cur.filter((b) => b.columnId !== c.id);
                          void saveBinds(ct, next);
                        }} />
                      <label style={{ flex: 1 }}>{c.name} <span style={{ color: "var(--muted)", fontSize: 11 }}>({c.type})</span></label>
                      {bound && (
                        <label style={{ fontSize: 11.5 }}>
                          required{" "}
                          <input type="checkbox" checked={bound.required}
                            onChange={(e) => {
                              const next = (ct.columns ?? []).map((b) =>
                                b.columnId === c.id ? { ...b, required: e.target.checked } : b);
                              void saveBinds(ct, next);
                            }} />
                        </label>
                      )}
                      {bound && ct.docSet && (
                        <label style={{ fontSize: 11.5 }} title="Children of this document set inherit the set's value">
                          shared{" "}
                          <input type="checkbox" checked={!!bound.shared}
                            onChange={(e) => {
                              const next = (ct.columns ?? []).map((b) =>
                                b.columnId === c.id ? { ...b, shared: e.target.checked } : b);
                              void saveBinds(ct, next);
                            }} />
                        </label>
                      )}
                    </div>
                  );
                })}
                {!columns.length && <p className="d-sub">Add library columns first to bind them.</p>}
              </div>
            )}
          </div>
        ))}
        {!types.length && <p className="empty" style={{ margin: "8px 0" }}>No content types yet.</p>}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn-ghost btn-sm" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

// ---- policy presets (one-click governance) ----

interface Preset {
  id: string;
  name: string;
  desc: string;
  patch: { versioning: "major" | "minor"; approval: boolean; retentionDays: number | null };
}

const PRESETS: Preset[] = [
  {
    id: "collab", name: "Collaboration",
    desc: "Open editing — major versions only, no approval gate. Default for team work.",
    patch: { versioning: "major", approval: false, retentionDays: null },
  },
  {
    id: "managed", name: "Managed documents",
    desc: "Draft → publish workflow: minor versions and owner approval before anything goes live.",
    patch: { versioning: "minor", approval: true, retentionDays: null },
  },
  {
    id: "records", name: "Records",
    desc: "Managed + retention: approval required, items untouched for 2 years move to the recycle bin.",
    patch: { versioning: "minor", approval: true, retentionDays: 730 },
  },
];

/** Detect which preset the library currently matches (null = custom). */
export function presetFor(lib: Library | null): string | null {
  if (!lib) return null;
  const hit = PRESETS.find((p) =>
    p.patch.versioning === (lib.versioning ?? "major")
    && p.patch.approval === !!lib.approval
    && (p.patch.retentionDays ?? null) === (lib.retentionDays ?? null));
  return hit?.id ?? null;
}

/** One-click governance presets — sets versioning + approval + retention in a
 *  single PATCH instead of three separate toggles. Site owners only. */
export function PresetDialog({ siteId, lib, onClose, onChange, toast }: {
  siteId: string; lib: Library;
  onClose: () => void;
  onChange: (lib: Library) => void;
  toast: (m: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(presetFor(lib));
  const [busy, setBusy] = useState(false);
  void siteId;

  const apply = async () => {
    const p = PRESETS.find((x) => x.id === picked);
    if (!p || busy) return;
    setBusy(true);
    try {
      const r = await api.patch<{ library: Library }>(
        `/api/sites/${siteId}/libraries/${lib.id}`, p.patch);
      onChange(r.library);
      toast(`"${p.name}" policy applied`);
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed");
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label="Policy presets">
      <h2>Policy presets — {lib.name}</h2>
      <p className="d-sub">One click applies a governance profile (versioning, approval, retention). Individual settings stay adjustable afterwards.</p>
      {PRESETS.map((p) => (
        <button key={p.id} className="site-card" style={{ width: "100%", textAlign: "left", marginBottom: 6,
          outline: picked === p.id ? "2px solid var(--k-orange)" : "none" }}
          onClick={() => setPicked(p.id)}>
          <span className="site-card-ico">{picked === p.id ? "●" : "○"}</span>
          <span className="site-card-body">
            <b>{p.name}</b>
            <span>{p.desc}</span>
          </span>
        </button>
      ))}
      {presetFor(lib) === null && picked === null && (
        <p className="d-sub">This library currently has a custom mix of settings.</p>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={!picked || busy || picked === presetFor(lib)} onClick={() => void apply()}>
          {busy ? "Applying…" : "Apply preset"}
        </button>
      </div>
    </Modal>
  );
}
