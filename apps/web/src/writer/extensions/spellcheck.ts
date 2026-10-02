import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { checkWord, addToDict, ensureDictionary, dictionaryPending, type Miss } from "../proofing";

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
  // the real dictionary is still loading — flagging now would squiggle
  // legitimate words the hunspell pass is about to clear
  if (dictionaryPending()) return [];
  const out: Miss[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    scanNode(node, pos, ignored, out);
    return true;
  });
  return out;
}

function scanNode(node: PMNode, pos: number, ignored: Set<string>, out: Miss[]) {
  if (!node.isText || !node.text) return;
  for (const m of node.text.matchAll(/[A-Za-z][A-Za-z'’-]*/g)) {
    const w = m[0];
    if (ignored.has(w.toLowerCase())) continue;
    if (!checkWord(w)) out.push({ word: w, from: pos + (m.index ?? 0), to: pos + (m.index ?? 0) + w.length });
  }
}

/** Red-squiggle decorations for words not in core vocab + custom dict + doc vocab. */
export const Spellcheck = Extension.create({
  name: "spellcheck",

  addStorage() {
    return { enabled: true, ignored: new Set<string>() };
  },

  onCreate() {
    // warm the real dictionary in the background; refresh decorations once it
    // lands so fallback-flagged words get re-evaluated
    void ensureDictionary().then(() => {
      if (!this.editor.isDestroyed)
        this.editor.view.dispatch(this.editor.state.tr.setMeta("kxSpellForce", true));
    });
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
            if (tr.getMeta("kxSpellForce"))
              return enabled() ? computeMisses(tr.doc, ignored()) : [];
            if (!tr.docChanged) return cur;
            if (!enabled()) return [];

            // incremental: remap misses through the transaction, then rescan
            // only the textblocks the edit touched — a full-doc descent per
            // keystroke was the dominant typing cost on long documents
            const mapped = cur
              .map((m) => ({ word: m.word, from: tr.mapping.map(m.from), to: tr.mapping.map(m.to) }))
              .filter((m) => m.from < m.to && m.to <= tr.doc.content.size);

            // changed ranges, expressed in the final doc's coordinates
            const ranges: [number, number][] = [];
            tr.steps.forEach((step, i) => {
              step.getMap().forEach((_oS, _oE, nS, nE) => {
                let a = nS, b = nE;
                for (let j = i + 1; j < tr.steps.length; j++) {
                  const sm = tr.steps[j].getMap();
                  a = sm.map(a, -1);
                  b = sm.map(b, 1);
                }
                ranges.push([a, b]);
              });
            });
            if (!ranges.length) return mapped;

            // expand each range to its enclosing textblock bounds
            const docSize = tr.doc.content.size;
            const spans: [number, number][] = [];
            for (const [a, b] of ranges) {
              try {
                const $a = tr.doc.resolve(Math.max(0, Math.min(a, docSize - 1)));
                const $b = tr.doc.resolve(Math.max(0, Math.min(Math.max(b, a), docSize - 1)));
                const from = $a.depth ? $a.start() : 0;
                const to = $b.depth ? $b.end() : docSize;
                spans.push([from, to]);
              } catch { spans.push([a, b]); }
            }

            const ig = ignored();
            const kept = mapped.filter((m) => !spans.some(([s, e]) => m.from < e && m.to > s));
            const added: Miss[] = [];
            for (const [s, e] of spans) {
              tr.doc.nodesBetween(s, e, (node, pos) => {
                scanNode(node, pos, ig, added);
                return true;
              });
            }
            return kept.concat(added);
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
