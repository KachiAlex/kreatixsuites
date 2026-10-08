import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n, LOCALES } from "../lib/i18n";
import { api } from "../lib/api";
import type { DriveItem, FileKind } from "@kreatix/shared";
import { KIND_META } from "../lib/format";
import { CommandPalette, renderSnippet } from "./CommandPalette";
import { FeedbackWidget } from "./FeedbackWidget";
import { AppIcon, BrandLockup } from "./AppIcon";
import { TemplatesDialog } from "./TemplatesDialog";
import { SecurityDialog } from "./SecurityDialog";
import { useToast } from "../lib/hooks";
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
  const t = useI18n().t;
  const { user } = useAuth();

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
    } catch { toast(t("shell.uploadFailed")); }
  };

  // platform operators get a minimal chrome — no workspace nav, search,
  // upload, mentions or feedback; just brand, settings and the portal.
  if (user?.isSuper) return <SuperShell />;

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
      <FeedbackWidget />
      <input ref={fileInput} type="file" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </div>
  );
}

/** Platform-operator chrome for is_super sessions — brand rail with
 *  settings/security/sign-out only, and a bare topbar over the portal. */
function SuperShell() {
  const { user, logout } = useAuth();
  const { t, locale, setLocale } = useI18n();
  const navigate = useNavigate();
  const { msg, toast } = useToast();
  const [menu, setMenu] = useState(false);
  const [acctMenu, setAcctMenu] = useState(false);
  const [security, setSecurity] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const acctRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false);
      if (acctRef.current && !acctRef.current.contains(e.target as Node)) setAcctMenu(false);
    };
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") { setMenu(false); setAcctMenu(false); }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, []);
  const toggleTheme = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("kx_theme", next); } catch { /* private mode */ }
  };
  return (
    <div className="shell sap-shell">
      <aside className="rail">
        <div className="brand-mark"><AppIcon kind="suites" /></div>
        <div className="spacer" />
        <div ref={ref} style={{ position: "relative" }}>
          <button className="rail-btn" title={t("shell.settings")} aria-haspopup="menu" aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}>⚙</button>
          {menu && (
            <div className="user-menu" style={{ position: "fixed", left: 62, bottom: 12, width: 190 }}>
              <button onClick={() => { setMenu(false); toggleTheme(); }}>{t("shell.toggleTheme")}</button>
              <button onClick={() => { setMenu(false); setSecurity(true); }}>{t("shell.security")}</button>
              <div className="um-lang">
                <label>{t("shell.language")}</label>
                <select value={locale} onChange={(e) => setLocale(e.target.value)}>
                  {LOCALES.map((l) => <option key={l.tag} value={l.tag}>{l.label}</option>)}
                </select>
              </div>
              <button onClick={() => { setMenu(false); logout(); navigate("/login"); }}>{t("shell.signOut")}</button>
            </div>
          )}
        </div>
        {security && <SecurityDialog onClose={() => setSecurity(false)} toast={toast} />}
      </aside>
      <main>
        <div className="topbar sap-topbar">
          <div className="sap-crumbs">Kreatix Suites <em>/</em> <b>Platform console</b></div>
          <div className="sap-tbright">
            <span className="sap-scope">
              <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" fill="none" stroke="currentColor" strokeWidth="1.7"/></svg>
              Restricted superadmin surface
            </span>
            <div ref={acctRef} style={{ position: "relative" }}>
              <button className="sap-avatar sap-avatarbtn" aria-haspopup="menu" aria-expanded={acctMenu}
                aria-label={`Superadmin account — ${user?.email ?? ""}`}
                onClick={() => setAcctMenu((v) => !v)}>{user?.initials ?? "SA"}</button>
              {acctMenu && (
                <div className="user-menu sap-acctmenu" role="menu">
                  <div className="um-head">
                    <b>{user?.displayName ?? "Superadmin"}</b>
                    <span>{user?.email}</span>
                    <span className="sap-acctrole">Platform superadmin · all tenants</span>
                  </div>
                  <button role="menuitem" onClick={() => { setAcctMenu(false); setSecurity(true); }}>{t("shell.security")}</button>
                  <button role="menuitem" className="sap-signout"
                    onClick={() => { setAcctMenu(false); logout(); navigate("/login"); }}>
                    {t("shell.signOut")}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        <Outlet />
      </main>
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </div>
  );
}

/** Workspace subscription status — trial countdown, grace, lockout.
 *  Reads stay open when locked; this banner explains the 402s. */
