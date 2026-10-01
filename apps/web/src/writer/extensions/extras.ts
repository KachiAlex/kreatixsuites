import { Node, Mark, Extension, mergeAttributes } from "@tiptap/core";
import { TextStyle } from "@tiptap/extension-text-style";
import type { Node as PMNode } from "@tiptap/pm/model";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    kxFont: {
      /** Apply font-dialog attributes to the selection (null clears). */
      setFontFx: (attrs: Record<string, unknown>) => ReturnType;
    };
    dropCap: {
      toggleDropCap: (lines?: number) => ReturnType;
    };
    multiList: {
      toggleMultiList: () => ReturnType;
    };
    chartNode: {
      insertChart: (attrs: Record<string, unknown>) => ReturnType;
    };
    shapeNode: {
      insertShape: (attrs: Record<string, unknown>) => ReturnType;
      updateShape: (attrs: Record<string, unknown>) => ReturnType;
    };
    textBoxNode: {
      insertTextBox: (attrs?: Record<string, unknown>) => ReturnType;
    };
    wordArt: {
      insertWordArt: (attrs: Record<string, unknown>) => ReturnType;
      updateWordArt: (attrs: Record<string, unknown>) => ReturnType;
    };
    cite: {
      insertCitation: (attrs: { key: string; display: string; data?: string }) => ReturnType;
      insertBibliography: () => ReturnType;
    };
    indexEntry: {
      markIndexEntry: (entry: string, sub?: string) => ReturnType;
      unmarkIndexEntry: () => ReturnType;
    };
  }
}

/* ---------------------------------------------------------------- fonts */

/** TextStyle extended with Word's Font dialog effects — stored as attrs on
 *  the same mark so DOCX-compatible base attrs (family/size/color) are
 *  untouched. All render as inline style on the textStyle span. */
export const KxTextStyle = TextStyle.extend({
  name: "textStyle",
  addAttributes() {
    return {
      ...this.parent?.(),
      // live-formatting caps (reversible — unlike Edit ▸ UPPERCASE)
      allCaps: {
        default: null,
        parseHTML: (el: HTMLElement) =>
          el.style.textTransform === "uppercase" || el.getAttribute("data-caps") === "all" ? true : null,
        renderHTML: (a: Record<string, unknown>) => (a.allCaps ? { style: "text-transform:uppercase" } : {}),
      },
      smallCaps: {
        default: null,
        parseHTML: (el: HTMLElement) =>
          el.style.fontVariant === "small-caps" || el.style.fontVariantCaps === "small-caps" ? true : null,
        renderHTML: (a: Record<string, unknown>) => (a.smallCaps ? { style: "font-variant:small-caps" } : {}),
      },
      // hidden text — CSS decides visibility (shown dotted when marks on)
      hidden: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.getAttribute("data-hidden") ? true : null),
        renderHTML: (a: Record<string, unknown>) => (a.hidden ? { "data-hidden": "1" } : {}),
      },
      // expanded/condensed letter spacing, in pt
      spacing: {
        default: null,
        parseHTML: (el: HTMLElement) => el.style.letterSpacing || null,
        renderHTML: (a: Record<string, unknown>) =>
          a.spacing ? { style: `letter-spacing:${a.spacing}` } : {},
      },
      // underline style/color beyond plain underline
      uStyle: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const s = el.style.textDecorationStyle;
          return s && s !== "solid" ? s : null;
        },
        renderHTML: (a: Record<string, unknown>) =>
          a.uStyle ? { style: `text-decoration:underline ${a.uStyle}` } : {},
      },
      uColor: {
        default: null,
        parseHTML: (el: HTMLElement) => el.style.textDecorationColor || null,
        renderHTML: (a: Record<string, unknown>) =>
          a.uColor ? { style: `text-decoration-color:${a.uColor}` } : {},
      },
      // double strikethrough
      dstrike: {
        default: null,
        parseHTML: (el: HTMLElement) =>
          el.style.textDecorationStyle === "double" && /line-through/.test(el.style.textDecorationLine ?? "")
            ? true : null,
        renderHTML: (a: Record<string, unknown>) =>
          a.dstrike ? { style: "text-decoration:line-through double" } : {},
      },
      fxShadow: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.getAttribute("data-fx") === "shadow" ? true : null),
        renderHTML: (a: Record<string, unknown>) =>
          a.fxShadow ? { "data-fx": "shadow", style: "text-shadow:2px 2px 3px rgba(0,0,0,.35)" } : {},
      },
      fxOutline: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.getAttribute("data-fx") === "outline" ? true : null),
        renderHTML: (a: Record<string, unknown>) =>
          a.fxOutline
            ? { "data-fx": "outline", style: "-webkit-text-stroke:.6px currentColor;color:transparent" }
            : {},
      },
    };
  },
  addCommands() {
    return {
      setFontFx:
        (attrs) =>
        ({ commands }) =>
          commands.setMark(this.name, attrs),
    };
  },
});

