import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

const FLOW_BLOCKS = "p,h1,h2,h3,h4,h5,h6";

interface LineRect { top: number; left: number; page: number }

/**
 * Word-style line numbering: measures the real line boxes of every flow
 * block (Range#getClientRects gives one rect per wrapped line), groups them
 * by page paper, and renders numbers into an absolutely-positioned overlay
 * pinned to the left margin. Recomputed on layout/doc changes, debounced.
 */
export const LineNumbers = Extension.create({
  name: "kxLineNumbers",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("kxLineNumbers"),
        view(view) {
          // the editor DOM mounts after plugin views are created — resolve the
          // overlay host lazily on the first compute, not at view() time
          let overlay: HTMLDivElement | null = null;
          const ensure = () => {
            if (overlay?.isConnected) return true;
            const host = view.dom.closest(".doc-page") as HTMLElement | null;
            if (!host) return false;
            overlay = document.createElement("div");
            overlay.className = "kx-linenums-overlay";
            host.appendChild(overlay);
            return true;
          };

          let raf = 0;
          let debounce = 0;

          const compute = () => {
            if (view.isDestroyed) return;
            if (!ensure() || !overlay) return;
            if (!view.dom.classList.contains("kx-linenums")) {
              if (overlay.childElementCount) overlay.replaceChildren();
              return;
            }
            const hostRect = overlay.getBoundingClientRect();
            const papers = [...view.dom.querySelectorAll<HTMLElement>(".kx-page-paper")];
            const paperRects = papers.map((p) => p.getBoundingClientRect());

            const lines: LineRect[] = [];
            const pushRect = (r: DOMRect, l: number, t: number) => {
              // merge rects that belong to the same visual line
              const prev = lines[lines.length - 1];
              if (prev && prev.page === l && Math.abs(prev.top - t) < 2) return;
              lines.push({ top: t, left: r.left, page: l });
            };

            const pageOf = (cy: number) => {
              if (!paperRects.length) return 0;
              for (let i = 0; i < paperRects.length; i++) {
                if (cy <= paperRects[i].bottom) return i;
              }
              return paperRects.length - 1;
            };

            const blocks = view.dom.querySelectorAll<HTMLElement>(FLOW_BLOCKS);
            const range = document.createRange();
            for (const el of blocks) {
              if (el.closest(".rm-pages-wrapper,td,th,[class*='header'],[class*='footer'],.kx-linenums-overlay,.kx-notes-area")) continue;
              const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
              let sawText = false;
              let node = walker.nextNode();
              while (node) {
                const tn = node as Text;
                if (tn.data.trim() || tn.data.length) {
                  range.selectNodeContents(tn);
                  for (const r of range.getClientRects()) {
                    if (r.height < 2) continue;
                    sawText = true;
                    pushRect(r, pageOf(r.top + r.height / 2), r.top);
                  }
                }
                node = walker.nextNode();
              }
              if (!sawText) {
                const r = el.getBoundingClientRect();
                if (r.height >= 2) pushRect(r, pageOf(r.top + r.height / 2), r.top);
              }
            }

            const perPage = new Map<number, LineRect[]>();
            for (const ln of lines) {
              const arr = perPage.get(ln.page) ?? [];
              arr.push(ln);
              perPage.set(ln.page, arr);
            }

            const frag = document.createDocumentFragment();
            for (const [page, arr] of perPage) {
              arr.sort((a, b) => a.top - b.top);
              const paper = paperRects[page];
              const left = paper
                ? paper.left - hostRect.left + 14
                : Math.min(...arr.map((l) => l.left)) - hostRect.left - 42;
              arr.forEach((ln, i) => {
                const d = document.createElement("div");
                d.className = "kx-linenum";
                d.textContent = String(i + 1);
                d.style.top = `${ln.top - hostRect.top}px`;
                d.style.left = `${Math.max(0, left)}px`;
                frag.appendChild(d);
              });
            }
            overlay.replaceChildren(frag);
          };

          const schedule = () => {
            clearTimeout(debounce);
            debounce = window.setTimeout(() => {
              raf = requestAnimationFrame(compute);
            }, 250);
          };

          const ro = new ResizeObserver(schedule);
          ro.observe(view.dom);
          schedule();

          return {
            update() { schedule(); },
            destroy() {
              clearTimeout(debounce);
              cancelAnimationFrame(raf);
              ro.disconnect();
              overlay?.remove();
            },
          };
        },
      }),
    ];
  },
});
