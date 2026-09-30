import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { measureBands, bandIndexAt } from "../banding";
import { pageOfPos } from "./field";
import { fmtN } from "./extras";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    footnote: {
      /** Insert a numbered footnote reference; `note` is the footnote text. */
      insertFootnote: (note: string) => ReturnType;
      /** Insert an endnote — numbered separately, collected at document end. */
      insertEndnote: (note: string) => ReturnType;
      /** Update the text of the footnote ref at the current selection. */
      updateFootnote: (note: string) => ReturnType;
    };
  }
}

interface NoteOcc { pos: number; note: string; kind: string }

function notesIn(doc: PMNode, kind: string): NoteOcc[] {
  const out: NoteOcc[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "footnote" && (node.attrs.kind ?? "footnote") === kind) {
      out.push({ pos, note: node.attrs.note as string, kind });
    }
    return true;
  });
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface NotesState {
  fnByBand: Map<number, { n: string; note: string }[]>;
  end: { n: string; note: string }[];
  bandEnds: number[];
}
const NOTES_KEY = new PluginKey<NotesState>("kxNotes");

/** Inline footnote/endnote reference — numbered via CSS counters (per kind),
 *  note text in attrs. Page-bottom/end-of-doc rendering by the plugin below. */
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
      kind: {
        default: "footnote", // "footnote" | "endnote"
        parseHTML: (el) => el.getAttribute("data-kind") ?? "footnote",
        renderHTML: (attrs) => ({ "data-kind": attrs.kind }),
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
          commands.insertContent({ type: this.name, attrs: { note, kind: "footnote" } }),
      insertEndnote:
        (note) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { note, kind: "endnote" } }),
      updateFootnote:
        (note) =>
        ({ commands, state }) => {
          const node = (state.selection as { node?: { type: { name: string } } }).node;
          if (node?.type.name !== this.name) return false;
          return commands.updateAttributes(this.name, { note });
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      // Footnote areas at the bottom of each page band + endnotes at doc end.
      // Rendered as block widgets (PM-owned DOM — no mutation fights).
      new Plugin({
        key: NOTES_KEY,
        state: {
          init: (): NotesState => ({ fnByBand: new Map(), end: [], bandEnds: [] }),
          apply: (tr, v) => (tr.getMeta(NOTES_KEY) as NotesState | undefined) ?? v,
        },
        props: {
          decorations(state) {
            const st = NOTES_KEY.getState(state) ?? { fnByBand: new Map<number, { n: string; note: string }[]>(), end: [], bandEnds: [] };
            const decos: Decoration[] = [];
            for (const [band, notes] of st.fnByBand) {
              const pos = st.bandEnds[band];
              if (pos == null) continue;
              const html = `<div class="kx-fn-rule"></div>` + notes.map((x) =>
                `<div class="kx-fn-line"><sup>${x.n}</sup> ${esc(x.note)}</div>`).join("");
              decos.push(Decoration.widget(pos, () => {
                const d = document.createElement("div");
                d.className = "kx-fn-area";
                d.contentEditable = "false";
                d.innerHTML = html;
                return d;
              }, { side: -1, key: `fn-${band}` }));
            }
            if (st.end.length) {
              const html = `<div class="kx-fn-rule kx-en-rule"></div>` + st.end.map((x) =>
                `<div class="kx-fn-line"><sup>${x.n}</sup> ${esc(x.note)}</div>`).join("");
              decos.push(Decoration.widget(state.doc.content.size, () => {
                const d = document.createElement("div");
                d.className = "kx-fn-area kx-en-area";
                d.contentEditable = "false";
                d.innerHTML = html;
                return d;
              }, { side: -1, key: "endnotes" }));
            }
            return decos.length ? DecorationSet.create(state.doc, decos) : null;
          },
        },
        view(view) {
          let raf = 0;
          let lastSig = "";
          let prevSig = "";
          const run = () => {
            const root = view.dom as HTMLElement;
            const bands = measureBands(root);
            const fn = notesIn(view.state.doc, "footnote");
            const en = notesIn(view.state.doc, "endnote");
            const fFmt = root.dataset.fnfmt ?? "decimal";
            const eFmt = root.dataset.enfmt ?? "lower-roman";
            const restart = root.dataset.fnrestart === "1";
            const fnByBand = new Map<number, { n: string; note: string }[]>();
            const bandEnds: number[] = [];
            if (bands) {
              // page band of each footnote (restart optionally renumbers per page)
              const perBand = new Map<number, number>();
              fn.forEach((f, i) => {
                const p = pageOfPos(view, f.pos);
                const band = (p ?? 1) - 1;
                const arr = fnByBand.get(band) ?? [];
                const n = restart ? (perBand.get(band) ?? 0) + 1 : i + 1;
                perBand.set(band, n);
                arr.push({ n: fmtN(n, fFmt), note: f.note });
                fnByBand.set(band, arr);
              });
              // last textblock end per band → widget anchor
              const rootTop = root.getBoundingClientRect().top;
              view.state.doc.descendants((node, pos) => {
                if (!node.isTextblock) return true;
                if (view.state.doc.resolve(pos).depth > 0) return true;
                try {
                  const y = view.coordsAtPos(pos).top - rootTop;
                  const band = bandIndexAt(bands, y);
                  bandEnds[band] = pos + node.nodeSize;
                } catch { /* unrendered */ }
                return true;
              });
            }
            const end = en.map((e, i) => ({ n: fmtN(i + 1, eFmt), note: e.note }));
            const sig = JSON.stringify({
              f: [...fnByBand.entries()], e: end, b: bandEnds.filter((x) => x != null),
            });
            // oscillation guard: if the layout ping-pongs between two sigs, stop
            if (sig === prevSig) { lastSig = sig; return; }
            prevSig = lastSig; lastSig = sig;
            const cur = NOTES_KEY.getState(view.state);
            const curSig = JSON.stringify({ f: [...(cur?.fnByBand.entries() ?? [])], e: cur?.end ?? [], b: (cur?.bandEnds ?? []).filter((x) => x != null) });
            if (curSig !== sig) {
              view.dispatch(view.state.tr.setMeta(NOTES_KEY, { fnByBand, end, bandEnds }).setMeta("addToHistory", false));
            }
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
