import { Extension } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    paragraphSpacing: {
      /** Set space above/below the current textblock, in px (0 = unset) */
      setParagraphSpacing: (before?: number | null, after?: number | null) => ReturnType;
      /** Increase left indent by one step (24px), max 8 steps */
      increaseIndent: () => ReturnType;
      /** Decrease left indent by one step */
      decreaseIndent: () => ReturnType;
    };
    listStyle: {
      /** Set the CSS list-style-type of the enclosing/selected list(s) */
      setListStyle: (style: string | null) => ReturnType;
    };
  }
}

const LIST_TYPES = ["bulletList", "orderedList"];

/** List marker styles (disc/circle/square, decimal/alpha/roman…) as a list attr. */
export const ListStyle = Extension.create({
  name: "listStyle",

  addGlobalAttributes() {
    return [
      {
        types: LIST_TYPES,
        attributes: {
          listStyle: {
            default: null,
            parseHTML: (el) => (el as HTMLElement).style.listStyleType || null,
            renderHTML: (attrs) => (attrs.listStyle && !attrs.bullet ? { style: `list-style-type:${attrs.listStyle}` } : {}),
          },
          // DOCX symbol-font bullets (Wingdings ü = ✓ etc.) — import writes
          // --kx-bullet on the <ul>; CSS renders it as the ::marker glyph
          bullet: {
            default: null,
            parseHTML: (el) => {
              const h = el as HTMLElement;
              if (!h.hasAttribute("data-kx-bullet")) return null;
              const g = h.style.getPropertyValue("--kx-bullet").trim().replace(/^['"]|['"]$/g, "");
              return g || "•";
            },
            renderHTML: (attrs) => attrs.bullet
              ? {
                  "data-kx-bullet": "",
                  style: `--kx-bullet:'${String(attrs.bullet).replace(/'/g, "\\'")}'`
                    + (attrs.listStyle ? `;list-style-type:${attrs.listStyle}` : ""),
                }
              : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setListStyle:
        (style) =>
        ({ tr, state, dispatch }) => {
          const { from, to } = state.selection;
          let changed = false;
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (!LIST_TYPES.includes(node.type.name)) return;
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, listStyle: style });
            changed = true;
          });
          if (changed && dispatch) dispatch(tr);
          return changed;
        },
    };
  },
});

const INDENT_STEP = 24;
const INDENT_MAX = 8;
const BLOCKS = ["paragraph", "heading", "blockquote"];

/** Paragraph spacing (space before/after) + indent attributes on textblocks. */
export const ParagraphSpacing = Extension.create({
  name: "paragraphSpacing",

  addGlobalAttributes() {
    return [
      {
        types: BLOCKS,
        attributes: {
          spaceBefore: {
            default: null,
            parseHTML: (el) => (el as HTMLElement).style.marginTop || null,
            renderHTML: (attrs) => (attrs.spaceBefore ? { style: `margin-top:${attrs.spaceBefore}px` } : {}),
          },
          spaceAfter: {
            default: null,
            parseHTML: (el) => (el as HTMLElement).style.marginBottom || null,
            renderHTML: (attrs) => (attrs.spaceAfter ? { style: `margin-bottom:${attrs.spaceAfter}px` } : {}),
          },
          indent: {
            default: 0,
            parseHTML: (el) => Math.round(parseInt((el as HTMLElement).style.marginLeft || "0") / INDENT_STEP),
            renderHTML: (attrs) => (attrs.indent ? { style: `margin-left:${attrs.indent * INDENT_STEP}px` } : {}),
          },
          // Word ▸ Paragraph ▸ Line and Page Breaks — honored by the paginator patch
          pageBreakBefore: {
            default: null,
            parseHTML: (el) => ((el as HTMLElement).getAttribute("data-pb-before") ? true : null),
            renderHTML: (attrs) => (attrs.pageBreakBefore ? { "data-pb-before": "1" } : {}),
          },
          keepNext: {
            default: null,
            parseHTML: (el) => ((el as HTMLElement).getAttribute("data-keep-next") ? true : null),
            renderHTML: (attrs) => (attrs.keepNext ? { "data-keep-next": "1" } : {}),
          },
          keepLines: {
            default: null,
            parseHTML: (el) => ((el as HTMLElement).getAttribute("data-keep-lines") ? true : null),
            renderHTML: (attrs) => (attrs.keepLines ? { "data-keep-lines": "1" } : {}),
          },
          widowOrphan: {
            default: null,
            parseHTML: (el) => ((el as HTMLElement).getAttribute("data-widow-orphan") ? true : null),
            renderHTML: (attrs) => (attrs.widowOrphan ? { "data-widow-orphan": "1" } : {}),
          },
        },
      },
    ];
  },

  addCommands() {
    const apply = (fn: (attrs: Record<string, unknown>) => Record<string, unknown>) =>
      ({ tr, state, dispatch }: { tr: any; state: any; dispatch?: (t: any) => void }) => {
        const { from, to } = state.selection;
        let changed = false;
        state.doc.nodesBetween(from, to, (node: any, pos: number) => {
          if (!BLOCKS.includes(node.type.name)) return;
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...fn(node.attrs) });
          changed = true;
        });
        if (changed && dispatch) dispatch(tr);
        return changed;
      };

    return {
      setParagraphSpacing:
        (before, after) =>
        ({ commands }) => {
          const attrs: Record<string, unknown> = {};
          if (before !== undefined) attrs.spaceBefore = before || null;
          if (after !== undefined) attrs.spaceAfter = after || null;
          for (const name of BLOCKS) commands.updateAttributes(name, attrs);
          return true;
        },
      increaseIndent:
        () =>
        (args) =>
          apply((attrs) => ({ indent: Math.min(INDENT_MAX, (attrs.indent as number) + 1) }))(args as never),
      decreaseIndent:
        () =>
        (args) =>
          apply((attrs) => ({ indent: Math.max(0, (attrs.indent as number) - 1) }))(args as never),
    };
  },
});
