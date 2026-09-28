import { Image } from "@tiptap/extension-image";
import { mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";

export type ImageWrap = "inline" | "square" | "tight" | "topBottom" | "behind" | "front";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    richImage: {
      setImageAlign: (align: "left" | "center" | "right" | "none") => ReturnType;
      setImageWidth: (width: number | null) => ReturnType;
      setImageWrap: (wrap: ImageWrap, align?: "left" | "center" | "right" | "none") => ReturnType;
      /** Arrange all multi-selected images (floating images only). */
      arrangeImages: (action: "alignLeft" | "alignCenter" | "alignRight" | "alignTop" | "alignMiddle" | "alignBottom" | "distH" | "distV" | "fwd" | "back") => ReturnType;
      /** Toggle an image node position in/out of the multi-selection. */
      toggleImageMulti: (pos: number) => ReturnType;
      clearImageMulti: () => ReturnType;
    };
  }
}

export const IMG_MULTI = new PluginKey<Set<number>>("kxImgMulti");

export const WRAP_LABELS: Record<ImageWrap, string> = {
  inline: "In line with text",
  square: "Square",
  tight: "Tight",
  topBottom: "Top and bottom",
  behind: "Behind text",
  front: "In front of text",
};

/** Effective wrap: legacy docs used align=left/right to mean float-wrap. */
export const effectiveWrap = (a: { wrap?: ImageWrap; align?: string }): ImageWrap =>
  (a.wrap ?? "inline") === "inline" && (a.align === "left" || a.align === "right") ? "square" : (a.wrap ?? "inline");

const clampCrop = (v: unknown) => Math.max(0, Math.min(49, Number(v) || 0));

/**
 * Image node: width/height, alignment, Word-style text wrapping (square /
 * tight / top-bottom / behind / in-front), anchor offsets, z-order, rotate,
 * flip, crop, caption — plus resize/rotate/move handles in the node view.
 */
