import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";
import type { DriveItem, FileKind } from "@kreatix/shared";
import { KIND_META } from "../lib/format";
import { CommandPalette, renderSnippet } from "./CommandPalette";
import { AppIcon, BrandLockup } from "./AppIcon";
import { TemplatesDialog } from "./TemplatesDialog";
import { SecurityDialog } from "./SecurityDialog";
import { useToast } from "../pages/Home";
import { AnonBanner } from "./Desktop";
import { useIsMobile } from "../lib/mobile";
import { kindForPath, openLocalFile } from "../lib/offline/openLocal";

export function Shell() {
  const [palette, setPalette] = useState(false);
  const [templates, setTemplates] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const isMobile = useIsMobile();
  const { msg, toast } = useToast();

  // close the nav drawer on navigation + lock body scroll while it's open
  useEffect(() => { setNavOpen(false); }, [pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setNavOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", onKey); };
  }, [navOpen]);

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
    // office types get their editor kind so they open in the right app on click
    const kind = (kindForPath(f.name) ?? (f.type === "application/pdf" ? "pdf" : "file")) as FileKind;
    try {
      await api.upload(`/api/drive/upload?name=${encodeURIComponent(f.name)}&kind=${kind}`, f);
      navigate("/drive/all");
      window.dispatchEvent(new Event("kreatix:refresh"));
    } catch { toast("Upload failed"); }
  };

  return (
    <div className="shell">
      <Rail toast={toast} />
      <Sidebar onTemplates={() => setTemplates(true)} open={navOpen} onClose={() => setNavOpen(false)} toast={toast} />
      {isMobile && navOpen && <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />}
      <main>
        <Topbar onPalette={() => setPalette(true)} onNav={() => setNavOpen(true)} />
        <AnonBanner />
        <BillingBanner />
        <Outlet />
      </main>
      <CommandPalette open={palette} onClose={() => setPalette(false)}
        onTemplates={() => { setPalette(false); setTemplates(true); }}
        onUpload={() => { setPalette(false); fileInput.current?.click(); }}
        toast={toast} />
      {templates && <TemplatesDialog onClose={() => setTemplates(false)} toast={toast} />}
      <input ref={fileInput} type="file" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </div>
  );
}

/** Workspace subscription status — trial countdown, grace, lockout.
 *  Reads stay open when locked; this banner explains the 402s. */
function BillingBanner() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [sub, setSub] = useState<{ state: string; daysLeft: number | null } | null>(null);

  useEffect(() => {
    if (!user) return;
    api.get<{ state: string; daysLeft: number | null }>("/api/billing/summary")
      .then(setSub)
      .catch(() => setSub(null));
  }, [user]);

  if (!sub) return null;
  const isAdmin = user?.role === "owner" || user?.role === "admin";
  const go = () => navigate("/admin");
  if (sub.state === "locked") {
    return (
      <div className="billing-banner locked">
        Subscription expired — this workspace is read-only.
        {isAdmin && <button onClick={go}>Renew subscription</button>}
      </div>
    );
  }
  if (sub.state === "grace") {
    return (
      <div className="billing-banner warn">
        Payment overdue — {sub.daysLeft ?? 0} day{sub.daysLeft === 1 ? "" : "s"} left before the workspace locks.
        {isAdmin && <button onClick={go}>Pay now</button>}
      </div>
    );
  }
  if (sub.state === "trialing" && (sub.daysLeft ?? 99) <= 14) {
    return (
      <div className="billing-banner info">
        Free trial ends in {sub.daysLeft} day{sub.daysLeft === 1 ? "" : "s"}.
        {isAdmin && <button onClick={go}>Set up billing</button>}
      </div>
    );
  }
  return null;
}

