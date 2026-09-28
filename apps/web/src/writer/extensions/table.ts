// Table parity extensions — Word/Docs-class table attributes & commands.
// Extends the stock TipTap table nodes with shading, borders, padding,
// vertical alignment, sizes, text direction, table alignment/width modes,
// header-row repeat and row-height controls; plus commands for sorting,
// distributing, autofit, splitting and text↔table conversion.
import { Extension } from "@tiptap/core";
import {
  Table as BaseTable, TableRow as BaseTableRow,
  TableCell as BaseTableCell, TableHeader as BaseTableHeader,
} from "@tiptap/extension-table";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { CommandProps } from "@tiptap/core";
import { TableMap, CellSelection } from "@tiptap/pm/tables";
import { TextSelection } from "@tiptap/pm/state";
import type { ResolvedPos } from "@tiptap/pm/model";

// ---- types ----------------------------------------------------------------

export interface BorderSpec { style: string; width: number; color: string }
export interface CellBorders { top?: BorderSpec; right?: BorderSpec; bottom?: BorderSpec; left?: BorderSpec }
/** One sort criterion: a grid column, a comparison type, and a direction. */
export interface SortKey { col: number; type: "auto" | "text" | "number" | "date"; dir: "asc" | "desc" }

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    kxTable: {
      setTableAttributes: (attrs: Record<string, unknown>) => ReturnType;
      /** Apply attrs to every cell in the current cell selection (or the cell under cursor). */
      setCellAttributes: (attrs: Record<string, unknown>) => ReturnType;
      setRowHeight: (height: number | null, mode?: "atLeast" | "exact") => ReturnType;
      /** Set the width (px) of the column under the cursor; null = auto. */
      setColumnWidth: (width: number | null) => ReturnType;
      toggleHeaderRepeat: () => ReturnType;
      sortTableRows: (dir?: "asc" | "desc", opts?: { keys?: SortKey[]; header?: boolean }) => ReturnType;
      /** Insert a cell, shifting the column's cells down (Word "Shift cells down"). */
      insertCellsDown: () => ReturnType;
      /** Delete the cell under the cursor, shifting cells below up (Word "Shift cells up"). */
      deleteCellsUp: () => ReturnType;
      /** Move the selected row(s) one row up/down (Word Alt+Shift+↑/↓). */
      moveTableRow: (dir: "up" | "down") => ReturnType;
      /** Split selected cells into cols×rows sub-cells (Word Split Cells). */
      splitCellsGrid: (cols: number, rows: number) => ReturnType;
      distributeColumnsEvenly: () => ReturnType;
      distributeRowsEvenly: () => ReturnType;
      autofitTable: (mode: "contents" | "window" | "fixed") => ReturnType;
      /** Split the table at the row containing the cursor. */
      splitTable: () => ReturnType;
      /** Apply a named style preset across the whole table. */
      applyTablePreset: (preset: "plain" | "banded" | "headerAccent" | "outline") => ReturnType;
      convertTextToTable: (delim?: string) => ReturnType;
      convertTableToText: (delim?: string) => ReturnType;
    };
  }
}

// ---- borders helpers (also used by the DOCX exporter) -----------------------

const SIDE_CSS: Record<keyof CellBorders, string> = {
  top: "border-top", right: "border-right", bottom: "border-bottom", left: "border-left",
};

export const bordersToStyle = (b: CellBorders | null | undefined): string =>
  b ? (Object.keys(SIDE_CSS) as (keyof CellBorders)[])
      .filter((s) => b[s])
      .map((s) => `${SIDE_CSS[s]}:${b[s]!.width}px ${b[s]!.style} ${b[s]!.color}`)
      .join("; ") : "";

const bordersFromStyle = (st: CSSStyleDeclaration): CellBorders | null => {
  const out: CellBorders = {};
  for (const [side, css] of Object.entries(SIDE_CSS) as [keyof CellBorders, string][]) {
    const w = st.getPropertyValue(`${css}-width`);
    const s = st.getPropertyValue(`${css}-style`);
    const c = st.getPropertyValue(`${css}-color`);
    if (w && s && s !== "none") out[side] = { width: parseInt(w) || 1, style: s, color: c || "#000" };
  }
  return Object.keys(out).length ? out : null;
};

// ---- cell/header shared attributes ------------------------------------------
// mergeAttributes joins `style` fragments, so each attr can emit its own.

