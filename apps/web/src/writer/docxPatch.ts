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
  constructor(message = "This edit can't be kept in the original Word file") {
    super(message);
    this.name = "UnpreservableEditError";
  }
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PATCHABLE = new Set(["paragraph", "heading"]);
const TEXT_BLOCK = new Set(["paragraph", "heading"]);
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

/** The document's structure without paragraph text: block types, attributes, and
 *  nesting. Two documents with equal skeletons differ only inside paragraphs. */
const skeleton = (n: Node): unknown =>
  n.type === "paragraph" || n.type === "heading"
    ? { t: n.type, a: n.attrs ?? null }
    : { t: n.type, a: n.attrs ?? null, x: n.text ?? null, c: (n.content ?? []).map(skeleton) };

/** Source index → the paragraph that carries it (a list item's paragraph, or a
 *  paragraph/heading itself). Walks the whole tree, so list items are included. */
function indexParagraphs(blocks: Node[], out = new Map<number, Node>()): Map<number, Node> {
  for (const n of blocks) {
    if (n.type === "listItem") {
      const idx = srcOf(n);
      const p = (n.content ?? [])[0];
      if (idx != null && p && !out.has(idx)) out.set(idx, p);
    } else if ((n.type === "paragraph" || n.type === "heading") && srcOf(n) != null) {
      if (!out.has(srcOf(n) as number)) out.set(srcOf(n) as number, n);
    }
    indexParagraphs(n.content ?? [], out);
  }
  return out;
}

type Rel = { id: string; type: string; target: string };
const parseRels = (xml: string): Rel[] =>
  [...xml.matchAll(/<Relationship\b[^>]*\/>/g)].map((m) => ({
    id: m[0].match(/\sId="([^"]+)"/)?.[1] ?? "",
    type: m[0].match(/\sType="([^"]+)"/)?.[1] ?? "",
    target: m[0].match(/\sTarget="([^"]+)"/)?.[1] ?? "",
  }));
const IMAGE_REL = /\/image$/;
const CT_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  bmp: "image/bmp", emf: "image/x-emf", wmf: "image/x-wmf", svg: "image/svg+xml",
};

/** Declare on the rebuilt root element every namespace prefix the original root declares,
 *  so XML copied from the original stays well-formed. */
function withNamespacesOf(target: string, source: string, rootTag: string): string {
  const open = new RegExp(`<${rootTag}\\b[^>]*>`);
  const srcRoot = source.match(open)?.[0] ?? "";
  const tgtRoot = target.match(open)?.[0] ?? "";
  if (!tgtRoot) return target;
  let root = tgtRoot;
  for (const m of srcRoot.matchAll(/\s(xmlns:[\w.-]+)="([^"]*)"/g)) {
    if (!root.includes(` ${m[1]}=`)) root = root.replace(/>$/, ` ${m[1]}="${m[2]}">`);
  }
  return target.replace(tgtRoot, root);
}

/** Append the original list definitions to the rebuilt numbering part. Ids are shifted
 *  so they can't collide with the rebuild's own lists. */
