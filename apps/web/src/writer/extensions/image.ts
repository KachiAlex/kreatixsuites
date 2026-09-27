import { Image } from "@tiptap/extension-image";
import { mergeAttributes } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    richImage: {
      setImageAlign: (align: "left" | "center" | "right" | "none") => ReturnType;
      setImageWidth: (width: number | null) => ReturnType;
    };
  }
}

/** Image node with width/alignment/alt/caption + drag-to-resize handle. */
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
      align: {
        default: "none",
        parseHTML: (el) => (el.closest("figure")?.getAttribute("data-align") as string) || "none",
        renderHTML: () => ({}),
      },
      caption: {
        default: "",
        parseHTML: (el) => el.closest("figure")?.querySelector("figcaption")?.textContent ?? "",
        renderHTML: () => ({}),
      },
    };
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "figure",
      { class: `doc-image align-${node.attrs.align || "none"}` , "data-align": node.attrs.align || "none" },
      ["img", mergeAttributes(HTMLAttributes)],
      ...(node.attrs.caption ? [["figcaption", {}, node.attrs.caption] as const] : []),
    ];
  },

  parseHTML() {
    return [{ tag: "figure img" }, { tag: 'img[src]:not(figure img)' }];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("figure");
      dom.className = `doc-image align-${node.attrs.align || "none"}`;
      const img = document.createElement("img");
      img.src = node.attrs.src;
      if (node.attrs.alt) img.alt = node.attrs.alt;
      if (node.attrs.width) img.style.width = `${node.attrs.width}px`;
      dom.appendChild(img);
      if (node.attrs.caption) {
        const cap = document.createElement("figcaption");
        cap.textContent = node.attrs.caption;
        dom.appendChild(cap);
      }

      let handle: HTMLElement | null = null;
      const attachHandle = () => {
        if (!editor.isEditable || handle) return;
        handle = document.createElement("span");
        handle.className = "img-resize-handle";
        handle.contentEditable = "false";
        handle.addEventListener("mousedown", (e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startW = img.offsetWidth;
          const move = (ev: MouseEvent) => {
            const w = Math.max(60, Math.min(dom.parentElement?.clientWidth ?? 900, startW + ev.clientX - startX));
            img.style.width = `${w}px`;
          };
          const up = (ev: MouseEvent) => {
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
            const w = Math.max(60, Math.round(startW + ev.clientX - startX));
            const pos = typeof getPos === "function" ? getPos() : undefined;
            if (pos !== undefined) {
              editor.chain().command(({ tr, state }) => {
                const n = state.doc.nodeAt(pos) as PMNode | null;
                if (n?.type.name === "image") tr.setNodeMarkup(pos, undefined, { ...n.attrs, width: w });
                return true;
              }).run();
            }
          };
          document.addEventListener("mousemove", move);
          document.addEventListener("mouseup", up);
        });
        dom.appendChild(handle);
      };

      return {
        dom,
        selectNode() { dom.classList.add("selected"); attachHandle(); },
        deselectNode() { dom.classList.remove("selected"); },
        update(n) {
          if (n.type.name !== "image") return false;
          img.src = n.attrs.src;
          img.style.width = n.attrs.width ? `${n.attrs.width}px` : "";
          dom.className = `doc-image align-${n.attrs.align || "none"}`;
          return true;
        },
      };
    };
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
    };
  },
});
