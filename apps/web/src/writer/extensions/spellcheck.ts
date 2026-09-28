import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { checkWord, addToDict, type Miss } from "../proofing";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    spellcheck: {
      /** Enable/disable inline spellcheck decorations. */
      toggleSpellcheck: () => ReturnType;
      /** Session-ignore every occurrence of `word`. */
      ignoreWord: (word: string) => ReturnType;
      /** Add `word` to the custom dictionary. */
      learnWord: (word: string) => ReturnType;
    };
  }
  interface Storage {
    spellcheck: { enabled: boolean; ignored: Set<string> };
  }
}

export const SPELL_KEY = new PluginKey<Miss[]>("kxSpell");

function computeMisses(doc: PMNode, ignored: Set<string>): Miss[] {
  const out: Miss[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    for (const m of node.text.matchAll(/[A-Za-z][A-Za-z'’-]*/g)) {
      const w = m[0];
      if (ignored.has(w.toLowerCase())) continue;
      if (!checkWord(w)) out.push({ word: w, from: pos + (m.index ?? 0), to: pos + (m.index ?? 0) + w.length });
    }
    return true;
  });
  return out;
}

/** Red-squiggle decorations for words not in core vocab + custom dict + doc vocab. */
export const Spellcheck = Extension.create({
  name: "spellcheck",

  addStorage() {
    return { enabled: true, ignored: new Set<string>() };
  },

  addCommands() {
    return {
      toggleSpellcheck:
        () =>
        ({ editor, tr, dispatch }) => {
          editor.storage.spellcheck.enabled = !editor.storage.spellcheck.enabled;
          if (dispatch) dispatch(tr.setMeta("kxSpellForce", true));
          return true;
        },
      ignoreWord:
        (word) =>
        ({ editor, tr, dispatch }) => {
          editor.storage.spellcheck.ignored.add(word.toLowerCase());
          if (dispatch) dispatch(tr.setMeta("kxSpellForce", true));
          return true;
        },
      learnWord:
        (word) =>
        ({ tr, dispatch }) => {
          addToDict(word);
          if (dispatch) dispatch(tr.setMeta("kxSpellForce", true));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const ignored = () => this.editor.storage.spellcheck.ignored;
    const enabled = () => this.editor.storage.spellcheck.enabled;
    return [
      new Plugin({
        key: SPELL_KEY,
        state: {
          init: () => [] as Miss[],
          apply(tr, cur) {
            // recompute on doc change or forced refresh; positions map through tr
            const mapped = tr.docChanged ? cur.map((m) => ({ word: m.word, from: tr.mapping.map(m.from), to: tr.mapping.map(m.to) })) : cur;
            if (tr.docChanged || tr.getMeta("kxSpellForce")) {
              return enabled() ? computeMisses(tr.doc, ignored()) : [];
            }
            return mapped;
          },
        },
        props: {
          decorations(state) {
            const misses = SPELL_KEY.getState(state) ?? [];
            if (!misses.length) return null;
            return DecorationSet.create(state.doc, misses
              .filter((m) => m.from < m.to && m.to <= state.doc.content.size)
              .map((m) => Decoration.inline(m.from, m.to, { class: "kx-spell", "data-word": m.word })));
          },
        },
      }),
    ];
  },
});