/* ------------------------------------------------------------- drop cap */

/** Word ▸ Insert ▸ Drop Cap — paragraph attribute rendered via ::first-letter. */
export const DropCap = Extension.create({
  name: "kxDropCap",
  addGlobalAttributes() {
    return [{
      types: ["paragraph"],
      attributes: {
        dropCap: {
          default: null,
          parseHTML: (el: HTMLElement) => el.getAttribute("data-dropcap"),
          renderHTML: (a: Record<string, unknown>) =>
            a.dropCap ? { "data-dropcap": String(a.dropCap) } : {},
        },
      },
    }];
  },
  addCommands() {
    return {
      toggleDropCap:
        (lines = 3) =>
        ({ commands, state }) => {
          const $from = state.selection.$from;
          const node = $from.parent;
          if (node.type.name !== "paragraph") return false;
          const cur = node.attrs.dropCap as number | null;
          return commands.updateAttributes("paragraph", { dropCap: cur ? null : lines });
        },
    };
  },
});

/* ------------------------------------------------------- multilevel list */

/** Word's multilevel list — attr on orderedList; nested levels get 1. / 1.1 /
 *  1.1.1 markers via CSS counters. */
export const MultiList = Extension.create({
  name: "multiList",
  addGlobalAttributes() {
    return [{
      types: ["orderedList"],
      attributes: {
        ml: {
          default: null,
          parseHTML: (el: HTMLElement) => (el.classList.contains("ml") ? true : null),
          renderHTML: (a: Record<string, unknown>) => (a.ml ? { class: "ml" } : {}),
        },
      },
    }];
  },
  addCommands() {
    return {
      toggleMultiList:
        () =>
        ({ tr, state, dispatch }) => {
          const { from, to } = state.selection;
          let hit = false;
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type.name !== "orderedList") return;
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, ml: node.attrs.ml ? null : true });
            hit = true;
          });
          if (hit && dispatch) dispatch(tr);
          return hit;
        },
    };
  },
});

/* ---------------------------------------------------------------- charts */

export interface ChartSeries { name: string; values: number[] }
export interface ChartAttrs {
  ctype: "bar" | "line" | "pie" | "doughnut";
  title: string;
  labels: string[];
  series: ChartSeries[];
}

export function parseChartAttrs(attrs: Record<string, unknown>): ChartAttrs {
  let labels: string[] = [];
  let series: ChartSeries[] = [];
  try { labels = JSON.parse((attrs.labels as string) || "[]"); } catch { /* bad json */ }
  try { series = JSON.parse((attrs.series as string) || "[]"); } catch { /* bad json */ }
  return {
    ctype: (attrs.ctype as ChartAttrs["ctype"]) || "bar",
    title: (attrs.title as string) || "",
    labels, series,
  };
}

const PALETTE = ["#F2782E", "#3b82f6", "#10b981", "#8b5cf6", "#ef4444", "#f59e0b", "#06b6d4", "#ec4899"];

