// Proofing layer: lightweight spell engine, thesaurus, readability, a11y checks.
// Offline-first — no network lookups. The dictionary is a lazily-loaded hunspell
// en_US (~50k stems + affix rules); until it arrives a baked-in core vocabulary,
// morphology expansion, and the user's custom dictionary (localStorage) act as
// the fallback.
import type { Spell } from "nspell";

const CORE_WORDS = new Set((
  // supplemental common words not in the base list
  "mat hat sat rat bat pat fat cat hat map tap gap lap nap sap rap war jar car far bar tar par mar oar ear fear gear near pear tear wear year dear hear bear clear able did done its going without later something asked rain plan star paint pose distant stead equate multiply numeral verb i its it did doing goes gone went come came coming run ran running sit sat sitting mat mats hat hats dog cats dogs pets bed beds leg legs arm arms cup cups mug mugs fan fans van vans man men woman women kid kids toy toys sun moon sky sea bay fog ice snow wind storm leaf leaves tree trees bush grass seed root vine rose lily pine oak elm ash mud dirt sand rock stone hill lake pond pool path road lane wall gate door roof room hall step stair floor wall shop mall bank park farm barn crop crop seed meat fish egg milk rice corn bean soup salt sugar oil tea coffee juice bread cake pie soup bowl dish pan pot cup fork spoon knife plate table desk chair lamp light fan door bed room bath sink soap towel comb brush clock watch radio phone screen key lock card mail box bag pack pen pencil ink page note card list file tape glue clip pin nail hook wire rope cord tube tank sink bath wash soap foam shampoo razor blade tooth teeth tongue lip chin cheek brow jaw neck chest waist hip knee shin ankle heel toe nail skin bone joint rib spine skull brain heart lung liver blood vein nerve cell germ virus drug pill dose cure pain ache fever cold flu cough sneeze breath sigh yawn smile laugh cry tear weep sob moan groan yell shout scream whisper hum sing song tune beat drum bell ring tone note chord band choir dance step jump leap hop skip run walk crawl climb swim dive float sink sail row boat ship dock port wave tide surf foam sand shell crab fish whale shark seal duck goose hen chick pig cow bull calf horse foal sheep lamb goat deer bear wolf fox lion tiger cat dog rat mouse bat ant bee fly bug worm snail frog toad snake bird owl crow dove swan eagle hawk nest egg wing beak tail claw fur hide horn hoof mane trunk tusk horn winter spring summer fall autumn season month week day night dawn dusk noon clock time year date past now soon early late fast slow quick rapid swift calm still quiet loud soft hard rough smooth sharp dull flat round square oval long short wide narrow thin thick tall high low deep shallow big small huge tiny vast mini giant micro hot warm cool cold icy warm mild wet dry damp moist clean dirty neat messy tidy bright dim dark light pale vivid dull bold plain fancy simple plain grand royal noble proud meek mild wild tame calm fierce cruel kind nice mean rude polite sweet sour bitter salty spicy fresh stale ripe raw rotten moldy clean new old young aged ancient modern recent early late first last next final next prior each all both few many much more most some any none few less least more most half whole part piece bit slice chunk share total sum rest other same such very too quite just only even also still yet again once twice thrice often seldom rarely always never maybe perhaps sure real true false actual plain mere pure full empty bare void rich poor weak strong brave bold shy timid eager calm glad sad mad bad good nice fine fair just right wrong true false sure legal moral civil public private common rare usual normal odd weird strange queer funny silly smart wise dull dumb clever bright keen sharp blunt vague exact strict loose tight firm solid fluid liquid gas vapor steam smoke ash dust dirt grime rust mold rot decay growth birth death life fate luck chance risk odds truth lie fact myth tale story plot scene act play game sport fun joy glee bliss peace rest sleep dream nap wake watch guard warn alert alarm shock dread fear hope wish want need lack have hold keep lose find seek hunt chase catch grab seize grip drop toss throw hurl fling push pull drag lift raise lower bend fold twist turn spin whirl roll slide slip trip fall dive leap jump hop skip march pace step stride roam rove hike trek tour trip visit stay dwell live hide lurk sneak creep crawl slip slide glide float drift sail swim dive surf row paddle kick hit punch slap smack swat beat pound tap rap knock bang slam crash smash crush grind mash chop slice dice mince peel core seed stem leaf root bark wood trunk limb twig sap pine oak elm ash fir palm rose lily iris tulip daisy fern moss vine weed seed pod hull husk rind skin pulp juice milk cream butter cheese bread loaf roll bun crumb crust dough flour wheat rye oats bran meal meat beef pork ham bacon lamb veal fish trout bass cod tuna crab clam shrimp beef stew soup broth sauce gravy spice herb salt sugar honey jam jelly syrup candy gum mint cola soda pop beer wine ale rum gin tea coffee cocoa juice milk water ice cream pie cake tart bun roll loaf slice wedge block bar slab sheet strip band tape wire cord rope chain link ring hook nail screw bolt nut gear wheel axle lever pulley ramp slope hill peak vale dale glen cave den nest web net trap bait lure hook line rod reel oar sail mast hull deck bow stern port keel helm crew mate hand ship boat raft canoe kayak yacht barge tug sub jet ski plane jet wing tail fin flap gear brake tire wheel rim hub cap door hood trunk seat belt dash horn light wiper road lane path trail track route map tour trek trip ride drive walk run jog bike bus car van truck taxi cab train rail tram tube jet boat ship sub base camp tent hut shed barn mill plant site yard lot park zone area spot point site seat rank post role task job work duty chore labor toil effort feat deed act play game toy doll kite ball bat net goal score team club gang band crew staff host guest user buyer seller maker owner agent aide boss chief head lead peer rival foe ally fan buff pro ace star hero idol champ pro vet tyro scam hoax con fraud theft crime sin vice law rule code pact deal term oath vow word name tag sign mark note card list memo mail post fax call ring tone dial chat text site page blog post link file data bit byte disk chip port plug jack slot tray dock cord wire cable fuse bulb lamp tube beam ray glow spark flash flame fire heat coal oil gas fuel wood log stick twig straw hay grass lawn yard gate fence wall door lock key bolt latch knob hinge frame pane glass sill beam joist stud plank board tile brick stone rock sand clay mud dirt dust soot ash mold rust nail tack pin clip staple tape glue paste gum wax soap foam suds lather rinse wash wipe scrub sweep mop dust broom brush pail pan pot lid jar jug cup mug bowl dish tray rack shelf hook peg nail coat hat cap sock shoe boot lace belt tie vest suit coat gown robe slip bra pant sock hose glove scarf shawl wrap cloak cape hood veil mask crown ring gem jewel bead chain charm locket watch purse bag sack pack box case crate trunk bin tub can jar jug pot pan lid cap top lid tag tab flap fold pleat seam hem cuff hem dart slit slot hole pit gap dent nick chip crack split tear rip cut gash stab jab poke prod push shove nudge bump thump rap tap pat rub scrub brush comb pick pull tug yank jerk snap crack pop bang boom roar rumble crash clash clang clink chime ding dong peal toll hum buzz whir hiss fizz pop snap crack sizzle slosh splash drip drop leak seep ooze flow pour spill drip trickle gush jet spray mist fog haze smog smoke fume odor scent smell whiff sniff snort gasp pant puff blow suck sip gulp swig bite chew gnaw nibble munch crunch grind mash pulp puree blend mix stir whip beat fold knead roll press pat mold shape form cut trim snip clip shear shave pare peel core pit seed husk hull shell skin rind peel flesh pulp juice sap gum resin tar pitch wax oil lard fat grease lube slick slime mud muck ooze slush sleet hail frost ice snow rain mist dew fog haze smog cloud sky sun moon star comet meteor nova orbit space void dark light dawn dusk day night eve morn noon week month year era age eon past now next soon late early fast slow quick swift rapid hasty brisk spry agile nimble deft apt able fit apt prone bound sure set apt due owed own self same such both each all any some none few many much more most less least half whole part rest last next first then once twice often yet still even also just only very too quite rather quite pretty fairly fairly " +
  // core English vocabulary — common function words, verbs, nouns, adjectives
  "a about above across act action add after again against age ago agree air all allow almost alone along already also although always am among an and angle animal answer any appear apple are area arm around art as ask at atom away baby back bad ball band bank bar base basic be bear beat beauty became because become bed been before began begin behind believe bell belong below best better between big bird bit black block blood blow blue board boat body bone book born both bottom bought box boy branch bread break bright bring broad broke broken brother brought brown build burn bus busy but buy by call came can capital car care carry case cat catch caught cause cell cent center century certain chair chance change character charge check child children choose circle city claim class clean clear climb clock close clothes cloud coast coat cold collect colony color come common company compare complete condition connect consider contain continent continue control cook cool copy corn corner correct cost cotton could count country course cover cow create crop cross crowd cry current cut dad dance dark day dead deal dear death decide decimal deep describe desert design determine develop dictionary die differ direct discuss distance divide do doctor dog dollar done door double down draw dream dress drive drop dry during each early earth ease east eat edge effect eight either electric else end energy engine enjoy enough enter equal even evening event ever every exact example except exercise expect experience explain eye face fact fair fall family famous far farm fast father favor fear feel feet fell felt few field fig fight figure fill final find fine finger finish fire first fish five flat floor flow flower fly follow food foot for force forest form forward found four free fresh friend from front fruit full fun game garden gas gave general get girl give glad glass go gold gone good got govern grass great green grew ground group grow guess guide had hair half hand happen happy hard has hat have he head hear heard heart heat heavy held help her here high hill him his history hit hold hole home hope horse hot hour house how huge human hundred hunt idea if imagine important in inch include indicate industry insect instead instrument interest into invent iron is island it job join joy jump just keep kept key kill kind king knew know lady land language large last late laugh law lay lead learn least leave left leg length less let letter level lie life lift light like line list listen little live log long look lost lot loud love low machine made main major make man many map mark market master match matter may me mean meant measure meat meet melody men metal method middle might mile milk million mind mine minute miss modern molecule moment money month moon more morning most mother mountain mouth move much music must my name nation natural nature near necessary neck need neighbor never new next night nine no noise none noon nor north nose not note nothing notice noun now number object observe ocean of off office often oh old on once one only open operate opposite or order other our out over own page pair paper paragraph parent part party pass past pattern pay people perhaps period person phrase pick picture piece place plain plane planet plant play please plural poem point poor position possible pound power practice prepare present press pretty print problem produce product promise proper prove provide pull push put quarter question quick quiet quite race radio raise ran range rather reach read ready real reason receive record red region remember reply report represent rest result rich ride right ring rise river road rock roll room root round row rule run safe said salt same sat save saw say scale school science sea seat second section seed seem seen segment self sell send sense sentence separate serve set settle seven several shape share sharp she sheet ship shoe shop short should shoulder show side sight sign similar simple since sing single sister sit six size skill skin sky sleep slow small smell smile snow so soft soil soldier solve some son song soon sound south space speak special speed spell spend spring square stand start state stay steel step still stone stood stop store story straight strange stream street strong student study subject substance such sudden sugar suggest suit summer sun supply support suppose sure surface syllable system table tail take talk tall teach team tell ten term test than thank that the their them then there these they thick thing think third this those though thought thousand three through thus time tiny tire to together told tone took tool top total touch toward town track trade train travel tree triangle trip trouble truck true try turn twenty two type under unit until up us use usual valley value various very view village visit voice vowel wait walk wall want war warm was watch water wave way we wear weather week weight well went were west wet what wheel when where whether which while white who whole whose why wide wife wild will win wind window wing winter wire wish with within woman women wonder wood word work world would write written wrong wrote yard year yellow yes yet you young your"
).split(/\s+/));

