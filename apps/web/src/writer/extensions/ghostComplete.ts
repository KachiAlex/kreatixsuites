// Ghost-text completion — a ProseMirror widget decoration renders the AI
// suggestion inline at the caret (grey, non-editable). Tab accepts, Esc or
// any edit dismisses. The suggestion itself is fetched by the editor's
// debounced update handler and set via setGhost().
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/core";

export interface GhostState { pos: number; text: string }

export const ghostKey = new PluginKey<GhostState | null>("ghostComplete");

export const GhostComplete = Extension.create({
  name: "ghostComplete",

  addProseMirrorPlugins() {
    return [
      new Plugin<GhostState | null>({
        key: ghostKey,
        state: {
          init: () => null,
          apply(tr, val) {
            const meta = tr.getMeta(ghostKey);
            if (meta !== undefined) return meta as GhostState | null;
            if (!val) return null;
            if (tr.docChanged) return null; // any edit dismisses
            return { pos: tr.mapping.map(val.pos), text: val.text };
          },
        },
        props: {
          decorations(state) {
            const s = ghostKey.getState(state);
            if (!s) return null;
            const span = document.createElement("span");
            span.className = "kx-ghost";
            span.textContent = s.text;
            span.title = "Tab to accept · Esc to dismiss";
            return DecorationSet.create(state.doc, [
              Decoration.widget(s.pos, span, { side: 1, key: "kx-ghost" }),
            ]);
          },
          handleKeyDown(view, e) {
            const s = ghostKey.getState(view.state);
            if (!s) return false;
            if (e.key === "Tab") {
              e.preventDefault();
              view.dispatch(view.state.tr.insertText(` ${s.text}`, s.pos).setMeta(ghostKey, null).scrollIntoView());
              return true;
            }
            if (e.key === "Escape") {
              view.dispatch(view.state.tr.setMeta(ghostKey, null));
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});

export function setGhost(editor: Editor, pos: number, text: string) {
  editor.view.dispatch(editor.state.tr.setMeta(ghostKey, { pos, text } satisfies GhostState));
}

export function clearGhost(editor: Editor) {
  editor.view.dispatch(editor.state.tr.setMeta(ghostKey, null));
}
