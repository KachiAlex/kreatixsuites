import { Node, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pageBreak: {
      setPageBreak: () => ReturnType;
    };
  }
}

/** Explicit page break — prints as a hard break, renders as a labeled rule in-editor. */
export const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  selectable: true,
  atom: true,

  parseHTML() {
    return [{ tag: 'div[data-type="page-break"]' }, { tag: "hr.pb" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": "page-break", class: "page-break" }),
      ["span", { class: "page-break-label" }, "Page break"],
    ];
  },

  addCommands() {
    return {
      setPageBreak:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },

  addKeyboardShortcuts() {
    return { "Mod-Enter": () => this.editor.commands.setPageBreak() };
  },
});
