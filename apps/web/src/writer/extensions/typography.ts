import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

declare module "@tiptap/core" {
  interface Storage {
    typography: { enabled: boolean };
  }
  interface Commands<ReturnType> {
    typography: {
      toggleTypography: () => ReturnType;
    };
  }
}

const TYPO_KEY = new PluginKey("kxTypography");

/** symbol/substitution rules — evaluated on the char that completes the token */
const SUBS: [RegExp, string][] = [
  [/\.\.\.$/, "…"],
  [/<->$/, "↔"],
  [/\(tm\)$/i, "™"],
  [/\(c\)$/i, "©"],
  [/\(r\)$/i, "®"],
  [/\(e\)$/i, "€"],
  [/->$/, "→"],
  [/<-$/, "←"],
  [/1\/2$/, "½"],
  [/1\/4$/, "¼"],
  [/3\/4$/, "¾"],
  [/<=$/, "≤"],
  [/>=$/, "≥"],
  [/!=$/, "≠"],
  [/\+-$/, "±"],
];

/** common typos — corrected when a word boundary (space/punct) follows */
const AUTOCORRECT: Record<string, string> = {
  teh: "the", adn: "and", hte: "the", taht: "that", thta: "that", waht: "what",
  recieve: "receive", recieved: "received", beleive: "believe", occured: "occurred",
  occurence: "occurrence", neccessary: "necessary", seperate: "separate", definately: "definitely",
  wierd: "weird", untill: "until", becuase: "because", freind: "friend", freinds: "friends",
  acheive: "achieve", acheived: "achieved", whch: "which", thier: "their",
  shoudl: "should", woudl: "would", coudl: "could", abotu: "about",
  ahev: "have", jsut: "just", iwth: "with", wiht: "with", nto: "not", nad: "and",
  adress: "address", ammount: "amount", arguement: "argument", calender: "calendar",
  comming: "coming", concious: "conscious", enviroment: "environment", goverment: "government",
  grammer: "grammar", harrass: "harass", immediatly: "immediately", independant: "independent",
  knowlege: "knowledge", liason: "liaison", maintenence: "maintenance", managment: "management",
  miniscule: "minuscule", mispell: "misspell", noticable: "noticeable", ocassion: "occasion",
  persue: "pursue", posession: "possession", prefered: "preferred", priviledge: "privilege",
  pronounciation: "pronunciation", publically: "publicly", refering: "referring",
  rember: "remember", rythm: "rhythm", sieze: "seize", succesful: "successful",
  supercede: "supersede", suprise: "surprise", tatoo: "tattoo", tendancy: "tendency",
  threshhold: "threshold", tomatos: "tomatoes", truely: "truly", vaccum: "vacuum",
  writting: "writing",
};

const WORD_RE = /[\w'’]+$/;

/**
 * Word-style AutoCorrect + AutoFormat-as-you-type:
 *  - symbol shortcuts (…, —, ©, →, ½, ≤ …)
 *  - smart quotes/apostrophes
 *  - common-typo replacement on word boundary
 *  - sentence-start capitalization + TWo-initial-caps fix
 */
export const Typography = Extension.create({
  name: "typography",

  addStorage() {
    return { enabled: localStorage.getItem("kx.typography") !== "off" };
  },

  addCommands() {
    return {
      toggleTypography:
        () =>
        ({ editor, tr, dispatch }) => {
          editor.storage.typography.enabled = !editor.storage.typography.enabled;
          localStorage.setItem("kx.typography", editor.storage.typography.enabled ? "on" : "off");
          if (dispatch) dispatch(tr.setMeta(TYPO_KEY, true));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const enabled = () => this.editor.storage.typography.enabled;
    return [
      new Plugin({
        key: TYPO_KEY,
        props: {
          handleTextInput(view, from, to, text) {
            if (!enabled()) return false;
            const $from = view.state.doc.resolve(from);
            if (!$from.parent.isTextblock) return false;
            const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");

            // 1. symbol substitutions — the typed char completes the token;
            //    it isn't in the doc yet, so replace [from-(len-1), from)
            if (!/\s/.test(text)) {
              const tail = before + text;
              for (const [re, rep] of SUBS) {
                const m = tail.match(re);
                if (m) {
                  view.dispatch(view.state.tr.insertText(rep, from - m[0].length + text.length, from));
                  return true;
                }
              }
            }

            // 2. smart quotes
            if (text === '"' || text === "'") {
              const last = before.slice(-1);
              const open = !last || /[\s([{<“‘]/.test(last);
              const rep = text === '"' ? (open ? "“" : "”") : (open ? "‘" : "’");
              view.dispatch(view.state.tr.insertText(rep, from, to));
              return true;
            }

            // 3. boundary triggers — space or punctuation ends a word
            if (!/[\s.,;:!?)]/.test(text)) return false;

            // dashes inside the just-ended token → em dash (Word behavior:
            // "a--b " → "a—b ", "a---b " → "a—b "). The boundary char rides
            // inside this transaction and the input is consumed — a separate
            // dispatch would shrink the doc under PM's pending insertion and
            // throw out-of-range.
            const dm = before.match(/(\S*?)(---|--)(\S*)$/);
            if (dm) {
              view.dispatch(view.state.tr.insertText(dm[1] + "—" + dm[3] + text, from - dm[0].length, from));
              return true;
            }

            const wm = before.match(WORD_RE);
            if (wm) {
              const word = wm[0];
              const lower = word.toLowerCase();
              if (lower in AUTOCORRECT) {
                const fixed = AUTOCORRECT[lower];
                const cased = word[0] === word[0].toUpperCase()
                  ? fixed[0].toUpperCase() + fixed.slice(1)
                  : fixed;
                // replacement may change length → fold the boundary char in
                view.dispatch(view.state.tr.insertText(cased + text, from - word.length, from));
                return true;
              }
              // TWo initial capitals → normal (Word-style; 4+ chars, not all-caps)
              if (word.length > 3 && /^[A-Z]{2}[a-z]/.test(word)) {
                const fixed = word[0] + word.slice(1).toLowerCase();
                view.dispatch(view.state.tr.insertText(fixed, from - word.length, from));
                return false;
              }
            }

            // 4. capitalize after sentence end: "... end. next" → "Next"
            const sm = before.match(/[.!?]["'’)\]]*\s+([a-z])[\w'’]*$/);
            if (sm) {
              view.dispatch(view.state.tr.insertText(
                sm[1].toUpperCase(), from - sm[0].length, from - sm[0].length + 1,
              ));
              return false;
            }
            return false;
          },
        },
      }),
    ];
  },
});