// morphological forms — expand a stem into inflections
const MORPH_SUFFIXES = ["s", "es", "ed", "d", "ing", "ly", "er", "ers", "est", "n't", "'s", "ies", "ied", "ier", "iest", "ness", "ment", "ments", "ful", "less", "nesses", "ally", "tion", "tions", "y", "e"];

const DICT_KEY = "kreatix.customDict";
let customDict: Set<string> | null = null;
export function getCustomDict(): Set<string> {
  if (!customDict) {
    try { customDict = new Set(JSON.parse(localStorage.getItem(DICT_KEY) ?? "[]") as string[]); }
    catch { customDict = new Set(); }
  }
  return customDict;
}
export function addToDict(word: string) {
  const d = getCustomDict();
  d.add(word.toLowerCase());
  customDict = d;
  spell?.add(word.toLowerCase());
  localStorage.setItem(DICT_KEY, JSON.stringify([...d]));
}

// ---- spellcheck dictionary ----
// Real hunspell dictionaries (vendored under dict-*/) are lazily loaded so the
// writer chunk doesn't carry them. Until one resolves the CORE_WORDS +
// morphology rules act as the fallback; test harnesses can inject the
// dictionary directly via loadDictionary().
let spell: Spell | null = null;
let dictState: "idle" | "loading" | "ready" | "failed" = "idle";
let dictPromise: Promise<void> | null = null;

