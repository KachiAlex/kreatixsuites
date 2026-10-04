import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";

// ---------- types ----------

/** Named paragraph style, Word-style. Definitions live in the doc payload (`styles`). */
export interface StyleDef {
  key: string;
  label: string;
  /** Base node the style produces */
  node: "paragraph" | "heading" | "blockquote";
  level?: number; // heading level when node==="heading"
  // character props
  fontFamily?: string;
  fontSize?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  // paragraph props (CSS values; spacing in px numbers)
  align?: "left" | "center" | "right" | "justify";
  lineHeight?: string;
  spaceBefore?: number;
  spaceAfter?: number;
  indent?: number; // 28px units, matches data-indent
  /** Style applied to the paragraph created on Enter */
  nextStyle?: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    kxStyles: {
      /** Apply a named style to the selected blocks. */
      applyStyle: (key: string) => ReturnType;
      /** Modify/create a style definition. */
      modifyStyle: (def: Partial<StyleDef> & { key: string }) => ReturnType;
      /** Remove a custom style (blocks keep their look via nothing — revert to normal). */
      deleteStyle: (key: string) => ReturnType;
    };
  }
  interface Storage {
    KxStyles: { defs: Record<string, StyleDef> };
  }
}

// ---------- built-in styles ----------

export const DEFAULT_STYLES: StyleDef[] = [
  { key: "normal", label: "Normal", node: "paragraph", nextStyle: "normal" },
  { key: "title", label: "Title", node: "paragraph", nextStyle: "subtitle",
    fontSize: "28px", spaceAfter: 8 },
  { key: "subtitle", label: "Subtitle", node: "paragraph", nextStyle: "normal",
    fontSize: "15px", color: "#6b7280", spaceAfter: 12 },
  { key: "heading1", label: "Heading 1", node: "heading", level: 1, nextStyle: "normal" },
  { key: "heading2", label: "Heading 2", node: "heading", level: 2, nextStyle: "normal" },
  { key: "heading3", label: "Heading 3", node: "heading", level: 3, nextStyle: "normal" },
  { key: "heading4", label: "Heading 4", node: "heading", level: 4, nextStyle: "normal" },
  { key: "heading5", label: "Heading 5", node: "heading", level: 5, nextStyle: "normal" },
  { key: "heading6", label: "Heading 6", node: "heading", level: 6, nextStyle: "normal" },
  { key: "quote", label: "Quote", node: "blockquote", nextStyle: "normal" },
  { key: "caption", label: "Caption", node: "paragraph", nextStyle: "normal",
    fontSize: "12px", italic: true, color: "#6b7280", spaceBefore: 4, spaceAfter: 10 },
  { key: "listParagraph", label: "List Paragraph", node: "paragraph", nextStyle: "listParagraph", indent: 1 },
];

export function styleDefsOf(editor: Editor): Record<string, StyleDef> {
  return (editor.storage.KxStyles?.defs ?? {}) as Record<string, StyleDef>;
}

export function allStyleDefs(editor: Editor): StyleDef[] {
  const defs = styleDefsOf(editor);
  return DEFAULT_STYLES.map((d) => ({ ...d, ...(defs[d.key] ?? {}) }))
    .concat(Object.values(defs).filter((d) => !DEFAULT_STYLES.some((b) => b.key === d.key)));
}

export function styleDefOf(editor: Editor, key: string): StyleDef | undefined {
  return allStyleDefs(editor).find((d) => d.key === key);
}

/** CSS selector inside the editor for a style def. */
export function selectorFor(def: StyleDef): string {
  if (def.node === "heading") return `.ProseMirror h${def.level ?? 1}`;
  if (def.node === "blockquote") return ".ProseMirror blockquote";
  // "normal" is Word's default style — unstyled paragraphs carry no attr.
  if (def.key === "normal") return '.ProseMirror p:not([data-style]), .ProseMirror p[data-style="normal"]';
  return `.ProseMirror [data-style="${def.key}"]`;
}

/** CSS declaration block for a def's formatting props. */
export function cssFor(def: StyleDef): string {
  const p: string[] = [];
  if (def.fontFamily) p.push(`font-family:${def.fontFamily}`);
  if (def.fontSize) p.push(`font-size:${def.fontSize}`);
  if (def.bold != null) p.push(`font-weight:${def.bold ? "700" : "400"}`);
  if (def.italic != null) p.push(`font-style:${def.italic ? "italic" : "normal"}`);
  if (def.underline != null) p.push(`text-decoration:${def.underline ? "underline" : "none"}`);
  if (def.color) p.push(`color:${def.color}`);
  if (def.align) p.push(`text-align:${def.align}`);
  if (def.lineHeight) p.push(`line-height:${def.lineHeight}`);
  if (def.spaceBefore != null) p.push(`margin-top:${def.spaceBefore}px`);
  if (def.spaceAfter != null) p.push(`margin-bottom:${def.spaceAfter}px`);
  if (def.indent != null) p.push(`margin-left:${def.indent * 28}px`);
  return p.join(";");
}

