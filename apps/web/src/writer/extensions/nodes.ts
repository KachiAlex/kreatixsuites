import { Node, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pageBreak: {
      setPageBreak: () => ReturnType;
    };
    sectionBreak: {
      setSectionBreak: (type?: "nextPage" | "continuous" | "evenPage" | "oddPage") => ReturnType;
    };
    columnBreak: {
      setColumnBreak: () => ReturnType;
    };
    columns: {
      setColumns: (count?: number, gap?: number, rule?: boolean) => ReturnType;
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
      mergeAttributes(HTMLAttributes, { "data-type": "page-break", "data-force-break": "1", class: "page-break" }),
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

const SECTION_LABELS: Record<string, string> = {
  nextPage: "Section break (next page)",
  continuous: "Section break (continuous)",
  evenPage: "Section break (even page)",
  oddPage: "Section break (odd page)",
};

/** Section boundary — carries the *following* section's page setup, mirroring
 *  OOXML `w:sectPr`. non-continuous types force a band end (visual page break)
 *  via data-force-break; continuous inserts a flow divider only. */
export const SectionBreak = Node.create({
  name: "sectionBreak",
  group: "block",
  selectable: true,
  atom: true,

  addAttributes() {
    return {
      type: { default: "nextPage" },
      // following section geometry — nulls mean "inherit document setup"
      pageWidth: { default: null }, pageHeight: { default: null },
      marginTop: { default: null }, marginBottom: { default: null },
      marginLeft: { default: null }, marginRight: { default: null },
      headerLeft: { default: null }, headerRight: { default: null },
      footerLeft: { default: null }, footerRight: { default: null },
      /** restart page numbering at this value in the following section */
      pnStart: { default: null },
    };
  },

  parseHTML() {
    return [{
      tag: 'div[data-type="section-break"]',
      getAttrs: (el) => ({
        type: (el as HTMLElement).getAttribute("data-section-type") ?? "nextPage",
        pageWidth: numAttr(el, "data-page-width"), pageHeight: numAttr(el, "data-page-height"),
        marginTop: numAttr(el, "data-margin-top"), marginBottom: numAttr(el, "data-margin-bottom"),
        marginLeft: numAttr(el, "data-margin-left"), marginRight: numAttr(el, "data-margin-right"),
        headerLeft: el.getAttribute("data-header-left"), headerRight: el.getAttribute("data-header-right"),
        footerLeft: el.getAttribute("data-footer-left"), footerRight: el.getAttribute("data-footer-right"),
        pnStart: numAttr(el, "data-pn-start"),
      }),
    }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const a = node.attrs as Record<string, unknown>;
    const type = (a.type as string) ?? "nextPage";
    const data: Record<string, string> = { "data-section-type": type };
    for (const [k, v] of Object.entries({
      pageWidth: a.pageWidth, pageHeight: a.pageHeight,
      marginTop: a.marginTop, marginBottom: a.marginBottom,
      marginLeft: a.marginLeft, marginRight: a.marginRight,
      headerLeft: a.headerLeft, headerRight: a.headerRight,
      footerLeft: a.footerLeft, footerRight: a.footerRight,
      pnStart: a.pnStart,
    })) {
      if (v != null) data[`data-${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`] = String(v);
    }
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "section-break",
        // continuous sections flow inline; the rest force a band end
        ...(type !== "continuous" ? { "data-force-break": "1" } : {}),
        "data-odd-even": type === "oddPage" || type === "evenPage" ? type : "",
        class: `page-break section-break section-${type}`,
        ...data,
      }),
      ["span", { class: "page-break-label" }, SECTION_LABELS[type] ?? "Section break"],
    ];
  },

  addCommands() {
    return {
      setSectionBreak:
        (type = "nextPage") =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { type } }),
    };
  },
});

const numAttr = (el: Element, name: string): number | null => {
  const v = (el as HTMLElement).getAttribute(name);
  return v == null ? null : Number(v);
};

/** Forces the next column inside a `columns` region (CSS column break). */
export const ColumnBreak = Node.create({
  name: "columnBreak",
  group: "block",
  selectable: true,
  atom: true,

  parseHTML() {
    return [{ tag: 'div[data-type="column-break"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": "column-break", class: "page-break column-break" }),
      ["span", { class: "page-break-label" }, "Column break"],
    ];
  },

  addCommands() {
    return {
      setColumnBreak:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },
});

/** Multi-column region — a continuous-section layout (Word/Docs column sections). */
export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "block+",

  addAttributes() {
    return {
      count: {
        default: 2,
        parseHTML: (el) => parseInt((el as HTMLElement).getAttribute("data-cols") ?? "2"),
        renderHTML: (a) => ({ "data-cols": String(a.count) }),
      },
      gap: {
        default: 32,
        parseHTML: (el) => parseInt((el as HTMLElement).style.columnGap || "32"),
        renderHTML: () => ({}),
      },
      rule: {
        default: false,
        parseHTML: (el) => (el as HTMLElement).style.columnRuleStyle !== "",
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="columns"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const a = node.attrs as { count: number; gap: number; rule: boolean };
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "columns",
        class: "doc-columns",
        style: `column-count:${a.count};column-gap:${a.gap}px` +
          (a.rule ? ";column-rule:1px solid #DDD6D0" : ""),
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setColumns:
        (count = 2, gap = 32, rule = false) =>
        ({ commands, state }) => {
          // wrap the current block selection in a columns region, or update one
          const { $from } = state.selection;
          for (let d = $from.depth; d >= 0; d--) {
            if ($from.node(d).type.name === this.name) {
              return commands.updateAttributes(this.name, { count, gap, rule });
            }
          }
          return commands.wrapIn(this.name, { count, gap, rule });
        },
    };
  },
});
