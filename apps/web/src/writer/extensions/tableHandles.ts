// Word-style mouse affordances for tables that prosemirror-tables lacks:
//  - row-height dragging on every horizontal border (bottom edges of cells,
//    the table's top edge adjusts row 1, bottom edge adjusts the last row)
//  - first-column left-border dragging (lib only resizes via right edges)
//  - bottom-right corner handle that scales all columns proportionally
//  - a top-left grip: click selects the table, drag moves it in the doc
// Interior column borders and cell drag-selection are already handled by
// columnResizing/tableEditing in the base Table extension.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, NodeSelection, TextSelection } from "@tiptap/pm/state";
import {
  TableMap, CellSelection,
  addRowBefore, addRowAfter, addColumnBefore, addColumnAfter,
  mergeCells,
} from "@tiptap/pm/tables";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { splitCellsInTable } from "./table";

const GRAB_PX = 5; // invisible grab zone around borders

/** Active pen/eraser tool — toggled via the `setTableTool` command. */
export type TableTool = "draw" | "erase" | null;
let tableTool: TableTool = null;
export const getTableTool = (): TableTool => tableTool;

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

// ---- selection affordances (cell arrow / row strip / column strip) ----------

type SelZone =
  | { kind: "cell"; cellPos: number }
  | { kind: "row"; cellPos: number }   // a cell in the target row
  | { kind: "col"; cellPos: number };  // a cell in the target column

/** Doc pos of the cell node whose content contains the given pos. */
const cellPosAt = (view: EditorView, pos: number): number | null => {
  const $p = view.state.doc.resolve(pos);
  for (let d = $p.depth; d >= 0; d--) {
    const n = $p.node(d).type.name;
    if (n === "tableCell" || n === "tableHeader") return $p.before(d);
  }
  return null;
};

/** Which selection zone (if any) the pointer is in. */
const selZoneHit = (view: EditorView, ev: MouseEvent): SelZone | null => {
  const target = ev.target as HTMLElement | null;
  const cell = target?.closest?.("td,th");
  if (cell && view.dom.contains(cell)) {
    // cell-select arrow strip: just inside the cell's left edge, past the
    // border-resize grab zone
    const rect = cell.getBoundingClientRect();
    const dl = ev.clientX - rect.left;
    // strip starts past the boundary-insert band (GRAB..11px = ⊕ insert zone)
    // and never exceeds ~30% of the cell width — narrow cells stay clickable
    const stripEnd = Math.min(18, Math.max(12, rect.width * 0.3));
    if (dl > 11 && dl <= stripEnd && ev.clientY > rect.top + 2 && ev.clientY < rect.bottom - 2) {
      const at = view.posAtCoords({ left: rect.left + rect.width / 2, top: rect.top + rect.height / 2 });
      const pos = at && cellPosAt(view, at.pos);
      if (pos != null) return { kind: "cell", cellPos: pos };
    }
    return null;
  }
  // strips outside cells: scan the editor's tbodies (cheap — tables are few)
  for (const tbody of view.dom.querySelectorAll("tbody")) {
    const tr = tbody.getBoundingClientRect();
    if (tr.width === 0) continue;
    // left of the table edge → row select strip
    if (ev.clientX < tr.left && ev.clientX > tr.left - 22 && ev.clientY >= tr.top && ev.clientY <= tr.bottom) {
      const at = view.posAtCoords({ left: tr.left + 6, top: ev.clientY });
      const pos = at && cellPosAt(view, at.pos);
      if (pos != null) return { kind: "row", cellPos: pos };
    }
    // above the table's top edge → column select strip
    if (ev.clientY < tr.top && ev.clientY > tr.top - 20 && ev.clientX >= tr.left && ev.clientX <= tr.right) {
      const at = view.posAtCoords({ left: ev.clientX, top: tr.top + 6 });
      const pos = at && cellPosAt(view, at.pos);
      if (pos != null) return { kind: "col", cellPos: pos };
    }
  }
  return null;
};

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    kxTableTools: {
      /** Toggle the Draw-table pen or Eraser tool (pass null, or the active
       *  mode, to switch back to normal editing). */
      setTableTool: (mode: TableTool) => ReturnType;
    };
  }
}

// ---- draw-table pen & eraser ------------------------------------------------

/** Entry point while a tool is armed. Returns true when the event was
 *  consumed inside the editor. */
const toolMouseDown = (view: EditorView, ev: MouseEvent): boolean => {
  if (!view.dom.contains(ev.target as Node)) return false;
  if (tableTool === "erase") { eraseDown(view, ev); return true; }
  if (tableTool === "draw") { drawDown(view, ev); return true; }
  return false;
};

/** Eraser: click a border to remove it — interior borders merge the cells
 *  across them, perimeter borders are set to `none`. Dragging across a cell
 *  range merges the whole rectangle (Word behaviour). */