function regenerateCss(editor: Editor) {
  let tag = document.querySelector("style[data-kx-styles]") as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement("style");
    tag.setAttribute("data-kx-styles", "");
    document.head.appendChild(tag);
  }
  const rules = allStyleDefs(editor)
    .map((d) => `${selectorFor(d)}{${cssFor(d) || ""}}`)
    .join("\n");
  tag.textContent = rules;
}

// ---------- extension ----------

export const KxStyles = Extension.create({
  name: "KxStyles",

  addStorage() {
    return {
      defs: {} as Record<string, StyleDef>, // doc-level customizations + customs
    };
  },

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading", "blockquote"],
        attributes: {
          styleName: {
            default: null,
            parseHTML: (el: HTMLElement) => el.getAttribute("data-style") || null,
            renderHTML: (attrs: Record<string, any>) =>
              attrs.styleName ? { "data-style": attrs.styleName } : {},
          },
        },
      },
    ];
  },

  onCreate() {
    regenerateCss(this.editor);
  },

  addCommands() {
    return {
      applyStyle:
        (key: string) =>
        ({ editor, tr, state, dispatch }) => {
          const def = styleDefOf(editor, key);
          if (!def) return false;
          const { from, to } = state.selection;
          const poss: number[] = [];
          state.doc.nodesBetween(from, to, (n, pos) => {
            if (n.type.name === "paragraph" || n.type.name === "heading" || n.type.name === "blockquote")
              poss.push(pos);
          });
          if (!poss.length) return false;
          if (dispatch) {
            for (const pos of poss) {
              const node = tr.doc.nodeAt(pos)!;
              if (def.node === "blockquote") {
                if (node.type.name !== "blockquote") {
                  const range = tr.doc.resolve(pos).blockRange();
                  if (range) tr.wrap(range, [{ type: state.schema.nodes.blockquote }]);
                }
                continue;
              }
              const targetType = def.node === "heading" ? state.schema.nodes.heading : state.schema.nodes.paragraph;
              tr.setNodeMarkup(pos, targetType, {
                ...node.attrs,
                level: def.node === "heading" ? def.level ?? 1 : node.attrs.level,
                styleName: def.node === "paragraph" ? key : null,
              });
            }
          }
          return true;
        },

      modifyStyle:
        (def) =>
        ({ editor, dispatch, state }) => {
          const existing = styleDefsOf(editor);
          const base = existing[def.key] ?? DEFAULT_STYLES.find((d) => d.key === def.key)
            ?? { key: def.key, label: def.key, node: "paragraph" as const };
          const merged: StyleDef = { ...base, ...def, key: def.key } as StyleDef;
          editor.storage.KxStyles.defs = { ...existing, [merged.key]: merged };
          regenerateCss(editor);
          if (dispatch) state.tr.setMeta("kxStyles", true);
          return true;
        },

      deleteStyle:
        (key: string) =>
        ({ editor, dispatch, state }) => {
          if (DEFAULT_STYLES.some((d) => d.key === key)) return false;
          const { [key]: _drop, ...rest } = styleDefsOf(editor);
          editor.storage.KxStyles.defs = rest;
          regenerateCss(editor);
          if (dispatch) state.tr.setMeta("kxStyles", true);
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { $from } = editor.state.selection;
        const parent = $from.parent;
        const key = parent.attrs.styleName
          ?? (parent.type.name === "heading" ? `heading${parent.attrs.level}` : null);
        const def = key ? styleDefOf(editor, key) : undefined;
        if (!def?.nextStyle || def.nextStyle === key || !key) return false;
        const next = styleDefOf(editor, def.nextStyle);
        if (!next) return false;
        return editor
          .chain()
          .focus()
          .splitBlock()
          .applyStyle(next.key)
          .run();
      },
    };
  },
});

/** Serialize style defs into the save payload. */
export function serializeStyles(editor: Editor): Record<string, StyleDef> {
  return styleDefsOf(editor);
}

/** Apply doc-level style defs from a loaded payload. */
export function loadStyleDefs(editor: Editor, defs: Record<string, StyleDef> | undefined) {
  editor.storage.KxStyles.defs = defs ?? {};
  regenerateCss(editor);
}
