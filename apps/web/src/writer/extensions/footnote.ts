import { Node, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    footnote: {
      /** Insert a numbered footnote reference; `note` is the footnote text. */
      insertFootnote: (note: string) => ReturnType;
      /** Update the text of the footnote ref at the current selection. */
      updateFootnote: (note: string) => ReturnType;
    };
  }
}

/** Inline footnote reference — auto-numbered via CSS counters, note text in attrs. */
export const Footnote = Node.create({
  name: "footnote",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      note: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-note") ?? "",
        renderHTML: (attrs) => ({ "data-note": attrs.note, title: attrs.note }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'sup[data-type="footnote"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["sup", mergeAttributes(HTMLAttributes, { "data-type": "footnote", class: "footnote-ref" })];
  },

  addCommands() {
    return {
      insertFootnote:
        (note) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { note } }),
      updateFootnote:
        (note) =>
        ({ commands, state }) => {
          const node = (state.selection as { node?: { type: { name: string } } }).node;
          if (node?.type.name !== this.name) return false;
          return commands.updateAttributes(this.name, { note });
        },
    };
  },
});
