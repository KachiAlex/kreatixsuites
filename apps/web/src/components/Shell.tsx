import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";
import type { DriveItem, FileKind } from "@kreatix/shared";
import { KIND_META } from "../lib/format";
import { CommandPalette, renderSnippet } from "./CommandPalette";
import { TemplatesDialog } from "./TemplatesDialog";
import { useToast } from "../pages/Home";

export function Shell() {
  const [palette, setPalette] = useState(false);
  const [templates, setTemplates] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { msg, toast } = useToast();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const upload = async (f: File) => {
    const kind = f.type === "application/pdf" || f.name.endsWith(".pdf") ? "pdf" : "file";
    try {
      await api.upload(`/api/drive/upload?name=${encodeURIComponent(f.name)}&kind=${kind}`, f);
      navigate("/drive/all");
      window.dispatchEvent(new Event("kreatix:refresh"));
    } catch { toast("Upload failed"); }
  };

  return (
    <div className="shell">
      <Rail />
      <Sidebar onTemplates={() => setTemplates(true)} />
      <main>
        <Topbar onPalette={() => setPalette(true)} />
        <Outlet />
      </main>
      <CommandPalette open={palette} onClose={() => setPalette(false)}
        onTemplates={() => { setPalette(false); setTemplates(true); }}
        onUpload={() => { setPalette(false); fileInput.current?.click(); }}
        toast={toast} />
      {templates && <TemplatesDialog onClose={() => setTemplates(false)} toast={toast} />}
      <input ref={fileInput} type="file" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
      {msg && <div className="toast">{msg}</div>}
    </div>
  );
}

function Rail() {
  const { pathname } = useLocation();
  const items = [
    { to: "/", icon: "⌂", title: "Home" },
    { to: "/drive", icon: "▣", title: "Kreatix Drive" },
  ];
  return (
    <aside className="rail">
      <div className="brand-mark">K</div>
      {items.map((i) => (
        <NavLink key={i.to} to={i.to} end={i.to === "/"} title={i.title}
          className={`rail-btn ${pathname === i.to ? "active" : ""}`}>{i.icon}</NavLink>
      ))}
      <div className="spacer" />
      <button className="rail-btn" title="Settings">⚙</button>
    </aside>
  );
}

function Sidebar({ onTemplates }: { onTemplates: () => void }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const createFile = async (kind: FileKind) => {
    setMenuOpen(false);
    setCreating(true);
    const names: Record<string, string> = {
      writer: "Untitled document", sheets: "Untitled spreadsheet",
      present: "Untitled presentation", folder: "New folder",
    };
    try {
      const r = await api.post<{ item: DriveItem }>("/api/drive", { name: names[kind] ?? "Untitled", kind });
      if (kind === "folder") {
        navigate("/drive");
        window.dispatchEvent(new Event("kreatix:refresh"));
      } else {
        navigate(`/edit/${r.item.id}`);
      }
    } finally {
      setCreating(false);
    }
  };

  const upload = async (f: File) => {
    setMenuOpen(false);
    const kind = f.type === "application/pdf" || f.name.endsWith(".pdf") ? "pdf" : "file";
    await api.upload(`/api/drive/upload?name=${encodeURIComponent(f.name)}&kind=${kind}`, f);
    navigate("/drive");
    window.dispatchEvent(new Event("kreatix:refresh"));
  };

  const navCls = ({ isActive }: { isActive: boolean }) => `nav ${isActive ? "active" : ""}`;
  return (
    <aside className="sidebar" style={{ position: "sticky" }}>
      <div className="brand-name">
        <div className="mini-logo">K</div>
        <div><h3>Kreatix Business Suite</h3><p>Business workspace</p></div>
      </div>
      <div ref={menuRef} style={{ position: "relative" }}>
        <button className="create" onClick={() => setMenuOpen((v) => !v)} disabled={creating}>
          ＋ {creating ? "Creating…" : "Create new"}
        </button>
        {menuOpen && (
          <div className="create-menu">
            <button onClick={() => createFile("writer")}><span className="cm-ico writer">W</span>Kreatix Writer</button>
            <button onClick={() => createFile("sheets")}><span className="cm-ico sheets">S</span>Kreatix Sheets</button>
            <button onClick={() => createFile("present")}><span className="cm-ico present">P</span>Kreatix Present</button>
            <hr />
            <button onClick={() => createFile("folder")}><span className="cm-ico folder-ico">▣</span>New folder</button>
            <button onClick={() => fileInput.current?.click()}><span className="cm-ico file-ico">↑</span>Upload file / PDF</button>
          </div>
        )}
        <input ref={fileInput} type="file" hidden
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </div>

      <div className="section-label">Workspace</div>
      <NavLink to="/" end className={navCls}><span className="dot" />Home</NavLink>
      <NavLink to="/drive" className={navCls}><span className="dot" />Recent</NavLink>
      <NavLink to="/drive/starred" className={navCls}><span className="dot" />Starred</NavLink>
      <NavLink to="/drive/all" className={navCls}><span className="dot" />Kreatix Drive</NavLink>
      <NavLink to="/drive/shared" className={navCls}><span className="dot" />Shared with me</NavLink>
      <NavLink to="/drive/trash" className={navCls}><span className="dot" />Recycle bin</NavLink>

      <div className="section-label">Applications</div>
      <a className="nav" onClick={() => createFile("writer")}><span style={{ color: "var(--writer)", fontWeight: 900 }}>W</span>Writer</a>
      <a className="nav" onClick={() => createFile("sheets")}><span style={{ color: "var(--sheets)", fontWeight: 900 }}>S</span>Sheets</a>
      <a className="nav" onClick={() => createFile("present")}><span style={{ color: "var(--present)", fontWeight: 900 }}>P</span>Present</a>
      <a className="nav" onClick={() => fileInput.current?.click()}><span style={{ color: "var(--pdf)", fontWeight: 900, fontSize: 9 }}>PDF</span>PDF</a>

      <div className="section-label">Workspace tools</div>
      <a className="nav" onClick={onTemplates}><span className="dot" />Templates</a>
      {(user?.role === "owner" || user?.role === "admin") && (
        <NavLink to="/admin" className={navCls}><span className="dot" />Administration</NavLink>
      )}

      <div className="ai-card">
        <div className="tag">Kreatix AI</div>
        <h4>Your intelligent work companion across the entire suite.</h4>
        <button>Open AI workspace</button>
      </div>
    </aside>
  );
}

