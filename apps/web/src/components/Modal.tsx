// Accessible modal wrapper: role=dialog + aria-modal, focus trap,
// Escape-to-close, and focus restore on unmount. Two skins matching the
// codebase's existing conventions — "overlay" (.overlay > .dialog) and
// "dlg" (.dlg-back > .dlg).
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ onClose, label, skin = "overlay", children, className, style }: {
  onClose: () => void;
  label: string;
  skin?: "overlay" | "dlg";
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const backRef = useRef<HTMLDivElement>(null);
  const dlgRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dlg = dlgRef.current;
    const back = backRef.current;
    if (!dlg || !back) return;
    const prev = document.activeElement as HTMLElement | null;

    // initial focus: explicit autofocus target, else first focusable, else the dialog
    const first = (dlg.querySelector<HTMLElement>("[autofocus]") ??
      dlg.querySelector<HTMLElement>(FOCUSABLE) ?? dlg) as HTMLElement;
    if (first === dlg) dlg.tabIndex = -1;
    first.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab") return;
      const items = [...dlg.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (!items.length) { e.preventDefault(); return; }
      const firstI = items[0], lastI = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstI) { lastI.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === lastI) { firstI.focus(); e.preventDefault(); }
    };
    back.addEventListener("keydown", onKey);
    return () => { back.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, [onClose]);

  return (
    <div ref={backRef} className={skin === "overlay" ? "overlay" : "dlg-back"}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dlgRef} className={`${skin === "overlay" ? "dialog" : "dlg"}${className ? ` ${className}` : ""}`}
        style={style} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}
