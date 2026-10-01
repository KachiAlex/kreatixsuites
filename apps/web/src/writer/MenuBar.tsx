import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";

export interface MenuItem {
  label?: string;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  icon?: ReactNode;
  onClick?: () => void;
  submenu?: MenuItem[];
  divider?: boolean;
  /** Render a custom widget instead of a label row (e.g. table grid picker) */
  custom?: ReactNode;
}

interface MenuBarProps {
  items: { label: string; items: MenuItem[] }[];
}

/** Docs-style menubar: click to open, hover to switch menus, Esc/click-out to close. */
export function MenuBar({ items }: MenuBarProps) {
  const [open, setOpen] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <div className="menubar" ref={rootRef} role="menubar">
      {items.map((menu) => (
        <div key={menu.label} className="menu-root">
          <button
            className={`menu-btn ${open === menu.label ? "open" : ""}`}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === menu.label}
            onClick={() => setOpen(open === menu.label ? null : menu.label)}
            onMouseEnter={() => open && setOpen(menu.label)}
          >
            {menu.label}
          </button>
          {open === menu.label && (
            <div className="menu-drop" role="menu">
              <MenuList items={menu.items} close={() => setOpen(null)} depth={0} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Anchored flyout position for a submenu — position:fixed escapes the
 *  overflow:auto clipping on .menu-drop containers (a left:100% flyout inside
 *  a scroller is clipped invisible). Flips to the parent item's left edge when
 *  there's no room on the right; height clamps inside the viewport. */
export function subMenuStyle(rect: DOMRect): CSSProperties {
  const W = 244;
  const flip = rect.right + W > window.innerWidth - 8 && rect.left - W > 8;
  const top = Math.max(8, Math.min(rect.top, window.innerHeight - 224));
  return {
    position: "fixed",
    left: flip ? Math.max(8, rect.left - W + 2) : rect.right - 2,
    top,
    maxHeight: window.innerHeight - top - 8,
    overflowY: "auto",
  };
}

export function MenuList({ items, close, depth }: { items: MenuItem[]; close: () => void; depth: number }) {
  const [sub, setSub] = useState<{ i: number; rect: DOMRect } | null>(null);
  return (
    <>
      {items.map((item, i) => {
        if (item.divider) return <div key={i} className="menu-divider" />;
        if (item.custom) return <div key={i} className="menu-custom">{item.custom}</div>;
        const hasSub = !!item.submenu?.length;
        return (
          <div
            key={i}
            className={`menu-item ${item.disabled ? "disabled" : ""}`}
            role="menuitem"
            aria-disabled={item.disabled}
            onMouseEnter={(e) => setSub(hasSub ? { i, rect: e.currentTarget.getBoundingClientRect() } : null)}
            onClick={(e) => {
              if (item.disabled) return;
              if (hasSub) { e.stopPropagation(); setSub(sub?.i === i ? null : { i, rect: e.currentTarget.getBoundingClientRect() }); return; }
              item.onClick?.();
              close();
            }}
          >
            <span className="menu-check">{item.checked ? "✓" : ""}</span>
            <span className="menu-label">{item.icon}{item.label}</span>
            {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
            {hasSub && <span className="menu-sub-arrow">▸</span>}
            {hasSub && sub?.i === i && (
              <div className="menu-drop sub" role="menu" style={subMenuStyle(sub.rect)}>
                <MenuList items={item.submenu!} close={close} depth={depth + 1} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

// ---------- shared item builders (used by WriterEditor) ----------

export function textCaseItems(editor: Editor): MenuItem[] {
  const sel = () => {
    const { from, to } = editor.state.selection;
    return { from, to, text: editor.state.doc.textBetween(from, to, "\n") };
  };
  const transform = (fn: (s: string) => string) => () => {
    const { from, to, text } = sel();
    if (to > from) editor.chain().focus().insertContentAt({ from, to }, fn(text)).run();
  };
  return [
    { label: "UPPERCASE", onClick: transform((s) => s.toUpperCase()) },
    { label: "lowercase", onClick: transform((s) => s.toLowerCase()) },
    { label: "Title Case", onClick: transform((s) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())) },
    { label: "Capitalize first letter", onClick: transform((s) => s.charAt(0).toUpperCase() + s.slice(1)) },
  ];
}