/** Render a chart spec to an SVG string (shared by the node view + exports). */
export function chartSvg(c: ChartAttrs, w = 560, h = 300): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const pad = { l: 44, r: 12, t: 34, b: 30 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const labels = c.labels;
  const series = c.series;
  const flat = series.flatMap((s) => s.values);
  const max = Math.max(1e-9, ...flat, 0);
  let out = `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" font-family="Inter,sans-serif" font-size="10">`;
  if (c.title) out += `<text x="${w / 2}" y="16" text-anchor="middle" font-size="13" font-weight="600">${esc(c.title)}</text>`;

  if (c.ctype === "pie" || c.ctype === "doughnut") {
    const vals = series[0]?.values ?? [];
    const total = vals.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    const cx = w / 2 - 40, cy = h / 2 + 8, r = Math.min(iw, ih) / 2 - 6;
    let a0 = -Math.PI / 2;
    vals.forEach((v, i) => {
      const a1 = a0 + (Math.max(0, v) / total) * Math.PI * 2;
      const mid = (a0 + a1) / 2;
      const p = (a: number, rr: number) => `${cx + Math.cos(a) * rr},${cy + Math.sin(a) * rr}`;
      out += `<path d="M ${cx},${cy} L ${p(a0, r)} A ${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1, r)} Z" fill="${PALETTE[i % PALETTE.length]}"/>`;
      const lx = cx + Math.cos(mid) * (r + 14), ly = cy + Math.sin(mid) * (r + 14);
      out += `<text x="${lx}" y="${ly}" text-anchor="${Math.cos(mid) > 0.2 ? "start" : Math.cos(mid) < -0.2 ? "end" : "middle"}" dominant-baseline="middle">${esc(labels[i] ?? String(i + 1))}</text>`;
      a0 = a1;
    });
    if (c.ctype === "doughnut") out += `<circle cx="${cx}" cy="${cy}" r="${r * 0.55}" fill="white"/>`;
    out += `</svg>`;
    return out;
  }

  // bar / line — axes
  out += `<line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + ih}" stroke="#888"/>`;
  out += `<line x1="${pad.l}" y1="${pad.t + ih}" x2="${pad.l + iw}" y2="${pad.t + ih}" stroke="#888"/>`;
  for (let g = 0; g <= 4; g++) {
    const y = pad.t + ih - (ih * g) / 4;
    out += `<line x1="${pad.l}" y1="${y}" x2="${pad.l + iw}" y2="${y}" stroke="#e5e5e5"/>`;
    out += `<text x="${pad.l - 4}" y="${y + 3}" text-anchor="end" fill="#666">${esc(String(Math.round((max * g) / 4)))}</text>`;
  }
  const nLab = Math.max(1, labels.length);
  const slot = iw / nLab;
  labels.forEach((l, i) => {
    out += `<text x="${pad.l + slot * (i + 0.5)}" y="${pad.t + ih + 14}" text-anchor="middle" fill="#444">${esc(l)}</text>`;
  });
  if (c.ctype === "bar") {
    const bw = (slot * 0.7) / Math.max(1, series.length);
    series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        const bh = Math.max(0, v / max) * ih;
        const x = pad.l + slot * (i + 0.15) + si * bw;
        out += `<rect x="${x.toFixed(1)}" y="${(pad.t + ih - bh).toFixed(1)}" width="${(bw * 0.9).toFixed(1)}" height="${bh.toFixed(1)}" fill="${PALETTE[si % PALETTE.length]}"/>`;
      });
    });
  } else {
    series.forEach((s, si) => {
      const pts = s.values
        .map((v, i) => `${(pad.l + slot * (i + 0.5)).toFixed(1)},${(pad.t + ih - (Math.max(0, v) / max) * ih).toFixed(1)}`)
        .join(" ");
      out += `<polyline points="${pts}" fill="none" stroke="${PALETTE[si % PALETTE.length]}" stroke-width="2"/>`;
    });
  }
  // legend
  series.forEach((s, si) => {
    const x = pad.l + si * 90;
    out += `<rect x="${x}" y="${h - 10}" width="9" height="9" fill="${PALETTE[si % PALETTE.length]}"/>`;
    out += `<text x="${x + 12}" y="${h - 2}" fill="#444">${esc(s.name)}</text>`;
  });
  return out + "</svg>";
}

