// Word-style mouse affordances for tables that prosemirror-tables lacks:
//  - row-height dragging (grab a row's bottom border, drag, commit on release)
//  - a top-left grip that selects the whole table (NodeSelection)
// Column resizing and cell drag-selection are already handled by
// columnResizing/tableEditing in the base Table extension.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, NodeSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

const GRAB_PX = 5; // invisible grab zone around a row's bottom border

const zoomOf = (view: EditorView): number => {
  const el = view.dom.closest(".doc-zoom") as HTMLElement | null;
  const z = el ? parseFloat(getComputedStyle(el).zoom) : 1;
  return isFinite(z) && z > 0 ? z : 1;
};

/** If the pointer sits on a row's bottom border, return the row's doc pos + current px height. */
const rowBorderHit = (view: EditorView, ev: MouseEvent) => {
  const cell = (ev.target as HTMLElement | null)?.closest?.("td,th");
  if (!cell || !view.dom.contains(cell)) return null;
  const rect = cell.getBoundingClientRect();
  if (Math.abs(ev.clientY - rect.bottom) > GRAB_PX) return null;
  const at = view.posAtCoords({ left: ev.clientX, top: rect.top + rect.height / 2 });
  if (!at) return null;
  const $pos = view.state.doc.resolve(at.pos);
  for (let d = $pos.depth; d >= 0; d--) {
    if ($pos.node(d).type.name === "tableRow") {
      return { rowPos: $pos.before(d), row: $pos.node(d), height: rect.height, startY: ev.clientY };
    }
  }
  return null;
};

/** Table element + doc pos under the pointer, if any (for the grip).
 *  PaginationPlus unboxes <table> (display:contents; the box lives on tbody),
 *  so callers should measure `tbody` for the real rect. */
const tableAt = (view: EditorView, ev: MouseEvent): { pos: number; el: HTMLElement } | null => {
  const table = (ev.target as HTMLElement | null)?.closest?.("table") as HTMLElement | null;
  if (!table || !view.dom.contains(table)) return null;
  const at = view.posAtCoords({ left: ev.clientX, top: ev.clientY });
  if (!at) return null;
  const $pos = view.state.doc.resolve(at.inside >= 0 ? at.inside : at.pos);
  for (let d = $pos.depth; d >= 0; d--) {
    if ($pos.node(d).type.name === "table") {
      const el = (table.querySelector("tbody") ?? table) as HTMLElement;
      return { pos: $pos.before(d), el };
    }
  }
  return null;
};

export const KxTableHandles = Extension.create({
  name: "kxTableHandles",

  addProseMirrorPlugins() {
    return [
      new Plugin<{ gripFor: number | null }>({
        key: new PluginKey("kxTableHandles"),

        state: {
          init: () => ({ gripFor: null }),
          apply: (_tr, v) => v,
        },

        props: {
          handleDOMEvents: {
            mousemove: (view, event) => {
              if (!view.editable || event.buttons) return;
              const on = rowBorderHit(view, event) != null;
              view.dom.classList.toggle("kx-rowgrab", on);
            },
            mousedown: (view, event) => {
              if (!view.editable || event.button !== 0) return;
              const hit = rowBorderHit(view, event);
              if (!hit) return;
              event.preventDefault();
              event.stopPropagation();

              const zoom = zoomOf(view);
              const guide = document.createElement("div");
              guide.className = "kx-row-guide";
              guide.style.top = `${event.clientY}px`;
              document.body.appendChild(guide);

              let dy = 0;
              const move = (e: MouseEvent) => {
                dy = e.clientY - hit.startY;
                guide.style.top = `${e.clientY}px`;
              };
              const up = () => {
                window.removeEventListener("mousemove", move, true);
                guide.remove();
                view.dom.classList.remove("kx-rowgrab");
                const height = Math.max(20, Math.round(hit.height + dy / zoom));
                const { state } = view;
                const node = state.doc.nodeAt(hit.rowPos);
                if (node && node.type.name === "tableRow") {
                  view.dispatch(state.tr.setNodeMarkup(hit.rowPos, undefined, {
                    ...node.attrs, height, heightMode: "exact",
                  }));
                }
              };
              window.addEventListener("mousemove", move, true);
              window.addEventListener("mouseup", up, { once: true, capture: true });
            },
            mouseleave: (view) => {
              view.dom.classList.remove("kx-rowgrab");
            },
          },
        },

        view(view) {
          const grip = document.createElement("div");
          grip.className = "kx-tbl-grip";
          grip.title = "Select table";
          grip.style.display = "none";
          grip.textContent = "⠿";
          document.body.appendChild(grip);

          let gripPos: number | null = null;
          let gripTbl: HTMLElement | null = null;

          const hide = () => {
            grip.style.display = "none";
            gripPos = null;
            gripTbl = null;
          };
          const place = (tbl: HTMLElement, pos: number) => {
            const r = tbl.getBoundingClientRect();
            grip.style.display = "flex";
            grip.style.left = `${r.left - 18}px`;
            grip.style.top = `${r.top - 8}px`;
            gripPos = pos;
            gripTbl = tbl;
          };

          const onMove = (e: MouseEvent) => {
            const hit = view.editable && !e.buttons ? tableAt(view, e) : null;
            if (hit) place(hit.el, hit.pos);
            else if (e.target !== grip) hide();
          };

          const onGripDown = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (gripPos == null) return;
            const { state } = view;
            const node = state.doc.nodeAt(gripPos);
            if (node?.type.name === "table") {
              view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, gripPos)));
            }
          };

          const onScroll = () => {
            if (gripPos != null && gripTbl?.isConnected) {
              // keep the grip glued while scrolling
              const r = gripTbl.getBoundingClientRect();
              grip.style.left = `${r.left - 18}px`;
              grip.style.top = `${r.top - 8}px`;
            } else hide();
          };

          document.addEventListener("mousemove", onMove, true);
          window.addEventListener("scroll", onScroll, true);
          grip.addEventListener("mousedown", onGripDown);

          return {
            update: () => {
              // table may have been deleted or moved — revalidate
              if (gripPos == null) return;
              const node = view.state.doc.nodeAt(gripPos);
              if (node?.type.name !== "table" || !gripTbl?.isConnected) hide();
              else onScroll();
            },
            destroy: () => {
              document.removeEventListener("mousemove", onMove, true);
              window.removeEventListener("scroll", onScroll, true);
              grip.remove();
            },
          };
        },
      }),
    ];
  },
});
