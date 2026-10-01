import { useEffect, useRef, useState, type ReactNode } from "react";
import { MenuList, type MenuItem } from "../writer/MenuBar";

/** A cluster of controls inside a ribbon tab — either inline JSX or a dropdown of MenuItems. */
export interface RibbonGroup {
  id: string;
  /** Caption rendered under the group (Excel-style "Font / Alignment" labels). */
  label?: string;
  /** Inline controls (.rb / .rb-sel / .rb-sep / pickers). */
  node?: ReactNode;
  /** Dropdown group — renders a "Label ▾" button opening a menu of MenuItems. */
  items?: MenuItem[];
}

export interface RibbonTab {
  id: string;
  label: string;
  /** Glyph shown in place of the label on narrow screens (mobile icon-only tabs). */
  icon?: ReactNode;
  /** File-style tab: opens a dropdown menu instead of switching the panel. */
  menu?: MenuItem[];
  groups?: RibbonGroup[];
  /** Contextual tab — shown by the editor only when a relevant selection exists. */
  contextual?: boolean;
}

interface RibbonTabsProps {
  tabs: RibbonTab[];
  /** Persists active tab + collapsed state under `kx-rib-{persistKey}-*`. */
  persistKey: string;
  /** Pinned right-side content inside the ribbon panel (zoom, word count, badges). */
  end?: ReactNode;
  /** Controlled active tab (editors with contextual auto-activation). */
  active?: string;
  onActive?: (id: string) => void;
}

function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* private mode */ }
}

/**
 * Excel-style ribbon: a tab row (File-style menu tabs + panel tabs) above a panel
 * of labeled command groups. Click the active tab or the chevron to collapse the
 * panel; on phones the panel is the same single scrollable strip as before.
 */
