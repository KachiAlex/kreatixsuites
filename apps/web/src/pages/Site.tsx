import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Library, Site, SiteMember, SiteRole } from "@kreatix/shared";
import { api } from "../lib/api";
import { useToast } from "../lib/hooks";
import { Modal } from "../components/Modal";

const TYPE_LABEL: Record<Site["type"], string> = {
  team: "Team site", project: "Project site",
  department: "Department site", communication: "Communication site",
};

export function SitePage() {
  const { siteId = "" } = useParams();
  const navigate = useNavigate();
  const { msg, toast } = useToast();
  const [site, setSite] = useState<Site | null>(null);
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [members, setMembers] = useState<SiteMember[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [libDlg, setLibDlg] = useState(false);
  const [memberDlg, setMemberDlg] = useState(false);
  const [settingsDlg, setSettingsDlg] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ site: Site; libraries: Library[] }>(`/api/sites/${siteId}`);
      setSite(r.site);
      setLibraries(r.libraries);
      const m = await api.get<{ members: SiteMember[] }>(`/api/sites/${siteId}/members`);
      setMembers(m.members);
    } catch { setNotFound(true); }
  }, [siteId]);
  useEffect(() => { void load(); }, [load]);

  if (notFound) return <div className="panel"><div className="empty">Site not found or you don't have access.</div></div>;
  if (!site) return <div className="empty">Loading…</div>;

  const canManage = site.myRole === "owner";
  const canWrite = site.myRole === "owner" || site.myRole === "member";

  return (
    <>
      <div className="crumbs">
        <Link to="/home">Home</Link> <span>/</span> <Link to="/sites">Sites</Link> <span>/</span> <b>{site.name}</b>
      </div>

      <div className="site-head panel">
        <div>
          <h2 style={{ margin: 0 }}>{site.name}</h2>
          <p className="d-sub" style={{ margin: "4px 0 0" }}>
            {TYPE_LABEL[site.type]} · {site.visibility === "private" ? "Private — members only" : "Organization"} · {site.memberCount ?? members.length} member{(site.memberCount ?? members.length) === 1 ? "" : "s"}
          </p>
          {site.description && <p style={{ margin: "6px 0 0", fontSize: 12.5 }}>{site.description}</p>}
        </div>
        <div className="site-head-actions">
          <div className="people" title="Members">
            {members.slice(0, 5).map((m) => <span key={m.userId} title={`${m.user.displayName} — ${m.role}`}>{m.user.initials}</span>)}
          </div>
          <button className="btn-ghost btn-sm" onClick={() => setMemberDlg(true)}>Members</button>
          {canManage && <button className="btn-ghost btn-sm" onClick={() => setSettingsDlg(true)}>Settings</button>}
        </div>
      </div>

      <div className="section-head">
        <h2>Document libraries</h2>
        {canWrite && (
          <button className="btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={() => setLibDlg(true)}>
            ＋ New library
          </button>
        )}
      </div>

      <div className="site-grid">
        {libraries.map((l) => (
          <button key={l.id} className="site-card" onClick={() => navigate(`/sites/${site.id}/library/${l.id}`)}>
            <span className="site-card-ico">🗂</span>
            <span className="site-card-body">
              <b>{l.name}</b>
              <span>{l.itemCount ?? 0} item{(l.itemCount ?? 0) === 1 ? "" : "s"} · {l.kind}</span>
            </span>
            <span style={{ color: "var(--muted)" }}>›</span>
          </button>
        ))}
      </div>

      {libDlg && <NewLibraryDialog siteId={site.id} toast={toast} onClose={() => setLibDlg(false)}
        onCreated={(l) => { setLibDlg(false); navigate(`/sites/${site.id}/library/${l.id}`); }} />}
      {memberDlg && <MembersDialog site={site} members={members} canManage={canManage}
        toast={toast} onClose={() => { setMemberDlg(false); void load(); }} />}
      {settingsDlg && <SiteSettingsDialog site={site} toast={toast}
        onClose={() => { setSettingsDlg(false); void load(); }}
        onDeleted={() => navigate("/sites")} />}
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </>
  );
}

