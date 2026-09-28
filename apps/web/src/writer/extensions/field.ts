import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { measureBands, bandIndexAt } from "../banding";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    field: {
      /** Insert a field at the selection. `id` lets REF/PAGEREF target it. */
      insertField: (instr: string, opts?: { id?: string; cached?: string }) => ReturnType;
      /** Re-evaluate all fields (F9). */
      updateFields: () => ReturnType;
    };
  }
}

export interface FieldTarget {
  /** Field node position or bookmark range start (doc pos). */
  pos: number;
  /** End pos for ranged bookmarks. */
  end?: number;
  /** Renderable text (cached field value or bookmarked text). */
  text: string;
}

/** Collect every named target: field ids and bookmark marks. */
export function collectTargets(doc: PMNode): Map<string, FieldTarget> {
  const map = new Map<string, FieldTarget>();
  doc.descendants((node, pos) => {
    if (node.type.name === "field" && node.attrs.id) {
      map.set(node.attrs.id as string, { pos, text: (node.attrs.cached as string) || "?" });
    }
    if (node.isText) {
      for (const m of node.marks) {
        if (m.type.name === "bookmark" && m.attrs.id) {
          const ex = map.get(m.attrs.id as string);
          if (ex) { ex.end = pos + node.nodeSize; ex.text += node.text ?? ""; }
          else map.set(m.attrs.id as string, { pos, end: pos + node.nodeSize, text: node.text ?? "" });
        }
      }
    }
    return true;
  });
  return map;
}

/** Page number (1-based) of a doc position via pagination bands; null if unknown. */
export function pageOfPos(view: EditorView, pos: number): number | null {
  try {
    const bands = measureBands(view.dom as HTMLElement);
    if (!bands || !bands.starts.length) return null;
    const y = view.coordsAtPos(pos).top - view.dom.getBoundingClientRect().top;
    return bandIndexAt(bands, y) + 1;
  } catch {
    return null;
  }
}

/** Total rendered page count. */
export function pageCount(view: EditorView): number | null {
  try {
    const bands = measureBands(view.dom as HTMLElement);
    return bands?.starts.length ? bands.starts.length : null;
  } catch {
    return null;
  }
}

interface FieldOcc { pos: number; node: PMNode }

function fieldsInDoc(doc: PMNode): FieldOcc[] {
  const out: FieldOcc[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "field") out.push({ pos, node });
    return true;
  });
  return out;
}

/** Evaluate a field instruction. Doc-only fields need `doc`; page fields need `view`. */
export function evalField(instr: string, doc: PMNode, view: EditorView | null, selfPos: number): string {
  const parts = instr.trim().split(/\s+/);
  const code = (parts[0] ?? "").toUpperCase();
  const targets = collectTargets(doc);
  switch (code) {
    case "SEQ": {
      // "SEQ Figure" → ordinal of this field among same-label SEQ fields
      const label = parts.slice(1).join(" ").replace(/\\\*.*/, "").trim();
      const all = fieldsInDoc(doc).filter((f) =>
        (f.node.attrs.instr as string).trim().toUpperCase().startsWith(`SEQ ${label.toUpperCase()}`));
      const idx = all.findIndex((f) => f.pos === selfPos);
      return String(idx < 0 ? all.length : idx + 1);
    }
    case "REF":
    case "NOTEREF": {
      const t = targets.get(parts[1] ?? "");
      return t ? t.text : "Error! Reference source not found.";
    }
    case "PAGEREF": {
      const t = targets.get(parts[1] ?? "");
      if (!t || !view) return "?";
      const p = pageOfPos(view, t.pos);
      return p ? String(p) : "?";
    }
    case "PAGE":
      return view ? String(pageOfPos(view, selfPos) ?? 1) : "1";
    case "NUMPAGES":
      return view ? String(pageCount(view) ?? 1) : "1";
    case "DATE":
      return new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    case "TIME":
      return new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    case "STYLEREF": {
      // last matching heading before this field (running headers)
      const want = parts.slice(1).join(" ").replace(/"/g, "").toLowerCase();
      const lvl = Number(want.replace("heading ", ""));
      let found = "";
      doc.descendants((node, pos) => {
        if (pos >= selfPos) return false;
        if (node.type.name === "heading" &&
            ((want.startsWith("heading") && node.attrs.level === lvl) || node.attrs.styleName === want)) {
          found = node.textContent;
        }
        return true;
      });
      return found || "—";
    }
    case "AUTHOR":
    case "TITLE":
      return "—"; // doc properties land in Phase 7
    default:
      return `?${code}?`;
  }
}

/** Word-style inline field: instruction in attrs, rendered `cached` result. */
export const Field = Node.create({
  name: "field",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      instr: {
        default: "",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-instr") ?? "",
        renderHTML: (attrs) => ({ "data-instr": attrs.instr }),
      },
      cached: { default: "", rendered: false },
      id: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-fid"),
        renderHTML: (attrs) => (attrs.id ? { "data-fid": attrs.id } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="field"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-type": "field", class: "kx-field" }),
      (node.attrs.cached as string) || "‹field›"];
  },

  addCommands() {
    return {
      insertField:
        (instr, opts) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { instr, cached: opts?.cached ?? "", id: opts?.id ?? null },
          }),
      updateFields:
        () =>
        ({ tr, state, dispatch, editor }) => {
          let changed = false;
          for (const { pos, node } of fieldsInDoc(state.doc)) {
            const v = evalField(node.attrs.instr as string, state.doc, editor.view, pos);
            if (v !== node.attrs.cached) { tr.setNodeMarkup(pos, undefined, { ...node.attrs, cached: v }); changed = true; }
          }
          if (changed && dispatch) dispatch(tr);
          return changed;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      F9: ({ editor }) => editor.chain().updateFields().run(),
    };
  },

  addProseMirrorPlugins() {
    return [
      // re-evaluate fields after render (page fields need layout), persist into
      // `cached` attrs — only when a value actually changed, so no loops.
      new Plugin({
        key: new PluginKey("kxFieldEval"),
        view(view) {
          let raf = 0;
          const run = () => {
            const tr = view.state.tr.setMeta("addToHistory", false);
            let changed = false;
            for (const { pos, node } of fieldsInDoc(view.state.doc)) {
              const v = evalField(node.attrs.instr as string, view.state.doc, view, pos);
              if (v !== node.attrs.cached) { tr.setNodeMarkup(pos, undefined, { ...node.attrs, cached: v }); changed = true; }
            }
            if (changed) view.dispatch(tr);
          };
          const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(run); };
          schedule();
          const onResize = () => schedule();
          window.addEventListener("resize", onResize);
          return { update: schedule, destroy() { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); } };
        },
      }),
    ];
  },
});
