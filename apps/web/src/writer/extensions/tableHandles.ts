// Word-style mouse affordances for tables that prosemirror-tables lacks:
//  - row-height dragging on every horizontal border (bottom edges of cells,
//    the table's top edge adjusts row 1, bottom edge adjusts the last row)
//  - first-column left-border dragging (lib only resizes via right edges)
//  - bottom-right corner handle that scales all columns proportionally
//  - a top-left grip: click selects the table, drag moves it in the doc
// Interior column borders and cell drag-selection are already handled by
// columnResizing/tableEditing in the base Table extension.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, NodeSelection } from "@tiptap/pm/state";
import { TableMap } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";

const GRAB_PX = 5; // invisible grab zone around borders

const zoomOf = (view: EditorView): number => {
  const el = view.dom.closest(".doc-zoom") as HTMLElement | null;
  const z = el ? parseFloat(getComputedStyle(el).zoom) : 1;
  return isFinite(z) && z > 0 ? z : 1;
};

interface TableCtx {
  tablePos: number;
  rowIdx: number;   // index of the row whose border was grabbed
  rowPos: number;
  colIdx: number;   // index of the column whose border was grabbed
  cellStart: number;
  map: TableMap;
}

/** Resolve the td/th under the pointer to table/row/column indices. */
const cellCtx = (view: EditorView, ev: MouseEvent, rect: DOMRect): TableCtx | null => {
  const at = view.posAtCoords({ left: rect.left + rect.width / 2, top: rect.top + rect.height / 2 });
  if (!at) return null;
  const $pos = view.state.doc.resolve(at.pos);
  let tablePos = -1, rowPos = -1, cellStart = -1;
  for (let d = $pos.depth; d >= 0; d--) {
    const n = $pos.node(d).type.name;
    if (n === "table") tablePos = $pos.before(d);
    else if (n === "tableRow") rowPos = $pos.before(d);
    else if (n === "tableCell" || n === "tableHeader") cellStart = $pos.before(d);
  }
  if (tablePos < 0 || rowPos < 0 || cellStart < 0) return null;
  const table = view.state.doc.nodeAt(tablePos)!;
  const map = TableMap.get(table);
  const rc = map.findCell(cellStart - tablePos - 1);
  const rowspan = (view.state.doc.nodeAt(cellStart)?.attrs.rowspan as number) || 1;
  // grid row index of the visual bottom edge of this cell
  const bottomRow = rc.top + rowspan - 1;
  // find doc position of the row index we actually want to size
  let rowIdx = rc.top;
  const border = Math.abs(ev.clientY - rect.bottom) <= GRAB_PX ? "bottom"
    : Math.abs(ev.clientY - rect.top) <= GRAB_PX ? "top" : null;
  if (border === "bottom") rowIdx = bottomRow;
  else if (border === "top") rowIdx = rc.top > 0 ? rc.top - 1 : 0;
  let targetRowPos = -1;
  table.forEach((_row, off, i) => { if (i === rowIdx) targetRowPos = tablePos + 1 + off; });
  return { tablePos, rowIdx, rowPos: targetRowPos, colIdx: rc.left, cellStart, map };
};

/** Table element + doc pos under the pointer, if any (for the grip/corner).
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

/** Horizontal border hit → which row edge, or null. */
const rowBorderHit = (view: EditorView, ev: MouseEvent) => {
  const cell = (ev.target as HTMLElement | null)?.closest?.("td,th");
  if (!cell || !view.dom.contains(cell)) return null;
  const rect = cell.getBoundingClientRect();
  const ctx = cellCtx(view, ev, rect);
  if (!ctx || ctx.rowPos < 0) return null;
  if (Math.abs(ev.clientY - rect.bottom) <= GRAB_PX) {
    return { ctx, height: rect.height, startY: ev.clientY };
  }
  if (Math.abs(ev.clientY - rect.top) <= GRAB_PX) {
    // top edge of row 0 = table's top border (sizes row 0);
    // other rows' top edge belongs to the row above — rowIdx already mapped
    return { ctx, height: rect.height, startY: ev.clientY };
  }
  return null;
};