export function RibbonTabs({ tabs, persistKey, end, active, onActive }: RibbonTabsProps) {
  const tabIds = tabs.map((t) => t.id).join("|");
  const firstPanel = tabs.find((t) => !t.menu)?.id ?? tabs[0]?.id ?? "";
  const [inner, setInner] = useState<string>(() => load(`kx-ribtab-${persistKey}`) ?? "");
  const [collapsed, setCollapsed] = useState(() => load(`kx-ribcol-${persistKey}`) === "1");
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  // anchored position for the File-style dropdown — it must be position:fixed
  // because .ribbon-tabs scrolls horizontally (overflow-x:auto clips overflow-y)
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const activeId = active ?? (tabs.some((t) => t.id === inner && !t.menu) ? inner : firstPanel);
  const rootRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // a previously-active contextual tab may disappear — fall back to the first panel tab
  useEffect(() => {
    const cur = active ?? inner;
    if (!tabs.some((t) => t.id === cur) || tabs.find((t) => t.id === cur)?.menu) {
      if (!menuOpen) pick(firstPanel);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabIds]);

  // close File/menu tabs on outside click + Escape
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(null); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [menuOpen]);

  const pick = (id: string) => {
    setInner(id);
    onActive?.(id);
    save(`kx-ribtab-${persistKey}`, id);
  };

  const toggleCollapse = () => {
    setCollapsed((c) => {
      save(`kx-ribcol-${persistKey}`, c ? "0" : "1");
      return !c;
    });
  };

  const openMenu = (tab: RibbonTab) => {
    const r = tabRefs.current.get(tab.id)?.getBoundingClientRect();
    if (r) {
      // keep the drop inside the viewport on narrow screens
      const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - 264));
      setMenuPos({ left, top: r.bottom + 2 });
    } else setMenuPos({ left: 8, top: 60 });
    setMenuOpen(tab.id);
  };

  const onTabClick = (tab: RibbonTab) => {
    if (tab.menu) {
      if (menuOpen === tab.id) setMenuOpen(null);
      else openMenu(tab);
      return;
    }
    setMenuOpen(null);
    if (activeId === tab.id && !collapsed) toggleCollapse();
    else { pick(tab.id); if (collapsed) toggleCollapse(); }
  };

  // WAI-ARIA tablist keyboard nav — arrows move between tabs, Enter activates
  const onTabsKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const ids = tabs.map((t) => t.id);
    const cur = ids.indexOf(menuOpen ?? activeId);
    const next = e.key === "Home" ? 0
      : e.key === "End" ? ids.length - 1
      : (cur + (e.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length;
    tabRefs.current.get(ids[next])?.focus();
  };

  const activeTab = tabs.find((t) => t.id === activeId && !t.menu);
  const openMenuTab = tabs.find((t) => t.id === menuOpen && t.menu);

  // track the anchor tab on resize so the fixed drop stays attached
  useEffect(() => {
    if (!menuOpen || !openMenuTab) return;
    const move = () => {
      const r = tabRefs.current.get(openMenuTab.id)?.getBoundingClientRect();
      if (r) setMenuPos({
        left: Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - 264)),
        top: r.bottom + 2,
      });
    };
    window.addEventListener("resize", move);
    return () => window.removeEventListener("resize", move);
  }, [menuOpen, openMenuTab]);

  return (
    <div className="ribbon-wrap" ref={rootRef}>
      <div className="ribbon-tabs" role="tablist" aria-label="Ribbon tabs" onKeyDown={onTabsKeyDown}>
        {tabs.map((tab) => {
          const isMenu = !!tab.menu;
          const selected = isMenu ? menuOpen === tab.id : activeId === tab.id;
          return (
            <div key={tab.id} className="ribbon-tab-root">
              <button
                ref={(el) => { if (el) tabRefs.current.set(tab.id, el); else tabRefs.current.delete(tab.id); }}
                className={`ribbon-tab${isMenu ? " menu-tab" : ""}${tab.contextual ? " ctx" : ""}`}
                role={isMenu ? "button" : "tab"}
                aria-selected={!isMenu && selected}
                aria-expanded={isMenu ? selected : undefined}
                aria-haspopup={isMenu ? "menu" : undefined}
                tabIndex={selected ? 0 : -1}
                onClick={() => onTabClick(tab)}
                // menubar convention: while a menu is open, hovering another
                // menu tab switches the open menu to it
                onMouseEnter={() => { if (isMenu && menuOpen && menuOpen !== tab.id) openMenu(tab); }}
                onDoubleClick={() => !isMenu && toggleCollapse()}
              >
                {tab.icon && <span className="rt-ico" aria-hidden>{tab.icon}</span>}
                <span className="rt-label">{tab.label}</span>
              </button>
            </div>
          );
        })}
        <button
          className="ribbon-collapse"
          title={collapsed ? "Expand ribbon" : "Collapse ribbon"}
          aria-expanded={!collapsed}
          onClick={toggleCollapse}
        >{collapsed ? "⌄" : "⌃"}</button>
      </div>
      {/* File-style dropdown — fixed positioning escapes the scrollable tab row's clip */}
      {openMenuTab && menuPos && (
        <div className="menu-drop ribbon-menu-drop" role="menu" style={{ left: menuPos.left, top: menuPos.top }}>
          <MenuList items={openMenuTab.menu!} close={() => setMenuOpen(null)} depth={0} />
        </div>
      )}
      {!collapsed && activeTab && (
        <div className="ribbon ribbon-panel" role="tabpanel" aria-label={activeTab.label}>
          {activeTab.groups?.map((g) => (
            <RibbonGroupView key={g.id} group={g} />
          ))}
          {end && <div className="ribbon-end">{end}</div>}
        </div>
      )}
    </div>
  );
}

function RibbonGroupView({ group }: { group: RibbonGroup }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  if (group.items) {
    return (
      <div className="rbg" ref={ref}>
        <div className="rbg-body">
          <button className={`rb rbg-menu-btn${open ? " on" : ""}`} aria-haspopup="menu" aria-expanded={open}
            onClick={() => setOpen(!open)}>
            {group.label} <span className="rb-caret">▾</span>
          </button>
          {open && (
            <div className="menu-drop rbg-drop" role="menu">
              <MenuList items={group.items} close={() => setOpen(false)} depth={0} />
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="rbg">
      <div className="rbg-body">{group.node}</div>
      {group.label && <div className="rbg-cap">{group.label}</div>}
    </div>
  );
}
