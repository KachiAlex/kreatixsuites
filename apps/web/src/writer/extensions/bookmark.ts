import { Mark, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    bookmark: {
      /** Bookmark the current selection under `name` (id defaults to name). */
      setBookmark: (name: string) => ReturnType;
      /** Remove the bookmark named `name` (or under the cursor). */
      unsetBookmark: (name?: string) => ReturnType;
      /** Move the selection onto the named bookmark's range. */
      goToBookmark: (name: string) => ReturnType;
    };
  }
}

/** Word-style bookmark — an inline range mark that REF/PAGEREF fields target. */
export const Bookmark = Mark.create({
  name: "bookmark",
  inclusive: false,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-bm-id"),
        renderHTML: (attrs) => (attrs.id ? { "data-bm-id": attrs.id } : {}),
      },
      name: {
        default: "",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-bm-name") ?? "",
        renderHTML: (attrs) => (attrs.name ? { "data-bm-name": attrs.name } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-bm-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "kx-bookmark" })];
  },

  addCommands() {
    return {
      setBookmark:
        (name) =>
        ({ chain }) => {
          const id = name.replace(/\s+/g, "_");
          // one bookmark per id — strip any existing occurrence first
          chain().unsetBookmark(id).run();
          return chain()
            .command(({ tr, state: st }) => {
              const { from, to } = st.selection;
              const mk = st.schema.marks.bookmark.create({ id, name });
              tr.addMark(from, to, mk);
              return true;
            })
            .run();
        },
      unsetBookmark:
        (name) =>
        ({ tr, state, dispatch }) => {
          const mk = state.schema.marks.bookmark;
          const { from, to } = state.selection;
          if (name) {
            // remove everywhere this id appears
            state.doc.descendants((node, pos) => {
              if (!node.isText) return true;
              const m = node.marks.find((x) => x.type === mk && x.attrs.id === name);
              if (m) tr.removeMark(pos, pos + node.nodeSize, mk);
              return true;
            });
          } else {
            tr.removeMark(from, to, mk);
          }
          if (dispatch) dispatch(tr);
          return true;
        },
      goToBookmark:
        (name) =>
        ({ commands, state }) => {
          let found: { from: number; to: number } | null = null;
          state.doc.descendants((node, pos) => {
            if (!node.isText) return true;
            if (node.marks.some((m) => m.type.name === "bookmark" && m.attrs.id === name)) {
              if (!found) found = { from: pos, to: pos + node.nodeSize };
              else found.to = pos + node.nodeSize;
            }
            return true;
          });
          if (!found) return false;
          return commands.setTextSelection(found);
        },
    };
  },
});
