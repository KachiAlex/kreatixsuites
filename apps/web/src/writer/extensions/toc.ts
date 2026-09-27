import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    toc: {
      /** Insert a live table of contents (auto-rebuilds from headings). */
      insertToc: () => ReturnType;
    };
  }
}

function renderTocItems(doc: PMNode, container: HTMLElement) {
  const items: { level: number; text: string }[] = [];
  doc.descendants((node) => {
    if (node.type.name === "heading") {
      items.push({ level: node.attrs.level as number, text: node.textContent || "(empty)" });
    }
  });
  container.innerHTML = items.length
    ? items.map((h) => `<div class="toc-item" style="padding-left:${(h.level - 1) * 14}px">${escapeHtml(h.text)}</div>`).join("")
    : `<div class="toc-item toc-empty">No headings yet</div>`;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Block-level live TOC — rebuilds its DOM whenever headings change. */
export const Toc = Node.create({
  name: "toc",
  group: "block",
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'div[data-type="toc"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "toc", class: "doc-toc" })];
  },

  addNodeView() {
    return ({ editor }) => {
      const dom = document.createElement("div");
      dom.className = "doc-toc";
      dom.setAttribute("data-type", "toc");
      dom.contentEditable = "false";
      renderTocItems(editor.state.doc, dom);
      const update = () => renderTocItems(editor.state.doc, dom);
      editor.on("update", update);
      return {
        dom,
        destroy() { editor.off("update", update); },
      };
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("tocGuard"),
        // keep the node inert to editing
        props: {},
      }),
    ];
  },

  addCommands() {
    return {
      insertToc:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },
});
