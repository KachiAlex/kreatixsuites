import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/core";
import { pageOfPos } from "./field";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    tof: {
      /** Insert a table of figures for the given caption label (default: all). */
      insertTof: (label?: string) => ReturnType;
      /** Insert a numbered caption paragraph (Label + SEQ field + text) after the selection's block. */
      insertCaption: (label: string, text: string, where?: "above" | "below") => ReturnType;
    };
  }
}

export const CAPTION_LABELS = ["Figure", "Table", "Equation"] as const;

let refSeq = 0;
export const nextRefId = () => `_Ref${Date.now().toString(36)}${(refSeq++).toString(36)}`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface CaptionEntry { pos: number; label: string; num: string; text: string; page: number | null }

/** All caption paragraphs: paragraphs that contain a `field` with `SEQ <label>`. */
export function collectCaptions(doc: PMNode, editor: Editor | null, label?: string): CaptionEntry[] {
  const out: CaptionEntry[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let fld: PMNode | null = null;
    let fldPos = 0;
    node.forEach((ch, off) => {
      if (ch.type.name === "field" && (ch.attrs.instr as string).toUpperCase().startsWith("SEQ ")) {
        fld = ch; fldPos = pos + 1 + off;
      }
    });
    if (!fld) return false;
    const fldLabel = ((fld as PMNode).attrs.instr as string).trim().split(/\s+/).slice(1).join(" ").replace(/\\\*.*/, "").trim();
    if (label && fldLabel.toLowerCase() !== label.toLowerCase()) return false;
    const text = node.textContent.replace(/^.*?:\s*/, "");
    out.push({
      pos: fldPos,
      label: fldLabel,
      num: (fld as PMNode).attrs.cached || "?",
      text,
      page: editor ? pageOfPos(editor.view, fldPos) : null,
    });
    return false;
  });
  return out;
}

/** Block-level live Table of Figures — rebuilds on doc change. */
export const Tof = Node.create({
  name: "tof",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      label: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-label"),
        renderHTML: (attrs) => (attrs.label ? { "data-label": attrs.label } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="tof"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "tof", class: "doc-tof" })];
  },

  addNodeView() {
    return ({ node, editor }) => {
      const dom = document.createElement("div");
      dom.className = "doc-tof";
      dom.setAttribute("data-type", "tof");
      dom.contentEditable = "false";
      const render = () => {
        const label = (node.attrs.label as string) || undefined;
        const items = collectCaptions(editor.state.doc, editor, label);
        dom.innerHTML = items.length
          ? items.map((c) =>
              `<div class="tof-item"><span>${esc(c.label)} ${esc(c.num)}${c.text ? ` — ${esc(c.text)}` : ""}</span><span class="tof-page">${c.page ?? ""}</span></div>`).join("")
          : `<div class="toc-item toc-empty">No captions yet</div>`;
      };
      render();
      editor.on("update", render);
      // page numbers depend on layout — refresh after pagination settles
      const t = setInterval(render, 1500);
      return { dom, destroy() { editor.off("update", render); clearInterval(t); } };
    };
  },

  addProseMirrorPlugins() {
    return [new Plugin({ key: new PluginKey("tofGuard") })];
  },

  addCommands() {
    return {
      insertTof:
        (label) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { label: label ?? null } }),

      insertCaption:
        (captionLabel, text, where = "below") =>
        ({ tr, state, dispatch }) => {
          const id = nextRefId();
          const cap = state.schema.nodes.paragraph.create(
            { styleName: "caption" },
            [
              state.schema.text(`${captionLabel} `),
              state.schema.nodes.field.create({ instr: `SEQ ${captionLabel}`, id }),
              ...(text ? [state.schema.text(`: ${text}`)] : []),
            ],
          );
          // place relative to the block containing the selection
          const $from = state.selection.$from;
          let pos = where === "below" ? state.selection.to : state.selection.from;
          for (let d = $from.depth; d >= 1; d--) {
            if ($from.node(d).isBlock) {
              pos = where === "below" ? $from.after(d) : $from.before(d);
              break;
            }
          }
          if (dispatch) dispatch(tr.insert(pos, cap));
          return true;
        },
    };
  },
});
