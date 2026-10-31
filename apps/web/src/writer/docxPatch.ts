// Patch-based .docx export. The original upload stays the document of record:
// paragraphs the user did not change are copied from the original XML byte for
// byte, and only edited paragraphs are regenerated from the editor model. Any
// change this path cannot represent safely returns null, and the caller falls
// back to the full rebuild exporter.
import JSZip from "jszip";

type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string; marks?: { type: string }[] };

/** Thrown when an edit can't be kept in the original Word file. The caller must
 *  not rebuild silently: it asks the user, and only then exports a labelled copy. */
export class UnpreservableEditError extends Error {
  constructor() {
    super("This edit can't be kept in the original Word file");
    this.name = "UnpreservableEditError";
  }
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PATCHABLE = new Set(["paragraph", "heading"]);
// constructs a regenerated run must not contain: they reference parts of the package we keep as-is
const UNSAFE_RUN = /r:id=|r:embed=|<w:drawing|<w:hyperlink|<w:footnoteReference|<w:commentReference|<w:fldChar|<w:instrText|<w:sdt|<w:bookmarkStart|<mc:/;

const srcOf = (n: Node): number | null => (n.attrs?.srcIdx == null ? null : Number(n.attrs.srcIdx));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const CLOSE = "</w:p>";

/** Every non-self-closing <w:p> in document order, counted the same way the importer counts srcIdx. */
function paragraphSpans(xml: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const re = /<w:p(?=[ >])[^>]*?(?<!\/)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const end = xml.indexOf(CLOSE, m.index);
    if (end < 0) return [];
    spans.push({ start: m.index, end: end + CLOSE.length });
    re.lastIndex = end + CLOSE.length;
  }
  return spans;
}

/** Table ranges — paragraphs inside tables are not patched in this slice. */
function tableSpans(xml: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const re = /<w:tbl>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const end = xml.indexOf("</w:tbl>", m.index);
    if (end < 0) return [];
    out.push({ start: m.index, end: end + "</w:tbl>".length });
    re.lastIndex = end;
  }
  return out;
}

const insideAny = (s: { start: number; end: number }, ranges: { start: number; end: number }[]) =>
  ranges.some((r) => s.start >= r.start && s.end <= r.end);

/** Regenerate one edited paragraph's runs from the editor model. Returns the
 *  run XML (paragraph properties are taken from the original), or null if the
 *  regenerated runs need package parts this path does not carry over. */
async function regenerateRuns(
  para: Node,
  regen: (doc: Node) => Promise<Blob>,
): Promise<string | null> {
  const blob = await regen({ type: "doc", content: [para] });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) return null;
  const bodyStart = xml.indexOf("<w:body>");
  const spans = paragraphSpans(xml.slice(bodyStart));
  if (!spans.length) return null;
  const p = xml.slice(bodyStart).slice(spans[0].start, spans[0].end);
  const open = p.match(/^<w:p[^>]*>/)?.[0] ?? "";
  const inner = p.slice(open.length, p.length - CLOSE.length);
  const runs = inner.replace(/^<w:pPr>[\s\S]*?<\/w:pPr>/, "").replace(/<w:bookmark(?:Start|End)\b[^>]*\/>/g, "");
  if (UNSAFE_RUN.test(runs)) return null;
  return runs;
}

const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const PICTURE = /<w:drawing|<w:pict|<mc:AlternateContent|<w:object/;

type Seg = { kind: "t"; rPr: string; text: string } | { kind: "p"; xml: string };

/** Character formatting the editor tracks. Other marks (font, colour, size) keep
 *  the original run properties and are not changed by this patch. */
