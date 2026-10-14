import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Site } from "@kreatix/shared";
import { useSites, useToast } from "../lib/hooks";
import { NewSiteDialog } from "../components/NewSiteDialog";

const TYPE_LABEL: Record<Site["type"], string> = {
  team: "Team site",
  project: "Project site",
  department: "Department site",
  communication: "Communication site",
};

const TYPE_ICON: Record<Site["type"], string> = {
  team: "👥", project: "📋", department: "🏢", communication: "📢",
};

export function Sites() {
  const { sites, refresh } = useSites();
  const { msg, toast } = useToast();
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  return (
    <>
      <div className="crumbs"><Link to="/home">Home</Link> <span>/</span> <b>Sites</b></div>
      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>Sites</h2>
        <button className="btn-primary btn-sm" style={{ marginLeft: "auto" }} onClick={() => setCreating(true)}>
          ＋ New site
        </button>
      </div>
      <p className="d-sub" style={{ marginBottom: 16 }}>
        Sites are shared spaces with their own document libraries, members and permissions — like SharePoint sites.
      </p>
      {sites.length === 0 ? (
        <div className="panel"><div className="empty">No sites yet — create one to share a whole library with your team.</div></div>
      ) : (
        <div className="site-grid">
          {sites.map((s) => (
            <button key={s.id} className="site-card" onClick={() => navigate(`/sites/${s.id}`)}>
              <span className="site-card-ico">{TYPE_ICON[s.type] ?? "👥"}</span>
              <span className="site-card-body">
                <b>{s.name}</b>
                <span>{TYPE_LABEL[s.type] ?? s.type}{s.visibility === "private" ? " · Private" : ""}</span>
              </span>
              {s.myRole && <span className="perm-badge">{s.myRole}</span>}
            </button>
          ))}
        </div>
      )}
      {creating && (
        <NewSiteDialog toast={toast} onClose={() => setCreating(false)}
          onCreated={(s) => { setCreating(false); void refresh(); navigate(`/sites/${s.id}`); }} />
      )}
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </>
  );
}