function BillingBanner() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const t = useI18n().t;
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
        {t("billing.locked")}
        {isAdmin && <button onClick={go}>{t("shell.renewSub")}</button>}
      </div>
    );
  }
  if (sub.state === "grace") {
    const days = sub.daysLeft ?? 0;
    return (
      <div className="billing-banner warn">
        {t(days === 1 ? "billing.grace.one" : "billing.grace.other", { days })}
        {isAdmin && <button onClick={go}>{t("shell.payNow")}</button>}
      </div>
    );
  }
  if (sub.state === "trialing" && (sub.daysLeft ?? 99) <= 14) {
    const days = sub.daysLeft ?? 0;
    return (
      <div className="billing-banner info">
        {t(days === 1 ? "billing.trial.one" : "billing.trial.other", { days })}
        {isAdmin && <button onClick={go}>{t("shell.setupBilling")}</button>}
      </div>
    );
  }
  return null;
}

function Rail({ toast }: { toast: (m: string) => void }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { t, locale, setLocale } = useI18n();
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
    { to: "/", icon: "⌂", title: t("nav.home") },
    { to: "/drive", icon: "▣", title: t("nav.drive") },
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
        <button className="rail-btn" title={t("shell.settings")} aria-haspopup="menu" aria-expanded={menu}
          onClick={() => setMenu((v) => !v)}>⚙</button>
        {menu && (
          <div className="user-menu" style={{ position: "fixed", left: 62, bottom: 12, width: 190 }}>
            <button onClick={() => { setMenu(false); toggleTheme(); }}>{t("shell.toggleTheme")}</button>
            {user && user.id !== "local" && (
              <button onClick={() => { setMenu(false); setSecurity(true); }}>{t("shell.security")}</button>
            )}
            {(user?.role === "owner" || user?.role === "admin") && (
              <button onClick={() => { setMenu(false); navigate("/admin"); }}>{t("nav.admin")}</button>
            )}
            <div className="um-lang">
              <label>{t("shell.language")}</label>
              <select value={locale} onChange={(e) => setLocale(e.target.value)}>
                {LOCALES.map((l) => <option key={l.tag} value={l.tag}>{l.label}</option>)}
              </select>
            </div>
            <button onClick={() => { setMenu(false); logout(); navigate("/login"); }}>{t("shell.signOut")}</button>
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
  const t = useI18n().t;
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
      writer: t("home.untitledDoc"), sheets: t("home.untitledSheet"),
      present: t("home.untitledDeck"), folder: t("nav.newFolder"),
    };
    try {
      const r = await api.post<{ item: DriveItem }>("/api/drive", { name: names[kind] ?? t("nav.untitled"), kind });
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
    } catch { toast(t("shell.uploadFailed")); }
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
        const c = await api.post<{ item: DriveItem }>("/api/drive", { name: t("home.untitledDoc"), kind: "writer" });
        navigate(`/edit/${c.item.id}?ai=`);
      }
    } catch { toast(t("shell.aiOpenFailed")); }
  };

  const navCls = ({ isActive }: { isActive: boolean }) => `nav ${isActive ? "active" : ""}`;
  return (
    <aside className={`sidebar${open ? " open" : ""}`}>
      <div className="brand-name">
        <BrandLockup size={34} />
        <button className="sidebar-close iconbtn" onClick={onClose} aria-label={t("shell.closeNav")}>✕</button>
      </div>
      <div ref={menuRef} style={{ position: "relative" }}>
        <button className="create" onClick={() => setMenuOpen((v) => !v)} disabled={creating}>
          ＋ {creating ? t("nav.creating") : t("nav.createNew")}
        </button>
        {menuOpen && (
          <div className="create-menu">
            <button onClick={() => createFile("writer")}><span className="cm-ico writer"><AppIcon kind="writer" /></span>Kreatix Writer</button>
            <button onClick={() => createFile("sheets")}><span className="cm-ico sheets"><AppIcon kind="sheets" /></span>Kreatix Sheets</button>
            <button onClick={() => createFile("present")}><span className="cm-ico present"><AppIcon kind="present" /></span>Kreatix Present</button>
            <hr />
            <button onClick={() => createFile("folder")}><span className="cm-ico folder-ico"><AppIcon kind="folder" /></span>{t("nav.newFolder")}</button>
            <button onClick={openFromComputer}><span className="cm-ico file-ico"><AppIcon kind="file" /></span>{t("nav.openFile")}</button>
            <button onClick={() => fileInput.current?.click()}><span className="cm-ico file-ico"><AppIcon kind="file" /></span>{t("nav.upload")}</button>
          </div>
        )}
        <input ref={fileInput} type="file" hidden
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <button className="open-local" onClick={openFromComputer} title={t("nav.openFromDeviceTitle")}>
          📂 {t("nav.openFromDevice")}
        </button>
      </div>

      <div className="section-label">{t("nav.workspace")}</div>
      <NavLink to="/home" end className={navCls}><span className="dot" />{t("nav.home")}</NavLink>
      <NavLink to="/drive" className={navCls}><span className="dot" />{t("nav.recent")}</NavLink>
      <NavLink to="/drive/starred" className={navCls}><span className="dot" />{t("nav.starred")}</NavLink>
      <NavLink to="/drive/all" className={navCls}><span className="dot" />{t("nav.drive")}</NavLink>
      <NavLink to="/drive/shared" className={navCls}><span className="dot" />{t("nav.shared")}</NavLink>
      <NavLink to="/drive/trash" className={navCls}><span className="dot" />{t("nav.trash")}</NavLink>

      <div className="section-label">{t("nav.applications")}</div>
      <button type="button" className="nav" onClick={() => createFile("writer")}><AppIcon kind="writer" size={18} />{t("nav.writer")}</button>
      <button type="button" className="nav" onClick={() => createFile("sheets")}><AppIcon kind="sheets" size={18} />{t("nav.sheets")}</button>
      <button type="button" className="nav" onClick={() => createFile("present")}><AppIcon kind="present" size={18} />{t("nav.present")}</button>
      <button type="button" className="nav" onClick={() => fileInput.current?.click()}><AppIcon kind="pdf" size={18} />PDF</button>

      <div className="section-label">{t("nav.workspaceTools")}</div>
      <button type="button" className="nav" onClick={onTemplates}><span className="dot" />{t("nav.templates")}</button>
      {(user?.role === "owner" || user?.role === "admin") && (
        <NavLink to="/admin" className={navCls}><span className="dot" />{t("nav.admin")}</NavLink>
      )}

      <div className="ai-card">
        <div className="tag">Kreatix AI</div>
        <h4>{t("nav.aiTagline")}</h4>
        <button onClick={() => void openAi()}>{t("nav.openAi")}</button>
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
  const t = useI18n().t;
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
      <button className="iconbtn" title={t("shell.notifications")} onClick={toggle} style={{ position: "relative" }}>
        ♢
        {unread > 0 && <span className="mention-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="user-menu" style={{ width: 300, maxHeight: 380, overflow: "auto" }}>
          <div className="um-head"><b>{t("shell.mentions")}</b></div>
          {!mentions.length && <div style={{ padding: "14px 16px", fontSize: 12, color: "var(--muted)" }}>{t("shell.noMentions")}</div>}
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
  const t = useI18n().t;
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [open, setOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
  const boxRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("kx_theme", next); } catch { /* private mode */ }
    setTheme(next);
  };

  useEffect(() => {
    const close = (e: MouseEvent) => {
      const el = e.target as Node;
      if (boxRef.current && !boxRef.current.contains(el)) setOpen(false);
      // the user menu sits outside .search — a mousedown on it must not
      // unmount the menu before its onClick handlers run
      if (userMenuRef.current && !userMenuRef.current.contains(el)) setUserMenu(false);
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
      <button className="iconbtn nav-burger" onClick={onNav} aria-label={t("shell.openNav")}>☰</button>
      <div className="search" ref={boxRef} style={{ position: "relative" }}>
        <span style={{ color: "var(--muted)" }}>⌕</span>
        <input
          placeholder={t("shell.search")}
          aria-label={t("shell.searchAria")}
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
        title={theme === "dark" ? t("shell.toLight") : t("shell.toDark")}
        aria-label={t("shell.toggleThemeAria")}>{theme === "dark" ? "☾" : "☼"}</button>
      <MentionsBell />
      <div ref={userMenuRef} style={{ position: "relative" }}>
        <button className="user" aria-label={t("shell.accountMenu")} aria-haspopup="menu" aria-expanded={userMenu}
          onClick={() => setUserMenu((v) => !v)}>{user?.initials ?? "…"}</button>
        {userMenu && (
          <div className="user-menu">
            <div className="um-head"><b>{user?.displayName}</b><span>{user?.email}</span></div>
            <button onClick={() => { logout(); navigate("/login"); }}>{t("shell.signOut")}</button>
          </div>
        )}
      </div>
    </div>
  );
}