type Fmt = { b: boolean; i: boolean; u: boolean; s: boolean };
const fmtKey = (f: Fmt) => `${+f.b}${+f.i}${+f.u}${+f.s}`;
const fmtOfMarks = (marks?: { type: string }[]): Fmt => {
  const t = new Set((marks ?? []).map((m) => m.type));
  return { b: t.has("bold"), i: t.has("italic"), u: t.has("underline"), s: t.has("strike") };
};
const onTag = (rPr: string, tag: string) =>
  new RegExp(`<w:${tag}(?:\\s[^>]*)?\\/>`).test(rPr) && !new RegExp(`<w:${tag}\\s[^>]*w:val="(?:0|false|none)"`).test(rPr);
const readFmt = (rPr: string): Fmt => ({ b: onTag(rPr, "b"), i: onTag(rPr, "i"), u: onTag(rPr, "u"), s: onTag(rPr, "strike") });
const STRIP_FMT = /<w:(?:b|bCs|i|iCs|strike|u)(?:\s[^>]*)?\/>/g;
// schema order inside w:rPr: b, bCs, i, iCs, strike come before these; u comes after highlight and before these
const BEFORE_FLAGS = /<w:(?:caps|smallCaps|dstrike|outline|shadow|emboss|imprint|noProof|snapToGrid|vanish|webHidden|color|spacing|w|kern|position|sz|szCs|highlight)\b/;
const BEFORE_U = /<w:(?:effect|bdr|shd|fitText|vertAlign|rtl|cs|em|lang|eastAsianLayout|specVanish|oMath)\b/;

/** Return the run properties with the tracked formatting set to `f`. */
function applyFmt(rPr: string, f: Fmt): string {
  const inner = rPr.replace(/^<w:rPr>/, "").replace(/<\/w:rPr>$/, "").replace(STRIP_FMT, "");
  const head = inner.match(/^(?:<w:rStyle\b[^>]*\/>)?(?:<w:rFonts\b[^>]*\/>)?/)?.[0] ?? "";
  let rest = inner.slice(head.length);
  const flags = `${f.b ? "<w:b/><w:bCs/>" : ""}${f.i ? "<w:i/><w:iCs/>" : ""}${f.s ? "<w:strike/>" : ""}`;
  if (flags) {
    const at = rest.search(BEFORE_FLAGS);
    rest = at < 0 ? rest + flags : rest.slice(0, at) + flags + rest.slice(at);
  }
  if (f.u) {
    const at = rest.search(BEFORE_U);
    const u = '<w:u w:val="single"/>';
    rest = at < 0 ? rest + u : rest.slice(0, at) + u + rest.slice(at);
  }
  const out = head + rest;
  return out ? `<w:rPr>${out}</w:rPr>` : "";
}

/** Split a paragraph body into plain text runs and picture runs. Returns null for
 *  anything else (tabs, breaks, fields, bookmarks, nested runs) — those stay on
 *  the full-rebuild path. */
function splitRuns(inner: string): Seg[] | null {
  const runRe = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g;
  if (inner.replace(runRe, "").trim() !== "") return null;
  const segs: Seg[] = [];
  for (const m of inner.matchAll(runRe)) {
    const body = m[1];
    if (/<w:r[\s>]/.test(body)) return null;
    if (PICTURE.test(body)) { segs.push({ kind: "p", xml: m[0] }); continue; }
    const rPr = body.match(/^<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] ?? "";
    const t = body.slice(rPr.length).match(/^<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>$/);
    if (!t) return null;
    segs.push({ kind: "t", rPr, text: unesc(t[1]) });
  }
  return segs;
}

