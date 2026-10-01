import { useEffect, useRef, type ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

/**
 * Bottom sheet — used on coarse-pointer / small screens in place of fixed
 * popovers. Renders nothing when closed. Drag the handle or tap the backdrop
 * to dismiss; Escape closes.
 */
export function BottomSheet({ open, onClose, title, children }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const dragY = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);

  if (!open) return null;

  const onPointerDown = (e: React.PointerEvent) => {
    dragY.current = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragY.current === null || !cardRef.current) return;
    const dy = Math.max(0, e.clientY - dragY.current);
    cardRef.current.style.transform = `translateY(${dy}px)`;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (dragY.current === null || !cardRef.current) return;
    const dy = Math.max(0, e.clientY - dragY.current);
    dragY.current = null;
    cardRef.current.style.transform = "";
    if (dy > 90) onClose();
  };

  return (
    <div className="sheet-back" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet-card" ref={cardRef} role="dialog" aria-modal="true">
        <div className="sheet-grip" onPointerDown={onPointerDown} onPointerMove={onPointerMove}
          onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <div className="sheet-grip-bar" />
        </div>
        {title && <div className="sheet-title">{title}</div>}
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
