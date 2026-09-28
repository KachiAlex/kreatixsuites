// Word-style formulas inside table cells: an inline `tableFormula` atom whose
// NodeView evaluates `expr` (=SUM(ABOVE), =A1+B2*2, …) live against the
// current document — results are never stored, so edits auto-refresh and
// undo history isn't polluted.
import { Node, mergeAttributes, type CommandProps } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { TableMap } from "@tiptap/pm/tables";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    tableFormula: {
      /** Insert/update a formula field at the cursor (must be in a cell). */
      insertTableFormula: (expr: string, fmt?: string | null) => ReturnType;
      /** Force every formula field to recompute (they already refresh live). */
      updateTableFormulas: () => ReturnType;
    };
  }
}

// ---- numeric helpers --------------------------------------------------------

/** A cell's numeric value: literal number text and/or nested formula results.
 *  Returns null when the cell holds non-numeric text. */
const cellNumber = (
  doc: PMNode, cell: PMNode, cellPos: number, visiting: Set<number>,
): number | null => {
  let text = "";
  let fsum = 0, fcount = 0;
  cell.descendants((n, off) => {
    if (n.isText) text += n.text;
    else if (n.type.name === "tableFormula") {
      const abs = cellPos + 1 + off;
      fcount++;
      if (!visiting.has(abs)) {
        visiting.add(abs);
        const v = evalAt(doc, n.attrs.expr as string, abs, visiting);
        if (v != null) fsum += v;
      }
    }
  });
  const trimmed = text.trim();
  const lit = trimmed === "" ? null : parseCellText(trimmed);
  if (lit == null && trimmed !== "") return null;       // non-numeric text
  if (lit == null && fcount === 0) return null;
  return (lit ?? 0) + fsum;
};

const parseCellText = (s: string): number | null => {
  const m = s.match(/^[+\-−]?[$€£]?\s*\(?[\d,]*\.?\d+\)?%?$/u);
  if (!m) return null;
  let t = s.trim();
  let neg = /^[-−]/.test(t) || /^\(.*\)$/.test(t);
  t = t.replace(/[()$€£%,\s]/g, "").replace(/^[+\-−]/, "");
  const v = parseFloat(t);
  return isFinite(v) ? (neg ? -v : v) : null;
};

// ---- mini expression engine -------------------------------------------------

type Dir = "ABOVE" | "BELOW" | "LEFT" | "RIGHT";
const DIRS: Dir[] = ["ABOVE", "BELOW", "LEFT", "RIGHT"];

interface EvalCtx { doc: PMNode; pos: number; visiting: Set<number> }

/** Locate the formula node's own cell + table (grid coords). */
const formulaCell = (ctx: EvalCtx) => {
  const $p = ctx.doc.resolve(ctx.pos);
  let tablePos = -1, cellPos = -1;
  for (let d = $p.depth; d >= 0; d--) {
    const n = $p.node(d).type.name;
    if (n === "table") tablePos = $p.before(d);
    else if ((n === "tableCell" || n === "tableHeader") && cellPos < 0) cellPos = $p.before(d);
  }
  if (tablePos < 0 || cellPos < 0) return null;
  const table = ctx.doc.nodeAt(tablePos)!;
  const map = TableMap.get(table);
  const rc = map.findCell(cellPos - tablePos - 1);
  return { tablePos, table, map, row: rc.top, col: rc.left };
};

/** Numeric value of the cell covering grid (r,c). */
const gridCellNumber = (ctx: EvalCtx, tablePos: number, map: TableMap, r: number, c: number): number | null => {
  if (r < 0 || r >= map.height || c < 0 || c >= map.width) return null;
  const pos = tablePos + 1 + map.map[r * map.width + c];
  const node = ctx.doc.nodeAt(pos);
  return node ? cellNumber(ctx.doc, node, pos, ctx.visiting) : null;
};

/** Directional range: contiguous numeric cells from the formula cell outward. */
const dirValues = (ctx: EvalCtx, dir: Dir): number[] => {
  const f = formulaCell(ctx);
  if (!f) return [];
  const out: number[] = [];
  const steps: Record<Dir, [number, number]> = {
    ABOVE: [-1, 0], BELOW: [1, 0], LEFT: [0, -1], RIGHT: [0, 1],
  };
  let [dr, dc] = steps[dir];
  let r = f.row + dr, c = f.col + dc;
  for (;;) {
    const v = gridCellNumber(ctx, f.tablePos, f.map, r, c);
    if (v == null) break;
    out.push(v);
    r += dr; c += dc;
  }
  return out;
};

/** A1-style ref → cell value. */
const refValue = (ctx: EvalCtx, ref: string): number | null => {
  const m = ref.match(/^([A-Za-z]+)([0-9]+)$/);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = parseInt(m[2], 10);
  const f = formulaCell(ctx);
  if (!f) return null;
  return gridCellNumber(ctx, f.tablePos, f.map, row - 1, col - 1);
};