const textOf = (segs: Seg[]) => segs.map((s) => (s.kind === "t" ? s.text : "")).join("");
const runXml = (rPr: string, text: string) => `<w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

/** The editor collapses runs of whitespace into one space. Apply the same rule to
 *  any text and its per-character formatting, so both sides compare identically. */
function normalizeText(text: string, fmt: Fmt[]): { t: string; f: Fmt[] } {
  let t = "", last = false;
  const f: Fmt[] = [];
  for (let i = 0; i < text.length; i++) {
    const sp = /\s/.test(text[i]);
    if (sp && last) continue;
    t += sp ? " " : text[i];
    f.push(fmt[i]);
    last = sp;
  }
  return { t, f };
}

/** Per-character formatting of a re-read paragraph body (normalized like the editor). */
function fmtsOfSegs(segs: Seg[]): { t: string; f: Fmt[] } {
  const raw: string[] = [], fmt: Fmt[] = [];
  for (const sg of segs) if (sg.kind === "t") for (let j = 0; j < sg.text.length; j++) { raw.push(sg.text[j]); fmt.push(readFmt(sg.rPr)); }
  return normalizeText(raw.join(""), fmt);
}

/** Rebuild one paragraph from its original runs so that its text and its tracked
 *  formatting match the editor's. Pictures keep their place; an edit whose changed
 *  text would cross a picture is refused. Unchanged characters keep their original
 *  run XML. The result is re-read and must match the edited text and formatting
 *  exactly, or the patch is refused. */
function patchRuns(original: string, edited: string, editedFmt: Fmt[]): string | null {
  const open = original.match(/^<w:p[^>]*>/)?.[0];
  if (!open) return null;
  const pPr = original.slice(open.length).match(/^<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
  const inner = original.slice(open.length + pPr.length, original.length - CLOSE.length);
  const segs = splitRuns(inner);
  if (!segs) return null;

  const old = textOf(segs);
  const oldFmt: Fmt[] = [];
  for (const sg of segs) if (sg.kind === "t") for (let j = 0; j < sg.text.length; j++) oldFmt.push(readFmt(sg.rPr));
  const O = normalizeText(old, oldFmt);
  const E = normalizeText(edited, editedFmt);
  const oldN = O.t, edN = E.t, efmt = E.f;

  // raw index → normalized index; a dropped duplicate space maps to the kept one before it
  const rawToNorm: number[] = [];
  let k = -1, last = false;
  for (let i = 0; i < old.length; i++) {
    const sp = /\s/.test(old[i]);
    if (sp && last) { rawToNorm.push(k); continue; }
    k++;
    rawToNorm.push(k);
    last = sp;
  }
  const rawStart = (n: number) => { const i = rawToNorm.findIndex((v) => v >= n); return i < 0 ? old.length : i; };

  let p = 0;
  while (p < oldN.length && p < edN.length && oldN[p] === edN[p]) p++;
  let s = 0;
  while (s < oldN.length - p && s < edN.length - p && oldN[oldN.length - 1 - s] === edN[edN.length - 1 - s]) s++;
  const mid = edN.slice(p, edN.length - s);
  const midFmt = efmt.slice(p, edN.length - s);
  const pRaw = rawStart(p), eRaw = rawStart(oldN.length - s);
  const midAt = pRaw < old.length ? pRaw : old.length - 1;

  let midRPr = "", pos0 = 0;
  for (const sg of segs) {
    if (sg.kind !== "t") continue;
    if (midAt >= pos0 && midAt < pos0 + sg.text.length) midRPr = sg.rPr;
    pos0 += sg.text.length;
  }

  type Piece = { xml: string } | { rPr: string; text: string; fmt: Fmt };
  const pieces: Piece[] = [];
  let midDone = false;
  const pushMid = () => {
    if (midDone) return;
    midDone = true;
    mid.split("").forEach((ch, j) => pieces.push({ rPr: midRPr, text: ch, fmt: midFmt[j] }));
  };
  let pos = 0;
  for (const sg of segs) {
    if (sg.kind === "p") {
      if (pos > pRaw && pos < eRaw) return null;
      pieces.push({ xml: sg.xml });
      continue;
    }
    for (let j = 0; j < sg.text.length; j++) {
      const g = pos + j;
      if (g === pRaw) pushMid();
      if (g >= pRaw && g < eRaw) continue;
      const kk = rawToNorm[g];
      const fmt = kk < p ? efmt[kk] : efmt[edN.length - (oldN.length - kk)];
      pieces.push({ rPr: sg.rPr, text: sg.text[j], fmt });
    }
    pos += sg.text.length;
  }
  pushMid();

  type Group = { xml: string } | { rPr: string; text: string; fmt: Fmt };
  const groups: Group[] = [];
  for (const pc of pieces) {
    if ("xml" in pc) { groups.push({ xml: pc.xml }); continue; }
    const prev = groups[groups.length - 1];
    if (prev && "text" in prev && prev.rPr === pc.rPr && fmtKey(prev.fmt) === fmtKey(pc.fmt)) prev.text += pc.text;
    else groups.push({ rPr: pc.rPr, text: pc.text, fmt: pc.fmt });
  }
  const body = groups.map((g) => ("xml" in g ? g.xml
    : runXml(fmtKey(readFmt(g.rPr)) === fmtKey(g.fmt) ? g.rPr : applyFmt(g.rPr, g.fmt), g.text))).join("");

  const rebuilt = open + pPr + body + CLOSE;
  const again = splitRuns(rebuilt.slice(open.length + pPr.length, rebuilt.length - CLOSE.length));
  if (!again) return null;
  const got = fmtsOfSegs(again);
  if (got.t !== edN || got.f.length !== efmt.length || got.f.some((f, i) => fmtKey(f) !== fmtKey(efmt[i]))) return null;
  return rebuilt;
}

/** Edited paragraph as plain text plus per-character formatting. Returns null when
 *  the paragraph holds anything other than text (for example a hard break). */
function textAndFmt(c: Node): { text: string; fmt: Fmt[] } | null {
  let text = "";
  const fmt: Fmt[] = [];
  for (const n of (c.content ?? []) as Node[]) {
    if (n.type !== "text") return null;
    const f = fmtOfMarks(n.marks);
    for (let j = 0; j < (n.text ?? "").length; j++) fmt.push(f);
    text += n.text ?? "";
  }
  return { text, fmt };
}

/** Patch the original package with the edits between `baseline` (the document
 *  as imported) and `current` (the document now). Returns null when the change
 *  needs the full rebuild instead. */
export async function tryPatchExport(
  source: ArrayBuffer,
  baseline: Node,
  current: Node,
  regen: (doc: Node) => Promise<Blob>,
): Promise<Blob | null> {
  const zip = await JSZip.loadAsync(source);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) return null;
  const base = (baseline.content ?? []) as Node[];
  const cur = (current.content ?? []) as Node[];
  if (base.length !== cur.length) return null;
  const spans = paragraphSpans(xml);
  const tables = tableSpans(xml);

  const edits: { start: number; end: number; xml: string }[] = [];
  for (let i = 0; i < cur.length; i++) {
    const b = base[i], c = cur[i];
    if (same(b, c)) continue;
    if (b.type !== c.type || !PATCHABLE.has(c.type)) return null;
    const idx = srcOf(c);
    if (idx == null || idx !== srcOf(b)) return null;
    if (!same(b.attrs, c.attrs)) return null; // paragraph formatting changed — rebuild path
    const span = spans[idx];
    if (!span || insideAny(span, tables)) return null;
    const original = xml.slice(span.start, span.end);
    const open = original.match(/^<w:p[^>]*>/)?.[0];
    if (!open) return null;
    if (PICTURE.test(original)) {
      // pictures stay in place: text and tracked formatting are rebuilt around them
      const t = textAndFmt(c);
      if (!t) return null;
      const rebuilt = patchRuns(original, t.text, t.fmt);
      if (rebuilt == null) return null;
      edits.push({ ...span, xml: rebuilt });
      continue;
    }
    const pPr = original.slice(open.length).match(/^<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
    const runs = await regenerateRuns(c, regen);
    if (runs == null) return null;
    edits.push({ ...span, xml: open + pPr + runs + CLOSE });
  }
  if (!edits.length) return null;

  let out = xml;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.xml + out.slice(e.end);
  }
  if (paragraphSpans(out).length !== spans.length) return null;
  zip.file("word/document.xml", out);
  const bytes = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  return new Blob([bytes], { type: DOCX_MIME });
}