const cellAttrs = {
  backgroundColor: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute("data-bg") || el.style.backgroundColor || null,
    renderHTML: (a: Record<string, unknown>) =>
      a.backgroundColor ? { "data-bg": a.backgroundColor as string, style: `background-color:${a.backgroundColor}` } : {},
  },
  vAlign: {
    default: null,
    parseHTML: (el: HTMLElement) => el.style.verticalAlign || null,
    renderHTML: (a: Record<string, unknown>) => a.vAlign ? { style: `vertical-align:${a.vAlign}` } : {},
  },
  padding: {
    default: null,
    parseHTML: (el: HTMLElement) => (el.style.padding ? parseInt(el.style.padding) : null),
    renderHTML: (a: Record<string, unknown>) => a.padding != null ? { style: `padding:${a.padding}px` } : {},
  },
  borders: {
    default: null,
    parseHTML: (el: HTMLElement) => bordersFromStyle(el.style),
    renderHTML: (a: Record<string, unknown>) => {
      const st = bordersToStyle(a.borders as CellBorders);
      return st ? { style: st } : {};
    },
  },
  textDirection: {
    default: null,
    parseHTML: (el: HTMLElement) => el.style.writingMode || null,
    renderHTML: (a: Record<string, unknown>) => a.textDirection ? { style: `writing-mode:${a.textDirection}` } : {},
  },
};

export const KxTableCell = BaseTableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellAttrs };
  },
});

export const KxTableHeader = BaseTableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellAttrs };
  },
});

// ---- table + row attrs ------------------------------------------------------
// Dynamic widths/indent ride CSS custom props so they merge cleanly with the
// base extension's own `style` output (width/min-width from the colgroup).

export const KxTable = BaseTable.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      align: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-align") || null,
        renderHTML: (a: Record<string, unknown>) => a.align ? { "data-align": a.align as string } : {},
      },
      widthMode: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-width-mode") || null,
        renderHTML: (a: Record<string, unknown>) => a.widthMode ? { "data-width-mode": a.widthMode as string } : {},
      },
      widthPct: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const w = el.style.width;
          return w?.endsWith("%") ? parseInt(w) : null;
        },
        renderHTML: (a: Record<string, unknown>) => a.widthPct ? { style: `--twidth:${a.widthPct}%` } : {},
      },
      indent: {
        default: 0,
        parseHTML: (el: HTMLElement) => Math.round(parseInt(el.style.marginLeft || "0") / 24),
        renderHTML: (a: Record<string, unknown>) => a.indent ? { style: `--tindent:${(a.indent as number) * 24}px` } : {},
      },
      repeatHeader: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-repeat-header") === "true",
        renderHTML: (a: Record<string, unknown>) => a.repeatHeader ? { "data-repeat-header": "true" } : {},
      },
      // Word "Table Style Options" — composable emphasis/banding flags that
      // layer on top of a preset via CSS (explicit cell shading still wins)
      optHeaderRow: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-opt-hdr") === "true",
        renderHTML: (a: Record<string, unknown>) => a.optHeaderRow ? { "data-opt-hdr": "true" } : {},
      },
      optTotalRow: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-opt-total") === "true",
        renderHTML: (a: Record<string, unknown>) => a.optTotalRow ? { "data-opt-total": "true" } : {},
      },
      optFirstCol: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-opt-fcol") === "true",
        renderHTML: (a: Record<string, unknown>) => a.optFirstCol ? { "data-opt-fcol": "true" } : {},
      },
      optLastCol: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-opt-lcol") === "true",
        renderHTML: (a: Record<string, unknown>) => a.optLastCol ? { "data-opt-lcol": "true" } : {},
      },
      optBandedRows: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-opt-brows") === "true",
        renderHTML: (a: Record<string, unknown>) => a.optBandedRows ? { "data-opt-brows": "true" } : {},
      },
      optBandedCols: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-opt-bcols") === "true",
        renderHTML: (a: Record<string, unknown>) => a.optBandedCols ? { "data-opt-bcols": "true" } : {},
      },
    };
  },
});

export const KxTableRow = BaseTableRow.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      height: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.style.height ? parseInt(el.style.height) : null),
        renderHTML: (a: Record<string, unknown>) =>
          a.height ? { style: `height:${a.height}px` } : {},
      },
      heightMode: {
        default: null,
        parseHTML: () => null,
        renderHTML: () => ({}),
      },
      cantSplit: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-cant-split") === "true",
        renderHTML: (a: Record<string, unknown>) => a.cantSplit ? { "data-cant-split": "true" } : {},
      },
    };
  },
});

