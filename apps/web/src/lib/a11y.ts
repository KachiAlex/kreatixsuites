// Global modal accessibility layer — retrofits every dialog that uses the
// codebase's .dlg-back/.overlay backdrop + .dlg/.dialog body convention,
// without touching each call site.
//
// A MutationObserver watches for dialogs mounting/unmounting and:
//   • sets role="dialog" + aria-modal="true" on the dialog body
//   • derives aria-label from the dialog's first h2/h3 heading
//   • focuses the [autofocus] element or first focusable inside, and
//     restores focus to the pre-dialog element on unmount
// A capture-phase keydown handler adds Escape-to-close (fires the backdrop's
// own click/mousedown handler — every dialog already wires close-on-backdrop)
// and traps Tab within the topmost dialog.
//
// Dialogs that render the Modal component manage all of this themselves —
// they're detected via role="dialog" and skipped by both observers.
import { useEffect } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const BACKDROPS = ".dlg-back, .overlay";
const BODIES = ".dlg, .dialog";

/** Topmost open dialog backdrop (later in DOM order = on top). */
function topBackdrop(): HTMLElement | null {
  const list = document.querySelectorAll<HTMLElement>(BACKDROPS);
  return list.length ? list[list.length - 1] : null;
}

function bodyOf(back: HTMLElement): HTMLElement | null {
  return back.querySelector<HTMLElement>(BODIES);
}

/** Dialogs built with <Modal> already self-manage — skip them. */
function selfManaged(back: HTMLElement): boolean {
  return !!back.querySelector('[role="dialog"]');
}

export function useGlobalModalA11y(): void {
  useEffect(() => {
    const restore = new Map<HTMLElement, Element | null>();

    const hydrate = (back: HTMLElement) => {
      if (selfManaged(back) || restore.has(back)) return;
      const body = bodyOf(back);
      if (!body) return;
      body.setAttribute("role", "dialog");
      body.setAttribute("aria-modal", "true");
      const heading = body.querySelector("h2, h3");
      if (heading && !body.hasAttribute("aria-label") && !body.hasAttribute("aria-labelledby")) {
        const label = heading.textContent?.trim();
        if (label) body.setAttribute("aria-label", label);
      }
      restore.set(back, document.activeElement);
      const first = body.querySelector<HTMLElement>("[autofocus]") ??
        body.querySelector<HTMLElement>(FOCUSABLE) ?? body;
      if (first === body) body.tabIndex = -1;
      first.focus();
    };

    const release = (back: HTMLElement) => {
      const prev = restore.get(back);
      restore.delete(back);
      if (prev instanceof HTMLElement) prev.focus();
    };

    const observer = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (!(n instanceof HTMLElement)) return;
          if (n.matches(BACKDROPS)) hydrate(n);
          n.querySelectorAll<HTMLElement>(BACKDROPS).forEach(hydrate);
        });
        m.removedNodes.forEach((n) => {
          if (!(n instanceof HTMLElement)) return;
          if (n.matches(BACKDROPS)) release(n);
          n.querySelectorAll<HTMLElement>(BACKDROPS).forEach(release);
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll<HTMLElement>(BACKDROPS).forEach(hydrate); // any already open

    const onKey = (e: KeyboardEvent) => {
      const back = topBackdrop();
      if (!back || selfManaged(back)) return;
      const body = bodyOf(back);
      if (!body) return;
      if (e.key === "Escape") {
        e.preventDefault();
        // reuse the dialog's own outside-click handler — uniform close path
        back.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        back.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...body.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((n) => n.offsetParent !== null);
      if (!items.length) { if (!body.contains(document.activeElement)) { body.tabIndex = -1; body.focus(); e.preventDefault(); } return; }
      const first = items[0], last = items[items.length - 1];
      const active = document.activeElement;
      if (!body.contains(active)) { first.focus(); e.preventDefault(); return; }
      if (e.shiftKey && active === first) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && active === last) { first.focus(); e.preventDefault(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { observer.disconnect(); document.removeEventListener("keydown", onKey, true); };
  }, []);
}