export const RichImage = Image.extend({
  name: "image",

  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => el.getAttribute("width"),
        renderHTML: (attrs) => (attrs.width ? { width: attrs.width } : {}),
      },
      height: {
        default: null,
        parseHTML: (el) => el.getAttribute("height"),
        renderHTML: (attrs) => (attrs.height ? { height: attrs.height } : {}),
      },
      lockAspect: { default: true, parseHTML: (el) => el.closest("figure")?.dataset.lockAspect !== "0", renderHTML: () => ({}) },
      align: {
        default: "none",
        parseHTML: (el) => (el.closest("figure")?.getAttribute("data-align") as string) || "none",
        renderHTML: () => ({}),
      },
      wrap: {
        default: "inline",
        parseHTML: (el) => (el.closest("figure")?.getAttribute("data-wrap") as ImageWrap) || "inline",
        renderHTML: () => ({}),
      },
      posX: { default: 0, parseHTML: (el) => Number(el.closest("figure")?.dataset.posx ?? 0) || 0, renderHTML: () => ({}) },
      posY: { default: 0, parseHTML: (el) => Number(el.closest("figure")?.dataset.posy ?? 0) || 0, renderHTML: () => ({}) },
      zIndex: { default: 0, parseHTML: (el) => Number(el.closest("figure")?.dataset.z ?? 0) || 0, renderHTML: () => ({}) },
      rotate: { default: 0, parseHTML: (el) => Number(el.closest("figure")?.dataset.rot ?? 0) || 0, renderHTML: () => ({}) },
      flipH: { default: false, parseHTML: (el) => el.closest("figure")?.dataset.fh === "1", renderHTML: () => ({}) },
      flipV: { default: false, parseHTML: (el) => el.closest("figure")?.dataset.fv === "1", renderHTML: () => ({}) },
      cropT: { default: 0, parseHTML: (el) => clampCrop(el.closest("figure")?.dataset.ct), renderHTML: () => ({}) },
      cropR: { default: 0, parseHTML: (el) => clampCrop(el.closest("figure")?.dataset.cr), renderHTML: () => ({}) },
      cropB: { default: 0, parseHTML: (el) => clampCrop(el.closest("figure")?.dataset.cb), renderHTML: () => ({}) },
      cropL: { default: 0, parseHTML: (el) => clampCrop(el.closest("figure")?.dataset.cl), renderHTML: () => ({}) },
      caption: {
        default: "",
        parseHTML: (el) => el.closest("figure")?.querySelector("figcaption")?.textContent ?? "",
        renderHTML: () => ({}),
      },
    };
  },

  renderHTML({ HTMLAttributes, node }) {
    const a = node.attrs;
    const wrap = effectiveWrap(a);
    return [
      "figure",
      {
        class: `doc-image wrap-${wrap} align-${a.align || "none"}`,
        "data-align": a.align || "none",
        "data-wrap": a.wrap || "inline",
        "data-posx": a.posX, "data-posy": a.posY, "data-z": a.zIndex,
        "data-rot": a.rotate, "data-fh": a.flipH ? 1 : 0, "data-fv": a.flipV ? 1 : 0,
        "data-ct": a.cropT, "data-cr": a.cropR, "data-cb": a.cropB, "data-cl": a.cropL,
        "data-lock-aspect": a.lockAspect === false ? 0 : 1,
        style: figureStyle(a),
      },
      ["img", mergeAttributes(HTMLAttributes, { style: imgStyle(a) })],
      ...(a.caption ? [["figcaption", {}, a.caption] as const] : []),
    ];
  },

  parseHTML() {
    return [{ tag: "figure img" }, { tag: 'img[src]:not(figure img)' }];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("figure");
      const img = document.createElement("img");
      dom.appendChild(img);
      let cap: HTMLElement | null = null;

      const apply = (n: PMNode) => {
        const a = n.attrs;
        const wrap = effectiveWrap(a);
        dom.className = `doc-image wrap-${wrap} align-${a.align || "none"}`;
        dom.dataset.align = a.align || "none";
        dom.dataset.wrap = a.wrap || "inline";
        dom.style.cssText = figureStyle(a);
        img.src = a.src;
        img.alt = a.alt ?? "";
        img.style.cssText = imgStyle(a);
        if (a.caption && !cap) {
          cap = document.createElement("figcaption");
          dom.appendChild(cap);
        }
        if (cap) {
          cap.textContent = a.caption ?? "";
          cap.style.display = a.caption ? "" : "none";
        }
      };

      const pos = () => (typeof getPos === "function" ? getPos() : undefined);
      const commit = (attrs: Record<string, unknown>) => {
        const p = pos();
        if (p === undefined) return;
        editor.chain().command(({ tr, state }) => {
          const n = state.doc.nodeAt(p);
          if (n?.type.name === "image") tr.setNodeMarkup(p, undefined, { ...n.attrs, ...attrs });
          return true;
        }).run();
      };

      const mkHandle = (cls: string, down: (e: MouseEvent) => void) => {
        const h = document.createElement("span");
        h.className = cls;
        h.contentEditable = "false";
        h.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); down(e); });
        return h;
      };

      const corner = mkHandle("img-resize-handle", (e) => {
        const startX = e.clientX, startW = img.offsetWidth, startH = img.offsetHeight;
        const aspect = startH / Math.max(1, startW);
        const move = (ev: MouseEvent) => {
          const w = Math.max(40, Math.min(dom.parentElement?.clientWidth ?? 900, startW + ev.clientX - startX));
          img.style.width = `${w}px`;
          if (node.attrs.lockAspect !== false) img.style.height = `${Math.round(w * aspect)}px`;
        };
        const up = (ev: MouseEvent) => {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
          const w = Math.max(40, Math.round(startW + ev.clientX - startX));
          commit({ width: w, height: node.attrs.lockAspect !== false ? Math.round(w * aspect) : node.attrs.height });
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      });

      const side = mkHandle("img-resize-side", (e) => {
        const startY = e.clientY, startH = img.offsetHeight;
        const move = (ev: MouseEvent) => { img.style.height = `${Math.max(30, startH + ev.clientY - startY)}px`; };
        const up = (ev: MouseEvent) => {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
          commit({ height: Math.max(30, Math.round(startH + ev.clientY - startY)), lockAspect: false });
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      });

      const rot = mkHandle("img-rotate-handle", (e) => {
        const r = img.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const start = Math.atan2(e.clientY - cy, e.clientX - cx) - (node.attrs.rotate || 0) * Math.PI / 180;
        const move = (ev: MouseEvent) => {
          const deg = Math.round(((Math.atan2(ev.clientY - cy, ev.clientX - cx) - start) * 180 / Math.PI) * 10) / 10;
          applyTransform(dom, { ...node.attrs, rotate: deg }, effectiveWrap(node.attrs));
        };
        const up = (ev: MouseEvent) => {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
          const deg = Math.round(((Math.atan2(ev.clientY - cy, ev.clientX - cx) - start) * 180 / Math.PI) * 10) / 10;
          commit({ rotate: ((deg % 360) + 360) % 360 });
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      });

      // shift+click toggles multi-select (reliable pos via getPos)
      img.addEventListener("mousedown", (e) => {
        if (!editor.isEditable || !e.shiftKey) return;
        e.preventDefault();
        e.stopPropagation();
        const p = pos();
        if (p !== undefined) editor.view.dispatch(editor.state.tr.setMeta(IMG_MULTI, { toggle: p }));
      });
      // floating images: drag body to move (updates posX/posY)
      img.addEventListener("mousedown", (e) => {
        const wrap = effectiveWrap(node.attrs);
        if (wrap !== "behind" && wrap !== "front") return;
        if (!editor.isEditable || e.shiftKey) return;
        e.preventDefault();
        const sx = e.clientX, sy = e.clientY;
        const ox = node.attrs.posX || 0, oy = node.attrs.posY || 0;
        const move = (ev: MouseEvent) => {
          applyTransform(dom, { ...node.attrs, posX: ox + ev.clientX - sx, posY: oy + ev.clientY - sy }, wrap);
        };
        const up = (ev: MouseEvent) => {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
          commit({ posX: Math.round(ox + ev.clientX - sx), posY: Math.round(oy + ev.clientY - sy) });
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      });

      let handles: HTMLElement[] = [];
      const attach = () => {
        if (!editor.isEditable || handles.length) return;
        handles = [corner, side, rot];
        for (const h of handles) dom.appendChild(h);
      };

      apply(node);
      return {
        dom,
        selectNode() { dom.classList.add("selected"); attach(); },
        deselectNode() { dom.classList.remove("selected"); },
        update(n) {
          if (n.type.name !== "image") return false;
          node = n;
          apply(n);
          return true;
        },
      };
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: IMG_MULTI,
        state: {
          init: () => new Set<number>(),
          apply(tr, cur) {
            const meta = tr.getMeta(IMG_MULTI) as { toggle?: number; clear?: boolean } | undefined;
            let next = cur;
            if (meta?.clear) next = new Set();
            else if (meta?.toggle !== undefined) {
              next = new Set(cur);
              if (next.has(meta.toggle)) next.delete(meta.toggle); else next.add(meta.toggle);
            }
            if (tr.docChanged) {
              const mapped = new Set<number>();
              for (const p of next) {
                const np = tr.mapping.map(p);
                if (tr.doc.nodeAt(np)?.type.name === "image") mapped.add(np);
              }
              next = mapped;
            }
            return next;
          },
        },
        props: {
          decorations(state) {
            const sel = IMG_MULTI.getState(state);
            if (!sel?.size) return null;
            const decos: Decoration[] = [];
            for (const p of sel) {
              const n = state.doc.nodeAt(p);
              if (n?.type.name === "image") decos.push(Decoration.node(p, p + n.nodeSize, { class: "multi-sel" }));
            }
            return decos.length ? DecorationSet.create(state.doc, decos) : null;
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      ...this.parent?.(),
      setImageAlign:
        (align) =>
        ({ commands, state }) => {
          const selNode = (state.selection as { node?: { type: { name: string } } }).node;
          if (state.selection.$from.nodeAfter?.type.name !== "image" && selNode?.type.name !== "image") return false;
          return commands.updateAttributes("image", { align });
        },
      setImageWidth:
        (width) =>
        ({ commands }) =>
          commands.updateAttributes("image", { width }),
      setImageWrap:
        (wrap, align) =>
        ({ commands, state }) => {
          const selNode = (state.selection as { node?: { type: { name: string } } }).node;
          if (state.selection.$from.nodeAfter?.type.name !== "image" && selNode?.type.name !== "image") return false;
          return commands.updateAttributes("image", {
            wrap,
            ...(align !== undefined ? { align } : {}),
          });
        },
      toggleImageMulti:
        (pos) =>
        ({ tr, dispatch, state }) => {
          if (state.doc.nodeAt(pos)?.type.name !== "image") return false;
          if (dispatch) dispatch(tr.setMeta(IMG_MULTI, { toggle: pos }));
          return true;
        },
      clearImageMulti:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(IMG_MULTI, { clear: true }));
          return true;
        },
      arrangeImages:
        (action) =>
        ({ state, dispatch, tr, view }) => {
          const sel = new Set(IMG_MULTI.getState(state) ?? []);
          // fall back to the single NodeSelection'd image for z-order etc.
          if (sel.size === 0) {
            const p = (state.selection as { $from?: { pos: number } }).$from?.pos;
            const at = state.selection.$from.nodeAfter ? state.selection.$from.pos : undefined;
            const nodePos = at ?? p;
            if (nodePos !== undefined && state.doc.nodeAt(nodePos)?.type.name === "image") sel.add(nodePos);
          }
          if (sel.size < 2 && action !== "fwd" && action !== "back") return false;
          type Item = { pos: number; node: PMNode; rect: DOMRect };
          const items: Item[] = [];
          for (const p of sel) {
            const n = state.doc.nodeAt(p);
            const el = view.nodeDOM(p) as HTMLElement | null;
            if (n?.type.name === "image" && el) items.push({ pos: p, node: n, rect: el.getBoundingClientRect() });
          }
          if (action === "fwd" || action === "back") {
            const d = action === "fwd" ? 1 : -1;
            for (const it of items) tr.setNodeMarkup(it.pos, undefined, { ...it.node.attrs, zIndex: (it.node.attrs.zIndex || 0) + d });
            if (dispatch) dispatch(tr);
            return true;
          }
          if (items.length < 2) return false;
          const minX = Math.min(...items.map((i) => i.rect.left));
          const maxR = Math.max(...items.map((i) => i.rect.right));
          const minY = Math.min(...items.map((i) => i.rect.top));
          const maxB = Math.max(...items.map((i) => i.rect.bottom));
          const cx = (minX + maxR) / 2, cy = (minY + maxB) / 2;
          const set = (it: Item, dx: number, dy: number) => {
            tr.setNodeMarkup(it.pos, undefined, {
              ...it.node.attrs,
              posX: Math.round((it.node.attrs.posX || 0) + dx),
              posY: Math.round((it.node.attrs.posY || 0) + dy),
            });
          };
          if (action === "alignLeft") for (const it of items) set(it, minX - it.rect.left, 0);
          else if (action === "alignRight") for (const it of items) set(it, maxR - it.rect.right, 0);
          else if (action === "alignCenter") for (const it of items) set(it, cx - (it.rect.left + it.rect.right) / 2, 0);
          else if (action === "alignTop") for (const it of items) set(it, 0, minY - it.rect.top);
          else if (action === "alignBottom") for (const it of items) set(it, 0, maxB - it.rect.bottom);
          else if (action === "alignMiddle") for (const it of items) set(it, 0, cy - (it.rect.top + it.rect.bottom) / 2);
          else {
            // distribute: equal gaps between extremes, keep extremes fixed
            const horiz = action === "distH";
            const sorted = [...items].sort((a, b) => (horiz ? a.rect.left - b.rect.left : a.rect.top - b.rect.top));
            const first = sorted[0], last = sorted[sorted.length - 1];
            const span = horiz
              ? (last.rect.left - first.rect.left)
              : (last.rect.top - first.rect.top);
            const step = span / (sorted.length - 1);
            sorted.forEach((it, i) => {
              const target = (horiz ? first.rect.left : first.rect.top) + step * i;
              if (i === 0 || i === sorted.length - 1) return;
              if (horiz) set(it, target - it.rect.left, 0);
              else set(it, 0, target - it.rect.top);
            });
          }
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },
});

/** Inline style string for the figure element (wrap model + transform). */
function figureStyle(a: Record<string, unknown>): string {
  const wrap = effectiveWrap(a as { wrap?: ImageWrap; align?: string });
  const s: string[] = [];
  if (wrap === "square" || wrap === "tight") {
    if (a.align === "right") s.push("float:right", "margin:4px 0 8px 18px");
    else s.push("float:left", "margin:4px 18px 8px 0");
    s.push("max-width:50%");
  } else if (wrap === "topBottom") {
    s.push("display:block", "margin:10px auto", "text-align:center");
  } else if (wrap === "behind" || wrap === "front") {
    s.push("position:absolute", "margin:0");
    s.push(`z-index:${wrap === "behind" ? -1 : 5 + (Number(a.zIndex) || 0)}`);
  } else {
    s.push("display:block");
    if (a.align === "center") s.push("margin:8px auto", "width:fit-content");
    else if (a.align === "right") s.push("margin:8px 0 8px auto", "width:fit-content");
  }
  const tf = transformOf(a, wrap);
  if (tf) s.push(`transform:${tf}`);
  return s.join(";");
}

function transformOf(a: Record<string, unknown>, wrap: ImageWrap): string {
  const parts: string[] = [];
  if (wrap === "behind" || wrap === "front") parts.push(`translate(${Number(a.posX) || 0}px,${Number(a.posY) || 0}px)`);
  if (Number(a.rotate)) parts.push(`rotate(${Number(a.rotate)}deg)`);
  if (a.flipH || a.flipV) parts.push(`scale(${a.flipH ? -1 : 1},${a.flipV ? -1 : 1})`);
  return parts.join(" ");
}

function applyTransform(dom: HTMLElement, a: Record<string, unknown>, wrap: ImageWrap) {
  dom.style.transform = transformOf(a, wrap);
}

/** Inline style for the img element (size + crop). */
function imgStyle(a: Record<string, unknown>): string {
  const s: string[] = [];
  if (a.width) s.push(`width:${a.width}px`);
  if (a.height) s.push(`height:${a.height}px`);
  const ct = clampCrop(a.cropT), cr = clampCrop(a.cropR), cb = clampCrop(a.cropB), cl = clampCrop(a.cropL);
  if (ct || cr || cb || cl) s.push(`clip-path:inset(${ct}% ${cr}% ${cb}% ${cl}%)`);
  return s.join(";");
}

/**
 * Position preset for floating images — computes posX/posY so the image lands
 * on the 3×3 page-content grid of the band containing its anchor.
 */
export function imagePreset(
  editor: Editor,
  pos: number,
  h: "left" | "center" | "right",
  v: "top" | "middle" | "bottom",
  bands?: { starts: number[]; ends: number[] } | null,
): { posX: number; posY: number } | null {
  const view = editor.view;
  const root = view.dom as HTMLElement;
  const n = view.state.doc.nodeAt(pos);
  const el = view.nodeDOM(pos) as HTMLElement | null;
  if (!n || !el) return null;
  const rootRect = root.getBoundingClientRect();
  const anchor = view.coordsAtPos(pos); // flow position of the node
  const anchorX = anchor.left - rootRect.left;
  const anchorY = anchor.top - rootRect.top;
  const w = el.offsetWidth, hgt = el.offsetHeight;
  const contentW = root.clientWidth;
  const bandTop = bands ? bands.starts[bandIndex(bands, anchorY)] : 0;
  const bandBot = bands ? bands.ends[bandIndex(bands, anchorY)] : root.clientHeight;
  const tx = h === "left" ? 0 : h === "right" ? contentW - w : (contentW - w) / 2;
  const ty = v === "top" ? bandTop : v === "bottom" ? bandBot - hgt : (bandTop + bandBot - hgt) / 2;
  return { posX: Math.round(tx - anchorX), posY: Math.round(ty - anchorY) };
}

function bandIndex(bands: { starts: number[]; ends: number[] }, y: number): number {
  for (let i = 0; i < bands.ends.length; i++) if (y < bands.ends[i]) return i;
  return bands.ends.length - 1;
}