const eraseDown = (view: EditorView, ev: MouseEvent): void => {
  const el = (ev.target as HTMLElement | null)?.closest?.("td,th") as HTMLElement | null;
  if (!el || !view.dom.contains(el)) return;
  const rect = el.getBoundingClientRect();
  const at = view.posAtCoords({ left: rect.left + rect.width / 2, top: rect.top + rect.height / 2 });
  const startPos = at && cellPosAt(view, at.pos);
  if (startPos == null) return;
  const sx = ev.clientX, sy = ev.clientY;
  const up = (u: MouseEvent) => {
    if (Math.hypot(u.clientX - sx, u.clientY - sy) > 8) {
      const ue = view.posAtCoords({ left: u.clientX, top: u.clientY });
      const endPos = ue && cellPosAt(view, ue.pos);
      if (endPos != null && endPos !== startPos) {
        try {
          view.dispatch(view.state.tr.setSelection(
            CellSelection.create(view.state.doc, startPos, endPos)));
          mergeCells(view.state, (t) => view.dispatch(t));
          return;
        } catch { /* cells can't form a merge rect — fall through */ }
      }
    }
    eraseBorderAt(view, ev, rect, startPos);
  };
  window.addEventListener("mouseup", up, { once: true, capture: true });
};

const eraseBorderAt = (
  view: EditorView, ev: MouseEvent,
  rect: DOMRect, cellStart: number,
): void => {
  const d: Record<string, number> = {
    left: ev.clientX - rect.left, right: rect.right - ev.clientX,
    top: ev.clientY - rect.top, bottom: rect.bottom - ev.clientY,
  };
  const [side, dist] = Object.entries(d).sort((a, b) => a[1] - b[1])[0];
  if (dist > GRAB_PX + 6) return;
  const ctx = cellCtx(view, ev, rect);
  if (!ctx) return;
  const { map, tablePos } = ctx;
  const cellNode = view.state.doc.nodeAt(cellStart);
  if (!cellNode) return;
  const rc = map.findCell(cellStart - tablePos - 1);
  const cs = (cellNode.attrs.colspan as number) || 1;
  const rs = (cellNode.attrs.rowspan as number) || 1;
  let nr = -1, nc = -1;
  if (side === "left") { nr = rc.top; nc = rc.left - 1; }
  else if (side === "right") { nr = rc.top + rs - 1; nc = rc.left + cs; }
  else if (side === "top") { nr = rc.top - 1; nc = rc.left; }
  else { nr = rc.top + rs; nc = rc.left; }
  const inGrid = nr >= 0 && nr < map.height && nc >= 0 && nc < map.width;
  if (inGrid) {
    const nPos = tablePos + 1 + map.map[nr * map.width + nc];
    if (nPos === cellStart) return; // edge of a merged cell — nothing across
    try {
      view.dispatch(view.state.tr.setSelection(
        CellSelection.create(view.state.doc, cellStart, nPos)));
      mergeCells(view.state, (t) => view.dispatch(t));
    } catch { /* not mergeable */ }
    return;
  }
  const borders = {
    ...(cellNode.attrs.borders as Record<string, unknown> | null),
    [side]: { style: "none", width: 0, color: "transparent" },
  };
  view.dispatch(view.state.tr.setNodeMarkup(cellStart, undefined,
    { ...cellNode.attrs, borders }));
};

/** Draw-table pen: drag inside a cell → split it on the dominant axis;
 *  drag on blank page → insert a table sized to the drawn rectangle. */
const drawDown = (view: EditorView, ev: MouseEvent): void => {
  const zoom = zoomOf(view);
  const cell = (ev.target as HTMLElement | null)?.closest?.("td,th") as HTMLElement | null;
  const inCell = !!(cell && view.dom.contains(cell));
  const sx = ev.clientX, sy = ev.clientY;
  const guide = mkGuide("kx-draw-guide");
  guide.style.left = `${sx}px`;
  guide.style.top = `${sy}px`;
  let moved = false;
  const move = (e: MouseEvent) => {
    moved = true;
    guide.style.left = `${Math.min(sx, e.clientX)}px`;
    guide.style.top = `${Math.min(sy, e.clientY)}px`;
    guide.style.width = `${Math.abs(e.clientX - sx)}px`;
    guide.style.height = `${Math.abs(e.clientY - sy)}px`;
  };
  const up = (u: MouseEvent) => {
    window.removeEventListener("mousemove", move, true);
    guide.remove();
    const w = Math.abs(u.clientX - sx) / zoom;
    const h = Math.abs(u.clientY - sy) / zoom;
    if (!moved || (w < 10 && h < 10)) return;
    if (inCell) {
      // dominant axis → line direction → split orientation
      splitCellDrawn(view, ev, cell!, h > w ? 2 : 1, h > w ? 1 : 2);
    } else {
      insertDrawnTable(view, ev, w, h);
    }
  };
  window.addEventListener("mousemove", move, true);
  window.addEventListener("mouseup", up, { once: true, capture: true });
};