const refRange = (ctx: EvalCtx, range: string): number[] => {
  const [a, b] = range.split(":");
  const pa = a.match(/^([A-Za-z]+)([0-9]+)$/), pb = b?.match(/^([A-Za-z]+)([0-9]+)$/);
  if (!pa || !pb) return [];
  const toRC = (m: RegExpMatchArray) => {
    let col = 0;
    for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
    return { r: parseInt(m[2], 10) - 1, c: col - 1 };
  };
  const A = toRC(pa), B = toRC(pb);
  const f = formulaCell(ctx);
  if (!f) return [];
  const out: number[] = [];
  for (let r = Math.min(A.r, B.r); r <= Math.max(A.r, B.r); r++)
    for (let c = Math.min(A.c, B.c); c <= Math.max(A.c, B.c); c++) {
      const v = gridCellNumber(ctx, f.tablePos, f.map, r, c);
      if (v != null) out.push(v);
    }
  return out;
};

const FUNCS: Record<string, (xs: number[]) => number> = {
  SUM: (xs) => xs.reduce((a, b) => a + b, 0),
  AVERAGE: (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0),
  COUNT: (xs) => xs.length,
  MAX: (xs) => (xs.length ? Math.max(...xs) : 0),
  MIN: (xs) => (xs.length ? Math.min(...xs) : 0),
  PRODUCT: (xs) => xs.reduce((a, b) => a * b, 1),
  ABS: (xs) => Math.abs(xs[0] ?? 0),
  INT: (xs) => Math.trunc(xs[0] ?? 0),
  ROUND: (xs) => Math.round(xs[0] ?? 0),
  MOD: (xs) => (xs.length > 1 ? xs[0] % xs[1] : xs[0] ?? 0),
};

/** Recursive-descent parser over: numbers, A1 refs, A1:B3 ranges,
 *  ABOVE/BELOW/LEFT/RIGHT, FUNC(args…), + - * / ( ). */
class P {
  private i = 0;
  private s: string;
  private ctx: EvalCtx;
  constructor(s: string, ctx: EvalCtx) { this.s = s; this.ctx = ctx; }
  private peek() { return this.s[this.i]; }
  parse(): number {
    const v = this.expr();
    if (this.i < this.s.length) throw new Error("trailing");
    return v;
  }
  private expr(): number {
    let v = this.term();
    for (;;) {
      const c = this.peek();
      if (c === "+") { this.i++; v += this.term(); }
      else if (c === "-") { this.i++; v -= this.term(); }
      else return v;
    }
  }
  private term(): number {
    let v = this.factor();
    for (;;) {
      const c = this.peek();
      if (c === "*") { this.i++; v *= this.factor(); }
      else if (c === "/") { this.i++; const d = this.factor(); v = d === 0 ? NaN : v / d; }
      else return v;
    }
  }
  private factor(): number {
    this.ws();
    const c = this.peek();
    if (c === "(") { this.i++; const v = this.expr(); this.ws(); this.expect(")"); return v; }
    if (c === "-") { this.i++; return -this.factor(); }
    if (c === "+") { this.i++; return this.factor(); }
    const rest = this.s.slice(this.i);
    // function call
    const fm = rest.match(/^([A-Za-z]+)\s*\(/);
    if (fm && FUNCS[fm[1].toUpperCase()]) {
      this.i += fm[0].length;
      const args: number[] = [];
      this.ws();
      if (this.peek() !== ")") {
        for (;;) {
          args.push(...this.arg());
          this.ws();
          if (this.peek() === ",") { this.i++; continue; }
          break;
        }
      }
      this.expect(")");
      return FUNCS[fm[1].toUpperCase()](args);
    }
    // direction keyword
    for (const d of DIRS) {
      if (rest.toUpperCase().startsWith(d) && !/^[A-Z]+\d/.test(rest.toUpperCase())) {
        this.i += d.length;
        const xs = dirValues(this.ctx, d);
        return xs.reduce((a, b) => a + b, 0);
      }
    }
    // range
    const rm = rest.match(/^([A-Za-z]+\d+)\s*:\s*([A-Za-z]+\d+)/);
    if (rm) {
      this.i += rm[0].length;
      const xs = refRange(this.ctx, `${rm[1]}:${rm[2]}`);
      return xs.reduce((a, b) => a + b, 0);
    }
    // cell ref
    const cm = rest.match(/^([A-Za-z]+\d+)/);
    if (cm) {
      this.i += cm[0].length;
      return refValue(this.ctx, cm[1]) ?? 0;
    }
    // number
    const nm = rest.match(/^\d*\.?\d+/);
    if (nm) { this.i += nm[0].length; return parseFloat(nm[0]); }
    throw new Error("bad token");
  }
  /** Function argument: direction | range | scalar expr. */
  private arg(): number[] {
    this.ws();
    const rest = this.s.slice(this.i).toUpperCase();
    for (const d of DIRS) {
      if (rest.startsWith(d) && !/^[A-Z]+\d/.test(rest)) {
        this.i += d.length;
        return dirValues(this.ctx, d);
      }
    }
    const rm = rest.match(/^([A-Z]+\d+)\s*:\s*([A-Z]+\d+)/);
    if (rm) {
      this.i += rm[0].length;
      return refRange(this.ctx, `${rm[1]}:${rm[2]}`);
    }
    const v = this.expr();
    return [v];
  }
  private ws() { while (this.peek() === " ") this.i++; }
  private expect(ch: string) {
    this.ws();
    if (this.peek() !== ch) throw new Error(`expected ${ch}`);
    this.i++;
  }
}

// ---- format -----------------------------------------------------------------

export const formatResult = (v: number, fmt: string | null): string => {
  if (!isFinite(v)) return "#ERR";
  switch (fmt) {
    case "0": return String(Math.round(v));
    case "0.00": return v.toFixed(2);
    case "#,##0": return Math.round(v).toLocaleString("en-US");
    case "#,##0.00": return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case "0%": return `${Math.round(v)}%`;
    case "$#,##0.00": return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
    default:
      return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  }
};

// ---- NodeView + registry ----------------------------------------------------

const viewsByEditor = new WeakMap<EditorView, Set<FormulaView>>();

class FormulaView {
  dom: HTMLElement;
  private node: PMNode;
  private view: EditorView;
  private getPos: () => number | undefined;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.dom = document.createElement("span");
    this.dom.className = "kx-formula";
    this.dom.title = `= ${node.attrs.expr}`;
    this.refresh();
    let set = viewsByEditor.get(view);
    if (!set) { set = new Set(); viewsByEditor.set(view, set); }
    set.add(this);
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "tableFormula") return false;
    this.node = node;
    this.dom.title = `= ${node.attrs.expr}`;
    this.refresh();
    return true;
  }

  refresh(): void {
    const pos = this.getPos();
    if (pos == null) return;
    const v = evalAt(this.view.state.doc, this.node.attrs.expr as string, pos);
    this.dom.textContent = v == null ? "!Error" : formatResult(v, this.node.attrs.fmt as string | null);
    this.dom.classList.toggle("kx-formula-err", v == null);
  }

  destroy(): void {
    viewsByEditor.get(this.view)?.delete(this);
  }
}