function NewLibraryDialog({ siteId, onClose, onCreated, toast }: {
  siteId: string; onClose: () => void; onCreated: (l: Library) => void; toast: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Library["kind"]>("documents");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ library: Library }>(`/api/sites/${siteId}/libraries`, { name: name.trim(), kind });
      onCreated(r.library);
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); setBusy(false); }
  };
  return (
    <Modal onClose={onClose} label="New document library">
      <h2>New document library</h2>
      <div className="field">
        <label>Name</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Contracts, Marketing assets" onKeyDown={(e) => e.key === "Enter" && void create()} />
      </div>
      <div className="field">
        <label>Kind</label>
        <select value={kind} onChange={(e) => setKind(e.target.value as Library["kind"])}>
          <option value="documents">Documents</option>
          <option value="media">Media assets</option>
          <option value="form">Forms</option>
        </select>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={!name.trim() || busy} onClick={() => void create()}>
          {busy ? "Creating…" : "Create library"}
        </button>
      </div>
    </Modal>
  );
}

function MembersDialog({ site, members, canManage, onClose, toast }: {
  site: Site; members: SiteMember[]; canManage: boolean;
  onClose: () => void; toast: (m: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<SiteRole>("member");
  const [list, setList] = useState(members);

  const reload = async () => {
    const r = await api.get<{ members: SiteMember[] }>(`/api/sites/${site.id}/members`);
    setList(r.members);
  };

  const add = async () => {
    if (!email.trim()) return;
    try {
      await api.post(`/api/sites/${site.id}/members`, { email: email.trim(), role });
      setEmail("");
      await reload();
      toast("Member added");
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  const setMemberRole = async (m: SiteMember, r: SiteRole) => {
    try {
      await api.patch(`/api/sites/${site.id}/members/${m.userId}`, { role: r });
      await reload();
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  const remove = async (m: SiteMember) => {
    if (!confirm(`Remove ${m.user.displayName} from this site?`)) return;
    try {
      await api.del(`/api/sites/${site.id}/members/${m.userId}`);
      await reload();
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  return (
    <Modal onClose={onClose} label="Site members">
      <h2>Members — {site.name}</h2>
      <p className="d-sub">Owners manage the site and all its files · Members can edit · Visitors can view.</p>
      {canManage && (
        <div className="field" style={{ display: "flex", gap: 8 }}>
          <input style={{ flex: 1 }} value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="colleague@company.com" onKeyDown={(e) => e.key === "Enter" && void add()} />
          <select value={role} onChange={(e) => setRole(e.target.value as SiteRole)} style={{ width: 110 }}>
            <option value="member">Member</option>
            <option value="owner">Owner</option>
            <option value="visitor">Visitor</option>
          </select>
          <button className="btn-primary btn-sm" onClick={() => void add()}>Add</button>
        </div>
      )}
      {list.map((m) => (
        <div className="share-row" key={m.userId}>
          <div className="c-av">{m.user.initials}</div>
          <div>
            <b style={{ fontSize: 12.5 }}>{m.user.displayName}</b>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>{m.user.email}</div>
          </div>
          {canManage ? (
            <>
              <select value={m.role} style={{ marginLeft: "auto", width: 100, height: 30, fontSize: 11.5 }}
                onChange={(e) => void setMemberRole(m, e.target.value as SiteRole)}>
                <option value="owner">Owner</option>
                <option value="member">Member</option>
                <option value="visitor">Visitor</option>
              </select>
              <button className="x" onClick={() => void remove(m)}>✕</button>
            </>
          ) : (
            <span className="perm-badge" style={{ marginLeft: "auto" }}>{m.role}</span>
          )}
        </div>
      ))}
    </Modal>
  );
}

function SiteSettingsDialog({ site, onClose, onDeleted, toast }: {
  site: Site; onClose: () => void; onDeleted: () => void; toast: (m: string) => void;
}) {
  const [name, setName] = useState(site.name);
  const [description, setDescription] = useState(site.description ?? "");
  const [visibility, setVisibility] = useState(site.visibility);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/api/sites/${site.id}`, { name: name.trim(), description: description.trim() || null, visibility });
      window.dispatchEvent(new Event("kreatix:sites"));
      toast("Site updated");
      onClose();
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
    setBusy(false);
  };

  const del = async () => {
    if (!confirm(`Delete site "${site.name}"? Its libraries are removed; the site must be empty of files first.`)) return;
    try {
      await api.del(`/api/sites/${site.id}`);
      window.dispatchEvent(new Event("kreatix:sites"));
      onDeleted();
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  return (
    <Modal onClose={onClose} label="Site settings">
      <h2>Site settings</h2>
      <div className="field">
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Description</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label>Visibility</label>
        <select value={visibility} onChange={(e) => setVisibility(e.target.value as "org" | "private")}>
          <option value="org">Organization — everyone in the workspace can view</option>
          <option value="private">Private — members only</option>
        </select>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button className="btn-ghost" style={{ color: "var(--danger)" }} onClick={() => void del()}>Delete site</button>
        <span style={{ flex: 1 }} />
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={!name.trim() || busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