// ---- commands ---------------------------------------------------------------

/** Depth of the `table` node enclosing the selection, or null. */
const tableDepthAt = (state: CommandProps["state"]) => {
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type.name === "table") return d;
  }
  return null;
};

/**
 * Word's vertical cell-shift: cascade the column's covering cells down one
 * row (insert) or up one row (delete) starting at the selection's cell.
 * Cells are treated as span entries (rowspan collapses to one entry), so
 * vertical merges move/extend correctly; the trailing displaced cell lands
 * in a new bottom row on insert.
 */
const shiftColumnCells = (
  { tr, state, dispatch }: { tr: CommandProps["tr"]; state: CommandProps["state"]; dispatch?: CommandProps["dispatch"] },
  op: "insert" | "delete",
): boolean => {
  const d = tableDepthAt(state);
  if (d == null) return false;
  const { $from } = state.selection;
  const table = $from.node(d);
  const tablePos = $from.before(d);
  let cellPos = -1;
  for (let dd = $from.depth; dd >= 0; dd--) {
    const n = $from.node(dd).type.name;
    if (n === "tableCell" || n === "tableHeader") { cellPos = $from.before(dd); break; }
  }
  if (cellPos < 0) return false;
  const map = TableMap.get(table);
  const W = map.width, H = map.height;
  const anchor = map.findCell(cellPos - tablePos - 1);
  const col = anchor.left;
  const row0 = anchor.top;
  if (!dispatch) return true;

  const rows: { node: PMNode; off: number }[] = [];
  table.forEach((r, off) => rows.push({ node: r, off }));

  interface Entry { cell: PMNode; top: number; origTop: number; rs: number; off: number }
  const entries: Entry[] = [];
  const seen = new Set<number>();
  for (let i = row0; i < H; i++) {
    const off = map.map[i * W + col];
    if (seen.has(off)) continue;
    seen.add(off);
    const cell = table.nodeAt(off)!;
    const rc = map.findCell(off);
    entries.push({ cell, top: rc.top, origTop: rc.top, rs: (cell.attrs.rowspan as number) || 1, off });
  }
  const origEntries = entries.slice();
  const e0 = entries.findIndex((e) => e.top <= row0 && row0 < e.top + e.rs);
  if (e0 < 0) return false;

  // patched cells for spans that cross the op point (they extend/shrink
  // rather than move); keyed by entry index in origEntries
  const patches = new Map<number, PMNode>();
  if (op === "insert") {
    if (entries[e0].top < row0) {
      const e = entries[e0];
      e.rs++;
      patches.set(e0, e.cell.type.create({ ...e.cell.attrs, rowspan: e.rs }, e.cell.content));
    } else {
      const empty = state.schema.nodes.tableCell.createAndFill()!;
      entries.splice(e0, 0, { cell: empty, top: row0, origTop: row0, rs: 1, off: -1 });
    }
    for (let i = e0 + 1; i < entries.length; i++) entries[i].top += 1;
  } else {
    const e = entries[e0];
    if (e.top < row0) {
      e.rs--;
      patches.set(e0, e.cell.type.create({ ...e.cell.attrs, rowspan: e.rs }, e.cell.content));
    } else {
      entries.splice(e0, 1);
      for (let i = e0; i < entries.length; i++) entries[i].top -= 1;
    }
  }

  // rebuild each row's child list: drop the cell that topped the column
  // there, then re-insert every entry whose new top lands in this row
  const kids: PMNode[][] = rows.map(({ node }) => {
    const a: PMNode[] = [];
    node.forEach((c) => a.push(c));
    return a;
  });
  const coverChildIdx = (i: number): number => {
    const coverOff = map.map[i * W + col];
    let k = -1;
    rows[i].node.forEach((_c, coff, ci) => { if (rows[i].off + 1 + coff === coverOff) k = ci; });
    return k;
  };
  // child index where column `col` belongs (first child not strictly left)
  const insIdx = (i: number): number => {
    let k = rows[i].node.childCount;
    rows[i].node.forEach((cell, coff, ci) => {
      const rc = map.findCell(rows[i].off + 1 + coff);
      if (rc.left + ((cell.attrs.colspan as number) || 1) > col && k === rows[i].node.childCount) k = ci;
    });
    return k;
  };

  for (const e of origEntries) {
    if (e.origTop < row0) continue;              // span origin above the cut
    const k = coverChildIdx(e.origTop);
    if (k >= 0) kids[e.origTop].splice(k, 1);
  }
  for (const [i, cell] of patches) {
    const e = origEntries[i];
    const k = coverChildIdx(e.origTop);
    if (k >= 0) kids[e.origTop][k] = cell;
  }

  let trailing: PMNode | null = null;
  for (const e of entries) {
    if (e.top < row0) continue;
    if (e.top >= H) { trailing = e.cell; continue; }
    kids[e.top].splice(insIdx(e.top), 0, e.cell);
  }

  // rows that lost a cell and gained none have a mid-row hole — pad it at
  // the hole position (fixTables would pad at the end, misaligning cells)
  const cellType = state.schema.nodes.tableCell;
  for (let i = 0; i < H; i++) {
    let covered = 0;
    kids[i].forEach((c) => { covered += (c.attrs.colspan as number) || 1; });
    // spans reaching into this row: other columns unchanged (original map),
    // the shifted column counts entries at their new tops
    for (let cj = 0; cj < W; cj++) {
      if (cj === col) continue;
      if (map.findCell(map.map[i * W + cj]).top < i) covered++;
    }
    for (const e of entries) {
      if (e.top < i && i < e.top + e.rs) { covered += (e.cell.attrs.colspan as number) || 1; break; }
    }
    while (covered < W) {
      kids[i].splice(insIdx(i), 0, cellType.createAndFill()!);
      covered++;
    }
  }

  const newRows = kids.map((k, i) => rows[i].node.type.create(rows[i].node.attrs, k));
  if (trailing) {
    const cellType = state.schema.nodes.tableCell;
    const pad: PMNode[] = [];
    for (let i = 0; i < col; i++) pad.push(cellType.createAndFill()!);
    pad.push(trailing);
    const span = (trailing.attrs.colspan as number) || 1;
    for (let i = 0; i < W - col - span; i++) pad.push(cellType.createAndFill()!);
    newRows.push(state.schema.nodes.tableRow.create(null, pad.filter(Boolean) as PMNode[]));
  }
  tr.replaceWith(tablePos, tablePos + table.nodeSize, table.type.create(table.attrs, newRows));
  return true;
};