/** Left border of a first-column cell → resize column 0 (lib skips it). */
const col0BorderHit = (view: EditorView, ev: MouseEvent) => {
  const cell = (ev.target as HTMLElement | null)?.closest?.("td,th");
  if (!cell || !view.dom.contains(cell)) return null;
  const rect = cell.getBoundingClientRect();
  if (Math.abs(ev.clientX - rect.left) > GRAB_PX) return null;
  const ctx = cellCtx(view, ev, rect);
  if (!ctx || ctx.colIdx !== 0) return null;
  return { ctx, width: rect.width, startX: ev.clientX };
};

/** Doc position of the Nth row inside a table. */
const setColWidth = (tr: any, tablePos: number, table: any, map: TableMap, colIdx: number, width: number) => {
  table.forEach((row: any, off: number) => {
    row.forEach((cell: any, coff: number) => {
      const start = tablePos + 1 + off + 1 + coff;
      const rc = map.findCell(start - tablePos - 1);
      const span = (cell.attrs.colspan as number) || 1;
      if (rc.left <= colIdx && colIdx < rc.left + span) {
        const widths = [...((cell.attrs.colwidth as number[] | null) ?? Array(span).fill(null))];
        widths[colIdx - rc.left] = Math.round(width);
        tr.setNodeMarkup(start, undefined, { ...cell.attrs, colwidth: widths });
      }
    });
  });
};

/** Current pixel width of each grid column, measured from the DOM via the doc map. */
const measureColumns = (tbody: HTMLElement, map: TableMap, table: any): number[] => {
  const widths = Array(map.width).fill(0) as number[];
  const domRows = tbody.querySelectorAll("tr");
  table.forEach((row: any, off: number, r: number) => {
    const domRow = domRows[r];
    let c = 0;
    row.forEach((cell: any, coff: number) => {
      const rc = map.findCell(off + 1 + coff);
      const span = (cell.attrs.colspan as number) || 1;
      const el = domRow?.children[c] as HTMLElement | undefined;
      const w = (el?.getBoundingClientRect().width || 0) / span;
      for (let i = 0; i < span; i++) if (w) widths[rc.left + i] ||= w;
      c++;
    });
  });
  return widths.map(w => w || 60);
};

const mkGuide = (cls: string) => {
  const g = document.createElement("div");
  g.className = cls;
  document.body.appendChild(g);
  return g;
};

