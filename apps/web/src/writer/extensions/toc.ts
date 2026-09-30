import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/core";
import { pageOfPos } from "./field";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    toc: {
      /** Insert a live table of contents (auto-rebuilds from headings).
       *  `levels` like "1-3" controls depth (Word's \o switch). */
      insertToc: (levels?: string) => ReturnType;
    };
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function parseLevels(spec: string | null): [number, number] {
  const m = /^(\d)(?:-(\d))?$/.exec(spec ?? "");
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : [1, 3];
}

export interface TocItem { level: number; text: string; pos: number; page: number | null }

export function collectHeadings(doc: PMNode, editor: Editor | null, lo = 1, hi = 3): TocItem[] {
  const items: TocItem[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      const level = node.attrs.level as number;
      if (level >= lo && level <= hi) {
        items.push({
          level,
          text: node.textContent || "(empty)",
          pos,
          page: editor ? pageOfPos(editor.view, pos) : null,
        });
      }
    }
    return true;
  });
  return items;
}

/** Block-level live TOC — rebuilds its DOM whenever headings change. */
export const Toc = Node.create({
  name: "toc",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      levels: {
        default: "1-3",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-levels") ?? "1-3",
        renderHTML: (attrs) => ({ "data-levels": attrs.levels }),
      },
      leader: {
        default: "dots",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-leader") ?? "dots",
        renderHTML: (attrs) => ({ "data-leader": attrs.leader }),
      },
      pageNums: {
        default: true,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-pagenums") !== "0",
        renderHTML: (attrs) => ({ "data-pagenums": attrs.pageNums ? "1" : "0" }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="toc"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "toc", class: "doc-toc" })];
  },

  addNodeView() {
    return ({ node, editor }) => {
      const dom = document.createElement("div");
      dom.className = "doc-toc";
      dom.setAttribute("data-type", "toc");
      dom.contentEditable = "false";
      const render = () => {
        const [lo, hi] = parseLevels(node.attrs.levels as string);
        const leader = (node.attrs.leader as string) || "dots";
        const pageNums = node.attrs.pageNums !== false;
        const items = collectHeadings(editor.state.doc, editor, lo, hi);
        dom.className = `doc-toc toc-leader-${leader}`;
        dom.setAttribute("data-type", "toc");
        dom.setAttribute("data-leader", leader);
        dom.innerHTML = items.length
          ? items.map((h, i) =>
              `<div class="toc-item toc-l${h.level}" data-i="${i}" style="padding-left:${(h.level - lo) * 14}px">` +
              `<span class="toc-text">${escapeHtml(h.text)}</span>` +
              `<span class="toc-lead"></span>` +
              (pageNums ? `<span class="toc-page">${h.page ?? ""}</span>` : "") +
              `</div>`).join("")
          : `<div class="toc-item toc-empty">No headings yet</div>`;
        // click → jump to heading
        dom.querySelectorAll<HTMLElement>(".toc-item[data-i]").forEach((el) => {
          el.onclick = () => {
            const it = items[Number(el.dataset.i)];
            if (it) editor.chain().focus().setTextSelection(it.pos + 1).scrollIntoView().run();
          };
        });
      };
      render();
      editor.on("update", render);
      // page numbers track layout — refresh on a slow poll too
      const t = setInterval(render, 2000);
      return { dom, destroy() { editor.off("update", render); clearInterval(t); } };
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
        (levels) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { levels: levels ?? "1-3" } }),
    };
  },
});
