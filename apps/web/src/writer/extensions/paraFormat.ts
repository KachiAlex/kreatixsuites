import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// ---------- types ----------

export interface TabStop { pos: number; align: "left" | "center" | "right" | "decimal"; leader?: "none" | "dot" | "dash" | "line" }
export interface ParaBorders { top?: BorderSide; right?: BorderSide; bottom?: BorderSide; left?: BorderSide }
export interface BorderSide { style: string; width: number; color: string }
export interface LineSpacingRule { mode: "multiple" | "exact" | "atLeast"; value: string } // value: "1.5" or "24px"/"18pt"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    paraFormat: {
      /** Merge paragraph-format attrs onto every selected textblock. */
      setParaFormat: (attrs: Record<string, unknown>) => ReturnType;
      /** Word ▸ Sort — sort the selected top-level paragraphs. */
      sortParagraphs: (dir?: "asc" | "desc") => ReturnType;
      /** Insert a literal tab character (advances to the next tab stop). */
      insertTabChar: () => ReturnType;
      /** Show/hide pilcrow + formatting marks. */
      toggleShowMarks: () => ReturnType;
    };
  }
  interface Storage {
    KxParaFormat: { showMarks: boolean };
  }
}

const BLOCKS = ["paragraph", "heading", "blockquote", "listItem", "taskItem"];
const SIDES = ["top", "right", "bottom", "left"] as const;
const TAB_KEY = new PluginKey<Map<number, number>>("kxTabStops");

function borderCss(side: string, b: BorderSide): string {
  return `border-${side}:${b.width}px ${b.style} ${b.color}`;
}

/** Word's paragraph formatting: indents (left/right/first-line/hanging),
 *  spacing rules, borders+shading, tab stops. */
