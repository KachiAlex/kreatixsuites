// Patch-based .docx export. The original upload stays the document of record:
// paragraphs the user did not change are copied from the original XML byte for
// byte, and only edited paragraphs are regenerated from the editor model. Any
// change this path cannot represent safely returns null, and the caller falls
// back to the full rebuild exporter.
import JSZip from "jszip";

type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string };

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
  const runs = inner.replace(/^<w:pPr>[\s\S]*?<\/w:pPr>/, "");
  if (UNSAFE_RUN.test(runs)) return null;
  return runs;
}

const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const PICTURE = /<w:drawing|<w:pict|<mc:AlternateContent|<w:object/;

type Seg = { kind: "t"; rPr: string; text: string } | { kind: "p"; xml: string };

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

/** Rebuild one paragraph from its original runs with the text between the common
 *  prefix and suffix replaced by the edited text. Pictures stay where they were;
 *  an edit whose changed region contains a picture is refused. The result is
 *  re-read and must give exactly the edited text, or the patch is refused. */
function patchRuns(original: string, edited: string): string | null {
  const open = original.match(/^<w:p[^>]*>/)?.[0];
  const pPr = original.slice((open ?? "").length).match(/^<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
  if (!open) return null;
  const inner = original.slice(open.length + pPr.length, original.length - CLOSE.length);
  const segs = splitRuns(inner);
  if (!segs) return null;
  const old = textOf(segs);
  let p = 0;
  while (p < old.length && p < edited.length && old[p] === edited[p]) p++;
  let s = 0;
  while (s < old.length - p && s < edited.length - p && old[old.length - 1 - s] === edited[edited.length - 1 - s]) s++;
  const oldEnd = old.length - s;
  const mid = edited.slice(p, edited.length - s);

  const prefix: string[] = [], suffix: string[] = [];
  let pos = 0, rAt = "";
  for (const sg of segs) {
    if (sg.kind === "p") {
      if (pos > p && pos < oldEnd) return null;
      (pos <= p ? prefix : suffix).push(sg.xml);
      continue;
    }
    const a = pos, len = sg.text.length, b = a + len;
    const cut1 = Math.min(Math.max(p - a, 0), len), cut2 = Math.min(Math.max(oldEnd - a, 0), len);
    if (cut1 > 0) prefix.push(runXml(sg.rPr, sg.text.slice(0, cut1)));
    if (cut2 < len) suffix.push(runXml(sg.rPr, sg.text.slice(cut2)));
    if (p >= a && p < b) rAt = sg.rPr;
    else if (p === b && !rAt) rAt = sg.rPr;
    pos = b;
  }
  const middle = mid ? [runXml(rAt, mid)] : [];
  const rebuilt = open + pPr + prefix.join("") + middle.join("") + suffix.join("") + CLOSE;
  const again = splitRuns(rebuilt.slice(open.length + pPr.length, rebuilt.length - CLOSE.length));
  if (!again || textOf(again) !== edited) return null;
  return rebuilt;
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
      // pictures stay in place: only the text between them is replaced, and an
      // edit reaching a picture is refused (falls back to the full rebuild)
      const edited = ((c.content ?? []) as Node[]).map((n) => n.text ?? "").join("");
      const rebuilt = patchRuns(original, edited);
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