/** Word-style embedded chart — data lives in attrs, rendered as SVG. */
export const Chart = Node.create({
  name: "chart",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      ctype: { default: "bar", parseHTML: (el) => el.getAttribute("data-ctype"), renderHTML: (a) => ({ "data-ctype": a.ctype }) },
      title: { default: "", parseHTML: (el) => el.getAttribute("data-title"), renderHTML: (a) => (a.title ? { "data-title": a.title } : {}) },
      labels: { default: "[]", parseHTML: (el) => el.getAttribute("data-labels"), renderHTML: (a) => ({ "data-labels": a.labels }) },
      series: { default: "[]", parseHTML: (el) => el.getAttribute("data-series"), renderHTML: (a) => ({ "data-series": a.series }) },
    };
  },
  parseHTML() { return [{ tag: 'div[data-type="kx-chart"]' }]; },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "kx-chart", class: "kx-chart" })];
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "kx-chart";
      dom.setAttribute("data-type", "kx-chart");
      const render = (n: PMNode) => {
        const c = parseChartAttrs(n.attrs as Record<string, unknown>);
        dom.innerHTML = c.series.length && c.labels.length
          ? chartSvg(c)
          : `<div class="kx-chart-empty">Chart — double-click to edit data</div>`;
      };
      render(node);
      return {
        dom,
        update(n) { if (n.type.name !== "chart") return false; render(n); return true; },
      };
    };
  },
  addCommands() {
    return {
      insertChart:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});

/* ---------------------------------------------------------------- shapes */

export const SHAPES = ["rect", "roundRect", "ellipse", "line", "arrow", "triangle", "diamond", "star5"] as const;
export type ShapeKind = (typeof SHAPES)[number];