function mergeNumbering(srcNum: string, rebuiltNum: string): { xml: string; numOffset: number } {
  const maxOf = (re: RegExp, s: string) => Math.max(0, ...[...s.matchAll(re)].map((m) => Number(m[1])));
  const absOffset = maxOf(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"/g, rebuiltNum) + 1;
  const numOffset = maxOf(/<w:num\b[^>]*w:numId="(\d+)"/g, rebuiltNum);
  const shift = (s: string) => s
    .replace(/(<w:abstractNum\b[^>]*w:abstractNumId=")(\d+)"/g, (_m, p: string, n: string) => `${p}${Number(n) + absOffset}"`)
    .replace(/(<w:abstractNumId\s+w:val=")(\d+)"/g, (_m, p: string, n: string) => `${p}${Number(n) + absOffset}"`)
    .replace(/(<w:num\b[^>]*w:numId=")(\d+)"/g, (_m, p: string, n: string) => `${p}${Number(n) + numOffset}"`);
  const abstracts = [...srcNum.matchAll(/<w:abstractNum\b[\s\S]*?<\/w:abstractNum>/g)].map((m) => shift(m[0])).join("");
  const nums = [...srcNum.matchAll(/<w:num\b[\s\S]*?<\/w:num>/g)].map((m) => shift(m[0])).join("");
  const firstNum = rebuiltNum.search(/<w:num\b/);
  let xml = firstNum < 0 ? rebuiltNum : rebuiltNum.slice(0, firstNum) + abstracts + rebuiltNum.slice(firstNum);
  if (firstNum < 0) xml = xml.replace("</w:numbering>", abstracts + "</w:numbering>");
  xml = xml.replace("</w:numbering>", nums + "</w:numbering>");
  return { xml: withNamespacesOf(xml, srcNum, "w:numbering"), numOffset };
}

/** Carry the original paragraphs into a rebuilt .docx. An unchanged paragraph
 *  is copied byte for byte; an edited one is rebuilt from the original by the text
 *  patch. Its image parts and relationships are copied into the rebuilt package and
 *  the relationship IDs rewritten, so the pictures still render. A paragraph that
 *  can't be carried over is left as the rebuild wrote it. */
export async function carryPicturesIntoRebuild(
  rebuilt: Blob,
  source: ArrayBuffer,
  baseline: Node,
  current: Node,
): Promise<Blob> {
  const src = await JSZip.loadAsync(source);
  const srcXml = await src.file("word/document.xml")?.async("string");
  if (!srcXml) return rebuilt;
  const srcRels = parseRels((await src.file("word/_rels/document.xml.rels")?.async("string")) ?? "");
  const srcSpans = paragraphSpans(srcXml);
  const baseMap = indexParagraphs((baseline.content ?? []) as Node[]);
  const curMap = indexParagraphs((current.content ?? []) as Node[]);

  const zip = await JSZip.loadAsync(await rebuilt.arrayBuffer());
  let docXml = await zip.file("word/document.xml")!.async("string");
  const relsPath = "word/_rels/document.xml.rels", ctPath = "[Content_Types].xml";
  let relsXml = (await zip.file(relsPath)?.async("string")) ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  let ctXml = await zip.file(ctPath)!.async("string");
  let changed = false;
  const srcNum = await src.file("word/numbering.xml")?.async("string");
  const rebuiltNum = await zip.file("word/numbering.xml")?.async("string");
  const merged = srcNum && rebuiltNum ? mergeNumbering(srcNum, rebuiltNum) : null;
  let numberingUsed = false;

  for (const [idx, node] of curMap) {
    const span = srcSpans[idx];
    if (!span) continue;
    const original = srcXml.slice(span.start, span.end);
    const before = baseMap.get(idx);
    const unchanged = !!before && same(before, node);
    let para: string | null = null;
    if (unchanged) para = original;
    else if (PICTURE.test(original)) { const t = textAndFmt(node); para = t ? patchRuns(original, t.text, t.fmt) : null; }
    else continue;
    if (!para) continue;
    // footnote, comment and section references point into parts the rebuild doesn't share
    if (/<w:(?:footnote|endnote|comment)(?:Reference|RangeStart|RangeEnd)\b|<w:sectPr\b/.test(para)) continue;
    if (/<w:numId w:val="[1-9]\d*"/.test(para)) {
      if (!merged) continue;
      para = para.replace(/(<w:numId\s+w:val=")(\d+)"/g, (m, p: string, n: string) => (Number(n) === 0 ? m : `${p}${Number(n) + merged.numOffset}"`));
      numberingUsed = true;
    }

    const at = docXml.indexOf(`w:name="kxsrc_${idx}"`);
    if (at < 0) continue;
    const ps = Math.max(docXml.lastIndexOf("<w:p>", at), docXml.lastIndexOf("<w:p ", at));
    const pe = docXml.indexOf(CLOSE, at);
    if (ps < 0 || pe < 0) continue;

    const rids = [...new Set([...para.matchAll(/r:(?:embed|id|link)="([^"]+)"/g)].map((m) => m[1]))];
    const plan = rids.map((rid) => {
      const rel = srcRels.find((r) => r.id === rid);
      const ext = rel?.target.split(".").pop()?.toLowerCase() ?? "";
      return rel && IMAGE_REL.test(rel.type) && CT_BY_EXT[ext] ? { rid, rel, ext } : null;
    });
    if (plan.some((p) => p == null)) continue;

    const map = new Map<string, string>();
    let seq = 0;
    for (const p of plan as { rid: string; rel: Rel; ext: string }[]) {
      const data = await src.file(`word/${p.rel.target}`)?.async("uint8array");
      if (!data) { map.clear(); break; }
      const name = `media/kxsrc${idx}_${seq++}.${p.ext}`;
      zip.file(`word/${name}`, data);
      const newId = `rIdKxSrc${idx}_${seq}`;
      relsXml = relsXml.replace("</Relationships>", `<Relationship Id="${newId}" Type="${p.rel.type}" Target="${name}"/></Relationships>`);
      if (!ctXml.includes(`Extension="${p.ext}"`)) ctXml = ctXml.replace("</Types>", `<Default Extension="${p.ext}" ContentType="${CT_BY_EXT[p.ext]}"/></Types>`);
      map.set(p.rid, newId);
    }
    if (map.size !== rids.length) continue;

    const carried = para.replace(/(r:(?:embed|id|link)=")([^"]+)"/g, (_m, pre: string, rid: string) => `${pre}${map.get(rid) ?? rid}"`);
    docXml = docXml.slice(0, ps) + carried + docXml.slice(pe + CLOSE.length);
    changed = true;
  }
  if (!changed) return rebuilt;

  // bookmark ids must be unique in the package: renumber each start/end pair in order
  const stack: number[] = [];
  let nextId = 1;
  docXml = docXml.replace(/<w:bookmark(Start|End)\b[^>]*?\/>/g, (m, kind: string) => {
    const id = kind === "Start" ? nextId++ : (stack.pop() ?? 0);
    if (kind === "Start") stack.push(id);
    return m.replace(/w:id="[^"]*"/, `w:id="${id}"`);
  });

  zip.file("word/document.xml", withNamespacesOf(docXml, srcXml, "w:document"));
  if (numberingUsed && merged) zip.file("word/numbering.xml", merged.xml);
  zip.file(relsPath, relsXml);
  zip.file(ctPath, ctXml);
  return new Blob([await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" })], { type: DOCX_MIME });
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

/** Patch, or return null when this path can't keep the edit (see patchOrRefuse for the reason). */
export async function tryPatchExport(source: ArrayBuffer, baseline: Node, current: Node, regen: (doc: Node) => Promise<Blob>): Promise<Blob | null> {
  try { return await patchOrRefuse(source, baseline, current, regen); } catch (e) { if (e instanceof UnpreservableEditError) return null; throw e; }
}

/** Render a new non-paragraph block (e.g. a table the user added) to OOXML by
 *  rebuilding it alone, so it can be grafted into the original package. Refuses
 *  when the result needs parts this path doesn't merge — pictures, links,
 *  fields or list numbering. */
async function regenerateBlock(n: Node, regen: (doc: Node) => Promise<Blob>): Promise<string | null> {
  const blob = await regen({ type: "doc", content: [n] });
  const docXml = await (await JSZip.loadAsync(await blob.arrayBuffer())).file("word/document.xml")?.async("string");
  const body = docXml?.match(/<w:body>([\s\S]*)<\/w:body>/)?.[1];
  if (!body) return null;
  const inner = body.replace(/<w:sectPr[\s\S]*?<\/w:sectPr>\s*$/, "").trim();
  if (!inner) return null;
  if (/\br:(id|embed|link)=|<w:numId\b|<w:fldChar|<w:instrText/.test(inner)) return null;
  return inner;
}

/** Patch the original package with the edits between `baseline` (the document
 *  as imported) and `current` (the document now). Edited text is rebuilt in place;
 *  paragraphs added after a paragraph are inserted; paragraphs removed are deleted.
 *  Moves, changes to lists, tables or other blocks, and anything else this path
 *  can't represent return null, and the caller refuses instead of rebuilding. */
/** Stop the patch with the reason, so the user sees which edit blocks the export. */
const refuse = (why: string): never => { throw new UnpreservableEditError(why); };

export async function patchOrRefuse(
  source: ArrayBuffer,
  baseline: Node,
  current: Node,
  regen: (doc: Node) => Promise<Blob>,
): Promise<Blob | null> {
  const zip = await JSZip.loadAsync(source);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) return refuse("the original file has no readable body");
  const baseTop = (baseline.content ?? []) as Node[];
  const curTop = (current.content ?? []) as Node[];
  const isText = (n: Node) => TEXT_BLOCK.has(n.type);
  // original non-paragraph blocks must survive unchanged and in order; extras
  // in the current document become insertions after a paragraph anchor
  const baseOthers = baseTop.filter((b) => !isText(b));
  const baseTopIndex = new Map<Node, number>(baseTop.map((b, i) => [b, i]));
  const baseTextBlocks = baseTop.filter(isText);
  if (baseTextBlocks.some((b) => srcOf(b) == null)) return refuse("a paragraph has no source link");
  const baseOrder = baseTextBlocks.map((b) => srcOf(b) as number);

  const spans = paragraphSpans(xml);
  const tables = tableSpans(xml);
  const baseMap = indexParagraphs(baseTop);
  const curMap = indexParagraphs(curTop);
  for (const idx of curMap.keys()) if (!baseMap.has(idx)) return refuse("a paragraph from outside the original was found");

  type Edit = { start: number; end: number; xml: string; kind: number };
  type Ins = { kind: "p"; runs: string } | { kind: "block"; xml: string };
  const edits: Edit[] = [];
  const matched = new Set<number>();
  const insertsAfter = new Map<number, Ins[]>();
  let anchor: number | null = null, blockSince = false, lastPos = -1, lastTopKey = -1, otherCursor = 0;
  for (const c of curTop) {
    if (!isText(c)) {
      const expect = baseOthers[otherCursor];
      if (expect && same(skeleton(expect), skeleton(c))) {
        // the original block survives here — it must keep its place among the source blocks
        otherCursor++;
        const key = baseTopIndex.get(expect) ?? 0;
        if (key <= lastTopKey) return refuse("a table or other block was moved");
        lastTopKey = key;
        blockSince = true; anchor = null;
        continue;
      }
      // a new block: it grafts after the last paragraph that kept its identity
      if (anchor == null || blockSince) return refuse("a new table or block was added where it can't be placed (before the first paragraph or after a table)");
      const blockXml = await regenerateBlock(c, regen);
      if (blockXml == null) return refuse("a new table or block contains content this path can't write (picture, link, list or field)");
      insertsAfter.set(anchor, [...(insertsAfter.get(anchor) ?? []), { kind: "block", xml: blockXml }]);
      continue;
    }
    const idx = srcOf(c);
    const pos = idx == null ? -1 : baseOrder.indexOf(idx);
    if (idx != null && pos >= 0 && curMap.get(idx) === c) {
      // the source paragraph keeps its identity: it must stay in order and keep its formatting
      if (pos < lastPos) return refuse("paragraphs were reordered");
      lastPos = pos;
      const key = baseTopIndex.get(baseTextBlocks[pos]) ?? 0;
      if (key <= lastTopKey) return refuse("a paragraph was moved across a table or other block");
      lastTopKey = key;
      matched.add(idx);
      if (!same(baseMap.get(idx)?.attrs, c.attrs)) return refuse("a paragraph's formatting (alignment, spacing, indents) was changed");
      anchor = idx;
      blockSince = false;
      continue;
    }
    // a copy or a new paragraph: it needs a paragraph directly before it to attach to
    if (anchor == null || blockSince || c.type !== "paragraph") return refuse("a new paragraph has no paragraph before it to attach to, or follows a table or list");
    const runs = await regenerateRuns(c, regen);
    if (runs == null) return refuse("a new paragraph contains content this path can't write (drawing, field, link)");
    insertsAfter.set(anchor, [...(insertsAfter.get(anchor) ?? []), { kind: "p", runs }]);
  }
  if (otherCursor !== baseOthers.length) return refuse("a table, list or other block was removed or changed");

  for (const idx of baseOrder) {
    if (matched.has(idx)) continue;
    const span = spans[idx];
    if (!span || insideAny(span, tables)) return refuse("a deleted paragraph is inside a table");
    if (PICTURE.test(xml.slice(span.start, span.end))) return refuse("a deleted paragraph holds a picture");
    edits.push({ start: span.start, end: span.end, xml: "", kind: 0 });
  }

  for (const [idx, c] of curMap) {
    const b = baseMap.get(idx);
    if (!b || same(b, c)) continue;
    if (!PATCHABLE.has(b.type)) return refuse("a changed paragraph is not a plain paragraph or heading");
    const span = spans[idx];
    if (!span || insideAny(span, tables)) return refuse("a changed paragraph is inside a table");
    const original = xml.slice(span.start, span.end);
    const open = original.match(/^<w:p[^>]*>/)?.[0];
    if (!open) return refuse("a changed paragraph could not be read");
    if (PICTURE.test(original)) {
      // pictures stay in place: text and tracked formatting are rebuilt around them
      const t = textAndFmt(c);
      if (!t) return refuse("a changed paragraph has an inline object this path can't write");
      const rebuilt = patchRuns(original, t.text, t.fmt);
      if (rebuilt == null) return refuse("the edit reaches a picture or a construct this path can't rewrite");
      edits.push({ start: span.start, end: span.end, xml: rebuilt, kind: 0 });
      continue;
    }
    const pPr = original.slice(open.length).match(/^<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
    const runs = await regenerateRuns(c, regen);
    if (runs == null) return refuse("a changed paragraph contains content this path can't write (drawing, field, link)");
    edits.push({ start: span.start, end: span.end, xml: open + pPr + runs + CLOSE, kind: 0 });
  }

  let inserted = 0;
  for (const [anchorIdx, chunks] of insertsAfter) {
    const span = spans[anchorIdx];
    if (!span || insideAny(span, tables)) return refuse("a new paragraph is anchored inside a table");
    const original = xml.slice(span.start, span.end);
    const open = original.match(/^<w:p[^>]*>/)?.[0] ?? "";
    const pPr = (original.slice(open.length).match(/^<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? "")
      .replace(/<w:numPr>[\s\S]*?<\/w:numPr>/, "").replace(/<w:sectPr[\s\S]*?<\/w:sectPr>/, "");
    // paragraphs inside grafted blocks (e.g. table cells) count too — the final
    // count check compares every <w:p> in the output
    inserted += chunks.reduce((n, r) => n + (r.kind === "p" ? 1 : (r.xml.match(/<w:p(?=[ >])[^>]*?(?<!\/)>/g) ?? []).length), 0);
    edits.push({ start: span.end, end: span.end, xml: chunks.map((r) => r.kind === "p" ? `<w:p>${pPr}${r.runs}</w:p>` : r.xml).join(""), kind: 1 });
  }
  if (!edits.length) return refuse("no change could be applied");

  let out = xml;
  // later positions first; at one position, ranged edits before insertions
  for (const e of [...edits].sort((a, b) => (b.start - a.start) || (a.kind - b.kind))) {
    out = out.slice(0, e.start) + e.xml + out.slice(e.end);
  }
  const deleted = edits.filter((e) => e.kind === 0 && e.xml === "").length;
  if (paragraphSpans(out).length !== spans.length - deleted + inserted) return refuse("the rebuilt paragraph count did not match the edit");
  zip.file("word/document.xml", out);
  const bytes = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  return new Blob([bytes], { type: DOCX_MIME });
}
