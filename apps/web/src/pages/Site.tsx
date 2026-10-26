import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { DriveItem, GroupGrant, Library, OrgGroup, Site, SiteMember, SitePage as SitePageType, SiteRole } from "@kreatix/shared";
import { api } from "../lib/api";
import { useToast } from "../lib/hooks";
import { KIND_META, timeAgo } from "../lib/format";
import { Modal } from "../components/Modal";
import { ContentTypeDialog } from "../components/LibraryDialogs";
import { Block } from "./SitePageView";

type SearchItem = DriveItem & { match?: "name" | "content"; snippet?: string };

interface SiteEvent {
  id: string; action: string; detail: string | null; fileId: string | null;
  actor: { displayName: string; initials: string }; createdAt: string;
}

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
  const [pages, setPages] = useState<SitePageType[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [libDlg, setLibDlg] = useState(false);
  const [memberDlg, setMemberDlg] = useState(false);
  const [settingsDlg, setSettingsDlg] = useState(false);
  const [activityDlg, setActivityDlg] = useState(false);
  const [trashDlg, setTrashDlg] = useState(false);
  const [ctDlg, setCtDlg] = useState(false);
  const [copilotDlg, setCopilotDlg] = useState(false);

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
  useEffect(() => {
    void api.get<{ pages: SitePageType[] }>(`/api/sites/${siteId}/pages`)
      .then((r) => setPages(r.pages)).catch(() => {});
  }, [siteId]);

  if (notFound) return <div className="panel"><div className="empty">Site not found or you don't have access.</div></div>;
  if (!site) return <div className="empty">Loading…</div>;

  const canManage = site.myRole === "owner";
  const canWrite = site.myRole === "owner" || site.myRole === "member";
  const homePage = pages.find((p) => p.isHome);

  const newPage = async () => {
    const title = prompt("Page title:", "Untitled page")?.trim();
    if (!title) return;
    try {
      const r = await api.post<{ page: SitePageType }>(`/api/sites/${siteId}/pages`, { title });
      navigate(`/sites/${siteId}/page/${r.page.id}`);
    } catch (e) { toast(e instanceof Error ? e.message : "Failed to create page"); }
  };

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
            {site.hubId && site.hubName && <> · <span className="perm-badge">hub: {site.hubName}</span></>}
          </p>
          {site.description && <p style={{ margin: "6px 0 0", fontSize: 12.5 }}>{site.description}</p>}
        </div>
        <div className="site-head-actions">
          <div className="people" title="Members">
            {members.slice(0, 5).map((m) => <span key={m.userId} title={`${m.user.displayName} — ${m.role}`}>{m.user.initials}</span>)}
          </div>
          <button className="btn-ghost btn-sm" onClick={() => setCopilotDlg(true)}>✦ Ask</button>
          <button className="btn-ghost btn-sm" onClick={() => setMemberDlg(true)}>Members</button>
          <button className="btn-ghost btn-sm" onClick={() => setActivityDlg(true)}>Activity</button>
          {canManage && <button className="btn-ghost btn-sm" onClick={() => setTrashDlg(true)}>Recycle bin</button>}
          {canManage && <button className="btn-ghost btn-sm" onClick={() => setCtDlg(true)}>Content types</button>}
          {canManage && <button className="btn-ghost btn-sm" onClick={() => setSettingsDlg(true)}>Settings</button>}
        </div>
      </div>

      {homePage && homePage.blocks.length > 0 && (
        <div className="site-home-page">
          <div className="home-section-head">
            <h3>{homePage.title}</h3>
            <button className="btn-ghost btn-sm" onClick={() => navigate(`/sites/${siteId}/page/${homePage.id}`)}>
              {canWrite ? "Edit page →" : "Open page →"}
            </button>
          </div>
          {homePage.blocks.map((b, i) => (
            <div className="page-block" key={i}>
              <Block b={b} i={i} siteId={siteId} libraries={libraries} edit={false}
                onChange={() => {}} navigate={navigate} />
            </div>
          ))}
        </div>
      )}

      <SiteSearch siteId={site.id} />

      <div className="section-head">
        <h2>Document libraries</h2>
        {canWrite && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button className="btn-ghost btn-sm" onClick={() => void newPage()}>＋ Page</button>
            <button className="btn-ghost btn-sm" onClick={() => setLibDlg(true)}>＋ New library</button>
          </div>
        )}
      </div>

      <div className="site-grid">
        {libraries.map((l) => (
          <button key={l.id} className="site-card" onClick={() => navigate(`/sites/${site.id}/library/${l.id}`)}>
            <span className="site-card-ico">{l.inheritPermissions === false ? "🔒" : l.kind === "list" ? "☰" : "🗂"}</span>
            <span className="site-card-body">
              <b>{l.name}</b>
              <span>{l.itemCount ?? 0} item{(l.itemCount ?? 0) === 1 ? "" : "s"} · {l.kind}
                {l.inheritPermissions === false ? " · unique permissions" : ""}</span>
            </span>
            <span style={{ color: "var(--muted)" }}>›</span>
          </button>
        ))}
      </div>

      {pages.length > 0 && (
        <>
          <div className="section-head"><h2>Pages</h2></div>
          <div className="site-grid">
            {pages.map((p) => (
              <button key={p.id} className="site-card" onClick={() => navigate(`/sites/${siteId}/page/${p.id}`)}>
                <span className="site-card-ico">📄</span>
                <span className="site-card-body">
                  <b>{p.title}</b>
                  <span>{p.isHome ? "Site home · " : ""}{p.blocks.length} block{p.blocks.length === 1 ? "" : "s"} · {timeAgo(p.updatedAt)}</span>
                </span>
                <span style={{ color: "var(--muted)" }}>›</span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="site-home">
        <SiteRecent site={site} libraries={libraries} />
        <SiteActivity site={site} onShowAll={() => setActivityDlg(true)} />
      </div>

      {site.associatedSites && site.associatedSites.length > 0 && (
        <>
          <div className="section-head"><h2>Associated sites</h2></div>
          <div className="site-grid">
            {site.associatedSites.map((s) => (
              <button key={s.id} className="site-card" onClick={() => navigate(`/sites/${s.id}`)}>
                <span className="site-card-ico">🌐</span>
                <span className="site-card-body"><b>{s.name}</b></span>
                <span style={{ color: "var(--muted)" }}>›</span>
              </button>
            ))}
          </div>
          <HubRollup sites={site.associatedSites} />
        </>
      )}

      {libDlg && <NewLibraryDialog siteId={site.id} toast={toast} onClose={() => setLibDlg(false)}
        onCreated={(l) => { setLibDlg(false); navigate(`/sites/${site.id}/library/${l.id}`); }} />}
      {memberDlg && <MembersDialog site={site} members={members} canManage={canManage}
        toast={toast} onClose={() => { setMemberDlg(false); void load(); }} />}
      {settingsDlg && <SiteSettingsDialog site={site} toast={toast}
        onClose={() => { setSettingsDlg(false); void load(); }}
        onDeleted={() => navigate("/sites")} />}
      {activityDlg && <ActivityDialog site={site} onClose={() => setActivityDlg(false)} />}
      {trashDlg && <TrashDialog site={site} toast={toast} onClose={() => setTrashDlg(false)} />}
      {ctDlg && <ContentTypeDialog siteId={site.id} onClose={() => setCtDlg(false)} toast={toast} />}
      {copilotDlg && <SiteCopilot site={site} onClose={() => setCopilotDlg(false)} />}
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </>
  );
}

/** Scoped full-text search across the site's libraries (SharePoint
 *  "search this site"). Results navigate straight into the library. */
function SiteSearch({ siteId }: { siteId: string }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ items: SearchItem[] }>(
          `/api/search?site=${encodeURIComponent(siteId)}&q=${encodeURIComponent(q)}`);
        setResults(r.items);
        setOpen(true);
      } catch { /* transient */ }
    }, 220);
    return () => clearTimeout(t);
  }, [q, siteId]);

  const go = (it: SearchItem) => {
    setOpen(false);
    setQ("");
    navigate(it.kind === "folder"
      ? `/sites/${siteId}/library/${it.libraryId}/folder/${it.id}`
      : `/edit/${it.id}`);
  };

  return (
    <div className="search site-search" ref={boxRef} style={{ position: "relative", marginBottom: 16 }}>
      <span style={{ color: "var(--muted)" }}>⌕</span>
      <input value={q} placeholder="Search this site…" aria-label="Search this site"
        onChange={(e) => setQ(e.target.value)} onFocus={() => results.length && setOpen(true)} />
      {open && results.length > 0 && (
        <div className="file-menu" style={{ top: "100%", left: 0, right: 0, minWidth: 0 }}>
          {results.map((it) => (
            <button key={it.id} onClick={() => go(it)}>
              <b>{it.name}</b>
              <small style={{ color: "var(--muted)" }}> · {it.kind}</small>
              {it.snippet && <span className="srch-snip">{it.snippet.replace(/[«»]/g, "")}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
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
          <option value="list">List (structured rows)</option>
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
  const [groupGrants, setGroupGrants] = useState<GroupGrant[]>([]);
  const [allGroups, setAllGroups] = useState<OrgGroup[]>([]);
  const [pickGroup, setPickGroup] = useState("");

  const reload = async () => {
    const r = await api.get<{ members: SiteMember[]; groups?: GroupGrant[] }>(`/api/sites/${site.id}/members`);
    setList(r.members);
    setGroupGrants(r.groups ?? []);
  };
  useEffect(() => {
    void reload().catch(() => {});
    void api.get<{ groups: OrgGroup[] }>("/api/groups")
      .then((r) => setAllGroups(r.groups)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id]);

  const addGroup = async () => {
    if (!pickGroup) return;
    try {
      await api.post(`/api/sites/${site.id}/groups`, { groupId: pickGroup, role });
      setPickGroup("");
      await reload();
      toast("Group added to site");
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  const setGroupRole = async (g: GroupGrant, r: SiteRole) => {
    try {
      await api.post(`/api/sites/${site.id}/groups`, { groupId: g.groupId, role: r });
      await reload();
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  const removeGroup = async (g: GroupGrant) => {
    if (!confirm(`Remove group "${g.name}" from this site?`)) return;
    try {
      await api.del(`/api/sites/${site.id}/groups/${g.groupId}`);
      await reload();
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
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
      {(groupGrants.length > 0 || (canManage && allGroups.length > 0)) && (
        <div style={{ borderTop: "1px solid var(--line)", margin: "12px 0 8px" }} />
      )}
      {groupGrants.length > 0 && <p className="d-sub" style={{ margin: "0 0 4px" }}>Groups with access</p>}
      {groupGrants.map((g) => (
        <div className="share-row" key={g.groupId}>
          <div className="c-av">👥</div>
          <div>
            <b style={{ fontSize: 12.5 }}>{g.name}</b>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>{g.memberCount} member{g.memberCount === 1 ? "" : "s"}</div>
          </div>
          {canManage ? (
            <>
              <select value={g.role} style={{ marginLeft: "auto", width: 100, height: 30, fontSize: 11.5 }}
                onChange={(e) => void setGroupRole(g, e.target.value as SiteRole)}>
                <option value="owner">Owner</option>
                <option value="member">Member</option>
                <option value="visitor">Visitor</option>
              </select>
              <button className="x" onClick={() => void removeGroup(g)}>✕</button>
            </>
          ) : (
            <span className="perm-badge" style={{ marginLeft: "auto" }}>{g.role}</span>
          )}
        </div>
      ))}
      {canManage && allGroups.filter((g) => !groupGrants.some((x) => x.groupId === g.id)).length > 0 && (
        <div className="field" style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <select style={{ flex: 1 }} value={pickGroup} onChange={(e) => setPickGroup(e.target.value)}>
            <option value="">Add a group…</option>
            {allGroups.filter((g) => !groupGrants.some((x) => x.groupId === g.id))
              .map((g) => <option key={g.id} value={g.id}>{g.name} ({g.memberCount ?? 0})</option>)}
          </select>
          <button className="btn-ghost btn-sm" disabled={!pickGroup} onClick={() => void addGroup()}>Add group</button>
        </div>
      )}
    </Modal>
  );
}

function SiteSettingsDialog({ site, onClose, onDeleted, toast }: {
  site: Site; onClose: () => void; onDeleted: () => void; toast: (m: string) => void;
}) {
  const [name, setName] = useState(site.name);
  const [description, setDescription] = useState(site.description ?? "");
  const [visibility, setVisibility] = useState(site.visibility);
  const [hubId, setHubId] = useState(site.hubId ?? "");
  const [hubCandidates, setHubCandidates] = useState<Site[]>([]);
  const [busy, setBusy] = useState(false);

  // hub candidates: every site except this one (server enforces one level)
  useEffect(() => {
    void api.get<{ sites: Site[] }>("/api/sites")
      .then((r) => setHubCandidates(r.sites.filter((s) => s.id !== site.id && !s.hubId)))
      .catch(() => {});
  }, [site.id]);

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/api/sites/${site.id}`, {
        name: name.trim(), description: description.trim() || null, visibility,
        hubId: hubId || null,
      });
      window.dispatchEvent(new Event("kreatix:sites"));
      toast("Site updated");
      onClose();
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
    setBusy(false);
  };

  const saveTemplate = async () => {
    const n = prompt("Template name:", `${site.name} template`)?.trim();
    if (!n) return;
    try {
      await api.post(`/api/sites/${site.id}/template`, { name: n });
      toast("Template saved — it's available when creating new sites");
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
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
      <div className="field">
        <label>Hub site</label>
        <select value={hubId} onChange={(e) => setHubId(e.target.value)}>
          <option value="">None</option>
          {hubCandidates.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button className="btn-ghost" style={{ color: "var(--danger)" }} onClick={() => void del()}>Delete site</button>
        <button className="btn-ghost" onClick={() => void saveTemplate()}>Save as template</button>
        <span style={{ flex: 1 }} />
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={!name.trim() || busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}

/** Site activity feed — site events + file activity across its libraries. */
function ActivityDialog({ site, onClose }: { site: Site; onClose: () => void }) {
  const [events, setEvents] = useState<SiteEvent[] | null>(null);
  useEffect(() => {
    void api.get<{ events: SiteEvent[] }>(`/api/sites/${site.id}/activity`)
      .then((r) => setEvents(r.events)).catch(() => setEvents([]));
  }, [site.id]);

  // owner-only server-side; failures surface as a no-download
  const exportCsv = async () => {
    const blob = await api.get<Blob>(`/api/sites/${site.id}/audit.csv`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-${site.name.replace(/[^\w-]+/g, "_")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal onClose={onClose} label="Site activity">
      <h2>Activity — {site.name}</h2>
      {!events && <p className="d-sub">Loading…</p>}
      {events && !events.length && <p className="empty" style={{ margin: "8px 0" }}>Nothing yet.</p>}
      {events?.map((e) => (
        <div className="share-row" key={e.id}>
          <div className="c-av">{e.actor.initials}</div>
          <div style={{ flex: 1 }}>
            <b style={{ fontSize: 12.5 }}>{e.actor.displayName}</b>
            <span className="perm-badge" style={{ marginLeft: 8 }}>{e.action}</span>
            <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{e.detail ?? "—"}</div>
          </div>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>{timeAgo(e.createdAt)}</span>
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        {site.myRole === "owner" && (
          <button className="btn-ghost btn-sm" onClick={() => void exportCsv()}>⭳ Export audit CSV</button>
        )}
        <button className="btn-ghost btn-sm" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

/** Recently modified items across the site's libraries (SharePoint's
 *  "recently modified" rollup) — jumps straight into the right library. */
function SiteRecent({ site, libraries }: { site: Site; libraries: Library[] }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<DriveItem[] | null>(null);
  useEffect(() => {
    void api.get<{ items: DriveItem[] }>(`/api/drive?view=recent&site=${site.id}`)
      .then((r) => setItems(r.items.slice(0, 8))).catch(() => setItems([]));
  }, [site.id]);

  const libName = (id: string | null | undefined) => libraries.find((l) => l.id === id)?.name;

  return (
    <div className="panel site-home-card">
      <div className="section-head" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 14 }}>Recent</h2>
      </div>
      {!items && <p className="d-sub">Loading…</p>}
      {items && !items.length && <p className="empty" style={{ margin: "8px 0" }}>Nothing yet.</p>}
      {items?.map((it) => (
        <button key={it.id} className="site-home-row" onClick={() => navigate(`/edit/${it.id}`)}>
          <b>{it.name}</b>
          <span>
            {libName(it.libraryId) ?? "File"} · {timeAgo(it.updatedAt)}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Inline site activity feed — the head of the full activity log. */
function SiteActivity({ site, onShowAll }: { site: Site; onShowAll: () => void }) {
  const [events, setEvents] = useState<SiteEvent[] | null>(null);
  useEffect(() => {
    void api.get<{ events: SiteEvent[] }>(`/api/sites/${site.id}/activity`)
      .then((r) => setEvents(r.events.slice(0, 8))).catch(() => setEvents([]));
  }, [site.id]);

  return (
    <div className="panel site-home-card">
      <div className="section-head" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 14 }}>Activity</h2>
        <button className="btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={onShowAll}>View all</button>
      </div>
      {!events && <p className="d-sub">Loading…</p>}
      {events && !events.length && <p className="empty" style={{ margin: "8px 0" }}>Nothing yet.</p>}
      {events?.map((e) => (
        <div className="site-home-row" key={e.id}>
          <b><span className="c-av" style={{ marginRight: 6, display: "inline-grid" }}>{e.actor.initials}</span>
            {e.actor.displayName}</b>
          <span>{e.action}{e.detail ? ` · ${e.detail}` : ""} · {timeAgo(e.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}

/** Site recycle bin — anything trashed inside the site's libraries, restorable
 *  by owners regardless of who owned or deleted it (SharePoint site bin). */
function TrashDialog({ site, toast, onClose }: { site: Site; toast: (m: string) => void; onClose: () => void }) {
  const [items, setItems] = useState<DriveItem[] | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: DriveItem[] }>(`/api/drive?view=trash&site=${site.id}`);
      setItems(r.items);
    } catch { setItems([]); }
  }, [site.id]);
  useEffect(() => { void load(); }, [load]);

  const restore = async (it: DriveItem) => {
    try {
      await api.post(`/api/drive/${it.id}/restore`);
      toast(`Restored "${it.name}"`);
      setItems((l) => l?.filter((x) => x.id !== it.id) ?? null);
    } catch (e) { toast(e instanceof Error ? e.message : "Restore failed"); }
  };
  const purge = async (it: DriveItem) => {
    if (!confirm(`Permanently delete "${it.name}"? This cannot be undone.`)) return;
    try {
      await api.del(`/api/drive/${it.id}?permanent=true`);
      setItems((l) => l?.filter((x) => x.id !== it.id) ?? null);
    } catch (e) { toast(e instanceof Error ? e.message : "Delete failed"); }
  };

  return (
    <Modal onClose={onClose} label="Site recycle bin">
      <h2>Recycle bin — {site.name}</h2>
      <p className="d-sub">Files deleted from this site's libraries.</p>
      {!items && <p className="d-sub">Loading…</p>}
      {items && !items.length && <p className="empty" style={{ margin: "8px 0" }}>The recycle bin is empty.</p>}
      {items?.map((it) => (
        <div className="share-row" key={it.id}>
          <div className="c-av">{KIND_META[it.kind]?.short ?? "?"}</div>
          <div style={{ flex: 1 }}>
            <b style={{ fontSize: 12.5 }}>{it.name}</b>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>Deleted {timeAgo(it.updatedAt)}</div>
          </div>
          <button className="btn-ghost btn-sm" onClick={() => void restore(it)}>Restore</button>
          <button className="x" title="Delete permanently" onClick={() => void purge(it)}>✕</button>
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn-ghost btn-sm" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

/** Hub roll-up — recent files + activity merged across the hub's associated
 *  sites (SharePoint hub roll-up web part). */
function HubRollup({ sites }: { sites: { id: string; name: string }[] }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<(DriveItem & { siteName?: string })[] | null>(null);
  const [events, setEvents] = useState<(SiteEvent & { siteName?: string })[] | null>(null);

  useEffect(() => {
    void (async () => {
      const docs: (DriveItem & { siteName?: string })[] = [];
      const acts: (SiteEvent & { siteName?: string })[] = [];
      for (const s of sites) {
        try {
          const r = await api.get<{ items: DriveItem[] }>(`/api/drive?view=recent&site=${s.id}`);
          for (const it of r.items.slice(0, 4)) docs.push({ ...it, siteName: s.name });
        } catch { /* site not accessible to this user */ }
        try {
          const a = await api.get<{ events: SiteEvent[] }>(`/api/sites/${s.id}/activity`);
          for (const e of a.events.slice(0, 4)) acts.push({ ...e, siteName: s.name });
        } catch { /* site not accessible to this user */ }
      }
      docs.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      acts.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      setItems(docs.slice(0, 8));
      setEvents(acts.slice(0, 8));
    })();
  }, [sites]);

  return (
    <div className="site-home" style={{ marginTop: 8 }}>
      <div className="panel site-home-card">
        <div className="section-head" style={{ marginTop: 0 }}>
          <h2 style={{ fontSize: 14 }}>Across the hub — recent</h2>
        </div>
        {!items && <p className="d-sub">Loading…</p>}
        {items && !items.length && <p className="empty" style={{ margin: "8px 0" }}>Nothing yet.</p>}
        {items?.map((it) => (
          <button key={it.id} className="site-home-row" onClick={() => navigate(`/edit/${it.id}`)}>
            <b>{it.name}</b>
            <span>{it.siteName} · {timeAgo(it.updatedAt)}</span>
          </button>
        ))}
      </div>
      <div className="panel site-home-card">
        <div className="section-head" style={{ marginTop: 0 }}>
          <h2 style={{ fontSize: 14 }}>Across the hub — activity</h2>
        </div>
        {!events && <p className="d-sub">Loading…</p>}
        {events && !events.length && <p className="empty" style={{ margin: "8px 0" }}>Nothing yet.</p>}
        {events?.map((e) => (
          <div className="site-home-row" key={e.id}>
            <b><span className="c-av" style={{ marginRight: 6, display: "inline-grid" }}>{e.actor.initials}</span>
              {e.actor.displayName}</b>
            <span>{e.siteName} · {e.action}{e.detail ? ` · ${e.detail}` : ""} · {timeAgo(e.createdAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Site copilot — ask questions grounded in the site's indexed content and
 *  activity ("what changed this week?", "what's pending approval?"). */
function SiteCopilot({ site, onClose }: { site: Site; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ q: string; a: string; sources: { id: string; name: string }[] }[]>([]);

  const ask = async () => {
    const question = q.trim();
    if (!question || asking) return;
    setAsking(true); setError(null);
    try {
      const r = await api.post<{ answer: string; sources: { id: string; name: string }[] }>(
        `/api/sites/${site.id}/ai/ask`, { question });
      setHistory((h) => [{ q: question, a: r.answer, sources: r.sources }, ...h]);
      setQ("");
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't answer right now"); }
    setAsking(false);
  };

  return (
    <Modal onClose={onClose} label={`Ask about ${site.name}`}>
      <h2 style={{ marginBottom: 4 }}>✦ Site copilot</h2>
      <p className="d-sub">Answers grounded in this site's indexed documents and activity log.</p>
      <div className="copilot-input">
        <input value={q} placeholder="What changed this week?" autoFocus
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void ask(); }} />
        <button className="btn-primary btn-sm" disabled={asking || !q.trim()} onClick={() => void ask()}>
          {asking ? "…" : "Ask"}
        </button>
      </div>
      {error && <p className="m-err" style={{ margin: "8px 0" }}>{error}</p>}
      <div className="copilot-history">
        {history.map((h, i) => (
          <div key={i} className="copilot-qa">
            <div className="copilot-q">{h.q}</div>
            <div className="copilot-a">{h.a}</div>
            {h.sources.length > 0 && (
              <div className="copilot-src">Sources: {h.sources.map((s) => s.name).join(", ")}</div>
            )}
          </div>
        ))}
        {!history.length && (
          <div className="d-sub" style={{ fontSize: 12 }}>
            Try: "What's pending approval?" · "Summarize recent activity" · "Which documents mention onboarding?"
          </div>
        )}
      </div>
    </Modal>
  );
}