export function shapeSvg(kind: ShapeKind, w: number, h: number, fill: string, stroke: string, sw: number): string {
  const esc = (s: string) => s.replace(/"/g, "&quot;");
  const f = `fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${sw}"`;
  let inner = "";
  switch (kind) {
    case "rect": inner = `<rect x="${sw / 2}" y="${sw / 2}" width="${w - sw}" height="${h - sw}" ${f}/>`; break;
    case "roundRect": inner = `<rect x="${sw / 2}" y="${sw / 2}" width="${w - sw}" height="${h - sw}" rx="${Math.min(12, h / 4)}" ${f}/>`; break;
    case "ellipse": inner = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${(w - sw) / 2}" ry="${(h - sw) / 2}" ${f}/>`; break;
    case "line": inner = `<line x1="${sw}" y1="${h / 2}" x2="${w - sw}" y2="${h / 2}" stroke="${esc(stroke)}" stroke-width="${sw}" fill="none"/>`; break;
    case "arrow": inner = `<line x1="${sw}" y1="${h / 2}" x2="${w - sw - 10}" y2="${h / 2}" stroke="${esc(stroke)}" stroke-width="${sw}" fill="none"/><polygon points="${w - sw},${h / 2} ${w - sw - 12},${h / 2 - 6} ${w - sw - 12},${h / 2 + 6}" fill="${esc(stroke)}"/>`; break;
    case "triangle": inner = `<polygon points="${w / 2},${sw} ${w - sw},${h - sw} ${sw},${h - sw}" ${f}/>`; break;
    case "diamond": inner = `<polygon points="${w / 2},${sw} ${w - sw},${h / 2} ${w / 2},${h - sw} ${sw},${h / 2}" ${f}/>`; break;
    case "star5": {
      const pts: string[] = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? Math.min(w, h) * 0.18 : Math.min(w, h) / 2 - sw;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        pts.push(`${(w / 2 + Math.cos(a) * r).toFixed(1)},${(h / 2 + Math.sin(a) * r).toFixed(1)}`);
      }
      inner = `<polygon points="${pts.join(" ")}" ${f}/>`;
      break;
    }
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

/** Drawing shape — block atom rendered as SVG. */
export const Shape = Node.create({
  name: "shape",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      shape: { default: "rect", parseHTML: (el) => el.getAttribute("data-shape"), renderHTML: (a) => ({ "data-shape": a.shape }) },
      w: { default: 180, parseHTML: (el) => Number(el.getAttribute("data-w")) || 180, renderHTML: (a) => ({ "data-w": a.w }) },
      h: { default: 100, parseHTML: (el) => Number(el.getAttribute("data-h")) || 100, renderHTML: (a) => ({ "data-h": a.h }) },
      fill: { default: "#dbeafe", parseHTML: (el) => el.getAttribute("data-fill"), renderHTML: (a) => ({ "data-fill": a.fill }) },
      stroke: { default: "#1e3a8a", parseHTML: (el) => el.getAttribute("data-stroke"), renderHTML: (a) => ({ "data-stroke": a.stroke }) },
      strokeW: { default: 2, parseHTML: (el) => Number(el.getAttribute("data-stroke-w")) || 2, renderHTML: (a) => ({ "data-stroke-w": a.strokeW }) },
    };
  },
  parseHTML() { return [{ tag: 'div[data-type="kx-shape"]' }]; },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "kx-shape", class: "kx-shape" })];
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "kx-shape";
      const render = (n: PMNode) => {
        const a = n.attrs;
        dom.innerHTML = shapeSvg(a.shape as ShapeKind, a.w as number, a.h as number, a.fill as string, a.stroke as string, a.strokeW as number);
      };
      render(node);
      return {
        dom,
        update(n) { if (n.type.name !== "shape") return false; render(n); return true; },
      };
    };
  },
  addCommands() {
    return {
      insertShape:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
      updateShape:
        (attrs) =>
        ({ commands, state }) => {
          const n = (state.selection as { node?: { type: { name: string } } }).node;
          if (n?.type.name !== this.name) return false;
          return commands.updateAttributes(this.name, attrs);
        },
    };
  },
});

/* -------------------------------------------------------------- text box */

/** Bordered text box — real editable content (Word's Insert ▸ Text Box).
 *  wrap/posX/posY mirror the image node's floating-object model so anchored
 *  OOXML boxes keep their page position on import. */
export const TextBox = Node.create({
  name: "textBox",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    const num = (name: string) => (el: Element) => {
      const v = (el as HTMLElement).getAttribute(name);
      return v == null ? null : Number(v);
    };
    return {
      align: { default: "none", parseHTML: (el) => el.getAttribute("data-align") ?? "none", renderHTML: (a) => ({ "data-align": a.align }) },
      w: { default: null, parseHTML: (el) => el.getAttribute("data-w"), renderHTML: (a) => (a.w ? { "data-w": a.w } : {}) },
      h: { default: null, parseHTML: num("data-h"), renderHTML: (a) => (a.h != null ? { "data-h": a.h } : {}) },
      bg: { default: "", parseHTML: (el) => el.getAttribute("data-bg") ?? "", renderHTML: (a) => (a.bg ? { "data-bg": a.bg } : {}) },
      border: { default: "1px solid #555", parseHTML: (el) => el.getAttribute("data-border") ?? "1px solid #555", renderHTML: (a) => ({ "data-border": a.border }) },
      wrap: { default: "", parseHTML: (el) => el.getAttribute("data-wrap") ?? "", renderHTML: (a) => (a.wrap ? { "data-wrap": a.wrap } : {}) },
      posX: { default: null, parseHTML: num("data-posx"), renderHTML: (a) => (a.posX != null ? { "data-posx": a.posX } : {}) },
      posY: { default: null, parseHTML: num("data-posy"), renderHTML: (a) => (a.posY != null ? { "data-posy": a.posY } : {}) },
      z: { default: 0, parseHTML: num("data-z"), renderHTML: (a) => (a.z ? { "data-z": a.z } : {}) },
    };
  },
  parseHTML() { return [{ tag: 'div[data-type="kx-textbox"]' }]; },
  renderHTML({ HTMLAttributes, node }) {
    const a = node.attrs as Record<string, string | number | null>;
    const floating = a.wrap === "front" || a.wrap === "behind";
    const style = [
      `border:${a.border || "1px solid #555"}`,
      a.w ? `width:${a.w}px` : "",
      a.h != null ? `min-height:${a.h}px` : "",
      a.bg ? `background:${a.bg}` : "",
      floating
        ? `position:absolute;transform:translate(${a.posX ?? 0}px,${a.posY ?? 0}px);z-index:${a.wrap === "behind" ? -1 : 5 + (Number(a.z) || 0)}`
        : a.align === "left" ? "float:left;margin:0 14px 8px 0"
        : a.align === "right" ? "float:right;margin:0 0 8px 14px"
        : a.align === "center" ? "margin-left:auto;margin-right:auto" : "",
      "padding:8px 10px",
    ].filter(Boolean).join(";");
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "kx-textbox", class: "kx-textbox", style }), 0];
  },
  addCommands() {
    return {
      insertTextBox:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs,
            content: [{ type: "paragraph" }],
          }),
    };
  },
});