const splitCellDrawn = (
  view: EditorView, ev: MouseEvent, cell: HTMLElement, cols: number, rows: number,
): void => {
  const ctx = cellCtx(view, ev, cell.getBoundingClientRect());
  if (!ctx) return;
  const { state } = view;
  const table = state.doc.nodeAt(ctx.tablePos);
  const cellNode = state.doc.nodeAt(ctx.cellStart);
  if (table?.type.name !== "table" || !cellNode) return;
  const rc = ctx.map.findCell(ctx.cellStart - ctx.tablePos - 1);
  const off = ctx.cellStart - ctx.tablePos - 1;
  const targets = new Map([[off, {
    cell: cellNode, off, left: rc.left, top: rc.top,
    cs: (cellNode.attrs.colspan as number) || 1,
    rs: (cellNode.attrs.rowspan as number) || 1,
  }]]);
  const tr = state.tr;
  splitCellsInTable(tr, state.schema, ctx.tablePos, table, targets, cols, rows);
  view.dispatch(tr);
};

const insertDrawnTable = (
  view: EditorView, ev: MouseEvent, w: number, h: number,
): void => {
  const { state } = view;
  const schema = state.schema;
  const cols = Math.max(1, Math.min(20, Math.round(w / 72)));
  const rows = Math.max(1, Math.min(50, Math.round(h / 28)));
  const rowH = Math.max(18, Math.round(h / rows));
  const rowType = schema.nodes.tableRow;
  const cellType = schema.nodes.tableCell;
  const rowNodes = Array.from({ length: rows }, () =>
    rowType.create({ height: rowH, heightMode: "atLeast" },
      Array.from({ length: cols }, () =>
        cellType.create({}, schema.nodes.paragraph.create()))));
  const table = schema.nodes.table.create(
    { widthMode: "fixed", widthAbs: Math.round(w), widthAbsUnit: "px" }, rowNodes);
  const at = view.posAtCoords({ left: ev.clientX, top: ev.clientY });
  let pos: number;
  if (at) {
    const $p = state.doc.resolve(at.pos);
    pos = $p.depth ? $p.before(1) : at.pos;
  } else {
    pos = state.doc.content.size;
  }
  const tr = state.tr.insert(pos, table);
  try {
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1))).scrollIntoView();
  } catch { /* selection placement is best-effort */ }
  view.dispatch(tr);
};