function Rail({ toast }: { toast: (m: string) => void }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [menu, setMenu] = useState(false);
  const [security, setSecurity] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);
  const toggleTheme = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("kx_theme", next); } catch { /* private mode */ }
  };
  const items = [
    { to: "/", icon: "⌂", title: "Home" },
    { to: "/drive", icon: "▣", title: "Kreatix Drive" },
  ];
  return (
    <aside className="rail">
      <div className="brand-mark"><AppIcon kind="suites" /></div>
      {items.map((i) => (
        <NavLink key={i.to} to={i.to} end={i.to === "/"} title={i.title}
          className={`rail-btn ${pathname === i.to ? "active" : ""}`}>{i.icon}</NavLink>
      ))}
      <div className="spacer" />
      <div ref={ref} style={{ position: "relative" }}>
        <button className="rail-btn" title="Settings" aria-haspopup="menu" aria-expanded={menu}
          onClick={() => setMenu((v) => !v)}>⚙</button>
        {menu && (
          <div className="user-menu" style={{ position: "fixed", left: 62, bottom: 12, width: 190 }}>
            <button onClick={() => { setMenu(false); toggleTheme(); }}>Toggle dark / light theme</button>
            {user && user.id !== "local" && (
              <button onClick={() => { setMenu(false); setSecurity(true); }}>Security &amp; two-factor…</button>
            )}
            {(user?.role === "owner" || user?.role === "admin") && (
              <button onClick={() => { setMenu(false); navigate("/admin"); }}>Administration</button>
            )}
            <button onClick={() => { setMenu(false); logout(); navigate("/login"); }}>Sign out</button>
          </div>
        )}
      </div>
      {security && <SecurityDialog onClose={() => setSecurity(false)} toast={toast} />}
    </aside>
  );
}