/* --------------------------------------------------------------- wordart */

const WORDART_FX: Record<string, (color: string) => string> = {
  gradient: (c) =>
    `background:linear-gradient(180deg,${c} 30%,#fff 55%,${c} 80%);-webkit-background-clip:text;background-clip:text;color:transparent`,
  outline: () => `-webkit-text-stroke:1px currentColor;color:transparent`,
  shadow: (c) => `color:${c};text-shadow:3px 3px 0 rgba(0,0,0,.3)`,
  slant: (c) => `color:${c};transform:skewX(-8deg);display:inline-block`,
};

/** WordArt — block atom, styled display text. */
export const WordArt = Node.create({
  name: "wordArt",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      text: { default: "Your text", parseHTML: (el) => el.getAttribute("data-text"), renderHTML: (a) => ({ "data-text": a.text }) },
      fx: { default: "gradient", parseHTML: (el) => el.getAttribute("data-fx"), renderHTML: (a) => ({ "data-fx": a.fx }) },
      color: { default: "#F2782E", parseHTML: (el) => el.getAttribute("data-color"), renderHTML: (a) => ({ "data-color": a.color }) },
      size: { default: 44, parseHTML: (el) => Number(el.getAttribute("data-size")) || 44, renderHTML: (a) => ({ "data-size": a.size }) },
    };
  },
  parseHTML() { return [{ tag: 'div[data-type="kx-wordart"]' }]; },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "kx-wordart", class: "kx-wordart" })];
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "kx-wordart";
      const render = (n: PMNode) => {
        const a = n.attrs as { text: string; fx: string; color: string; size: number };
        const style = WORDART_FX[a.fx] ?? WORDART_FX.gradient;
        dom.innerHTML = `<span style="font-weight:800;font-size:${a.size}px;line-height:1.15;${style(a.color)}">${a.text.replace(/</g, "&lt;")}</span>`;
      };
      render(node);
      return {
        dom,
        update(n) { if (n.type.name !== "wordArt") return false; render(n); return true; },
      };
    };
  },
  addCommands() {
    return {
      insertWordArt:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
      updateWordArt:
        (attrs) =>
        ({ commands, state }) => {
          const n = (state.selection as { node?: { type: { name: string } } }).node;
          if (n?.type.name !== this.name) return false;
          return commands.updateAttributes(this.name, attrs);
        },
    };
  },
});

/* ------------------------------------------------------------- citations */

export interface CitationData { author: string; year: string; title: string; kind: string }