export const KxTableCommands = Extension.create({
  name: "kxTable",

  addCommands() {
    return {
      setTableAttributes:
        (attrs) =>
        ({ tr, state, dispatch }) => {
          const d = tableDepthAt(state);
          if (d == null) return false;
          if (dispatch) {
            const $from = state.selection.$from;
            tr.setNodeMarkup($from.before(d), undefined, { ...$from.node(d).attrs, ...attrs });
          }
          return true;
        },

      setCellAttributes:
        (attrs) =>
        ({ tr, state, dispatch }) => {
          // One setNodeMarkup per cell — chained setCellAttribute calls read
          // stale doc attrs, so only the last key would survive.
          const { selection } = state;
          if (selection instanceof CellSelection) {
            if (!dispatch) return true;
            selection.forEachCell((node, pos) => {
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
            });
            return true;
          }
          const $f = selection.$from;
          for (let d = $f.depth; d >= 0; d--) {
            const n = $f.node(d).type.name;
            if (n === "tableCell" || n === "tableHeader") {
              if (dispatch) tr.setNodeMarkup($f.before(d), undefined, { ...$f.node(d).attrs, ...attrs });
              return true;
            }
          }
          return false;
        },

      setRowHeight:
        (height, mode) =>
        ({ tr, state, dispatch }) => {
          const { $from } = state.selection;
          for (let d = $from.depth; d >= 0; d--) {
            if ($from.node(d).type.name === "tableRow") {
              if (dispatch) tr.setNodeMarkup($from.before(d), undefined, { ...$from.node(d).attrs, height, heightMode: mode ?? null });
              return true;
            }
          }
          return false;
        },

      setColumnWidth:
        (width) =>
        ({ tr, state, dispatch }) => {
          const d = tableDepthAt(state);
          if (d == null) return false;
          const { $from } = state.selection;
          const table = $from.node(d);
          const tablePos = $from.before(d);
          const map = TableMap.get(table);
          // column index of the cell under the cursor
          let colIdx: number | null = null;
          for (let dd = $from.depth; dd > d; dd--) {
            const n = $from.node(dd).type.name;
            if (n === "tableCell" || n === "tableHeader") {
              const cellStart = $from.before(dd) - tablePos - 1;
              colIdx = map.findCell(cellStart).left;
              break;
            }
          }
          if (colIdx == null) return false;
          if (!dispatch) return true;
          table.forEach((row, off) => {
            row.forEach((cell, coff) => {
              const start = tablePos + 1 + off + 1 + coff;
              const rc = map.findCell(start - tablePos - 1);
              const span = (cell.attrs.colspan as number) || 1;
              if (rc.left <= colIdx! && colIdx! < rc.left + span) {
                const widths = [...((cell.attrs.colwidth as number[] | null) ?? Array(span).fill(null))];
                widths[colIdx! - rc.left] = width;
                tr.setNodeMarkup(start, undefined, { ...cell.attrs, colwidth: widths });
              }
            });
          });
          return true;
        },

      toggleHeaderRepeat:
        () =>
        ({ tr, state, dispatch }) => {
          const d = tableDepthAt(state);
          if (d == null) return false;
          if (dispatch) {
            const $from = state.selection.$from;
            const node = $from.node(d);
            tr.setNodeMarkup($from.before(d), undefined, { ...node.attrs, repeatHeader: !node.attrs.repeatHeader });
          }
          return true;
        },

      /** Word's Alt+Shift+↑/↓ — move the row(s) under the selection up/down
       *  one row; selection follows so repeat presses keep moving. */
      moveTableRow:
        (dir: "up" | "down") =>
        ({ tr, state, dispatch }) => {
          const d = tableDepthAt(state);
          if (d == null) return false;
          const { $from, $to } = state.selection;
          const table = $from.node(d);
          const tablePos = $from.before(d);
          const cellOf = (p: ResolvedPos) => {
            for (let dd = p.depth; dd >= 0; dd--) {
              const n = p.node(dd).type.name;
              if (n === "tableCell" || n === "tableHeader") return p.before(dd);
            }
            return -1;
          };
          const c1 = cellOf($from), c2 = cellOf($to);
          if (c1 < 0 || c2 < 0) return false;
          const map = TableMap.get(table);
          const rc1 = map.findCell(c1 - tablePos - 1);
          const rc2 = map.findCell(c2 - tablePos - 1);
          const rows: PMNode[] = [];
          table.forEach((r) => rows.push(r));
          const H = rows.length;
          const r0 = Math.min(rc1.top, rc2.top);
          const r1 = Math.max(
            rc1.top + ((table.nodeAt(c1 - tablePos - 1)?.attrs.rowspan as number) || 1) - 1,
            rc2.top + ((table.nodeAt(c2 - tablePos - 1)?.attrs.rowspan as number) || 1) - 1,
          );
          if (dir === "up" ? r0 === 0 : r1 >= H - 1) return false;
          if (!dispatch) return true;
          const order: PMNode[] = [];
          if (dir === "up") {
            order.push(...rows.slice(0, r0 - 1), ...rows.slice(r0, r1 + 1), rows[r0 - 1], ...rows.slice(r1 + 1));
          } else {
            order.push(...rows.slice(0, r0), rows[r1 + 1], ...rows.slice(r0, r1 + 1), ...rows.slice(r1 + 2));
          }
          tr.replaceWith(tablePos, tablePos + table.nodeSize, table.type.create(table.attrs, order));
          // put the caret in the first cell of the moved block's new spot
          const newIdx = dir === "up" ? r0 - 1 : r0 + 1;
          let pos = tablePos + 1;
          for (let i = 0; i < newIdx; i++) pos += order[i].nodeSize;
          tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 2)));
          return true;
        },

      insertCellsDown:
        () =>
        ({ tr, state, dispatch }) => shiftColumnCells({ tr, state, dispatch }, "insert"),

      deleteCellsUp:
        () =>
        ({ tr, state, dispatch }) => shiftColumnCells({ tr, state, dispatch }, "delete"),

      /** Word's Split Cells: divide the selected cell(s) into `cols × rows`
       *  sub-cells. Every covered grid column splits into `cols` and every
       *  covered row into `rows`, with neighbours' colspan/rowspan grown to
       *  match — so a plain 1×1 cell splits into a true sub-grid, and a
       *  merged region subdivides its spans. Content stays top-left. */
      splitCellsGrid:
        (cols: number, rows: number) =>
        ({ tr, state, dispatch }) => {
          cols = Math.max(1, Math.min(64, Math.floor(cols) || 1));
          rows = Math.max(1, Math.min(64, Math.floor(rows) || 1));
          const d = tableDepthAt(state);
          if (d == null) return false;
          const { $from } = state.selection;
          const table = $from.node(d);
          const tablePos = $from.before(d);
          const sel = state.selection;
          interface TCell { cell: PMNode; off: number; left: number; top: number; cs: number; rs: number }
          const targets = new Map<number, TCell>();
          const addTarget = (cell: PMNode, off: number) => {
            if (targets.has(off)) return;
            const rc = map_.findCell(off);
            targets.set(off, {
              cell, off, left: rc.left, top: rc.top,
              cs: (cell.attrs.colspan as number) || 1, rs: (cell.attrs.rowspan as number) || 1,
            });
          };
          const map_ = TableMap.get(table);
          if (sel instanceof CellSelection) {
            sel.forEachCell((n, pos) => addTarget(n, pos - tablePos - 1));
          } else {
            for (let dd = $from.depth; dd >= 0; dd--) {
              const n = $from.node(dd).type.name;
              if (n === "tableCell" || n === "tableHeader") {
                addTarget($from.node(dd), $from.before(dd) - tablePos - 1);
                break;
              }
            }
          }
          if (!targets.size) return false;
          // no-op guard: every target already exactly cols×rows? still split.
          if (!dispatch) return true;

          const colMult = new Map<number, number>();
          const rowMult = new Map<number, number>();
          for (const t of targets.values()) {
            for (let cj = t.left; cj < t.left + t.cs; cj++) colMult.set(cj, cols);
            for (let ri = t.top; ri < t.top + t.rs; ri++) rowMult.set(ri, rows);
          }
          const targetCols = [...colMult.keys()];
          const targetRows = [...rowMult.keys()];
          const overlaps = (s: number, len: number, set: number[]) =>
            set.filter((v) => v >= s && v < s + len).length;

          const cellType = state.schema.nodes.tableCell;
          const rowsArr: { node: PMNode; off: number }[] = [];
          table.forEach((r, off) => rowsArr.push({ node: r, off }));
          // grid index where a column belongs among a row's children
          const insIdx = (i: number, c: number) => {
            const { node, off } = rowsArr[i];
            let k = node.childCount;
            node.forEach((cell, coff, ci) => {
              const rc = map_.findCell(off + 1 + coff);
              if (rc.left + ((cell.attrs.colspan as number) || 1) > c && k === node.childCount) k = ci;
            });
            return k;
          };

          const newRows: PMNode[] = [];
          for (let i = 0; i < rowsArr.length; i++) {
            const { node: row, off } = rowsArr[i];
            const mult = rowMult.get(i) ?? 1;
            // covering targets (child of this row, or reaching down via rowspan)
            const covering = [...targets.values()].filter((t) => t.top <= i && i < t.top + t.rs);
            for (let k = 0; k < mult; k++) {
              const items: { key: number; node: PMNode }[] = [];
              if (k === 0) {
                row.forEach((cell, coff, ci) => {
                  const cellOff = off + 1 + coff;
                  const rc = map_.findCell(cellOff);
                  const cs = (cell.attrs.colspan as number) || 1;
                  const rs = (cell.attrs.rowspan as number) || 1;
                  if (targets.has(cellOff)) return;            // emitted as region below
                  const attrs = { ...cell.attrs };
                  const csOv = overlaps(rc.left, cs, targetCols);
                  const rsOv = overlaps(rc.top, rs, targetRows);
                  if (csOv) { attrs.colspan = cs + csOv * (cols - 1); attrs.colwidth = null; }
                  if (rsOv) attrs.rowspan = rs + rsOv * (rows - 1);
                  items.push({ key: ci, node: cell.type.create(attrs, cell.content) });
                });
              }
              for (const t of covering) {
                const key = insIdx(i, t.left);
                for (let j = 0; j < t.cs * cols; j++) {
                  const node = k === 0 && j === 0
                    ? t.cell.type.create({ ...t.cell.attrs, colspan: 1, rowspan: 1, colwidth: null }, t.cell.content)
                    : cellType.createAndFill({ ...t.cell.attrs, colspan: 1, rowspan: 1, colwidth: null })!;
                  items.push({ key: key + j * 0.001 + 0.5, node });
                }
              }
              items.sort((a, b) => a.key - b.key);
              newRows.push(row.type.create(row.attrs, items.map((it) => it.node)));
            }
          }
          tr.replaceWith(tablePos, tablePos + table.nodeSize, table.type.create(table.attrs, newRows));
          return true;
        },

      sortTableRows:
        (dir = "asc", opts) =>
        ({ tr, state, dispatch }) => {
          const d = tableDepthAt(state);
          if (d == null) return false;
          const { $from } = state.selection;
          const table = $from.node(d);
          const tablePos = $from.before(d);
          const map = TableMap.get(table);
          const keys: SortKey[] = opts?.keys?.length
            ? opts.keys
            : [{ col: 0, type: "auto", dir }];
          const pinHeaders = opts?.header ?? true;
          // leading all-header rows stay pinned at the top when header mode is on
          let headerCount = 0;
          const dataRows: { node: PMNode; vals: string[] }[] = [];
          table.forEach((row, roff) => {
            const isHeader = row.childCount > 0 && row.firstChild!.type.name === "tableHeader";
            if (pinHeaders && isHeader && dataRows.length === 0) {
              headerCount++;
              return;
            }
            // key value per sort column — the cell occupying that grid column
            const vals = keys.map((k) => {
              let txt = "";
              row.forEach((cell, coff) => {
                const rc = map.findCell(roff + 1 + coff);
                const span = (cell.attrs.colspan as number) || 1;
                if (rc.left <= k.col && k.col < rc.left + span) {
                  const t = cell.textContent.trim();
                  if (t) txt = t;
                }
              });
              return txt;
            });
            dataRows.push({ node: row, vals });
          });
          const cmpVal = (a: string, b: string, type: SortKey["type"]): number => {
            if (type === "number" || type === "auto") {
              const na = Number(a.replace(/[$€£,\s]/g, ""));
              const nb = Number(b.replace(/[$€£,\s]/g, ""));
              if (a !== "" && b !== "" && !isNaN(na) && !isNaN(nb)) return na - nb;
            }
            if (type === "date" || type === "auto") {
              const da = Date.parse(a), db = Date.parse(b);
              if (!isNaN(da) && !isNaN(db)) return da - db;
            }
            return a.localeCompare(b, undefined, {
              sensitivity: "base", numeric: type !== "text",
            });
          };
          dataRows.sort((x, y) => {
            for (let i = 0; i < keys.length; i++) {
              const c = cmpVal(x.vals[i] ?? "", y.vals[i] ?? "", keys[i].type);
              if (c !== 0) return keys[i].dir === "desc" ? -c : c;
            }
            return 0;
          });
          if (!dispatch) return true;
          const content: PMNode[] = [];
          table.forEach((row, _off, i) => {
            content.push(i < headerCount ? row : dataRows[i - headerCount].node);
          });
          tr.replaceWith(tablePos, tablePos + table.nodeSize, table.type.create(table.attrs, content));
          return true;
        },

      distributeColumnsEvenly:
        () =>
        ({ tr, state, dispatch }) => {
          const d = tableDepthAt(state);
          if (d == null) return false;
          const { $from } = state.selection;
          const table = $from.node(d);
          let cols = 0;
          table.forEach((row) => {
            let c = 0;
            row.forEach((cell) => { c += (cell.attrs.colspan as number) || 1; });
            cols = Math.max(cols, c);
          });
          if (!cols) return false;
          if (!dispatch) return true;
          const tablePos = $from.before(d);
          const per = 100 / cols;
          table.forEach((row, off) => {
            row.forEach((cell, coff) => {
              const span = (cell.attrs.colspan as number) || 1;
              tr.setNodeMarkup(tablePos + 1 + off + 1 + coff, undefined, {
                ...cell.attrs, colwidth: Array.from({ length: span }, () => per),
              });
            });
          });
          return true;
        },

      distributeRowsEvenly:
        () =>
        ({ tr, state, dispatch }) => {
          const d = tableDepthAt(state);
          if (d == null) return false;
          if (!dispatch) return true;
          const { $from } = state.selection;
          const table = $from.node(d);
          const tablePos = $from.before(d);
          table.forEach((row, off) => {
            tr.setNodeMarkup(tablePos + 1 + off, undefined, { ...row.attrs, height: null, heightMode: null });
          });
          return true;
        },

      autofitTable:
        (mode) =>
        ({ commands }) => {
          if (mode === "window") return commands.setTableAttributes({ widthMode: "pct", widthPct: 100 });
          if (mode === "contents") return commands.setTableAttributes({ widthMode: "auto", widthPct: null });
          return commands.setTableAttributes({ widthMode: "fixed" });
        },

      splitTable:
        () =>
        ({ tr, state, dispatch }) => {
          const d = tableDepthAt(state);
          if (d == null) return false;
          const { $from } = state.selection;
          const table = $from.node(d);
          const rowIndex = $from.index(d); // row the cursor sits in
          if ($from.depth <= d || rowIndex === 0) return false;
          if (!dispatch) return true;
          const tablePos = $from.before(d);
          const before: PMNode[] = [], after: PMNode[] = [];
          table.forEach((row, _off, i) => (i < rowIndex ? before : after).push(row));
          const gap = state.schema.nodes.paragraph.create();
          tr.replaceWith(
            tablePos, tablePos + table.nodeSize,
            [table.type.create(table.attrs, before), gap, table.type.create(table.attrs, after)],
          );
          return true;
        },

      applyTablePreset:
        (preset) =>
        ({ tr, state, dispatch }) => {
          const d = tableDepthAt(state);
          if (d == null) return false;
          if (!dispatch) return true;
          const { $from } = state.selection;
          const table = $from.node(d);
          const tablePos = $from.before(d);
          const line = (w: number, c: string): CellBorders => ({
            top: { style: "solid", width: w, color: c },
            right: { style: "solid", width: w, color: c },
            bottom: { style: "solid", width: w, color: c },
            left: { style: "solid", width: w, color: c },
          });
          table.forEach((row, off, ri) => {
            row.forEach((cell, coff) => {
              const pos = tablePos + 1 + off + 1 + coff;
              const a = { ...cell.attrs };
              if (preset === "plain") {
                a.backgroundColor = null;
                a.borders = line(1, "#DDD6D0");
              } else if (preset === "banded") {
                a.backgroundColor = ri === 0 ? "#F2782E" : ri % 2 === 0 ? "#FBF3EC" : null;
                a.borders = line(1, "#E4D9CE");
              } else if (preset === "headerAccent") {
                a.backgroundColor = ri === 0 ? "#3A3633" : null;
                a.borders = line(1, "#DDD6D0");
              } else if (preset === "outline") {
                a.backgroundColor = null;
                a.borders = null; // keep default thin grid
              }
              tr.setNodeMarkup(pos, undefined, a);
            });
          });
          return true;
        },

      convertTextToTable:
        (delim = "\t") =>
        ({ state, commands }) => {
          const { $from, $to, empty } = state.selection;
          if (empty) return false;
          const text = state.doc.textBetween($from.pos, $to.pos, "\n", "\n");
          const lines = text.split("\n").filter((l) => l.length);
          if (!lines.length) return false;
          const cells = lines.map((l) => l.split(delim));
          const cols = Math.max(...cells.map((c) => c.length));
          const mkCell = (t: string) => ({
            type: "tableCell",
            content: [{ type: "paragraph", content: t ? [{ type: "text", text: t }] : undefined }],
          });
          const rows = cells.map((c) => ({
            type: "tableRow",
            content: Array.from({ length: cols }, (_, i) => mkCell(c[i] ?? "")),
          }));
          return commands.insertContentAt(
            { from: $from.pos, to: $to.pos },
            { type: "table", content: rows },
          );
        },

      convertTableToText:
        (delim = "\t") =>
        ({ state, dispatch }) => {
          const d = tableDepthAt(state);
          if (d == null) return false;
          const { $from } = state.selection;
          const table = $from.node(d);
          const lines: string[] = [];
          table.forEach((row) => {
            const cells: string[] = [];
            row.forEach((cell) => cells.push(cell.textContent.trim().replace(/\n/g, " ")));
            if (delim === "\n") lines.push(...cells);   // "paragraphs" — one line per cell
            else lines.push(cells.join(delim));
          });
          if (!dispatch) return true;
          const pos = $from.before(d);
          const para = state.schema.nodes.paragraph;
          dispatch(state.tr.replaceWith(
            pos, pos + table.nodeSize,
            lines.map((l) => para.create(undefined, l ? state.schema.text(l) : undefined)),
          ));
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      "Alt-Shift-ArrowUp": () => this.editor.commands.moveTableRow("up"),
      "Alt-Shift-ArrowDown": () => this.editor.commands.moveTableRow("down"),
    };
  },
});