/** Evaluate `expr` for the formula node at `pos` inside `doc`. */
const evalAt = (doc: PMNode, expr: string, pos: number, visiting?: Set<number>): number | null => {
  const clean = expr.trim().replace(/^=/, "");
  if (!clean) return null;
  try {
    const ctx: EvalCtx = { doc, pos, visiting: visiting ?? new Set([pos]) };
    const v = new P(clean, ctx).parse();
    return isFinite(v) ? v : null;
  } catch {
    return null;
  }
};

// ---- extension ---------------------------------------------------------------

export const TableFormula = Node.create({
  name: "tableFormula",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      expr: { default: "" },
      fmt: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-fmt"),
        renderHTML: (a: Record<string, unknown>) => a.fmt ? { "data-fmt": a.fmt as string } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="table-formula"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, {
      "data-type": "table-formula", class: "kx-formula",
    }), ""];
  },

  addNodeView() {
    return ({ node, view, getPos }) => new FormulaView(node, view, getPos as () => number | undefined);
  },

  addCommands() {
    return {
      insertTableFormula:
        (expr, fmt = null) =>
        ({ commands, state }: CommandProps) => {
          const sel = state.selection as { node?: PMNode };
          if (sel.node?.type.name === this.name) {
            return commands.updateAttributes(this.name, { expr, fmt });
          }
          // Word restricts formulas to table cells
          const $p = state.selection.$from;
          for (let d = $p.depth; d >= 0; d--) {
            const n = $p.node(d).type.name;
            if (n === "tableCell" || n === "tableHeader") break;
            if (n === "doc") return false;
          }
          return commands.insertContent({ type: this.name, attrs: { expr, fmt } });
        },
      updateTableFormulas:
        () =>
        ({ view }: CommandProps) => {
          viewsByEditor.get(view)?.forEach((f) => f.refresh());
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("kxTableFormula"),
        view(view) {
          let t: ReturnType<typeof setTimeout> | null = null;
          return {
            update: () => {
              if (t) clearTimeout(t);
              t = setTimeout(() => viewsByEditor.get(view)?.forEach((f) => f.refresh()), 120);
            },
            destroy: () => { if (t) clearTimeout(t); },
          };
        },
      }),
    ];
  },
});