export const KxTableHandles = Extension.create({
  name: "kxTableHandles",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("kxTableHandles"),

        props: {
          handleDOMEvents: {
            mousemove: (view, event) => {
              if (!view.editable || event.buttons) return;
              const rowHit = rowBorderHit(view, event);
              const colHit = !rowHit && col0BorderHit(view, event);
              view.dom.classList.toggle("kx-rowgrab", !!rowHit);
              view.dom.classList.toggle("kx-colgrab", !!colHit);
            },

            mousedown: (view, event) => {
              if (!view.editable || event.button !== 0) return;
              const zoom = zoomOf(view);

              const rHit = rowBorderHit(view, event);
              if (rHit) {
                event.preventDefault();
                event.stopPropagation();
                const guide = mkGuide("kx-row-guide");
                guide.style.top = `${event.clientY}px`;
                let dy = 0;
                const move = (e: MouseEvent) => {
                  dy = e.clientY - rHit.startY;
                  guide.style.top = `${e.clientY}px`;
                };
                const up = () => {
                  window.removeEventListener("mousemove", move, true);
                  guide.remove();
                  view.dom.classList.remove("kx-rowgrab");
                  const height = Math.max(20, Math.round(rHit.height + dy / zoom));
                  const { state } = view;
                  const node = state.doc.nodeAt(rHit.ctx.rowPos);
                  if (node?.type.name === "tableRow") {
                    view.dispatch(state.tr.setNodeMarkup(rHit.ctx.rowPos, undefined, {
                      ...node.attrs, height, heightMode: "exact",
                    }));
                  }
                };
                window.addEventListener("mousemove", move, true);
                window.addEventListener("mouseup", up, { once: true, capture: true });
                return true;
              }

              const cHit = col0BorderHit(view, event);
              if (cHit) {
                event.preventDefault();
                event.stopPropagation();
                const guide = mkGuide("kx-col-guide");
                guide.style.left = `${event.clientX}px`;
                let dx = 0;
                const move = (e: MouseEvent) => {
                  dx = e.clientX - cHit.startX;
                  guide.style.left = `${e.clientX}px`;
                };
                const up = () => {
                  window.removeEventListener("mousemove", move, true);
                  guide.remove();
                  view.dom.classList.remove("kx-colgrab");
                  const width = Math.max(24, cHit.width + dx / zoom);
                  const { state } = view;
                  const table = state.doc.nodeAt(cHit.ctx.tablePos);
                  if (table?.type.name === "table") {
                    const tr = state.tr;
                    setColWidth(tr, cHit.ctx.tablePos, table, cHit.ctx.map, 0, width);
                    view.dispatch(tr);
                  }
                };
                window.addEventListener("mousemove", move, true);
                window.addEventListener("mouseup", up, { once: true, capture: true });
                return true;
              }
            },

            mouseleave: (view) => {
              view.dom.classList.remove("kx-rowgrab");
              view.dom.classList.remove("kx-colgrab");
            },
          },
        },

        view(view) {
          const grip = document.createElement("div");
          grip.className = "kx-tbl-grip";
          grip.title = "Click to select table · drag to move";
          grip.style.display = "none";
          grip.textContent = "⠿";
          document.body.appendChild(grip);

          const corner = document.createElement("div");
          corner.className = "kx-tbl-corner";
          corner.title = "Drag to resize table";
          corner.style.display = "none";
          document.body.appendChild(corner);

          let gripPos: number | null = null;
          let gripTbl: HTMLElement | null = null;

          const hide = () => {
            grip.style.display = "none";
            corner.style.display = "none";
            gripPos = null;
            gripTbl = null;
          };
          const place = (tbl: HTMLElement, pos: number) => {
            const r = tbl.getBoundingClientRect();
            grip.style.display = "flex";
            grip.style.left = `${r.left - 18}px`;
            grip.style.top = `${r.top - 8}px`;
            corner.style.display = "block";
            corner.style.left = `${r.right - 4}px`;
            corner.style.top = `${r.bottom - 4}px`;
            gripPos = pos;
            gripTbl = tbl;
          };

          const onMove = (e: MouseEvent) => {
            const hit = view.editable && !e.buttons ? tableAt(view, e) : null;
            if (hit) place(hit.el, hit.pos);
            else if (e.target !== grip && e.target !== corner) hide();
          };

          /** Shared move-table drag state, used by the grip. */
          const startTableDrag = (e: MouseEvent) => {
            const startPos = gripPos;
            if (startPos == null) return;
            const table = view.state.doc.nodeAt(startPos);
            if (table?.type.name !== "table") return;

            const startX = e.clientX, startY = e.clientY;
            const dragTbl = gripTbl; // hide() nulls gripTbl — capture it now
            let moved = false;
            let dropPos: number | null = null;
            const line = mkGuide("kx-drop-guide");
            line.style.display = "none";

            const move = (ev: MouseEvent) => {
              if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
              moved = true;
              hide(); // grip floats in the way otherwise
              line.style.display = "block";
              // nearest top-level boundary to the pointer, excluding inside the
              // table; clamp X to the table's span so margin drags don't snap
              // to doc start
              const tr2 = dragTbl?.getBoundingClientRect();
              const cx = tr2 ? Math.min(Math.max(ev.clientX, tr2.left + 8), tr2.right - 8) : ev.clientX;
              const at = view.posAtCoords({ left: cx, top: ev.clientY });
              dropPos = null;
              if (at) {
                const $p = view.state.doc.resolve(at.pos);
                const b = $p.before(1), a = $p.after(1);
                const tableEnd = startPos + table.nodeSize;
                const cand = Math.abs(at.pos - b) <= Math.abs(at.pos - a) ? b : a;
                if (!(cand >= startPos && cand <= tableEnd)) dropPos = cand;
              }
              if (dropPos != null) {
                try {
                  const co = view.coordsAtPos(dropPos);
                  line.style.top = `${co.top}px`;
                  line.style.opacity = "1";
                } catch { line.style.opacity = "0.4"; }
              } else line.style.opacity = "0.4";
            };
            const up = (ev: MouseEvent) => {
              window.removeEventListener("mousemove", move, true);
              line.remove();
              const node = view.state.doc.nodeAt(startPos);
              if (moved && dropPos != null && node?.type.name === "table") {
                const { state } = view;
                const tr = state.tr.delete(startPos, startPos + node.nodeSize);
                const target = tr.mapping.map(dropPos);
                try {
                  tr.insert(target, node);
                  tr.setSelection(NodeSelection.create(tr.doc, target)).scrollIntoView();
                  view.dispatch(tr);
                } catch { /* invalid drop target — keep table in place */ }
              } else if (!moved) {
                const { state } = view;
                view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, startPos)));
              }
              void ev;
            };
            window.addEventListener("mousemove", move, true);
            window.addEventListener("mouseup", up, { once: true, capture: true });
          };

          const onGripDown = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            startTableDrag(e);
          };

          const onCornerDown = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (gripPos == null || !gripTbl) return;
            const tablePos = gripPos;
            const tbody = gripTbl;
            const zoom = zoomOf(view);
            const r0 = tbody.getBoundingClientRect();
            const { state } = view;
            const table = state.doc.nodeAt(tablePos);
            if (table?.type.name !== "table") return;
            const map = TableMap.get(table);
            const base = measureColumns(tbody, map, table);
            const guide = mkGuide("kx-col-guide");
            guide.style.left = `${e.clientX}px`;

            let dx = 0;
            const move = (ev: MouseEvent) => {
              dx = ev.clientX - e.clientX;
              guide.style.left = `${ev.clientX}px`;
            };
            const up = () => {
              window.removeEventListener("mousemove", move, true);
              guide.remove();
              const factor = Math.max(0.25, (r0.width + dx / zoom) / r0.width);
              const { state: st } = view;
              const node = st.doc.nodeAt(tablePos);
              if (node?.type.name === "table") {
                const tr = st.tr;
                for (let c = 0; c < map.width; c++) {
                  setColWidth(tr, tablePos, node, map, c, base[c] * factor);
                }
                view.dispatch(tr);
              }
            };
            window.addEventListener("mousemove", move, true);
            window.addEventListener("mouseup", up, { once: true, capture: true });
          };

          const onScroll = () => {
            if (gripPos != null && gripTbl?.isConnected) {
              const r = gripTbl.getBoundingClientRect();
              grip.style.left = `${r.left - 18}px`;
              grip.style.top = `${r.top - 8}px`;
              corner.style.left = `${r.right - 4}px`;
              corner.style.top = `${r.bottom - 4}px`;
            } else hide();
          };

          document.addEventListener("mousemove", onMove, true);
          window.addEventListener("scroll", onScroll, true);
          grip.addEventListener("mousedown", onGripDown);
          corner.addEventListener("mousedown", onCornerDown);

          return {
            update: () => {
              if (gripPos == null) return;
              const node = view.state.doc.nodeAt(gripPos);
              if (node?.type.name !== "table" || !gripTbl?.isConnected) hide();
              else onScroll();
            },
            destroy: () => {
              document.removeEventListener("mousemove", onMove, true);
              window.removeEventListener("scroll", onScroll, true);
              grip.remove();
              corner.remove();
            },
          };
        },
      }),
    ];
  },
});