export const KxParaFormat = Extension.create({
  name: "KxParaFormat",

  addStorage() {
    return { showMarks: false };
  },

  addGlobalAttributes() {
    return [
      {
        types: BLOCKS,
        attributes: {
          indentPx: {
            default: null, // px — overrides stepped `indent` when set
            parseHTML: (el: HTMLElement) => el.style.marginLeft && el.style.marginLeft.endsWith("px")
              ? parseFloat(el.style.marginLeft) : null,
            renderHTML: (a) => (a.indentPx != null ? { style: `margin-left:${a.indentPx}px` } : {}),
          },
          indentRight: {
            default: null, // px
            parseHTML: (el: HTMLElement) => el.style.marginRight || null,
            renderHTML: (a) => (a.indentRight ? { style: `margin-right:${a.indentRight}px` } : {}),
          },
          firstLine: {
            default: null, // px signed; negative = hanging
            parseHTML: (el: HTMLElement) => el.style.textIndent || null,
            renderHTML: (a) => (a.firstLine ? { style: `text-indent:${a.firstLine}px` } : {}),
          },
          lineSpacingRule: {
            default: null, // "exact:24px" | "atLeast:18pt" | "multiple:1.5"
            parseHTML: (el: HTMLElement) => el.getAttribute("data-line-rule"),
            renderHTML: (a) => {
              const rule = a.lineSpacingRule as string | null;
              if (!rule) return {};
              const [mode, v] = rule.split(":");
              const lh = mode === "multiple" ? v : `${v}${/^\d+(\.\d+)?$/.test(v) ? "pt" : ""}`;
              return { "data-line-rule": rule, style: `line-height:${lh}` };
            },
          },
          pBorders: {
            default: null,
            parseHTML: (el: HTMLElement) => el.getAttribute("data-p-borders") ? JSON.parse(el.getAttribute("data-p-borders")!) : null,
            renderHTML: (a) => {
              const b = a.pBorders as ParaBorders | null;
              if (!b) return {};
              const css = SIDES.filter((s) => b[s]).map((s) => borderCss(s, b[s]!));
              if (!css.length) return {};
              return { "data-p-borders": JSON.stringify(b), style: css.join(";") };
            },
          },
          pShading: {
            default: null,
            parseHTML: (el: HTMLElement) => el.style.backgroundColor || el.getAttribute("data-p-shading"),
            renderHTML: (a) => (a.pShading ? { "data-p-shading": a.pShading, style: `background-color:${a.pShading}` } : {}),
          },
          tabs: {
            default: null,
            parseHTML: (el: HTMLElement) => el.getAttribute("data-tabs") ? JSON.parse(el.getAttribute("data-tabs")!) : null,
            renderHTML: (a) => (a.tabs ? { "data-tabs": JSON.stringify(a.tabs) } : {}),
          },
          /** Base text direction — Word's right-to-left paragraph setting. */
          dir: {
            default: null,
            parseHTML: (el: HTMLElement) => el.getAttribute("dir") || null,
            renderHTML: (a) => (a.dir ? { dir: a.dir } : {}),
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setParaFormat:
        (attrs) =>
        ({ tr, state, dispatch }) => {
          const { from, to } = state.selection;
          let changed = false;
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (!BLOCKS.includes(node.type.name)) return;
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
            changed = true;
          });
          if (changed && dispatch) dispatch(tr);
          return changed;
        },

      sortParagraphs:
        (dir = "asc") =>
        ({ tr, state, dispatch }) => {
          const { $from, $to } = state.selection;
          // contiguous run of top-level textblocks intersecting the selection;
          // a non-text block (table/image) splits the run — only the segment
          // containing the selection anchor is sorted.
          const segs: { pos: number; node: import("@tiptap/pm/model").Node }[][] = [[]];
          state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
            if (state.doc.resolve(pos).depth !== 0) return false;
            if (node.isTextblock) segs[segs.length - 1].push({ pos, node });
            else segs.push([]);
            return false;
          });
          const blocks =
            segs.find((s) => s.length && s.some((b) => $from.pos >= b.pos && $from.pos <= b.pos + b.node.nodeSize)) ??
            segs.find((s) => s.length >= 2) ??
            [];
          if (blocks.length < 2) return false;
          const sorted = [...blocks].sort((a, b) => {
            const c = a.node.textContent.localeCompare(b.node.textContent, undefined, { numeric: true });
            return dir === "desc" ? -c : c;
          });
          if (dispatch) {
            const first = blocks[0].pos;
            const last = blocks[blocks.length - 1].pos + blocks[blocks.length - 1].node.nodeSize;
            tr.replaceWith(first, last, sorted.map((b) => b.node));
          }
          return true;
        },

      insertTabChar:
        () =>
        ({ dispatch, tr }) => {
          if (dispatch) tr.insertText("\t");
          return true;
        },

      toggleShowMarks:
        () =>
        ({ editor, state, dispatch }) => {
          editor.storage.KxParaFormat.showMarks = !editor.storage.KxParaFormat.showMarks;
          if (dispatch) dispatch(state.tr.setMeta("kxShowMarks", true));
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        // keep list/outliner/table/code Tab semantics; body text gets a tab char
        if (editor.isActive("listItem") || editor.isActive("taskItem") || editor.isActive("codeBlock")) return false;
        if (editor.isActive("table")) return false;
        return editor.chain().insertTabChar().run();
      },
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      // --- pilcrow / space / tab formatting marks ---
      new Plugin({
        key: new PluginKey("kxShowMarks"),
        props: {
          decorations(state) {
            if (!editor.storage.KxParaFormat.showMarks) return null;
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.isText && node.text) {
                for (let i = 0; i < node.text.length; i++) {
                  const ch = node.text[i];
                  if (ch === " ") decos.push(Decoration.inline(pos + i, pos + i + 1, { class: "kx-mark-space" }));
                  else if (ch === "\t") decos.push(Decoration.inline(pos + i, pos + i + 1, { class: "kx-mark-tab" }));
                }
                return;
              }
              if (node.isTextblock) {
                // pilcrow at end of block
                decos.push(Decoration.widget(pos + node.nodeSize - 1, () => {
                  const s = document.createElement("span");
                  s.className = "kx-pilcrow";
                  s.textContent = "¶";
                  return s;
                }, { side: -1 }));
              }
              return true;
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
      // --- measured tab stops: bake width into the decoration itself.
      // (Direct DOM mutation fights PM's decoration re-render — MutationObserver
      // resets the span. Instead: measure via coordsAtPos in rAF, stash widths,
      // dispatch a meta tr to re-run decorations when they change.) ---
      new Plugin({
        key: TAB_KEY,
        state: {
          init: () => new Map<number, number>(),
          apply: (tr, map) => (tr.getMeta(TAB_KEY) as Map<number, number> | undefined) ?? map,
        },
        props: {
          decorations(state) {
            const widths = this.getState(state) as Map<number, number>;
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.isText && node.text?.includes("\t")) {
                for (let i = 0; i < node.text.length; i++) {
                  if (node.text[i] === "\t") {
                    const w = widths.get(pos + i);
                    decos.push(Decoration.inline(pos + i, pos + i + 1,
                      w ? { class: "kx-tabspan", style: `width:${w}px` } : { class: "kx-tabspan" }));
                  }
                }
                return false;
              }
              return true;
            });
            return decos.length ? DecorationSet.create(state.doc, decos) : null;
          },
        },
        view(view) {
          const measure = () => {
            const widths = TAB_KEY.getState(view.state) ?? new Map<number, number>();
            const next = new Map<number, number>();
            view.state.doc.descendants((node, pos) => {
              if (node.isText && node.text?.includes("\t")) {
                for (let i = 0; i < node.text.length; i++) {
                  if (node.text[i] !== "\t") continue;
                  const tabPos = pos + i;
                  try {
                    const coords = view.coordsAtPos(tabPos);
                    // the textblock holding the tab → its DOM element carries data-tabs
                    const $p = view.state.doc.resolve(tabPos);
                    const block = view.nodeDOM($p.start() - 1) as HTMLElement | null;
                    const raw = block?.getAttribute("data-tabs");
                    const tabs = raw ? (JSON.parse(raw) as TabStop[]) : null;
                    const blockLeft = (block?.getBoundingClientRect().left ?? 0) + parseFloat(block ? getComputedStyle(block).paddingLeft || "0" : "0");
                    const x = coords.left - blockLeft;
                    const stop = tabs?.length
                      ? (tabs.find((t) => t.pos > x + 1)?.pos ?? tabs[tabs.length - 1].pos)
                      : (Math.floor(x / 48) + 1) * 48;
                    next.set(tabPos, Math.round(Math.max(8, stop - x)));
                  } catch { /* position not rendered — skip */ }
                }
                return false;
              }
              return true;
            });
            const changed = next.size !== widths.size || [...next].some(([k, v]) => widths.get(k) !== v);
            if (changed) view.dispatch(view.state.tr.setMeta(TAB_KEY, next).setMeta("addToHistory", false));
          };
          let raf = 0;
          const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
          schedule();
          window.addEventListener("resize", schedule);
          return {
            update: schedule,
            destroy: () => { cancelAnimationFrame(raf); window.removeEventListener("resize", schedule); },
          };
        },
      }),
    ];
  },
});