export const PROOF_LANGS = [
  { tag: "en-US", label: "English (US)" },
  { tag: "de-DE", label: "Deutsch" },
  { tag: "es-ES", label: "Español" },
  { tag: "fr-FR", label: "Français" },
  { tag: "pt-PT", label: "Português" },
] as const;
export type ProofLang = (typeof PROOF_LANGS)[number]["tag"];

const DICT_LOADERS: Record<ProofLang, () => Promise<[string, string]>> = {
  "en-US": async () => [
    (await import("./dict-en/en_US.aff?raw")).default,
    (await import("./dict-en/en_US.dic?raw")).default,
  ],
  "de-DE": async () => [
    (await import("./dict-de/index.aff?raw")).default,
    (await import("./dict-de/index.dic?raw")).default,
  ],
  "es-ES": async () => [
    (await import("./dict-es/index.aff?raw")).default,
    (await import("./dict-es/index.dic?raw")).default,
  ],
  "fr-FR": async () => [
    (await import("./dict-fr/index.aff?raw")).default,
    (await import("./dict-fr/index.dic?raw")).default,
  ],
  "pt-PT": async () => [
    (await import("./dict-pt/index.aff?raw")).default,
    (await import("./dict-pt/index.dic?raw")).default,
  ],
};

const LANG_KEY = "kreatix.proofLang";
let dictLang: ProofLang | null = null;

