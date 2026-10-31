// Faithful .pptx export: patch only changed slide text inside the ORIGINAL
// package. A text object maps to the <p:sp> whose <a:t> runs carry the same
// text; the runs rebuild with the first run's formatting while every other
// part — layouts, masters, media, notes — stays byte-identical. Anything this
// path can't represent throws UnpreservableEditError.
import JSZip from "jszip";
import { UnpreservableEditError } from "../writer/docxPatch";

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const refuse = (why: string): never => { throw new UnpreservableEditError(why); };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

type SlideObj = { id?: string; type?: string; text?: string };
type Slide = { objects?: SlideObj[]; [k: string]: unknown };
type Deck = { slides?: Slide[] };

/** The text an object carries (text/shape objects; others have none). */
const textOf = (o: SlideObj): string | null => (o.type === "text" || o.type === "shape" || o.type === "table" ? (o.text ?? "") : null);

/** Replace the text runs inside one <p:sp>/<p:graphicFrame> element, keeping
 *  the first run's properties. Returns null when the element has no runs. */
function patchRuns(sp: string, text: string): string | null {
  const firstR = sp.match(/<a:r>[\s\S]*?<\/a:r>/);
  const rPr = firstR?.[0].match(/<a:rPr[\s\S]*?<\/a:rPr>|<a:rPr[^>]*\/>/)?.[0] ?? "";
  const paraSplits = text.split("\n");
  // one paragraph per source line, single run each, first run's formatting
  const paras = paraSplits.map((line) => `<a:p>${rPr ? `<a:r>${rPr}<a:t>${esc(line)}</a:t></a:r>` : `<a:r><a:t>${esc(line)}</a:t></a:r>`}</a:p>`).join("");
  const body = sp.match(/<p:txBody>[\s\S]*?<\/p:txBody>/)?.[0];
  if (!body) return null;
  const head = body.match(/^<p:txBody>(?:<a:bodyPr[\s\S]*?(?:\/>|<\/a:bodyPr>))?(?:<a:lstStyle[\s\S]*?(?:\/>|<\/a:lstStyle>))?/)?.[0];
  if (head == null) return null;
  return sp.replace(body, head + paras + "</p:txBody>");
}

export async function patchPptx(source: ArrayBuffer, baseline: Deck, current: Deck): Promise<Blob | null> {
  const zip = await JSZip.loadAsync(source);
  const presXml = await zip.file("ppt/presentation.xml")?.async("string");
  const rels = await zip.file("ppt/_rels/presentation.xml.rels")?.async("string");
  if (!presXml || !rels) return refuse("the original file has no readable presentation part");
  const bs = (baseline.slides ?? []) as Slide[], cs = (current.slides ?? []) as Slide[];
  if (bs.length !== cs.length) return refuse("slides were added or removed");
  const rids = [...presXml.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => m[1]);
  const relTarget = (rid: string) => rels.match(new RegExp(`Id="${rid}"[^>]*?Target="([^"]+)"`))?.[1]
    ?? rels.match(new RegExp(`Target="([^"]+)"[^>]*?Id="${rid}"`))?.[1];
  let touched = false;
  for (let i = 0; i < bs.length; i++) {
    const { objects: bo = [], ...bMeta } = bs[i];
    const { objects: co = [], ...cMeta } = cs[i];
    if (!same(bMeta, cMeta)) return refuse(`slide ${i + 1} changed outside its objects (layout, notes or settings)`);
    if (bo.length !== co.length) return refuse(`slide ${i + 1} has objects added or removed`);
    const target = rids[i] && relTarget(rids[i]);
    if (!target) return refuse(`slide ${i + 1} could not be located in the original file`);
    const path = `ppt/${target.replace(/^\/+/, "").replace(/^ppt\//, "").replace(/^\.\.\/slides\//, "slides/")}`;
    const sx = await zip.file(path)?.async("string");
    if (!sx) return refuse(`slide ${i + 1} could not be read`);
    let out = sx;
    const shapes = [...sx.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>|<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g)].map((m) => m[0]);
    const usedShapes = new Set<number>();
    for (let j = 0; j < bo.length; j++) {
      const b = bo[j], c = co[j];
      if (same(b, c)) continue;
      const bt = textOf(b), ct = textOf(c);
      // only the text may differ — type, position, style must be identical
      const { text: _bt, ...bRest } = b; const { text: _ct, ...cRest } = c;
      if (bt == null || ct == null || !same(bRest, cRest)) return refuse(`slide ${i + 1} object ${j + 1} changed beyond its text`);
      // map to the shape whose runs carry the old text — index 0 spans the sp/pic order
      const bLines = (bt ?? "").split("\n");
      const si = shapes.findIndex((s, k) => !usedShapes.has(k) && bLines.every((l) => s.includes(`<a:t>${esc(l)}</a:t>`) || s.includes(`<a:t xml:space="preserve">${esc(l)}</a:t>`) || unesc(s).includes(l)));
      if (si < 0) return refuse(`slide ${i + 1} text object ${j + 1} could not be matched to a shape`);
      usedShapes.add(si);
      const patched = patchRuns(shapes[si], ct ?? "");
      if (patched == null) return refuse(`slide ${i + 1} text object ${j + 1} has runs this path can't rewrite`);
      out = out.replace(shapes[si], patched);
      touched = true;
    }
    if (out !== sx) zip.file(path, out);
  }
  if (!touched) return refuse("no change could be applied");
  const bytes = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  return new Blob([bytes], { type: PPTX_MIME });
}
