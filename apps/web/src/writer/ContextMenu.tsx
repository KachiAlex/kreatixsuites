import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { subMenuStyle, type MenuItem } from "./MenuBar";

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** Positioned right-click menu — same item model as MenuBar, nested submenus
 *  supported. Clamps inside the viewport. */
export function ContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - r.width - 8);
    const y = Math.min(menu.y, window.innerHeight - r.height - 8);
    setPos({ x: Math.max(4, x), y: Math.max(4, y) });
  }, [menu]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const scroll = () => onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [onClose]);

  return (
    <div className="ctx-menu menu-drop" ref={ref} role="menu"
      style={{ position: "fixed", left: pos.x, top: pos.y }}>
      <CtxList items={menu.items} close={onClose} />
    </div>
  );
}

function CtxList({ items, close }: { items: MenuItem[]; close: () => void }) {
  const [sub, setSub] = useState<{ i: number; rect: DOMRect } | null>(null);
  return (
    <>
      {items.map((item, i) => {
        if (item.divider) return <div key={i} className="menu-divider" />;
        const hasSub = !!item.submenu?.length;
        return (
          <div
            key={i}
            className={`menu-item ${item.disabled ? "disabled" : ""} ${item.danger ? "danger" : ""}`}
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
                <CtxList items={item.submenu!} close={close} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
