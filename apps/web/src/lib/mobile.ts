import { useEffect, useRef, useState } from "react";

/** Reactive media query hook. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Coarse pointer (touchscreen) — cached, evaluated once per call site mount. */
export function isCoarse(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
}

/** Phone-ish width. Tablet still gets the desktop shell minus the sidebar. */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 768px)");
}

export function useIsTablet(): boolean {
  return useMediaQuery("(min-width: 769px) and (max-width: 1180px)");
}

export function useIsCoarse(): boolean {
  return useMediaQuery("(pointer: coarse)");
}

/**
 * Position a popover so it stays inside the viewport. Given a desired x/y
 * (usually pointer coords) and the popover's measured size, returns adjusted
 * coordinates clamped with a small margin.
 */
export function clampToViewport(x: number, y: number, w: number, h: number, margin = 8): { x: number; y: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.min(Math.max(margin, x), Math.max(margin, vw - w - margin)),
    y: Math.min(Math.max(margin, y), Math.max(margin, vh - h - margin)),
  };
}

/**
 * Long-press handler — iOS Safari doesn't reliably fire `contextmenu`.
 * Returns pointer event handlers; call `preventDefault` in `onLongPress` is not
 * needed — the hook suppresses the click that follows a fired long-press.
 */
export function useLongPress(onLongPress: (pt: { x: number; y: number }) => void, ms = 500) {
  const timer = useRef<number>(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = () => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = 0; }
    start.current = null;
  };

  return {
    fired,
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = window.setTimeout(() => {
        fired.current = true;
        onLongPress(start.current!);
      }, ms);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!start.current) return;
      if (Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
  };
}

/** visualViewport subscription — height shrinks while the soft keyboard is up. */
export function useVisualViewport(): { height: number; offsetTop: number } {
  const [vv, setVv] = useState(() => ({
    height: typeof window !== "undefined" && window.visualViewport ? window.visualViewport.height : window.innerHeight,
    offsetTop: typeof window !== "undefined" && window.visualViewport ? window.visualViewport.offsetTop : 0,
  }));
  useEffect(() => {
    const vp = window.visualViewport;
    if (!vp) return;
    const update = () => setVv({ height: vp.height, offsetTop: vp.offsetTop });
    vp.addEventListener("resize", update);
    vp.addEventListener("scroll", update);
    return () => { vp.removeEventListener("resize", update); vp.removeEventListener("scroll", update); };
  }, []);
  return vv;
}