/** Active proofing language: persisted choice → navigator.language → en-US. */
export function proofingLanguage(): ProofLang {
  if (!dictLang) {
    const saved = localStorage.getItem(LANG_KEY) as ProofLang | null;
    if (saved && saved in DICT_LOADERS) dictLang = saved;
    else {
      const nav = (typeof navigator !== "undefined" ? navigator.language : "") || "";
      dictLang = (Object.keys(DICT_LOADERS) as ProofLang[])
        .find((t) => nav.toLowerCase().startsWith(t.slice(0, 2))) ?? "en-US";
    }
  }
  return dictLang;
}

/** True while the hunspell dictionary is still being fetched/parsed —
 *  callers can suppress decorations rather than flash false squiggles. */
export const dictionaryPending = () => dictState === "loading";

export async function loadDictionary(aff: string | Uint8Array, dic: string | Uint8Array): Promise<void> {
  const nspell = (await import("nspell")).default;
  spell = nspell(aff, dic);
  for (const w of getCustomDict()) spell.add(w);
  dictState = "ready";
}

/** Switch proofing language — persists the choice and (re)loads the dict. */
export async function setProofingLanguage(tag: ProofLang): Promise<void> {
  dictLang = tag;
  localStorage.setItem(LANG_KEY, tag);
  dictState = "loading";
  dictPromise = null;
  dictPromise = loadDictionaryFor(tag).catch(() => { dictState = "failed"; });
  await dictPromise;
}

function loadDictionaryFor(tag: ProofLang): Promise<void> {
  return DICT_LOADERS[tag]().then(([a, d]) => loadDictionary(a, d));
}

