import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    commentMark: {
      setComment: (commentId: string) => ReturnType;
      unsetComment: (commentId: string) => ReturnType;
    };
  }
}

/** Anchors a comment thread to a text range (KBS-SHARED-006 / KBS-WRITER-013) */
export const CommentMark = Mark.create({
  name: "commentMark",
  inclusive: false,

  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-comment-id"),
        renderHTML: (attrs) => ({ "data-comment-id": attrs.commentId, class: "comment-mark" }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-comment-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setComment:
        (commentId) =>
        ({ commands }) =>
          commands.setMark(this.name, { commentId }),
      unsetComment:
        (commentId) =>
        ({ tr, state, dispatch }) => {
          if (!dispatch) return true;
          const type = state.schema.marks[this.name];
          state.doc.descendants((node, pos) => {
            node.marks.forEach((m) => {
              if (m.type === type && m.attrs.commentId === commentId) {
                tr.removeMark(pos, pos + node.nodeSize, type);
              }
            });
          });
          return true;
        },
    };
  },
});

/** OOXML w:sdt content control (run-level). `pr` carries the base64-encoded
 *  <w:sdtPr> XML verbatim so every property — alias, tag, lock, placeholder,
 *  list items — round-trips; `kind`/`checked` drive editor affordances. */
export const SdtMark = Mark.create({
  name: "sdt",
  inclusive: false,

  addAttributes() {
    return {
      pr: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-sdt"),
        renderHTML: (a) => (a.pr ? { "data-sdt": a.pr } : {}),
      },
      kind: {
        default: "text",
        parseHTML: (el) => el.getAttribute("data-sdt-kind") ?? "text",
        renderHTML: (a) => ({ "data-sdt-kind": a.kind }),
      },
      alias: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-sdt-alias") ?? "",
        renderHTML: (a) => (a.alias ? { "data-sdt-alias": a.alias, title: a.alias } : {}),
      },
      checked: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-sdt-checked"),
        renderHTML: (a) => (a.checked != null ? { "data-sdt-checked": a.checked } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-sdt]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "sdt-mark" }), 0];
  },

  addProseMirrorPlugins() {
    const markName = this.name;
    return [
      new Plugin({
        key: new PluginKey("kxSdtToggle"),
        props: {
          // Word-style checkbox controls: click the box glyph to toggle.
          handleClick(view, pos) {
            const { state } = view;
            const type = state.schema.marks[markName];
            if (!type) return false;
            const mark = state.doc.resolve(pos).marks().find((m) => m.type === type);
            if (!mark || mark.attrs.kind !== "checkbox") return false;
            const $pos = state.doc.resolve(pos);
            // expand to the whole run of this control inside the textblock
            let from = -1, to = -1;
            state.doc.nodesBetween($pos.start(), $pos.end(), (n, p) => {
              if (n.isText && n.marks.some((m) => m.type === type && m.attrs.pr === mark.attrs.pr)) {
                if (from < 0) from = p;
                to = p + n.nodeSize;
              }
            });
            if (from < 0) return false;
            const next = mark.attrs.checked === "1" || mark.attrs.checked === true ? "0" : "1";
            const glyph = next === "1" ? "☒" : "☐";
            const tr = state.tr;
            state.doc.nodesBetween(from, to, (n, p) => {
              if (!n.isText || !n.text) return;
              const idx = n.text.search(/[☐☒☑]/);
              if (idx >= 0) tr.replaceWith(p + idx, p + idx + 1, state.schema.text(glyph, n.marks));
            });
            tr.addMark(from, to, type.create({ ...mark.attrs, checked: next }));
            view.dispatch(tr);
            return true;
          },
        },
      }),
    ];
  },
});

/** Block-level w:sdt (controls wrapping whole paragraphs/tables): the b64
 *  sdtPr rides a `data-sdt` attribute; export re-wraps consecutive blocks. */
export const SdtBlock = Extension.create({
  name: "sdtBlock",
  addGlobalAttributes() {
    return [{
      types: ["paragraph", "heading", "blockquote", "listItem", "taskItem"],
      attributes: {
        sdt: {
          default: null,
          parseHTML: (el: HTMLElement) => el.getAttribute("data-sdt"),
          renderHTML: (a: Record<string, unknown>) =>
            (a.sdt ? { "data-sdt": a.sdt, class: "sdt-block" } : {}),
        },
      },
    }];
  },
});