function Sidebar({ onTemplates, open, onClose, toast }: { onTemplates: () => void; open: boolean; onClose: () => void; toast: (m: string) => void }) {
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
    // office types get their editor kind so they open in the right app on click
    const kind = (kindForPath(f.name) ?? (f.type === "application/pdf" ? "pdf" : "file")) as FileKind;
    try {
      await api.upload(`/api/drive/upload?name=${encodeURIComponent(f.name)}&kind=${kind}`, f);
      navigate("/drive");
      window.dispatchEvent(new Event("kreatix:refresh"));
    } catch { toast("Upload failed"); }
  };

  const openFromComputer = () => {
    setMenuOpen(false);
    void openLocalFile()
      .then((id) => { if (id) navigate(`/edit/${id}`); })
      .catch((e) => toast((e as Error).message));
  };

  // AI lives inside the editors — open the most recent file's AI panel,
  // or a fresh document when the workspace is empty.
  const openAi = async () => {
    try {
      const r = await api.get<{ items: DriveItem[] }>("/api/drive?view=home");
      const f = r.items.find((i) => i.kind !== "folder");
      if (f) navigate(`/edit/${f.id}?ai=`);
      else {
        const c = await api.post<{ item: DriveItem }>("/api/drive", { name: "Untitled document", kind: "writer" });
        navigate(`/edit/${c.item.id}?ai=`);
      }
    } catch { toast("Couldn't open Kreatix AI"); }
  };

  const navCls = ({ isActive }: { isActive: boolean }) => `nav ${isActive ? "active" : ""}`;
  return (
    <aside className={`sidebar${open ? " open" : ""}`}>
      <div className="brand-name">
        <BrandLockup size={34} />
        <button className="sidebar-close iconbtn" onClick={onClose} aria-label="Close navigation">✕</button>
      </div>
      <div ref={menuRef} style={{ position: "relative" }}>
        <button className="create" onClick={() => setMenuOpen((v) => !v)} disabled={creating}>
          ＋ {creating ? "Creating…" : "Create new"}
        </button>
        {menuOpen && (
          <div className="create-menu">
            <button onClick={() => createFile("writer")}><span className="cm-ico writer"><AppIcon kind="writer" /></span>Kreatix Writer</button>
            <button onClick={() => createFile("sheets")}><span className="cm-ico sheets"><AppIcon kind="sheets" /></span>Kreatix Sheets</button>
            <button onClick={() => createFile("present")}><span className="cm-ico present"><AppIcon kind="present" /></span>Kreatix Present</button>
            <hr />
            <button onClick={() => createFile("folder")}><span className="cm-ico folder-ico"><AppIcon kind="folder" /></span>New folder</button>
            <button onClick={openFromComputer}><span className="cm-ico file-ico"><AppIcon kind="file" /></span>Open file from this computer…</button>
            <button onClick={() => fileInput.current?.click()}><span className="cm-ico file-ico"><AppIcon kind="file" /></span>Upload file / PDF</button>
          </div>
        )}
        <input ref={fileInput} type="file" hidden
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <button className="open-local" onClick={openFromComputer} title="Open a document from this device">
          📂 Open from this computer…
        </button>
      </div>

      <div className="section-label">Workspace</div>
      <NavLink to="/home" end className={navCls}><span className="dot" />Home</NavLink>
      <NavLink to="/drive" className={navCls}><span className="dot" />Recent</NavLink>
      <NavLink to="/drive/starred" className={navCls}><span className="dot" />Starred</NavLink>
      <NavLink to="/drive/all" className={navCls}><span className="dot" />Kreatix Drive</NavLink>
      <NavLink to="/drive/shared" className={navCls}><span className="dot" />Shared with me</NavLink>
      <NavLink to="/drive/trash" className={navCls}><span className="dot" />Recycle bin</NavLink>

      <div className="section-label">Applications</div>
      <button type="button" className="nav" onClick={() => createFile("writer")}><AppIcon kind="writer" size={18} />Writer</button>
      <button type="button" className="nav" onClick={() => createFile("sheets")}><AppIcon kind="sheets" size={18} />Sheets</button>
      <button type="button" className="nav" onClick={() => createFile("present")}><AppIcon kind="present" size={18} />Present</button>
      <button type="button" className="nav" onClick={() => fileInput.current?.click()}><AppIcon kind="pdf" size={18} />PDF</button>

      <div className="section-label">Workspace tools</div>
      <button type="button" className="nav" onClick={onTemplates}><span className="dot" />Templates</button>
      {(user?.role === "owner" || user?.role === "admin") && (
        <NavLink to="/admin" className={navCls}><span className="dot" />Administration</NavLink>
      )}

      <div className="ai-card">
        <div className="tag">Kreatix AI</div>
        <h4>Your intelligent work companion across the entire suite.</h4>
        <button onClick={() => void openAi()}>Open AI workspace</button>
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

function Topbar({ onPalette, onNav }: { onPalette: () => void; onNav: () => void }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [open, setOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
  const boxRef = useRef<HTMLDivElement>(null);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("kx_theme", next); } catch { /* private mode */ }
    setTheme(next);
  };

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
      <button className="iconbtn nav-burger" onClick={onNav} aria-label="Open navigation">☰</button>
      <div className="search" ref={boxRef} style={{ position: "relative" }}>
        <span style={{ color: "var(--muted)" }}>⌕</span>
        <input
          placeholder="Search your workspace…"
          aria-label="Search your workspace"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
        />
        <kbd onClick={onPalette} role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPalette(); } }}
          style={{ cursor: "pointer" }} title="Open command palette">⌘ K</kbd>
        {open && results.length > 0 && (
          <div className="file-menu" style={{ top: 50, left: 0, right: 0, minWidth: 0 }}>
            {results.map((it) => (
              <button key={it.id} onClick={() => { setOpen(false); setQ(""); navigate(it.kind === "folder" ? `/drive/folder/${it.id}` : `/edit/${it.id}`); }}>
                <b>{it.name}</b> <small style={{ color: "var(--muted)" }}> · {KIND_META[it.kind]?.label}</small>
                {it.snippet && <span className="srch-snip">{renderSnippet(it.snippet)}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="iconbtn" onClick={toggleTheme}
        title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        aria-label="Toggle theme">{theme === "dark" ? "☾" : "☼"}</button>
      <MentionsBell />
      <div style={{ position: "relative" }}>
        <button className="user" aria-label="Account menu" aria-haspopup="menu" aria-expanded={userMenu}
          onClick={() => setUserMenu((v) => !v)}>{user?.initials ?? "…"}</button>
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