export const KxTableHandles = Extension.create({
  name: "kxTableHandles",

  addCommands() {
    return {
      setTableTool:
        (mode) =>
        ({ view }) => {
          tableTool = tableTool === mode ? null : mode;
          view.dom.classList.toggle("kx-tool-draw", tableTool === "draw");
          view.dom.classList.toggle("kx-tool-erase", tableTool === "erase");
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Escape: ({ editor }) =>
        tableTool ? editor.commands.setTableTool(null) : false,
    };
  },

  addProseMirrorPlugins() {
    // ---- Word "text wrapping: Around" --------------------------------------
    // The paginator's wall floats own the whole document float space (they
    // ARE the page bands), so real CSS floats can't coexist with them.
    // Wrap is emulated instead: the tableWrapper is abs-positioned at its
    // anchor edge (applyWrap), and block siblings overlapping its band get
    // padding via node decorations (PM-owned style — survives the
    // paginator's re-renders, which wipe unmanaged inline styles).
    let viewRef: EditorView | null = null;

    const isContentEl = (s: Element): s is HTMLElement => {
      const el = s as HTMLElement;
      return !el.classList?.contains("ProseMirror-widget") &&
        !/(^|\s)rm-/.test(el.className?.toString() ?? "") &&
        !el.dataset?.kxWrapped;
    };
    const wrapWrapper = (v: EditorView, pos: number) => {
      const dom = v.nodeDOM(pos) as HTMLElement | null;
      return (dom?.classList?.contains("tableWrapper")
        ? dom : (dom?.closest?.(".tableWrapper") as HTMLElement | null)) ?? null;
    };
    const hostContentBox = (v: EditorView) => {
      const r = v.dom.getBoundingClientRect();
      const cs = getComputedStyle(v.dom);
      return {
        left: r.left + (parseFloat(cs.paddingLeft) || 0),
        right: r.right - (parseFloat(cs.paddingRight) || 0),
      };
    };
    const tableContentWidth = (el: HTMLElement) => {
      // once abs-positioned the wrapper shrink-wraps the table — its rect
      // is the truth; before that, prefer explicit col widths over the
      // in-flow full width (converges on the next pass)
      if (el.dataset.kxWrapped) return el.getBoundingClientRect().width;
      let w = 0;
      el.querySelectorAll("col").forEach((c) => {
        w += parseFloat((c as HTMLElement).style.width || "") || 0;
      });
      return w || el.getBoundingClientRect().width;
    };
    // Anchor: while in-flow the wrapper's own top is the slot; once abs'd
    // the slot collapses so the next content sibling's top marks it. Both
    // are immune to the abs'd rect and to pad-induced reflow below it.
    const anchorTop = (v: EditorView, el: HTMLElement) => {
      if (!el.dataset.kxWrapped) return el.getBoundingClientRect().top;
      for (let sib = el.nextElementSibling; sib; sib = sib.nextElementSibling)
        if (isContentEl(sib)) return (sib as HTMLElement).getBoundingClientRect().top;
      for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling)
        if (isContentEl(sib)) return (sib as HTMLElement).getBoundingClientRect().bottom;
      return v.dom.getBoundingClientRect().top;
    };
    const wrapBand = (v: EditorView, el: HTMLElement, node: PMNode) => {
      const offX = (node.attrs.offX as number | null) ?? 0;
      const offY = (node.attrs.offY as number | null) ?? 0;
      const w = tableContentWidth(el);
      const h = el.getBoundingClientRect().height;
      const hb = hostContentBox(v);
      const top = anchorTop(v, el) + offY;
      const left = node.attrs.wrap === "right" ? hb.right - offX - w : hb.left + offX;
      return {
        top, bottom: top + h, left, right: left + w,
        side: node.attrs.wrap as string,
        gap: (node.attrs.wrapGap as number | null) ?? 12,
      };
    };

    return [
      new Plugin({
        key: new PluginKey("kxTableHandles"),

        props: {
          decorations: (state) => {
            const v = viewRef;
            if (!v) return null;
            const bands: ReturnType<typeof wrapBand>[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name !== "table" || !node.attrs.wrap) return true;
              const el = wrapWrapper(v, pos);
              if (el) bands.push(wrapBand(v, el, node));
              return true;
            });
            if (!bands.length) return null;
            // element children of the editor root align 1:1 with top-level
            // doc nodes — keep tableWrappers in the list for alignment, but
            // never pad them (they're floated objects, not flowing text)
            const kids = [...v.dom.children].filter((c) => {
              const el = c as HTMLElement;
              return !el.classList?.contains("ProseMirror-widget") &&
                !/(^|\s)rm-/.test(el.className?.toString() ?? "");
            });
            const decos: Decoration[] = [];
            let ki = 0;
            state.doc.forEach((node, off) => {
              const el2 = kids[ki++];
              if (!el2 || el2.classList.contains("tableWrapper")) return;
              const cr = el2.getBoundingClientRect();
              let l = 0;
              let r = 0;
              for (const b of bands) {
                if (cr.bottom < b.top + 4 || cr.top > b.bottom - 4) continue;
                if (b.side === "left") {
                  const need = b.right + b.gap - cr.left;
                  if (need > 4) l = Math.max(l, need);
                } else {
                  const need = cr.right - (b.left - b.gap);
                  if (need > 4) r = Math.max(r, need);
                }
              }
              if (l || r) {
                const style = [
                  l ? `padding-left:${Math.round(l)}px` : "",
                  r ? `padding-right:${Math.round(r)}px` : "",
                ].filter(Boolean).join(";");
                decos.push(Decoration.node(off, off + node.nodeSize, { style }));
              }
            });
            return DecorationSet.create(state.doc, decos);
          },

          handleDOMEvents: {
            mousemove: (view, event) => {
              if (tableTool) {
                view.dom.classList.remove("kx-rowgrab", "kx-colgrab",
                  "kx-selcell", "kx-selrow", "kx-selcol");
                return;
              }
              if (!view.editable || event.buttons) return;
              const rowHit = rowBorderHit(view, event);
              const colHit = !rowHit && col0BorderHit(view, event);
              const zone = !rowHit && !colHit ? selZoneHit(view, event) : null;
              view.dom.classList.toggle("kx-rowgrab", !!rowHit);
              view.dom.classList.toggle("kx-colgrab", !!colHit);
              view.dom.classList.toggle("kx-selcell", zone?.kind === "cell");
              view.dom.classList.toggle("kx-selrow", zone?.kind === "row");
              view.dom.classList.toggle("kx-selcol", zone?.kind === "col");
            },

            mousedown: (view, event) => {
              if (!view.editable || event.button !== 0) return;
              if (tableTool) {
                if (toolMouseDown(view, event)) {
                  event.preventDefault();
                  event.stopPropagation();
                  return true;
                }
                return false;
              }
              const zoom = zoomOf(view);

              const zone = selZoneHit(view, event);
              if (zone) {
                event.preventDefault();
                event.stopPropagation();
                const { state } = view;
                // resolve AT the cell boundary — node(-1)=row, nodeAfter=cell,
                // which is what cellAround expects inside row/colSelection
                const $c = state.doc.resolve(zone.cellPos);
                const sel = zone.kind === "cell"
                  ? CellSelection.create(state.doc, zone.cellPos)
                  : zone.kind === "row"
                    ? CellSelection.rowSelection($c, $c)
                    : CellSelection.colSelection($c, $c);
                view.dispatch(state.tr.setSelection(sel));
                return true;
              }

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
              view.dom.classList.remove("kx-selcell");
              view.dom.classList.remove("kx-selrow");
              view.dom.classList.remove("kx-selcol");
            },
          },
        },

        view(view) {
          viewRef = view;
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

          // ⊕ boundary-insert controls (Word 2013+): a hairline along the
          // boundary + a circle at the table edge; click inserts a row/column
          const mkIns = (cls: string, title: string) => {
            const w = document.createElement("div");
            w.className = `kx-tbl-ins ${cls}`;
            const line = document.createElement("div");
            line.className = "kx-ins-line";
            const btn = document.createElement("div");
            btn.className = "kx-ins-btn";
            btn.title = title;
            btn.textContent = "+";
            w.appendChild(line);
            w.appendChild(btn);
            w.style.display = "none";
            document.body.appendChild(w);
            return w;
          };
          const insRow = mkIns("row", "Insert row");
          const insCol = mkIns("col", "Insert column");

          type InsCand = { kind: "row" | "col"; index: number; at: number; d: number };
          let insCand: (InsCand & { tablePos: number }) | null = null;
          let insTbl: HTMLElement | null = null;
          const hideIns = () => {
            insRow.style.display = "none";
            insCol.style.display = "none";
            insCand = null;
            insTbl = null;
          };

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

          /** Doc pos + element for a tbody (used when the pointer sits just
          *  outside the table where tableAt can't see it). */
          const tableFromTbody = (tbody: HTMLElement): { pos: number; el: HTMLElement } | null => {
            const td = tbody.querySelector("td,th") as HTMLElement | null;
            if (!td) return null;
            const r = td.getBoundingClientRect();
            const at = view.posAtCoords({ left: r.left + 2, top: r.top + 2 });
            if (!at) return null;
            const $p = view.state.doc.resolve(at.inside >= 0 ? at.inside : at.pos);
            for (let d = $p.depth; d >= 0; d--) {
              if ($p.node(d).type.name === "table") return { pos: $p.before(d), el: tbody };
            }
            return null;
          };

          /** Hit-test row/col boundaries just past the resize grab zone. */
          const updateIns = (e: MouseEvent) => {
            if (!view.editable || e.buttons) return hideIns();
            const tgt = e.target as HTMLElement | null;
            if (insRow.contains(tgt) || insCol.contains(tgt)) return; // keep alive over the ⊕
            let t = tableAt(view, e);
            if (!t) {
              // pointer in the margin band just outside a table edge
              let best: { pos: number; el: HTMLElement } | null = null;
              let bestD = 15;
              for (const tb of view.dom.querySelectorAll("tbody")) {
                const r = tb.getBoundingClientRect();
                if (!r.width) continue;
                const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
                const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
                const d = Math.hypot(dx, dy);
                if (d <= bestD) { const t2 = tableFromTbody(tb as HTMLElement); if (t2) { best = t2; bestD = d; } }
              }
              t = best;
            }
            if (!t) return hideIns();
            const rect = t.el.getBoundingClientRect();
            const table = view.state.doc.nodeAt(t.pos);
            if (!table) return hideIns();
            const map = TableMap.get(table);
            // boundary positions (CSS px offsets relative to the table rect)
            const colB = [0];
            let acc = 0;
            for (const w of measureColumns(t.el, map, table)) colB.push((acc += w));
            const rowB = [0];
            for (const tr of t.el.querySelectorAll("tr")) {
              rowB.push(tr.getBoundingClientRect().bottom - rect.top);
            }
            let best: InsCand | null = null;
            if (e.clientY > rect.top + 4 && e.clientY < rect.bottom + 4) {
              for (let k = 0; k < colB.length; k++) {
                const d = Math.abs(e.clientX - (rect.left + colB[k]));
                if (d > GRAB_PX && d <= 11 && (!best || d < best.d)) {
                  best = { kind: "col", index: k, at: rect.left + colB[k], d };
                }
              }
            }
            if (e.clientX > rect.left + 4 && e.clientX < rect.right + 4) {
              for (let j = 0; j < rowB.length; j++) {
                const d = Math.abs(e.clientY - (rect.top + rowB[j]));
                if (d > GRAB_PX && d <= 11 && (!best || d < best.d)) {
                  best = { kind: "row", index: j, at: rect.top + rowB[j], d };
                }
              }
            }
            if (!best) return hideIns();
            insCand = { ...best, tablePos: t.pos };
            insTbl = t.el;
            if (best.kind === "row") {
              insCol.style.display = "none";
              insRow.style.display = "block";
              insRow.style.left = `${rect.left}px`;
              insRow.style.top = `${best.at}px`;
              insRow.style.width = `${rect.width}px`;
            } else {
              insRow.style.display = "none";
              insCol.style.display = "block";
              insCol.style.left = `${best.at}px`;
              insCol.style.top = `${rect.top}px`;
              insCol.style.height = `${rect.height}px`;
            }
          };

          /** First doc pos of a cell node inside table row `rowIdx`. */
          const rowCellPos = (tablePos: number, table: any, rowIdx: number) => {
            let p = -1;
            table.forEach((_r: any, off: number, i: number) => {
              if (i === rowIdx) p = tablePos + 1 + off + 1;
            });
            return p;
          };
          /** Doc pos of a cell occupying grid column `col`. */
          const colCellPos = (tablePos: number, table: any, map: TableMap, col: number) => {
            let p = -1;
            table.forEach((row: any, roff: number) =>
              row.forEach((cell: any, coff: number) => {
                if (p >= 0) return;
                const rc = map.findCell(roff + 1 + coff);
                const span = (cell.attrs.colspan as number) || 1;
                if (rc.left <= col && col < rc.left + span) p = tablePos + 1 + roff + 1 + coff;
              }),
            );
            return p;
          };

          const onInsDown = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const c = insCand;
            if (!c) return;
            const { state } = view;
            const table = state.doc.nodeAt(c.tablePos);
            if (table?.type.name !== "table") return;
            const map = TableMap.get(table);
            let cellPos = -1;
            let cmd: typeof addRowBefore;
            if (c.kind === "row") {
              const append = c.index >= table.childCount;
              cellPos = rowCellPos(c.tablePos, table, append ? table.childCount - 1 : c.index);
              cmd = append ? addRowAfter : addRowBefore;
            } else {
              const append = c.index >= map.width;
              cellPos = colCellPos(c.tablePos, table, map, append ? map.width - 1 : c.index);
              cmd = append ? addColumnAfter : addColumnBefore;
            }
            if (cellPos < 0) return;
            try {
              view.dispatch(state.tr.setSelection(
                TextSelection.near(state.doc.resolve(cellPos + 1), 1),
              ).scrollIntoView());
              cmd(view.state, view.dispatch);
            } catch { /* schema refused the insertion point */ }
            hideIns();
          };

          const onMove = (e: MouseEvent) => {
            if (tableTool) { hide(); hideIns(); return; }
            const hit = view.editable && !e.buttons ? tableAt(view, e) : null;
            if (hit) place(hit.el, hit.pos);
            else if (e.target !== grip && e.target !== corner) hide();
            updateIns(e);
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

          // Word: double-click a column border → autofit that column;
          // double-click a row border → clear fixed row height
          const onDblClick = (e: MouseEvent) => {
            if (!view.editable || e.button !== 0) return;
            const cell = (e.target as HTMLElement | null)?.closest?.("td,th") as HTMLElement | null;
            if (!cell || !view.dom.contains(cell)) return;
            const rect = cell.getBoundingClientRect();
            const ctx = cellCtx(view, e, rect);
            if (!ctx) return;

            const rightEdge = Math.abs(e.clientX - rect.right) <= GRAB_PX;
            const leftEdge = Math.abs(e.clientX - rect.left) <= GRAB_PX;
            const vertEdge = Math.abs(e.clientY - rect.top) <= GRAB_PX
              || Math.abs(e.clientY - rect.bottom) <= GRAB_PX;

            if (rightEdge || (leftEdge && ctx.colIdx === 0)) {
              e.preventDefault();
              e.stopPropagation();
              const cellNode = view.state.doc.nodeAt(ctx.cellStart);
              const span = (cellNode?.attrs.colspan as number) || 1;
              const col = rightEdge ? ctx.colIdx + span - 1 : 0;
              // natural width: clone each cell occupying this grid column into
              // an offscreen measurer (in-table max-content can't expand past
              // the <col> constraint under table-layout:fixed)
              const zoom = zoomOf(view);
              const tbody = cell.closest("tbody") as HTMLElement | null;
              if (!tbody) return;
              const meas = document.createElement("div");
              meas.style.cssText = "position:fixed;left:-10000px;top:0;visibility:hidden;white-space:nowrap";
              document.body.appendChild(meas);
              let max = 24;
              try {
                for (const td of tbody.querySelectorAll("td,th")) {
                  let pos: number;
                  try { pos = view.posAtDOM(td, 0); } catch { continue; }
                  const cp = cellPosAt(view, pos);
                  if (cp == null) continue;
                  const rc = ctx.map.findCell(cp - ctx.tablePos - 1);
                  const s = (view.state.doc.nodeAt(cp)?.attrs.colspan as number) || 1;
                  if (rc.left > col || col >= rc.left + s) continue;
                  const cs = getComputedStyle(td);
                  meas.style.font = cs.font;
                  meas.style.letterSpacing = cs.letterSpacing;
                  meas.style.padding = cs.padding;
                  meas.style.border = `${cs.borderLeftWidth} solid transparent`;
                  meas.innerHTML = td.innerHTML;
                  max = Math.max(max, meas.getBoundingClientRect().width / s);
                }
              } finally { meas.remove(); }
              const { state } = view;
              const table = state.doc.nodeAt(ctx.tablePos);
              if (table?.type.name === "table") {
                const tr = state.tr;
                setColWidth(tr, ctx.tablePos, table, ctx.map, col, max / zoom);
                view.dispatch(tr.scrollIntoView());
              }
              return;
            }

            if (vertEdge && ctx.rowPos >= 0) {
              e.preventDefault();
              e.stopPropagation();
              const { state } = view;
              const node = state.doc.nodeAt(ctx.rowPos);
              if (node?.type.name === "tableRow") {
                view.dispatch(state.tr.setNodeMarkup(ctx.rowPos, undefined, {
                  ...node.attrs, height: null, heightMode: null,
                }));
              }
            }
          };

          // Escape exits the tool even when the editor isn't focused
          const onKey = (e: KeyboardEvent) => {
            if (!tableTool || e.key !== "Escape") return;
            e.preventDefault();
            tableTool = null;
            view.dom.classList.remove("kx-tool-draw", "kx-tool-erase");
          };

          const onScroll = () => {
            hideIns();
            if (gripPos != null && gripTbl?.isConnected) {
              const r = gripTbl.getBoundingClientRect();
              grip.style.left = `${r.left - 18}px`;
              grip.style.top = `${r.top - 8}px`;
              corner.style.left = `${r.right - 4}px`;
              corner.style.top = `${r.bottom - 4}px`;
            } else hide();
          };

          // The resizable-table NodeView keeps its <table> element across
          // updates, so attrs' renderHTML never re-emits. Sync the
          // data-attrs/CSS-vars that drive styling directly onto the DOM.
          const BOOL_ATTRS: [string, string][] = [
            ["repeatHeader", "data-repeat-header"],
            ["optHeaderRow", "data-opt-hdr"],
            ["optTotalRow", "data-opt-total"],
            ["optFirstCol", "data-opt-fcol"],
            ["optLastCol", "data-opt-lcol"],
            ["optBandedRows", "data-opt-brows"],
            ["optBandedCols", "data-opt-bcols"],
          ];
          const STR_ATTRS: [string, string][] = [
            ["align", "data-align"],
            ["widthMode", "data-width-mode"],
            ["wrap", "data-wrap"],
          ];
          const syncTableAttrs = () => {
            view.state.doc.descendants((node, pos) => {
              if (node.type.name !== "table") return true;
              const dom = view.nodeDOM(pos) as HTMLElement | null;
              const tbl = (dom?.tagName === "TABLE" ? dom : dom?.querySelector?.("table")) as HTMLElement | null;
              if (!tbl) return true;
              for (const [k, dn] of BOOL_ATTRS) {
                if (node.attrs[k]) tbl.setAttribute(dn, "true");
                else tbl.removeAttribute(dn);
              }
              for (const [k, dn] of STR_ATTRS) {
                const v = node.attrs[k] as string | null;
                if (v) tbl.setAttribute(dn, v);
                else tbl.removeAttribute(dn);
              }
              const absW = node.attrs.widthAbs as number | null;
              const absPx = absW != null && node.attrs.widthAbsUnit === "pt" ? absW * (96 / 72) : absW;
              // empty custom properties invalidate var() fallbacks — remove
              // instead of setting ""
              const setVar = (el: HTMLElement, name: string, v: string | null) =>
                v ? el.style.setProperty(name, v) : el.style.removeProperty(name);
              setVar(tbl, "--twidth",
                absPx != null ? `${absPx}px` : node.attrs.widthPct ? `${node.attrs.widthPct}%` : null);
              setVar(tbl, "--tindent", node.attrs.indent ? `${node.attrs.indent * 24}px` : null);
              // wrap vars live on the float box — the tableWrapper parent
              const wrapHost = tbl.parentElement?.classList.contains("tableWrapper")
                ? tbl.parentElement as HTMLElement : tbl;
              setVar(wrapHost, "--wgap", node.attrs.wrapGap != null ? `${node.attrs.wrapGap}px` : null);
              setVar(wrapHost, "--wx", node.attrs.offX != null ? `${node.attrs.offX}px` : null);
              setVar(wrapHost, "--wy", node.attrs.offY != null ? `${node.attrs.offY}px` : null);
              const cm = node.attrs.cellMargins as { top?: number; right?: number; bottom?: number; left?: number } | null;
              setVar(tbl, "--kx-cmt", cm?.top != null ? `${cm.top}px` : null);
              setVar(tbl, "--kx-cmr", cm?.right != null ? `${cm.right}px` : null);
              setVar(tbl, "--kx-cmb", cm?.bottom != null ? `${cm.bottom}px` : null);
              setVar(tbl, "--kx-cml", cm?.left != null ? `${cm.left}px` : null);
              const alt = node.attrs.altText as string | null;
              if (alt) tbl.setAttribute("aria-label", alt);
              else tbl.removeAttribute("aria-label");
              const cs = node.attrs.cellSpacing as number | null;
              if (cs != null) {
                tbl.setAttribute("data-cell-spacing", String(cs));
                tbl.style.borderSpacing = `${cs}px`;
                tbl.style.borderCollapse = "separate";
              } else {
                tbl.removeAttribute("data-cell-spacing");
                tbl.style.borderSpacing = "";
                tbl.style.borderCollapse = "";
              }
              return true;
            });
          };
          setTimeout(syncTableAttrs, 0);

          // abs-position the wrapped tables' NodeView wrappers at their
          // anchor edge (NodeView-owned dom — PM won't wipe these styles)
          const setSty = (el: HTMLElement, k: "position" | "top" | "left" | "right" | "width", v: string) => {
            if (el.style[k] !== v) el.style[k] = v;
          };
          // decorations read geometry measured pre-abs on the first pass —
          // when a band changes, kick a no-op transaction so they recompute
          const lastBandSig = new WeakMap<HTMLElement, string>();
          let wrapKickQueued = false;
          const kickWrapDecos = () => {
            if (wrapKickQueued || view.isDestroyed) return;
            wrapKickQueued = true;
            requestAnimationFrame(() => {
              wrapKickQueued = false;
              try { view.dispatch(view.state.tr.setMeta("kxWrapKick", true)); }
              catch { /* view destroyed */ }
            });
          };
          const applyWrap = () => {
            const wrapped: { node: PMNode; el: HTMLElement }[] = [];
            view.state.doc.descendants((node, pos) => {
              if (node.type.name !== "table" || !node.attrs.wrap) return true;
              const el = wrapWrapper(view, pos);
              if (el) wrapped.push({ node, el });
              return true;
            });
            view.dom.querySelectorAll(".tableWrapper").forEach((w) => {
              const el = w as HTMLElement;
              if (el.dataset.kxWrapped && !wrapped.some((x) => x.el === el)) {
                setSty(el, "position", ""); setSty(el, "top", ""); setSty(el, "left", "");
                setSty(el, "right", ""); setSty(el, "width", ""); delete el.dataset.kxWrapped;
                lastBandSig.delete(el);
              }
            });
            let changed = false;
            for (const { node, el } of wrapped) {
              const band = wrapBand(view, el, node);
              const cbRect = ((el.offsetParent || view.dom) as HTMLElement).getBoundingClientRect();
              el.dataset.kxWrapped = "1";
              setSty(el, "position", "absolute");
              setSty(el, "top", `${band.top - cbRect.top}px`);
              setSty(el, "left", `${band.left - cbRect.left}px`);
              setSty(el, "right", "auto");
              const w = el.getBoundingClientRect().width;
              const sig = `${Math.round(band.top)},${Math.round(band.left)},${Math.round(w)}`;
              if (lastBandSig.get(el) !== sig) { lastBandSig.set(el, sig); changed = true; }
            }
            if (changed) kickWrapDecos();
          };

          document.addEventListener("mousemove", onMove, true);
          document.addEventListener("dblclick", onDblClick, true);
          document.addEventListener("keydown", onKey, true);
          window.addEventListener("scroll", onScroll, true);
          grip.addEventListener("mousedown", onGripDown);
          corner.addEventListener("mousedown", onCornerDown);
          (insRow.querySelector(".kx-ins-btn") as HTMLElement).addEventListener("mousedown", onInsDown);
          (insCol.querySelector(".kx-ins-btn") as HTMLElement).addEventListener("mousedown", onInsDown);

          let wrapRaf = 0;
          const scheduleWrap = () => {
            if (wrapRaf) return;
            wrapRaf = requestAnimationFrame(() => {
              wrapRaf = 0;
              try { applyWrap(); }
              catch (err) { console.warn("[kxwrap]", err); }
            });
          };
          setTimeout(applyWrap, 0);

          return {
            update: () => {
              syncTableAttrs();
              scheduleWrap();
              // keep the ⊕ control alive across unrelated transactions
              // (selection, paginator settle); hide only if its table vanished
              if (insCand) {
                const node = view.state.doc.nodeAt(insCand.tablePos);
                if (node?.type.name !== "table" || !insTbl?.isConnected) hideIns();
              }
              if (gripPos == null) return;
              const node = view.state.doc.nodeAt(gripPos);
              if (node?.type.name !== "table" || !gripTbl?.isConnected) hide();
              else onScroll();
            },
            destroy: () => {
              if (wrapRaf) cancelAnimationFrame(wrapRaf);
              viewRef = null;
              document.removeEventListener("mousemove", onMove, true);
              document.removeEventListener("dblclick", onDblClick, true);
              document.removeEventListener("keydown", onKey, true);
              window.removeEventListener("scroll", onScroll, true);
              grip.remove();
              corner.remove();
              insRow.remove();
              insCol.remove();
            },
          };
        },
      }),
    ];
  },
});