/** Inline citation — rendered "(Author, Year)", carries source metadata. */
export const Citation = Node.create({
  name: "citation",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      key: { default: "", parseHTML: (el) => el.getAttribute("data-key"), renderHTML: (a) => ({ "data-key": a.key }) },
      display: { default: "(?)", parseHTML: (el) => el.getAttribute("data-display"), renderHTML: (a) => ({ "data-display": a.display }) },
      data: { default: "{}", parseHTML: (el) => el.getAttribute("data-cite"), renderHTML: (a) => ({ "data-cite": a.data }) },
    };
  },
  parseHTML() { return [{ tag: 'span[data-type="kx-cite"]' }]; },
  renderHTML({ HTMLAttributes, node }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-type": "kx-cite", class: "kx-cite" }),
      (node.attrs.display as string) || "(?)"];
  },
  addCommands() {
    return {
      insertCitation:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
      insertBibliography:
        () =>
        ({ commands, state }) => {
          const items: { key: string; d: CitationData }[] = [];
          state.doc.descendants((node) => {
            if (node.type.name !== "citation") return true;
            let d: CitationData = { author: "?", year: "", title: "", kind: "book" };
            try { d = { ...d, ...JSON.parse((node.attrs.data as string) || "{}") }; } catch { /* bad json */ }
            items.push({ key: node.attrs.key as string, d });
            return true;
          });
          items.sort((a, b) => a.d.author.localeCompare(b.d.author));
          const paras = items.map(({ d }) => ({
            type: "paragraph",
            attrs: { indent: 0 },
            content: [{ type: "text", text: `${d.author}${d.year ? ` (${d.year}). ` : ". "}${d.title}${d.kind ? `. ${d.kind}` : ""}` }],
          }));
          if (!paras.length) return false;
          return commands.insertContent([
            { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Bibliography" }] },
            ...paras,
          ]);
        },
    };
  },
});

/* ----------------------------------------------------------------- index */

/** Index entry mark — invisible-ish marked text collected by Insert index. */
export const IndexEntry = Mark.create({
  name: "indexEntry",
  addAttributes() {
    return {
      entry: { default: "", parseHTML: (el) => el.getAttribute("data-ie"), renderHTML: (a) => ({ "data-ie": a.entry }) },
      sub: { default: "", parseHTML: (el) => el.getAttribute("data-ie-sub"), renderHTML: (a) => (a.sub ? { "data-ie-sub": a.sub } : {}) },
    };
  },
  parseHTML() { return [{ tag: "span[data-ie]" }]; },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "kx-ie" }), 0];
  },
  addCommands() {
    return {
      markIndexEntry:
        (entry, sub = "") =>
        ({ commands }) =>
          commands.setMark(this.name, { entry, sub }),
      unmarkIndexEntry:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

/** Format a footnote/endnote ordinal (decimal/alpha/roman). */
export function fmtN(n: number, fmt: string): string {
  if (fmt === "lower-alpha" || fmt === "upper-alpha") {
    let s = "", x = n;
    while (x > 0) { x--; s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26); }
    return fmt === "lower-alpha" ? s.toLowerCase() : s;
  }
  if (fmt === "lower-roman" || fmt === "upper-roman") {
    const t: [number, string][] = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
    let s = "", x = n;
    for (const [v, r] of t) while (x >= v) { s += r; x -= v; }
    return fmt === "lower-roman" ? s.toLowerCase() : s;
  }
  return String(n);
}

/** Collect index entries → grouped { entry: {sub: pages[]} }. */
export function collectIndex(doc: PMNode, pageOf: (pos: number) => number | null) {
  const map = new Map<string, Map<string, Set<number>>>();
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const m = node.marks.find((x) => x.type.name === "indexEntry");
    if (!m) return true;
    const entry = (m.attrs.entry as string) || node.text || "?";
    const sub = (m.attrs.sub as string) || "";
    const pg = pageOf(pos) ?? 0;
    if (!map.has(entry)) map.set(entry, new Map());
    const sm = map.get(entry)!;
    if (!sm.has(sub)) sm.set(sub, new Set());
    if (pg) sm.get(sub)!.add(pg);
    return true;
  });
  return map;
}