interface Mention {
  id: string; fileId: string; fileName: string; fileKind: string;
  from: { displayName: string; initials: string };
  excerpt: string; read: boolean; createdAt: string;
}

function MentionsBell() {
  const navigate = useNavigate();
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const r = await api.get<{ mentions: Mention[]; unread: number }>("/api/mentions");
      setMentions(r.mentions); setUnread(r.unread);
    } catch { /* ignore */ }
  };
  useEffect(() => {
    void load();
    const t = setInterval(load, 30000);
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => { clearInterval(t); document.removeEventListener("mousedown", close); };
  }, []);

  const toggle = () => {
    setOpen((v) => !v);
    if (!open && unread) { void api.post("/api/mentions/read", {}).then(load); }
  };

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <button className="iconbtn" title="Notifications" onClick={toggle} style={{ position: "relative" }}>
        ♢
        {unread > 0 && <span className="mention-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="user-menu" style={{ width: 300, maxHeight: 380, overflow: "auto" }}>
          <div className="um-head"><b>Mentions</b></div>
          {!mentions.length && <div style={{ padding: "14px 16px", fontSize: 12, color: "var(--muted)" }}>No mentions yet.</div>}
          {mentions.map((m) => (
            <button key={m.id} style={{ textAlign: "left", opacity: m.read ? 0.65 : 1 }}
              onClick={() => { setOpen(false); navigate(`/edit/${m.fileId}`); }}>
              <b>{m.from.displayName}</b> <span style={{ color: "var(--muted)" }}>in {m.fileName}</span>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{m.excerpt}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type SearchItem = DriveItem & { match?: "name" | "content"; snippet?: string };

function Topbar({ onPalette }: { onPalette: () => void }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [open, setOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setUserMenu(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    const t = setTimeout(async () => {
      const r = await api.get<{ items: SearchItem[] }>(`/api/search?q=${encodeURIComponent(q)}`);
      setResults(r.items);
      setOpen(true);
    }, 220);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="topbar">
      <div className="search" ref={boxRef} style={{ position: "relative" }}>
        <span style={{ color: "#8A817B" }}>⌕</span>
        <input
          placeholder="Search your workspace or ask Kreatix AI…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
        />
        <kbd onClick={onPalette} style={{ cursor: "pointer" }} title="Open command palette">⌘ K</kbd>
        {open && results.length > 0 && (
          <div className="file-menu" style={{ top: 50, left: 0, right: 0, minWidth: 0 }}>
            {results.map((it) => (
              <button key={it.id} onClick={() => { setOpen(false); setQ(""); navigate(it.kind === "folder" ? `/drive/folder/${it.id}` : `/edit/${it.id}`); }}>
                <b>{it.name}</b> <small style={{ color: "#A19A95" }}> · {KIND_META[it.kind]?.label}</small>
                {it.snippet && <span className="srch-snip">{renderSnippet(it.snippet)}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="iconbtn" title="Toggle theme">☼</button>
      <MentionsBell />
      <div style={{ position: "relative" }}>
        <button className="user" onClick={() => setUserMenu((v) => !v)}>{user?.initials ?? "…"}</button>
        {userMenu && (
          <div className="user-menu">
            <div className="um-head"><b>{user?.displayName}</b><span>{user?.email}</span></div>
            <button onClick={() => { logout(); navigate("/login"); }}>Sign out</button>
          </div>
        )}
      </div>
    </div>
  );
}
