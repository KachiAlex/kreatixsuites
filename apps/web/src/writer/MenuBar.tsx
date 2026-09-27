import { useEffect, useRef, useState, type ReactNode } from "react";
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

function MenuList({ items, close, depth }: { items: MenuItem[]; close: () => void; depth: number }) {
  const [sub, setSub] = useState<number | null>(null);
  return (
    <>
      {items.map((item, i) => {
        if (item.divider) return <div key={i} className="menu-divider" />;
        const hasSub = !!item.submenu?.length;
        return (
          <div
            key={i}
            className={`menu-item ${item.disabled ? "disabled" : ""}`}
            role="menuitem"
            aria-disabled={item.disabled}
            onMouseEnter={() => setSub(hasSub ? i : null)}
            onClick={(e) => {
              if (item.disabled) return;
              if (hasSub) { e.stopPropagation(); setSub(sub === i ? null : i); return; }
              item.onClick?.();
              close();
            }}
          >
            <span className="menu-check">{item.checked ? "✓" : ""}</span>
            <span className="menu-label">{item.icon}{item.label}</span>
            {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
            {hasSub && <span className="menu-sub-arrow">▸</span>}
            {hasSub && sub === i && (
              <div className="menu-drop sub" role="menu" style={{ top: -4 }}>
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