export function ensureDictionary(): Promise<void> {
  if (dictState === "idle") {
    dictState = "loading";
    dictPromise = loadDictionaryFor(proofingLanguage())
      .catch(() => { dictState = "failed"; });
  }
  return dictPromise ?? Promise.resolve();
}

const VOWELISH = /[aeiou]/;
const isWord = (w: string) => /^[\p{L}\p{M}][\p{L}\p{M}'’-]*$/u.test(w);

/** Is this word acceptable? Checks the core vocabulary, morphology-derived
 *  forms, and the user's custom dictionary. Capitalized words pass (proper
 *  nouns); all-caps acronyms pass; everything else must be a real word. */
export function checkWord(word: string): boolean {
  if (!isWord(word)) return true;                     // numbers/symbols
  if (word.length <= 2) return true;                  // I, an, TV…
  const lower = word.toLowerCase();
  if (getCustomDict().has(lower)) return true;
  if (spell) {
    // hunspell: checks the word + affix expansions (~150k forms)
    if (spell.correct(word) || spell.correct(lower)) return true;
    if (word === word.toUpperCase()) return true;      // acronyms: NASA, FAQ
    if (/^[A-Z]/.test(word)) return true;              // proper nouns pass
    return false;
  }
  if (CORE_WORDS.has(lower)) return true;
  // morphology: strip a suffix and re-check
  for (const suf of MORPH_SUFFIXES) {
    if (lower.endsWith(suf) && lower.length - suf.length >= 3) {
      const stem = lower.slice(0, -suf.length);
      if (CORE_WORDS.has(stem) || getCustomDict().has(stem)) return true;
      // handle e-drop: "make"+"ing" → "mak" → try stem+"e"
      if ((suf === "ing" || suf === "ed" || suf === "er" || suf === "est") && CORE_WORDS.has(stem + "e")) return true;
      // doubling: "run"+"ning" → "runn" → strip last char
      if ((suf === "ing" || suf === "ed" || suf === "er" || suf === "est") && stem.length > 3 && stem[stem.length - 1] === stem[stem.length - 2] && CORE_WORDS.has(stem.slice(0, -1))) return true;
      // y→i: "happy"+"ness" → "happi" → stem→y
      if ((suf === "ness" || suf === "ly" || suf === "ies" || suf === "ied" || suf === "ier" || suf === "iest") && CORE_WORDS.has(stem.slice(0, -1) + "y")) return true;
    }
  }
  if (word === word.toUpperCase() && !/[a-z]/.test(word)) return true; // acronyms: NASA, FAQ
  if (/^[A-Z]/.test(word) && !VOWELISH.test(lower)) return true;         // consonant-heavy capitals: Mrs., Dr., Ltd
  if (/^[A-Z]/.test(word)) return true;                                 // proper nouns pass
  return false;
}

/** Vocabulary for SUGGESTIONS: core words + custom dict + doc words (doc words
 *  are fine as suggestion sources — a typo can still match a real in-doc word). */
export function docVocabulary(text: string): Set<string> {
  const s = new Set<string>();
  // only words that pass the spellcheck may feed suggestions — anything else
  // would produce "corrections" the checker immediately re-flags
  for (const m of text.matchAll(/[\p{L}\p{M}][\p{L}\p{M}'’-]+/gu)) if (checkWord(m[0])) s.add(m[0].toLowerCase());
  for (const w of CORE_WORDS) s.add(w);
  for (const w of getCustomDict()) s.add(w);
  return s;
}

// edits-distance-1/2 suggestion generation against known vocabulary
export function suggest(word: string, vocab: Set<string>, max = 6): string[] {
  if (spell) {
    const s = spell.suggest(word).filter((x) => checkWord(x));
    if (s.length) return s.slice(0, max);
  }
  const w = word.toLowerCase();
  const out = new Set<string>();
  const letters = "abcdefghijklmnopqrstuvwxyz";
  // transpositions + deletions + insertions + substitutions (distance 1)
  for (let i = 0; i < w.length; i++) {
    if (vocab.has(w.slice(0, i) + w.slice(i + 1))) out.add(w.slice(0, i) + w.slice(i + 1));
    if (i + 1 < w.length) {
      const t = w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);
      if (vocab.has(t)) out.add(t);
    }
    for (const c of letters) {
      const sub = w.slice(0, i) + c + w.slice(i + 1);
      if (vocab.has(sub)) out.add(sub);
    }
  }
  for (let i = 0; i <= w.length; i++) {
    for (const c of letters) {
      const ins = w.slice(0, i) + c + w.slice(i);
      if (vocab.has(ins)) out.add(ins);
      if (out.size >= max * 3) break;
    }
    if (out.size >= max * 3) break;
  }
  // second pass for tougher typos
  if (out.size < 2) {
    const once = [...out];
    for (const cand of once) {
      for (const s of suggest(cand, vocab, 4)) out.add(s);
      if (out.size >= max * 3) break;
    }
  }
  // rank by length similarity then alphabetically; only offer words the
  // checker itself accepts so a picked suggestion can't stay squiggled
  return [...out].filter((c) => checkWord(c))
    .sort((a, b) => Math.abs(a.length - w.length) - Math.abs(b.length - w.length) || a.localeCompare(b)).slice(0, max);
}

/** Spell-check a text range — returns misspellings with positions. */
export interface Miss { word: string; from: number; to: number }
export function spellcheckText(text: string, basePos: number): Miss[] {
  const out: Miss[] = [];
  for (const m of text.matchAll(/[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu)) {
    const w = m[0];
    if (!checkWord(w)) out.push({ word: w, from: basePos + (m.index ?? 0), to: basePos + (m.index ?? 0) + w.length });
  }
  return out;
}

// ---- readability (Flesch-Kincaid + extras) ----
export interface Readability {
  words: number; sentences: number; syllables: number;
  fleschEase: number; fkGrade: number;
  avgSentenceLen: number; avgSyllablesPerWord: number;
  longWords: number; // 3+ syllables
}
function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]e|ed|es)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}
export function readability(text: string): Readability {
  const words = (text.match(/[\p{L}\p{M}'’-]+/gu) ?? []).filter((w) => /[\p{L}]/u.test(w));
  const sentences = Math.max(1, (text.match(/[.!?]+(\s|$)/g) ?? []).length || 1);
  let syl = 0, long = 0;
  for (const w of words) { const s = syllables(w); syl += s; if (s >= 3) long++; }
  const W = Math.max(1, words.length);
  const S = sentences;
  const fleschEase = 206.835 - 1.015 * (W / S) - 84.6 * (syl / W);
  const fkGrade = 0.39 * (W / S) + 11.8 * (syl / W) - 15.59;
  return {
    words: W, sentences: S, syllables: syl,
    fleschEase: Math.round(Math.max(0, Math.min(100, fleschEase)) * 10) / 10,
    fkGrade: Math.round(Math.max(0, fkGrade) * 10) / 10,
    avgSentenceLen: Math.round((W / S) * 10) / 10,
    avgSyllablesPerWord: Math.round((syl / W) * 100) / 100,
    longWords: long,
  };
}

// ---- accessibility checks ----
export interface A11yIssue { kind: string; detail: string; pos?: number }
/** `doc` is any node-walkable PM doc (duck-typed to keep this file UI-free). */
export function a11yCheck(doc: { descendants: (cb: (node: { type: { name: string }; attrs: Record<string, unknown>; textContent: string; nodeSize: number; isText: boolean; marks?: readonly { type: { name: string }; attrs: Record<string, unknown> }[] }, pos: number) => boolean | void) => void }): A11yIssue[] {
  const issues: A11yIssue[] = [];
  let lastLevel = 0;
  doc.descendants((node) => {
    const t = node.type.name;
    if (t === "image" || t === "inlineImage") {
      if (!node.attrs.alt) issues.push({ kind: "image-alt", detail: "Image missing alt text", pos: undefined });
    }
    if (t === "heading") {
      const lvl = (node.attrs.level as number) ?? 1;
      if (!node.textContent.trim()) issues.push({ kind: "empty-heading", detail: `Empty heading (H${lvl})` });
      if (lastLevel && lvl > lastLevel + 1) issues.push({ kind: "heading-skip", detail: `Heading level skipped (H${lastLevel} → H${lvl}): "${node.textContent.slice(0, 40)}"` });
      lastLevel = lvl;
    }
    if (t === "table" || t === "tableWrapper") {
      // table header-row check needs row introspection — reserved
    }
    if (node.isText && node.marks) {
      for (const m of node.marks) {
        if (m.type.name === "link") {
          const txt = node.textContent.trim().toLowerCase();
          if (["click here", "here", "link", "read more", "more"].includes(txt))
            issues.push({ kind: "link-text", detail: `Link text "${node.textContent.trim()}" is not descriptive` });
        }
      }
    }
    return true;
  });
  return issues;
}

// ---- thesaurus (compact built-in map for common words) ----
const THESAURUS: Record<string, string[]> = {
  good: ["excellent", "fine", "great", "positive", "satisfactory"],
  bad: ["poor", "inferior", "awful", "substandard", "harmful"],
  big: ["large", "huge", "enormous", "vast", "grand"],
  small: ["little", "tiny", "minor", "compact", "slight"],
  fast: ["quick", "rapid", "swift", "speedy", "brisk"],
  slow: ["gradual", "unhurried", "leisurely", "sluggish"],
  happy: ["glad", "pleased", "joyful", "delighted", "content"],
  sad: ["unhappy", "sorrowful", "gloomy", "downcast"],
  important: ["significant", "crucial", "vital", "essential", "key"],
  new: ["fresh", "novel", "recent", "modern", "original"],
  old: ["aged", "ancient", "former", "previous", "elderly"],
  make: ["create", "produce", "build", "construct", "form"],
  get: ["obtain", "acquire", "receive", "gain", "fetch"],
  give: ["provide", "grant", "offer", "donate", "supply"],
  take: ["grab", "seize", "capture", "remove", "accept"],
  show: ["display", "exhibit", "demonstrate", "reveal"],
  use: ["utilize", "employ", "apply", "operate"],
  help: ["assist", "aid", "support", "facilitate"],
  start: ["begin", "commence", "initiate", "launch"],
  end: ["finish", "conclude", "terminate", "complete"],
  find: ["discover", "locate", "detect", "uncover"],
  keep: ["retain", "hold", "preserve", "maintain"],
  think: ["believe", "consider", "suppose", "reckon"],
  know: ["understand", "realize", "recognize", "grasp"],
  see: ["observe", "notice", "view", "witness"],
  look: ["gaze", "glance", "stare", "peer"],
  say: ["state", "declare", "remark", "utter", "mention"],
  tell: ["inform", "notify", "relate", "narrate"],
  ask: ["inquire", "question", "request", "query"],
  work: ["labor", "toil", "operate", "function"],
  call: ["phone", "name", "summon", "contact"],
  try: ["attempt", "endeavor", "strive", "test"],
  need: ["require", "want", "demand", "necessitate"],
  feel: ["sense", "perceive", "experience", "touch"],
  become: ["turn into", "grow", "develop into", "transform"],
  leave: ["depart", "exit", "abandon", "vacate"],
  put: ["place", "set", "position", "lay", "insert"],
  mean: ["signify", "denote", "imply", "intend"],
  let: ["allow", "permit", "enable", "authorize"],
  seem: ["appear", "look", "sound"],
  want: ["desire", "wish", "crave", "seek"],
  move: ["shift", "transfer", "relocate", "advance"],
  like: ["enjoy", "prefer", "fancy", "appreciate"],
  right: ["correct", "proper", "accurate", "just"],
  wrong: ["incorrect", "mistaken", "false", "improper"],
  different: ["distinct", "unlike", "varied", "diverse"],
  same: ["identical", "equal", "equivalent", "matching"],
  easy: ["simple", "effortless", "straightforward"],
  hard: ["difficult", "tough", "challenging", "arduous"],
  strong: ["powerful", "sturdy", "robust", "mighty"],
  weak: ["feeble", "frail", "delicate", "faint"],
  rich: ["wealthy", "affluent", "prosperous"],
  poor2: ["needy", "impoverished", "destitute"], // "poor" (adj.) — keyed as poor2 to avoid clash
  idea: ["concept", "notion", "thought", "plan"],
  part: ["piece", "section", "portion", "component"],
  place: ["location", "spot", "site", "position"],
  thing: ["object", "item", "entity", "article"],
  way: ["method", "manner", "means", "approach"],
  time: ["period", "moment", "duration", "interval"],
  year: ["annum", "twelvemonth"],
  day: ["daytime", "24 hours"],
  man: ["male", "gentleman", "fellow"],
  woman: ["female", "lady"],
  child: ["kid", "youngster", "minor", "offspring"],
  world: ["globe", "earth", "planet", "society"],
  life: ["existence", "lifetime", "living"],
  hand: ["palm", "fist", "mitt"],
  eye: ["optic", "ocular organ"],
  money: ["cash", "currency", "funds", "capital"],
  story: ["tale", "narrative", "account", "yarn"],
  fact: ["truth", "reality", "certainty", "detail"],
  group: ["cluster", "collection", "set", "batch"],
  problem: ["issue", "difficulty", "trouble", "challenge"],
  change: ["alter", "modify", "transform", "vary"],
  increase: ["grow", "expand", "raise", "boost"],
  decrease: ["reduce", "lower", "diminish", "shrink"],
  improve: ["enhance", "better", "upgrade", "refine"],
  beautiful: ["lovely", "attractive", "gorgeous", "pretty"],
  ugly: ["unattractive", "unsightly", "hideous"],
  angry: ["furious", "irate", "mad", "annoyed"],
  afraid: ["fearful", "scared", "frightened", "terrified"],
  brave: ["courageous", "bold", "valiant", "fearless"],
  careful: ["cautious", "attentive", "prudent", "wary"],
  clever: ["smart", "intelligent", "bright", "sharp"],
  dull: ["boring", "tedious", "uninteresting", "drab"],
  famous: ["renowned", "celebrated", "well-known", "noted"],
  strange: ["odd", "peculiar", "unusual", "weird"],
  true2: ["genuine", "authentic", "real", "actual"],
  usually: ["normally", "generally", "typically", "mostly"],
  always: ["constantly", "forever", "perpetually", "invariably"],
  never: ["not ever", "at no time"],
  often: ["frequently", "regularly", "commonly"],
  sometimes: ["occasionally", "periodically", "at times"],
  begin: ["start", "commence", "initiate", "open"],
  build: ["construct", "erect", "assemble", "fabricate"],
  buy: ["purchase", "acquire", "obtain", "procure"],
  choose: ["select", "pick", "elect", "opt for"],
  create: ["make", "produce", "invent", "design"],
  decide: ["determine", "resolve", "settle", "choose"],
  develop: ["grow", "evolve", "expand", "advance"],
  explain: ["clarify", "describe", "elucidate", "interpret"],
  fix: ["repair", "mend", "correct", "restore"],
  learn: ["study", "master", "acquire", "absorb"],
  plan: ["scheme", "design", "arrange", "organize"],
  prove: ["demonstrate", "verify", "confirm", "establish"],
  reach: ["attain", "achieve", "arrive at", "extend"],
  reduce: ["cut", "decrease", "lower", "lessen"],
  remember: ["recall", "recollect", "retain"],
  save: ["rescue", "preserve", "store", "conserve"],
  send: ["dispatch", "transmit", "ship", "forward"],
  spend: ["expend", "use up", "consume", "pay out"],
  stop: ["halt", "cease", "quit", "discontinue"],
  suggest: ["propose", "recommend", "advise", "hint"],
  win: ["triumph", "prevail", "succeed", "conquer"],
  write: ["compose", "draft", "author", "record"],
};
// alias fixes
THESAURUS["poor"] = THESAURUS["poor2"]; delete THESAURUS["poor2"];
THESAURUS["true"] = THESAURUS["true2"]; delete THESAURUS["true2"];

export function synonyms(word: string): string[] {
  return THESAURUS[word.toLowerCase()] ?? [];
}
