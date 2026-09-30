import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { DriveItem } from "@kreatix/shared";
import { api } from "../lib/api";
import { FileList } from "../components/FileList";
import { AppIcon } from "../components/AppIcon";
import { ShareDialog } from "../components/ShareDialog";
import { VersionsPanel } from "../components/VersionsPanel";

export function useFiles(view: string, parent?: string) {
  const [items, setItems] = useState<DriveItem[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const qs = parent !== undefined ? `parent=${parent}` : `view=${view}`;
      const r = await api.get<{ items: DriveItem[] }>(`/api/drive?${qs}`);
      setItems(r.items);
    } finally {
      setLoading(false);
    }
  }, [view, parent]);
  useEffect(() => {
    refresh();
    const h = () => refresh();
    window.addEventListener("kreatix:refresh", h);
    return () => window.removeEventListener("kreatix:refresh", h);
  }, [refresh]);
  return { items, loading, refresh };
}

export function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  const toast = useCallback((m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2600);
  }, []);
  return { msg, toast };
}

export function useItemActions(refresh: () => void) {
  const [sharing, setSharing] = useState<DriveItem | null>(null);
  const [versions, setVersions] = useState<DriveItem | null>(null);
  const { msg, toast } = useToast();
  return { sharing, setSharing, versions, setVersions, msg, toast, refresh };
}

export function Home() {
  const navigate = useNavigate();
  const { items, refresh } = useFiles("home");
  const { sharing, setSharing, versions, setVersions, msg, toast } = useItemActions(refresh);

  const open = (it: DriveItem) =>
    navigate(it.kind === "folder" ? `/drive/folder/${it.id}` : `/edit/${it.id}`);

  const createDoc = async () => {
    const r = await api.post<{ item: DriveItem }>("/api/drive", { name: "Untitled document", kind: "writer" });
    navigate(`/edit/${r.item.id}`);
  };

  const apps = [
    { cls: "writer", name: "Kreatix Writer", desc: "Documents & reports", kind: "writer" },
    { cls: "sheets", name: "Kreatix Sheets", desc: "Data & analysis", kind: "sheets" },
    { cls: "present", name: "Kreatix Present", desc: "Slides & storytelling", kind: "present" },
    { cls: "pdf", name: "Kreatix PDF", desc: "Read, edit & sign", kind: "pdf" },
  ];

  return (
    <>
      <section className="hero">
        <div className="hero-orange" /><div className="hero-shape" /><div className="hero-ring" />
        <div className="hero-content">
          <div className="hero-badge">✦ KREATIX AI</div>
          <h1>One workspace.<br />Everything your business creates.</h1>
          <p>Write, calculate, present, review and collaborate from one connected productivity environment designed around the Kreatix way of working.</p>
          <div className="hero-actions">
            <button className="btn-primary" onClick={createDoc}>＋ Create a file</button>
            <button className="btn-secondary">✦ Ask Kreatix AI</button>
          </div>
        </div>
      </section>

      <section className="apps">
        {apps.map((a) => (
          <div className="app-card" key={a.cls}
            onClick={async () => {
              const names: Record<string, string> = { writer: "Untitled document", sheets: "Untitled spreadsheet", present: "Untitled presentation" };
              if (a.kind === "pdf") return navigate("/drive/all");
              const r = await api.post<{ item: DriveItem }>("/api/drive", { name: names[a.kind], kind: a.kind });
              navigate(`/edit/${r.item.id}`);
            }}>
            <div className={`app-ico ${a.cls}`}><AppIcon kind={a.cls} /></div>
            <div><h4>{a.name}</h4><p>{a.desc}</p></div>
            <div className="launch">›</div>
          </div>
        ))}
      </section>

      <div className="content-grid">
        <section>
          <div className="section-head"><h2>Continue working</h2><a onClick={() => navigate("/drive")} style={{ cursor: "pointer" }}>View all files →</a></div>
          <FileList items={items} onOpen={open} onRefresh={refresh} onShare={setSharing} onVersions={setVersions} toast={toast} />
        </section>
        <section>
          <div className="section-head"><h2>Kreatix AI</h2><a>Expand →</a></div>
          <div className="ai-panel">
            <div className="ai-head">
              <div className="ai-symbol">✦</div>
              <div><h3>What are you creating today?</h3><p>AI that works directly with your files.</p></div>
            </div>
            <div className="prompt">
              <textarea placeholder="Create an investor presentation from my strategy document and financial forecast…" />
              <div className="prompt-footer"><span className="add">＋ Add workspace files</span><button className="send">↗</button></div>
            </div>
            <div className="chips">
              <span className="chip">Draft document</span><span className="chip">Analyze data</span>
              <span className="chip">Build slides</span><span className="chip">Summarize PDF</span>
            </div>
          </div>
        </section>
      </div>

      <div className="section-head"><h2>Start from a template</h2><a>Browse templates →</a></div>
      <section className="templates">
        <div className="template"><div className="preview"><div className="paper"><div className="line orange-line short" /><div className="line" /><div className="line mid" /><div className="line" /></div></div><div className="template-info"><h4>Business Proposal</h4><p>Writer template</p></div></div>
        <div className="template"><div className="preview"><div className="paper"><div className="line short" /><div className="grid">{Array.from({ length: 12 }).map((_, i) => <span key={i} />)}</div></div></div><div className="template-info"><h4>Financial Model</h4><p>Sheets template</p></div></div>
        <div className="template"><div className="preview"><div className="paper" style={{ background: "#202020" }}><div className="line orange-line short" /><div className="line" style={{ background: "#555" }} /><div style={{ width: 42, height: 42, borderRadius: "50%", background: "var(--k-orange)", marginTop: 10 }} /></div></div><div className="template-info"><h4>Executive Presentation</h4><p>Present template</p></div></div>
        <div className="template"><div className="preview"><div className="paper"><div className="line orange-line short" /><div className="line" /><div className="line" /><div className="line mid" /></div></div><div className="template-info"><h4>Contract Review</h4><p>PDF workflow</p></div></div>
      </section>

      <div className="brand-strip">
        <div className="mini-logo"><AppIcon kind="suites" /></div>
        <div><strong>Kreatix Business Suite</strong><br /><span>Built around one clear visual identity: Kreatix orange, clean white space and confident black.</span></div>
      </div>
      <footer>Kreatix Business Suite · Writer · Sheets · Present · PDF · Drive · AI</footer>

      {sharing && <ShareDialog item={sharing} onClose={() => setSharing(null)} toast={toast} />}
      {versions && <VersionsPanel item={versions} onClose={() => setVersions(null)} toast={toast} />}
      {msg && <div className="toast">{msg}</div>}
    </>
  );
}
