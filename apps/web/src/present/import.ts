import type { Deck, Slide, SlideObject, Theme } from "./model";
import { newId } from "./model";
import { ensureDecryptedFile } from "../lib/passwordPrompt";

// OOXML DrawingML units → px (960×540 deck, 96dpi)
const EMU = 1 / 9525;
const emu = (v: string | null | undefined, dflt = 0) => (v == null ? dflt : Math.round(Number(v) * EMU));
const pt = (v: string | null | undefined) => (v == null ? undefined : Math.round(Number(v) / 100 * (96 / 72)));

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", bmp: "image/bmp", webp: "image/webp" };

/** raw EMU geometry pulled from a layout/master placeholder */
interface PhGeom { x: number; y: number; cx: number; cy: number; rot?: number }

interface Ctx {
  zip: import("jszip");
  rels: Map<string, string>; // rId -> target path (resolved)
  base: string;              // directory of the current part, e.g. "ppt/slides"
  scheme: Record<string, string>; // schemeClr name -> resolved hex
  spids?: Map<string, SlideObject>; // P6.2 — cNvPr @id → created object (for p:timing)
  skipPh?: boolean; // P6.2 — skip placeholder shapes (layout/master parse)
  /** layout + master placeholder geometry — slide placeholders that omit
   *  a:xfrm inherit position/size from here (ECMA-376 §19.3.1.36) */
  phGeom?: Map<string, PhGeom>;
  phGeomMaster?: Map<string, PhGeom>;
}

const phEl = (sp: Element) =>
  first(children(children(sp, "p:nvSpPr")[0] ?? null, "p:nvPr")[0] ?? null, "p:ph")
  ?? first(children(children(sp, "p:nvCxnSpPr")[0] ?? null, "p:nvPr")[0] ?? null, "p:ph");

/** placeholder lookup: exact type:idx → first of type → obj at same idx → master */
function phLookup(ph: Element | null | undefined, ctx: Ctx): PhGeom | undefined {
  if (!ph) return undefined;
  const t = attr(ph, "type") ?? "obj";
  const idx = attr(ph, "idx");
  const search = (m?: Map<string, PhGeom>) => m && (
    m.get(`${t}:${idx ?? "0"}`)
    ?? (idx == null ? [...m.entries()].find(([k]) => k.startsWith(`${t}:`))?.[1] : undefined)
    ?? (t !== "body" ? m.get(`body:${idx ?? "0"}`) : undefined)
    ?? m.get(`obj:${idx ?? "0"}`));
  return search(ctx.phGeom) ?? search(ctx.phGeomMaster);
}

const q = (el: Element | null, sel: string) => el?.getElementsByTagName(sel) ?? [];
const first = (el: Element | null, sel: string) => q(el, sel)[0];
const attr = (el: Element | null | undefined, name: string) => el?.getAttribute(name);

/** child elements of `el` with the given tag (direct children only where it matters) */
function children(el: Element | null, tag: string): Element[] {
  if (!el) return [];
  return [...el.children].filter((c) => c.tagName === tag);
}

function srgb(el: Element | null | undefined): string | undefined {
  const c = first(first(el ?? null, "a:solidFill"), "a:srgbClr") ?? first(el ?? null, "a:srgbClr");
  const v = attr(c ?? null, "val");
  return v ? `#${v}` : undefined;
}

function schemeColor(el: Element | null | undefined, ink: string, scheme: Record<string, string>): string | undefined {
  const c = first(first(el ?? null, "a:solidFill"), "a:schemeClr") ?? first(el ?? null, "a:schemeClr");
  const v = attr(c ?? null, "val");
  if (!v) return undefined;
  const mapped = v === "tx1" ? "dk1" : v === "tx2" ? "dk2" : v === "bg1" ? "lt1" : v === "bg2" ? "lt2" : v;
  return scheme[mapped] ?? (/^(dk|tx)/.test(v) ? ink : /^(lt|bg)/.test(v) ? "#FFFFFF" : undefined);
}

function fillColor(el: Element | null | undefined, ink: string, scheme: Record<string, string>): string | undefined {
  return srgb(el) ?? schemeColor(el, ink, scheme);
}

function textBodyToHtml(tx: Element | null, ink: string, scheme: Record<string, string>, rels?: Map<string, string>): { html: string; fontSize?: number; color?: string; bold?: boolean; italic?: boolean; align?: "left" | "center" | "right" } {
  const paras = children(tx, "a:p");
  const out: string[] = [];
  let fontSize: number | undefined, color: string | undefined, bold = false, italic = false, align: "left" | "center" | "right" | undefined;
  for (const p of paras) {
    const pPr = children(p, "a:pPr")[0];
    const algn = attr(pPr ?? null, "algn");
    const al = algn === "ctr" ? "center" : algn === "r" ? "right" : algn === "just" ? "justify" : "left";
    if (!align && algn) align = al === "justify" ? "left" : al;
    const line: string[] = [];
    if (children(pPr ?? null, "a:buChar").length || children(pPr ?? null, "a:buAutoNum").length) line.push("• ");
    for (const node of [...p.childNodes]) {
      const el = node as Element;
      if (el.tagName === "a:br") { line.push("<br/>"); continue; }
      if (el.tagName !== "a:r" && el.tagName !== "a:fld") continue;
      const t = first(el, "a:t");
      const text = (t?.textContent ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      if (!text) continue;
      const rPr = children(el, "a:rPr")[0];
      let run = text;
      if (rPr) {
        const sz = pt(attr(rPr, "sz"));
        if (sz && !fontSize) fontSize = sz;
        const col = fillColor(rPr, ink, scheme);
        if (col && !color) color = col;
        const b = attr(rPr, "b") === "1", i = attr(rPr, "i") === "1";
        const u = !!attr(rPr, "u") && attr(rPr, "u") !== "none";
        const k = attr(rPr, "strike") === "sngStrike" || attr(rPr, "strike") === "dblStrike";
        if (b) bold = true;
        if (i) italic = true;
        if (b) run = `<b>${run}</b>`;
        if (i) run = `<i>${run}</i>`;
        if (u) run = `<u>${run}</u>`;
        if (k) run = `<s>${run}</s>`;
        const bl = Number(attr(rPr, "baseline") ?? 0);
        if (bl > 0) run = `<sup>${run}</sup>`; else if (bl < 0) run = `<sub>${run}</sub>`;
        const latin = attr(children(rPr, "a:latin")[0] ?? null, "typeface");
        const sty: string[] = [];
        if (col) sty.push(`color:${col}`);
        if (sz) sty.push(`font-size:${sz}px`);
        if (latin) sty.push(`font-family:${latin}`);
        if (sty.length) run = `<span style="${sty.join(";")}">${run}</span>`;
        // run-level hyperlink — r:id resolves through the part's rels
        const rid = attr(children(rPr, "a:hlinkClick")[0] ?? null, "r:id");
        const href = rid ? rels?.get(rid) : undefined;
        if (href && /^[a-z][a-z0-9+.-]*:/i.test(href)) run = `<a href="${href.replace(/"/g, "&quot;")}" rel="noopener noreferrer">${run}</a>`;
      }
      line.push(run);
    }
    const inner = line.join("");
    // block wrapper per para keeps text-align + line breaks uniform
    out.push(`<div${al !== "left" ? ` style="text-align:${al}"` : ""}>${inner || "<br/>"}</div>`);
  }
  // a:bodyPr/a:normAutofit — the autofit shrink the renderer applied. Honor
  // fontScale (per-mille %, e.g. 65000 = 65%) so text doesn't re-overflow.
  const bodyPr = children(tx, "a:bodyPr")[0];
  const scale = Number(attr(first(bodyPr ?? null, "a:normAutofit"), "fontScale") ?? 100000) / 100000;
  let html = out.join("");
  if (scale && Math.abs(scale - 1) > 0.001) {
    html = html.replace(/font-size:\s*([\d.]+)px/g, (_m, n) => `font-size:${Math.round(Number(n) * scale * 10) / 10}px`);
    if (fontSize) fontSize = Math.round(fontSize * scale * 10) / 10;
  }
  return { html, fontSize, color, bold, italic, align };
}

function shapeKind(prst: string | null | undefined): SlideObject["shape"] {
  const map: Record<string, SlideObject["shape"]> = {
    rect: "rect", snip1Rect: "rect", roundRect: "roundrect", round1Rect: "roundrect", round2SameRect: "roundrect",
    ellipse: "ellipse", triangle: "triangle", isocelesTriangle: "triangle", rtTriangle: "rightTriangle",
    diamond: "diamond", pentagon: "pentagon", hexagon: "hexagon", octagon: "octagon",
    parallelogram: "parallelogram", trapezoid: "trapezoid",
    star4: "star4", star5: "star5", star6: "star6", star8: "star6",
    rightArrow: "arrowRight", leftArrow: "arrowLeft", upArrow: "arrowUp", downArrow: "arrowDown",
    leftRightArrow: "arrowBoth", quadArrow: "arrowBoth", bentUpArrow: "arrowUp",
    chevron: "chevron", homePlate: "homePlate", pentagon2: "homePlate",
    plus: "plus", mathPlus: "plus", mathMultiply: "crossX",
    donut: "donut", pie: "pie", blockArc: "blockArc", arc: "blockArc",
    wedgeRectCallout: "calloutRect", wedgeRoundRectCallout: "calloutRound", wedgeEllipseCallout: "calloutRound",
    cloudCallout: "cloud", cloud: "cloud", heart: "heart", lightningBolt: "lightning",
    sun: "sun", moon: "moon", can: "can", cube: "rect", bevel: "rect",
    foldedCorner: "document", flowChartDocument: "document",
    leftBrace: "leftBrace", rightBrace: "rightBrace", bracePair: "leftBrace",
    leftBracket: "leftBracket", rightBracket: "rightBracket",
    noSmoking: "noSymbol", prohibited: "noSymbol",
    flowChartProcess: "rect", flowChartDecision: "diamond", flowChartTerminator: "roundrect",
    flowChartInputOutput: "parallelogram", flowChartConnector: "ellipse", flowChartDatabase: "can",
    flowChartManualOperation: "trapezoid", flowChartPreparation: "hexagon",
    plaque: "roundrect", frame: "rect",
  };
  return prst ? map[prst] : undefined;
}

async function parseSp(sp: Element, ctx: Ctx, ink: string, scheme: Record<string, string>, transform: { ox: number; oy: number; sx: number; sy: number }): Promise<SlideObject | null> {
  // P6.2 — placeholder shapes are proto-objects owned by the layout; skip there
  const ph = phEl(sp);
  if (ctx.skipPh && ph) return null;
  const spPr = children(sp, "p:spPr")[0];
  const xfrm = children(spPr ?? null, "a:xfrm")[0];
  const off = children(xfrm ?? null, "a:off")[0];
  const ext = children(xfrm ?? null, "a:ext")[0];
  // placeholder inheritance — a slide <p:sp> with p:ph and no a:xfrm takes
  // its geometry from the matching layout (then master) placeholder
  let ox = attr(off, "x"), oy = attr(off, "y"), cx = attr(ext, "cx"), cy = attr(ext, "cy");
  let rotS = attr(xfrm ?? null, "rot");
  if ((ox == null || oy == null || cx == null || cy == null) && ph) {
    const g = phLookup(ph, ctx);
    if (g) {
      ox ??= String(g.x); oy ??= String(g.y); cx ??= String(g.cx); cy ??= String(g.cy);
      rotS ??= g.rot != null ? String(g.rot) : null;
    }
  }
  const x = emu(ox) * transform.sx + transform.ox;
  const y = emu(oy) * transform.sy + transform.oy;
  const w = Math.max(16, emu(cx) * transform.sx);
  const h = Math.max(16, emu(cy) * transform.sy);
  const rot = rotS;
  const prst = attr(children(spPr ?? null, "a:prstGeom")[0] ?? null, "prst");
  const tx = children(sp, "p:txBody")[0];
  const { html, fontSize, color, bold, italic, align } = textBodyToHtml(tx ?? null, ink, scheme, ctx.rels);
  const fill = fillColor(spPr, ink, scheme);
  const ln = children(spPr ?? null, "a:ln")[0];
  const stroke = fillColor(ln, ink, scheme);
  const strokeW = attr(ln ?? null, "w") ? Math.max(1, Math.round(Number(attr(ln, "w")) / 12700)) : undefined;
  const rotate = rot ? Math.round(Number(rot) / 60000) : undefined;
  const kind = shapeKind(prst);
  const hasFill = !!children(spPr ?? null, "a:solidFill").length && fill !== undefined;
  const isPictureLike = /^(line|straightConnector)/.test(prst ?? "");

  const base = { id: newId(), x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), z: 0, rotate };
  const hasText = html.replace(/<br\/>|<[^>]+>/g, "").trim().length > 0;

  let obj: SlideObject | null = null;
  if (isPictureLike) {
    obj = { ...base, type: "line", x2: Math.round(w), y2: 0, stroke: stroke ?? ink, strokeW: strokeW ?? 2 };
  } else if (kind && kind !== "rect" || hasFill || stroke) {
    // shape (may carry text)
    obj = { ...base, type: "shape", shape: kind ?? "rect", fill: fill ?? "transparent", stroke: stroke ?? "none", strokeW, html: hasText ? html : undefined, fontSize, color: color ?? "#FFFFFF", bold, italic, align };
  } else if (hasText) {
    obj = { ...base, type: "text", html, fontSize: fontSize ?? 20, color: color ?? ink, bold, italic, align };
  }
  if (obj) {
    const cNvPr = children(children(sp, "p:nvSpPr")[0] ?? null, "p:cNvPr")[0] ?? null;
    const sid = attr(cNvPr, "id");
    if (sid) ctx.spids?.set(sid, obj);
    // object-level hyperlink: cNvPr/a:hlinkClick r:id → rels
    const rid = attr(children(cNvPr, "a:hlinkClick")[0] ?? null, "r:id");
    const href = rid ? ctx.rels.get(rid) : undefined;
    if (href && /^[a-z][a-z0-9+.-]*:/i.test(href)) obj.link = href;
  }
  return obj;
}

async function parsePic(pic: Element, ctx: Ctx): Promise<SlideObject | null> {
  const spPr = children(pic, "p:spPr")[0];
  const xfrm = children(spPr ?? null, "a:xfrm")[0];
  const off = children(xfrm ?? null, "a:off")[0];
  const ext = children(xfrm ?? null, "a:ext")[0];
  const nvPr = children(children(pic, "p:nvPicPr")[0] ?? null, "p:nvPr")[0];
  const name = attr(children(children(pic, "p:nvPicPr")[0] ?? null, "p:cNvPr")[0] ?? null, "name") ?? "image";
  const rot = attr(xfrm ?? null, "rot");
  const rotate = rot ? Math.round(Number(rot) / 60000) : undefined;
  const pos = {
    x: emu(attr(off, "x")), y: emu(attr(off, "y")),
    w: Math.max(16, emu(attr(ext, "cx"), 100)), h: Math.max(16, emu(attr(ext, "cy"), 100)),
    rotate,
    imgFlipH: attr(xfrm ?? null, "flipH") === "1" || undefined,
    imgFlipV: attr(xfrm ?? null, "flipV") === "1" || undefined,
  };

  // P6.4 — video/audio files ride in as <a:videoFile>/<a:audioFile> rels on a p:pic
  const mediaEl = first(nvPr ?? null, "a:videoFile") ?? first(nvPr ?? null, "a:audioFile");
  if (mediaEl) {
    const mRid = attr(mediaEl, "r:link") ?? attr(mediaEl, "r:embed");
    const mTarget = mRid ? ctx.rels.get(mRid) : undefined;
    const mFile = mTarget ? ctx.zip.file(mTarget) : null;
    if (mFile) {
      const ext3 = mTarget!.split(".").pop()?.toLowerCase() ?? "mp4";
      const mm = mediaEl.tagName === "a:audioFile" ? "audio" : "video";
      const mimes: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4" };
      const b64 = await mFile.async("base64");
      return { id: newId(), type: "media", mediaKind: mm, mediaSrc: `data:${mimes[ext3] ?? `${mm}/*`};base64,${b64}`, alt: name, z: 0, ...pos };
    }
  }

  const blipFill = children(pic, "p:blipFill")[0];
  const blip = children(blipFill ?? null, "a:blip")[0];
  const rId = attr(blip ?? null, "r:embed");
  const target = rId ? ctx.rels.get(rId) : undefined;
  if (!target) return null;
  const file = ctx.zip.file(target);
  if (!file) return null;
  const ext2 = target.split(".").pop()?.toLowerCase() ?? "png";
  const b64 = await file.async("base64");
  // a:srcRect l/t/r/b are 1/1000 of a percent of the source image
  const sr = children(blipFill ?? null, "a:srcRect")[0];
  const pct = (n: string) => Math.max(0, Math.min(1, Number(attr(sr, n) ?? 0) / 100000));
  const imgCrop = sr ? { l: pct("l"), t: pct("t"), r: pct("r"), b: pct("b") } : undefined;
  // alphaModFix amt → opacity (1/1000 percent)
  const amt = attr(first(blip ?? null, "a:alphaModFix") ?? null, "amt");
  const imgOpacity = amt != null ? Math.max(0, Math.min(1, Number(amt) / 100000)) : undefined;
  return {
    id: newId(), type: "image", ...pos,
    imgCrop, imgOpacity,
    z: 0, src: `data:${MIME[ext2] ?? "image/png"};base64,${b64}`, alt: name,
  };
}

/** read cached pts (<c:pt idx><c:v>) from a strRef/numRef/strLit/numLit container */
function cachedPts(el: Element | null | undefined): string[] {
  if (!el) return [];
  const pts = [...el.getElementsByTagName("c:pt")]
    .map((p) => ({ idx: Number(attr(p, "idx") ?? 0), v: first(p, "c:v")?.textContent ?? "" }))
    .sort((a, b) => a.idx - b.idx);
  return pts.map((p) => p.v);
}

async function parseChart(gf: Element, ctx: Ctx): Promise<SlideObject | null> {
  const chartEl = first(gf, "c:chart");
  const rId = attr(chartEl ?? null, "r:id");
  const target = rId ? ctx.rels.get(rId) : undefined;
  const file = target ? ctx.zip.file(target) : null;
  if (!file) return null;
  const doc = new DOMParser().parseFromString(await file.async("text"), "text/xml");
  const de = doc.documentElement;
  const type = (first(de, "c:barChart") ?? first(de, "c:bar3DChart")) ? "bar"
    : (first(de, "c:pieChart") ?? first(de, "c:pie3DChart") ?? first(de, "c:doughnutChart") ?? first(de, "c:ofPieChart")) ? "pie"
    : (first(de, "c:lineChart") ?? first(de, "c:line3DChart") ?? first(de, "c:areaChart") ?? first(de, "c:area3DChart")
      ?? first(de, "c:scatterChart") ?? first(de, "c:radarChart") ?? first(de, "c:bubbleChart") ?? first(de, "c:stockChart")) ? "line"
    : null;
  if (!type) return null;

  const title = [...doc.getElementsByTagName("c:title")]
    .flatMap((t) => [...t.getElementsByTagName("a:t")].map((n) => n.textContent ?? ""))
    .join(" ").trim() || undefined;

  const series = [...doc.getElementsByTagName("c:ser")].map((ser) => {
    const name = cachedPts(first(ser, "c:tx"))[0] ?? "Series";
    const values = cachedPts(first(ser, "c:val")).map((v) => Number(v) || 0);
    return { name, values };
  });
  const labels = cachedPts(first(first(doc.documentElement, "c:ser") ?? null, "c:cat"));
  if (!series.length) return null;

  const xfrm = children(gf, "p:xfrm")[0];
  const off = children(xfrm ?? null, "a:off")[0];
  const ext = children(xfrm ?? null, "a:ext")[0];
  return {
    id: newId(), type: "chart",
    chart: { type, labels: labels.length ? labels : series[0].values.map((_, i) => `${i + 1}`), series, title },
    x: emu(attr(off, "x")), y: emu(attr(off, "y")), w: Math.max(120, emu(attr(ext, "cx"), 480)), h: Math.max(90, emu(attr(ext, "cy"), 270)),
    z: 0,
  };
}

/** p:cxnSp — connector lines; stCxn/endCxn reference target shapes by cNvPr
 *  @id and a connection-site index (0=top, 1=right, 2=bottom, 3=left cw). */
function parseCxnSp(el: Element, ctx: Ctx, ink: string, t: { ox: number; oy: number; sx: number; sy: number }): SlideObject | null {
  const spPr = children(el, "p:spPr")[0];
  const xfrm = children(spPr ?? null, "a:xfrm")[0];
  const off = children(xfrm ?? null, "a:off")[0];
  const ext = children(xfrm ?? null, "a:ext")[0];
  const x = emu(attr(off, "x")) * t.sx + t.ox;
  const y = emu(attr(off, "y")) * t.sy + t.oy;
  const w = emu(attr(ext, "cx")) * t.sx;
  const h = emu(attr(ext, "cy")) * t.sy;
  const flipH = attr(xfrm ?? null, "flipH") === "1";
  const flipV = attr(xfrm ?? null, "flipV") === "1";
  const rot = attr(xfrm ?? null, "rot");
  const prst = attr(children(spPr ?? null, "a:prstGeom")[0] ?? null, "prst") ?? "";
  const kind = /curvedConnector/.test(prst) ? "curve" as const : /bentConnector/.test(prst) ? "elbow" as const : "straight" as const;
  const ln = children(spPr ?? null, "a:ln")[0];
  const stroke = fillColor(ln, ink, ctx.scheme) ?? ink;
  const strokeW = attr(ln ?? null, "w") ? Math.max(1, Math.round(Number(attr(ln, "w")) / 12700)) : 2;
  // connection sites on a rect-ish shape run clockwise from the top
  const SITE: Record<number, "t" | "r" | "b" | "l"> = { 0: "t", 1: "r", 2: "b", 3: "l" };
  const cxn = (tag: string) => {
    const c = first(children(el, "p:nvCxnSpPr")[0] ?? null, tag);
    const id = attr(c ?? null, "id"), idx = attr(c ?? null, "idx");
    const obj = id ? ctx.spids?.get(id) : undefined;
    return obj ? { id: obj.id, side: SITE[Number(idx) % 4] ?? "t" } : undefined;
  };
  const x1 = x + (flipH ? w : 0), y1 = y + (flipV ? h : 0);
  const x2 = x + (flipH ? 0 : w), y2 = y + (flipV ? 0 : h);
  return {
    id: newId(), type: "connector",
    conn: { kind, x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2), from: cxn("a:stCxn"), to: cxn("a:endCxn") },
    ...connBox(x1, y1, x2, y2), z: 0, stroke, strokeW,
    rotate: rot ? Math.round(Number(rot) / 60000) : undefined,
  };
}

const connBox = (x1: number, y1: number, x2: number, y2: number) => ({
  x: Math.round(Math.min(x1, x2)), y: Math.round(Math.min(y1, y2)),
  w: Math.max(1, Math.round(Math.abs(x2 - x1))), h: Math.max(1, Math.round(Math.abs(y2 - y1))),
});

/** SmartArt — generators ship a pre-rendered copy of the diagram as
 *  ppt/diagrams/drawingN.xml (dsp: namespace mirrors p:). Import that shape
 *  tree and fit it into the frame's rect. */
async function parseDiagram(gf: Element, ctx: Ctx, ink: string): Promise<SlideObject[]> {
  const relIds = first(gf, "dgm:relIds") ?? first(first(gf, "a:graphicData") ?? null, "dgm:relIds");
  const rid = attr(relIds ?? null, "r:dm") ?? attr(relIds ?? null, "r:id");
  const target = rid ? ctx.rels.get(rid) : undefined;
  const file = target ? ctx.zip.file(target) : null;
  if (!file) return [];
  const dir = target!.slice(0, target!.lastIndexOf("/"));
  const nm = target!.slice(target!.lastIndexOf("/") + 1);
  const rels = await parseRels(ctx.zip, `${dir}/_rels/${nm}.rels`, dir);
  // dsp: → p: so the shape-tree parser applies unchanged
  const xml = (await file.async("text")).replace(/\bdsp:/g, "p:");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const tree = doc.getElementsByTagName("p:spTree")[0];
  const ctx2: Ctx = { ...ctx, rels, base: dir, phGeom: undefined, phGeomMaster: undefined };
  const objects: SlideObject[] = [];
  await parseChildren(tree ?? doc.documentElement, ctx2, ink, { ox: 0, oy: 0, sx: 1, sy: 1 }, objects);
  if (!objects.length) return [];
  // normalize the drawing's bbox onto the graphicFrame rect
  const xfrm = children(gf, "p:xfrm")[0];
  const fx = emu(attr(children(xfrm ?? null, "a:off")[0], "x")), fy = emu(attr(children(xfrm ?? null, "a:off")[0], "y"));
  const fw = emu(attr(children(xfrm ?? null, "a:ext")[0], "cx"), 400), fh = emu(attr(children(xfrm ?? null, "a:ext")[0], "cy"), 300);
  const box = (o: SlideObject) => o.type === "connector" && o.conn
    ? { x: Math.min(o.conn.x1, o.conn.x2), y: Math.min(o.conn.y1, o.conn.y2), w: Math.abs(o.conn.x2 - o.conn.x1), h: Math.abs(o.conn.y2 - o.conn.y1) }
    : o;
  const x0 = Math.min(...objects.map((o) => box(o).x)), y0 = Math.min(...objects.map((o) => box(o).y));
  const bw = Math.max(1, Math.max(...objects.map((o) => box(o).x + box(o).w)) - x0);
  const bh = Math.max(1, Math.max(...objects.map((o) => box(o).y + box(o).h)) - y0);
  const sx = fw / bw, sy = fh / bh;
  for (const o of objects) {
    o.x = fx + (o.x - x0) * sx; o.y = fy + (o.y - y0) * sy;
    o.w *= sx; o.h *= sy;
    if (o.conn) { o.conn.x1 = fx + (o.conn.x1 - x0) * sx; o.conn.x2 = fx + (o.conn.x2 - x0) * sx; o.conn.y1 = fy + (o.conn.y1 - y0) * sy; o.conn.y2 = fy + (o.conn.y2 - y0) * sy; }
  }
  objects.forEach((o, i) => { o.z = i; });
  return objects;
}

async function parseGraphicFrame(gf: Element, ctx: Ctx, ink: string): Promise<SlideObject | SlideObject[] | null> {
  const uri = attr(first(gf, "a:graphicData") ?? null, "uri") ?? "";
  if (uri.includes("chart")) return parseChart(gf, ctx);
  if (uri.includes("diagram")) return parseDiagram(gf, ctx, ink);
  const tbl = first(gf, "a:tbl");
  const xfrm = children(gf, "p:xfrm")[0];
  const off = children(xfrm ?? null, "a:off")[0];
  const ext = children(xfrm ?? null, "a:ext")[0];
  const frame = { x: emu(attr(off, "x")), y: emu(attr(off, "y")), w: Math.max(80, emu(attr(ext, "cx"), 400)), h: Math.max(40, emu(attr(ext, "cy"), 120)) };
  if (uri.includes("oleObject")) {
    // no renderable payload in a graphicFrame — keep a labeled placeholder
    // so the object's footprint isn't silently lost
    const prog = attr(first(gf, "p:oleObj") ?? null, "progId") ?? "Embedded object";
    return { id: newId(), type: "shape", shape: "rect", ...frame, z: 0, fill: "#F0F0F0", stroke: "#999999", html: `<i>📎 ${prog.replace(/</g, "&lt;")}</i>`, fontSize: 14, color: ink, align: "center" };
  }
  if (!tbl) return null;
  // a:tblGrid/a:gridCol widths (EMU) → proportional column widths for render
  const colWidths = children(children(tbl, "a:tblGrid")[0] ?? null, "a:gridCol")
    .map((gc) => Math.max(1, emu(attr(gc, "w"), 1)));
  const cellStyle: NonNullable<SlideObject["tableMeta"]>["cellStyle"] = {};
  const merges: NonNullable<NonNullable<SlideObject["tableMeta"]>["merges"]> = [];
  const rows: string[][] = children(tbl, "a:tr").map((tr, r) =>
    children(tr, "a:tc").map((tc, c) => {
      const { html } = textBodyToHtml(children(tc, "a:txBody")[0] ?? null, ink, ctx.scheme, ctx.rels);
      const rs = Math.max(1, Number(attr(tc, "rowSpan") ?? 1));
      const cs = Math.max(1, Number(attr(tc, "gridSpan") ?? 1));
      if (rs > 1 || cs > 1) merges.push({ r, c, rs, cs });
      const fill = fillColor(children(tc, "a:tcPr")[0] ?? null, ink, ctx.scheme);
      if (fill) cellStyle[`${r},${c}`] = { bg: fill };
      return html.replace(/<\/div>/g, " ").replace(/<br\/>/g, " ").replace(/<[^>]+>/g, "").trim();
    }));
  const tableMeta: SlideObject["tableMeta"] = {};
  if (colWidths.length) tableMeta.colWidths = colWidths;
  if (Object.keys(cellStyle).length) tableMeta.cellStyle = cellStyle;
  if (merges.length) tableMeta.merges = merges;
  return {
    id: newId(), type: "table", table: rows.length ? rows : [["", ""]],
    ...(Object.keys(tableMeta).length ? { tableMeta } : {}),
    ...frame,
    z: 0, fontSize: 14, color: ink,
  };
}

async function parseChildren(parent: Element | null, ctx: Ctx, ink: string, t: { ox: number; oy: number; sx: number; sy: number }, out: SlideObject[]) {
  const deferred: { el: Element; t: typeof t }[] = [];
  for (const el of [...(parent?.children ?? [])]) {
    if (el.tagName === "p:cxnSp") { deferred.push({ el, t }); continue; } // after shapes so stCxn/endCxn resolve
    if (el.tagName === "p:sp") {
      const o = await parseSp(el, ctx, ink, ctx.scheme, t);
      if (o) out.push(o);
    } else if (el.tagName === "p:pic") {
      const o = await parsePic(el, ctx);
      if (o) out.push(o);
    } else if (el.tagName === "p:graphicFrame") {
      const o = await parseGraphicFrame(el, ctx, ink);
      if (o) out.push(...(Array.isArray(o) ? o : [o]));
    } else if (el.tagName === "p:grpSp") {
      const gspPr = children(el, "p:grpSpPr")[0];
      const gx = children(gspPr ?? null, "a:xfrm")[0];
      const goff = children(gx ?? null, "a:off")[0];
      const gext = children(gx ?? null, "a:ext")[0];
      const coff = children(gx ?? null, "a:chOff")[0];
      const cext = children(gx ?? null, "a:chExt")[0];
      const sx = cext ? emu(attr(gext, "cx"), 1) / Math.max(1, emu(attr(cext, "cx"), 1)) : 1;
      const sy = cext ? emu(attr(gext, "cy"), 1) / Math.max(1, emu(attr(cext, "cy"), 1)) : 1;
      const added = out.length;
      await parseChildren(el, ctx, ink, {
        ox: t.ox + emu(attr(goff, "x")) * t.sx - (coff ? emu(attr(coff, "x")) * sx * t.sx : 0),
        oy: t.oy + emu(attr(goff, "y")) * t.sy - (coff ? emu(attr(coff, "y")) * sy * t.sy : 0),
        sx: t.sx * sx, sy: t.sy * sy,
      }, out);
      // group rot (1/60000°) — children were flattened into slide coords, so
      // rotate each added object about the group's bounding-rect center
      const grot = Number(attr(gx, "rot") ?? 0) / 60000;
      if (grot && out.length > added) {
        const rad = grot * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        const gcx = t.ox + (emu(attr(goff, "x")) + emu(attr(gext, "cx")) / 2) * t.sx;
        const gcy = t.oy + (emu(attr(goff, "y")) + emu(attr(gext, "cy")) / 2) * t.sy;
        const rotPt = (x: number, y: number) => {
          const dx = x - gcx, dy = y - gcy;
          return { x: gcx + dx * cos - dy * sin, y: gcy + dx * sin + dy * cos };
        };
        for (const o of out.slice(added)) {
          if (o.conn) {
            const p1 = rotPt(o.conn.x1, o.conn.y1), p2 = rotPt(o.conn.x2, o.conn.y2);
            o.conn.x1 = p1.x; o.conn.y1 = p1.y; o.conn.x2 = p2.x; o.conn.y2 = p2.y;
          }
          const c = rotPt(o.x + o.w / 2, o.y + o.h / 2);
          o.x = c.x - o.w / 2; o.y = c.y - o.h / 2;
          o.rotate = ((o.rotate ?? 0) + grot + 360) % 360;
        }
      }
    }
  }
  for (const d of deferred) {
    const o = parseCxnSp(d.el, ctx, ink, d.t);
    if (o) out.push(o);
  }
}

async function parseRels(zip: import("jszip"), relsPath: string, base: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const file = zip.file(relsPath);
  if (!file) return map;
  const doc = new DOMParser().parseFromString(await file.async("text"), "text/xml");
  for (const rel of [...doc.getElementsByTagName("Relationship")]) {
    const target = rel.getAttribute("Target") ?? "";
    const segs = (target.startsWith("/") ? target.slice(1) : `${base}/${target}`).split("/");
    const norm: string[] = [];
    for (const s of segs) { if (s === "..") norm.pop(); else if (s !== ".") norm.push(s); }
    map.set(rel.getAttribute("Id") ?? "", norm.join("/"));
  }
  return map;
}

/** pull the color scheme + major font from ppt/theme/themeN.xml */
async function parseTheme(zip: import("jszip")): Promise<{ theme?: Theme; scheme: Record<string, string> }> {
  const scheme: Record<string, string> = {};
  const file = zip.file(/ppt\/theme\/theme\d+\.xml/)[0];
  if (!file) return { scheme };
  const doc = new DOMParser().parseFromString(await file.async("text"), "text/xml");
  const clr = (el: Element | null | undefined): string | undefined => {
    const v = attr(first(el ?? null, "a:srgbClr") ?? null, "val")
      ?? attr(first(el ?? null, "a:sysClr") ?? null, "lastClr");
    return v ? `#${v}` : undefined;
  };
  const cs = first(doc.documentElement, "a:clrScheme");
  for (const name of ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"]) {
    const c = clr(children(cs ?? null, `a:${name}`)[0]);
    if (c) scheme[name] = c;
  }
  const majorFont = first(doc.documentElement, "a:majorFont");
  const font = attr(children(majorFont ?? null, "a:latin")[0] ?? null, "typeface");
  const theme: Theme = {
    id: "imported", name: "Imported",
    bg: scheme.lt1 ?? "#FFFFFF", ink: scheme.dk1 ?? "#171717",
    accent: scheme.accent1 ?? "#F2782E", soft: scheme.lt2 ?? "#FFF1E8",
    font: font || "Inter",
  };
  return { theme, scheme };
}

// ─── P6.2 — deeper PPTX fidelity: slide size, master/layout, timing, transitions ───

/** map an OOXML animEffect filter + presetClass to our AnimType */
function animTypeFor(filter: string, cls: string): import("./model").AnimType {
  const entr: Record<string, import("./model").AnimType> = {
    fade: "fade", appear: "fade", blinds: "wipe", box: "zoom", checkerboard: "wipe",
    circle: "zoom", diamond: "zoom", dissolve: "fade", fly: "slide-up",
    randombars: "wipe", spiral: "spin-in", split: "wipe", strips: "wipe",
    swivel: "spin-in", wedge: "zoom", wheel: "spin-in", wipe: "wipe", zoom: "zoom",
    float: "float", slide: "slide-left",
  };
  const emph: Record<string, import("./model").AnimType> = {
    pulse: "pulse", grow: "grow", shrink: "grow", spin: "spin-in", shake: "shake",
    colorwave: "color", brush: "color",
  };
  const exit: Record<string, import("./model").AnimType> = {
    fade: "fade-out", dissolve: "fade-out", fly: "slide-out", zoom: "zoom-out",
    wipe: "wipe-out", blinds: "wipe-out",
  };
  const map = cls === "exit" ? exit : cls === "emph" ? emph : entr;
  return map[filter] ?? (cls === "exit" ? "fade-out" : cls === "emph" ? "pulse" : "fade");
}

/** parse p:timing — walk effect cTn's in document order, map spid→object anims */
function parseTiming(doc: Document, spids: Map<string, SlideObject>) {
  const timing = doc.getElementsByTagName("p:timing")[0];
  if (!timing) return;
  let order = 0;
  for (const cTn of [...timing.getElementsByTagName("p:cTn")]) {
    const cls = attr(cTn, "presetClass");
    if (!cls || cls === "mediacall") continue;
    const spid = attr(first(cTn, "p:spTgt") ?? null, "spid");
    const obj = spid ? spids.get(spid) : undefined;
    if (!obj) continue;
    const effect = first(cTn, "p:animEffect") ?? first(cTn, "p:set") ?? first(cTn, "p:anim");
    const filter = attr(effect ?? null, "filter")?.split(" ")[0] ?? "fade";
    const dur = Number(attr(cTn, "dur") ?? 0) || undefined;
    const condDelay = attr(first(cTn, "p:cond") ?? null, "delay");
    const delay = condDelay && condDelay !== "indefinite" ? Number(condDelay) || undefined : undefined;
    const trigEl = attr(cTn, "nodeType");
    obj.anim = {
      type: animTypeFor(filter, cls), order: order++,
      duration: dur, delay,
      trigger: trigEl === "withEffect" || delay !== undefined && !attr(first(cTn, "p:cond") ?? null, "evt") ? "with" : "click",
    } as SlideObject["anim"];
  }
}

/** parse p:transition on a slide element → our transition spec */
function parseTransition(doc: Document): Slide["transition"] | undefined {
  const tr = doc.getElementsByTagName("p:transition")[0];
  if (!tr) return undefined;
  const dur = attr(tr, "dur") ?? attr(tr, "spd");
  const durMs = dur && /^\d+$/.test(dur) ? Number(dur) : dur === "slow" ? 900 : dur === "fast" ? 350 : undefined;
  const dirMap: Record<string, "l" | "r" | "t" | "b"> = { l: "l", r: "r", u: "t", d: "b" };
  for (const el of [...tr.children]) {
    const name = el.tagName.replace(/^p:/, "");
    const type: Record<string, import("./model").TransitionType> = {
      fade: "fade", push: "push", wipe: "wipe", split: "split", blinds: "blinds",
      dissolve: "dissolve", morph: "morph", flip: "flip", cover: "cover", zoom: "zoom",
      newsflash: "zoom", pull: "push", wheel: "dissolve", circle: "zoom",
    };
    if (type[name]) {
      const dir = dirMap[attr(el, "dir") ?? ""] ?? undefined;
      return { type: type[name], duration: durMs, dir };
    }
  }
  return { type: "fade", duration: durMs };
}

/** parse a slide layout/master part into objects (placeholders skipped) */
async function parsePartObjects(zip: import("jszip"), parser: DOMParser, path: string, scheme: Record<string, string>, ink: string): Promise<SlideObject[]> {
  const file = zip.file(path);
  if (!file) return [];
  const dir = path.slice(0, path.lastIndexOf("/"));
  const name = path.slice(path.lastIndexOf("/") + 1);
  const rels = await parseRels(zip, `${dir}/_rels/${name}.rels`, dir);
  const ctx: Ctx = { zip, rels, base: dir, scheme, skipPh: true };
  const doc = parser.parseFromString(await file.async("text"), "text/xml");
  const tree = doc.getElementsByTagName("p:spTree")[0];
  const objects: SlideObject[] = [];
  await parseChildren(tree ?? doc.documentElement, ctx, ink, { ox: 0, oy: 0, sx: 1, sy: 1 }, objects);
  objects.forEach((o, i) => { o.z = i; });
  return objects;
}

/** layout/master part → placeholder geometry map ("type:idx" → EMU xfrm).
 *  Slide placeholders that omit their own a:xfrm inherit from this. */
async function parsePhGeom(zip: import("jszip"), parser: DOMParser, path: string): Promise<Map<string, PhGeom>> {
  const map = new Map<string, PhGeom>();
  const file = zip.file(path);
  if (!file) return map;
  const doc = parser.parseFromString(await file.async("text"), "text/xml");
  for (const sp of [...doc.getElementsByTagName("p:sp"), ...doc.getElementsByTagName("p:pic")]) {
    const ph = phEl(sp);
    if (!ph) continue;
    const xfrm = children(children(sp, "p:spPr")[0] ?? null, "a:xfrm")[0];
    const off = children(xfrm ?? null, "a:off")[0];
    const ext = children(xfrm ?? null, "a:ext")[0];
    if (!off || !ext) continue;
    const key = `${attr(ph, "type") ?? "obj"}:${attr(ph, "idx") ?? "0"}`;
    if (!map.has(key))
      map.set(key, {
        x: Number(attr(off, "x") ?? 0), y: Number(attr(off, "y") ?? 0),
        cx: Number(attr(ext, "cx") ?? 0), cy: Number(attr(ext, "cy") ?? 0),
        rot: attr(xfrm ?? null, "rot") != null ? Number(attr(xfrm, "rot")) : undefined,
      });
  }
  return map;
}

/** Import a .pptx/.potx file into a Deck (best-effort OOXML mapping) */
export async function importPptx(file: File): Promise<Deck> {
  const JSZip = (await import("jszip")).default;
  file = await ensureDecryptedFile(file); // password-protected OOXML → ZIP
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const parser = new DOMParser();
  const { theme: importedTheme, scheme } = await parseTheme(zip);
  const ink = importedTheme?.ink ?? "#171717";

  // slide order from presentation.xml + its rels
  const presDoc = parser.parseFromString(await zip.file("ppt/presentation.xml")!.async("text"), "text/xml");
  const presRels = await parseRels(zip, "ppt/_rels/presentation.xml.rels", "ppt");
  const slidePaths: string[] = [];
  for (const sldId of [...presDoc.getElementsByTagName("p:sldId")]) {
    const rId = sldId.getAttribute("r:id");
    const target = rId ? presRels.get(rId) : undefined;
    if (target) slidePaths.push(target);
  }

  // P6.2 — real slide size (PPTX widescreen is 12192000×6858000 EMU = 1280×720px @96dpi)
  const sldSz = first(presDoc.documentElement, "p:sldSz");
  const slideW = Math.max(320, Math.round(Number(attr(sldSz, "cx") ?? 0) * EMU)) || 960;
  const slideH = Math.max(240, Math.round(Number(attr(sldSz, "cy") ?? 0) * EMU)) || 540;

  // P6.2 — first slide master → deck.master (non-placeholder objects)
  const masterPaths = zip.file(/ppt\/slideMasters\/slideMaster\d+\.xml$/).map((f) => f.name).sort();
  const master = masterPaths.length ? await parsePartObjects(zip, parser, masterPaths[0], scheme, ink) : undefined;
  // placeholder geometry from master — layouts that omit a ph xfrm fall back here
  const masterPhGeom = masterPaths.length ? await parsePhGeom(zip, parser, masterPaths[0]) : new Map<string, PhGeom>();

  // P6.2 — layouts → deck.layouts, keyed by basename; slides link via their layout rel
  const layoutCache = new Map<string, SlideObject[]>();
  const layoutPhGeom = new Map<string, Map<string, PhGeom>>();
  const layoutKey = (path: string) => `ly_${path.slice(path.lastIndexOf("/") + 1).replace(/\D/g, "") || "x"}`;
  const getLayout = async (path: string) => {
    if (!layoutCache.has(path)) layoutCache.set(path, await parsePartObjects(zip, parser, path, scheme, ink));
    return layoutCache.get(path)!;
  };
  const getLayoutPhGeom = async (path: string) => {
    if (!layoutPhGeom.has(path)) layoutPhGeom.set(path, await parsePhGeom(zip, parser, path));
    return layoutPhGeom.get(path)!;
  };

  const slides: Slide[] = [];
  for (const path of slidePaths) {
    const file = zip.file(path);
    if (!file) continue;
    const dir = path.slice(0, path.lastIndexOf("/"));
    const name = path.slice(path.lastIndexOf("/") + 1);
    const rels = await parseRels(zip, `${dir}/_rels/${name}.rels`, dir);
    const spids = new Map<string, SlideObject>();
    // resolve layout first — its placeholder geometry fills slide shapes
    // that omit their own a:xfrm
    const layoutTarget = [...rels.entries()].find(([, t]) => t.includes("slideLayouts"))?.[1];
    const phGeom = layoutTarget ? await getLayoutPhGeom(layoutTarget) : undefined;
    const ctx: Ctx = { zip, rels, base: dir, scheme, spids, phGeom, phGeomMaster: masterPhGeom };
    const doc = parser.parseFromString(await file.async("text"), "text/xml");
    const tree = doc.getElementsByTagName("p:spTree")[0];
    const objects: SlideObject[] = [];
    await parseChildren(tree ?? doc.documentElement, ctx, ink, { ox: 0, oy: 0, sx: 1, sy: 1 }, objects);
    objects.forEach((o, i) => { o.z = i; });

    // P6.2 — slide layout link + animation timing + transition
    const layout = layoutTarget ? layoutKey(layoutTarget) : undefined;
    if (layoutTarget) void getLayout(layoutTarget);
    parseTiming(doc, spids);
    const transition = parseTransition(doc);

    // explicit slide background
    const bgPr = children(first(doc.documentElement, "p:bg") ?? null, "p:bgPr")[0];
    const bg = fillColor(bgPr ?? null, ink, scheme);

    // speaker notes — only the notes-body placeholder (skip sldNum/sldImg/etc.)
    let notes: string | undefined;
    const notesTarget = [...rels.entries()].find(([, t]) => t.includes("notesSlides"))?.[1];
    if (notesTarget && zip.file(notesTarget)) {
      const ndoc = parser.parseFromString(await zip.file(notesTarget)!.async("text"), "text/xml");
      for (const sp of [...ndoc.getElementsByTagName("p:sp")]) {
        const ph = first(children(children(sp, "p:nvSpPr")[0] ?? null, "p:nvPr")[0] ?? null, "p:ph");
        if (attr(ph ?? null, "type") === "body") {
          const texts: string[] = [];
          for (const t of [...sp.getElementsByTagName("a:t")]) texts.push(t.textContent ?? "");
          notes = texts.join(" ").trim() || undefined;
          if (notes) break;
        }
      }
    }
    // P6.2 — hidden slides ride a show="0" attr on p:sld
    const hidden = attr(doc.documentElement, "show") === "0" || undefined;
    slides.push({ id: newId(), objects, notes, bg, layout, transition, hidden });
  }

  const layouts: Record<string, SlideObject[]> = {};
  layoutCache.forEach((objs, path) => { if (objs.length) layouts[layoutKey(path)] = objs; });

  return {
    theme: "kreatix",
    customTheme: importedTheme,
    slides: slides.length ? slides : [{ id: newId(), objects: [] }],
    slideW, slideH,
    master: master?.length ? master : undefined,
    layouts: Object.keys(layouts).length ? layouts : undefined,
  };
}

// ─── P6.1 — ODP (OpenDocument Presentation) import ────────────────────────────

const CM = 96 / 2.54;
const cm = (v: string | null | undefined, dflt = 0) => {
  if (v == null) return dflt;
  const m = /^([\d.]+)\s*(cm|in|mm|pt|px)?/.exec(v);
  if (!m) return dflt;
  const n = Number(m[1]);
  const u = m[2] ?? "cm";
  return u === "in" ? Math.round(n * 96) : u === "mm" ? Math.round(n * CM / 10)
    : u === "pt" ? Math.round(n * 96 / 72) : u === "px" ? Math.round(n)
    : Math.round(n * CM);
};
const odpColor = (v: string | null | undefined) =>
  v && v !== "none" && v !== "transparent" ? v : undefined;

interface OdpStyle { fill?: string; stroke?: string; strokeW?: number; fontSize?: number; color?: string; bold?: boolean; italic?: boolean; align?: "left" | "center" | "right" }

function odpStyles(doc: Document): Map<string, OdpStyle> {
  const map = new Map<string, OdpStyle>();
  for (const st of [...doc.getElementsByTagName("style:style")]) {
    const name = st.getAttribute("style:name");
    if (!name) continue;
    const out: OdpStyle = {};
    const gp = st.getElementsByTagName("style:graphic-properties")[0];
    if (gp) {
      if (gp.getAttribute("draw:fill") === "solid") out.fill = odpColor(gp.getAttribute("draw:fill-color"));
      if (gp.getAttribute("draw:stroke") !== "none")
        out.stroke = odpColor(gp.getAttribute("svg:stroke-color")) ?? "#171717";
      const sw = gp.getAttribute("svg:stroke-width");
      if (sw) out.strokeW = Math.max(1, cm(sw, 1));
    }
    const tp = st.getElementsByTagName("style:text-properties")[0];
    if (tp) {
      const fs = tp.getAttribute("fo:font-size") ?? tp.getAttribute("style:font-size");
      if (fs) out.fontSize = cm(fs);
      out.color = odpColor(tp.getAttribute("fo:color"));
      if (tp.getAttribute("fo:font-weight") === "bold") out.bold = true;
      if (tp.getAttribute("fo:font-style") === "italic") out.italic = true;
    }
    const pp = st.getElementsByTagName("style:paragraph-properties")[0];
    const ta = pp?.getAttribute("fo:text-align");
    if (ta === "center" || ta === "right") out.align = ta;
    const parent = st.getAttribute("style:parent-style-name");
    if (parent) (out as OdpStyle & { __p?: string }).__p = parent;
    map.set(name, out);
  }
  return map;
}

/** resolve ODP style parent chains (common styles → parent-style-name) */
function odpResolve(map: Map<string, OdpStyle>): Map<string, OdpStyle> {
  const done = new Map<string, OdpStyle>();
  const get = (name: string, seen = new Set<string>()): OdpStyle => {
    if (done.has(name)) return done.get(name)!;
    if (seen.has(name)) return {};
    const s = map.get(name);
    if (!s) return {};
    seen.add(name);
    const parent = (s as OdpStyle & { __p?: string }).__p;
    const merged: OdpStyle = { ...(parent ? get(parent, seen) : {}), ...s };
    delete (merged as OdpStyle & { __p?: string }).__p;
    done.set(name, merged);
    return merged;
  };
  map.forEach((_, k) => get(k));
  return done;
}

/** text:p / text:list content → html string */
function odpTextHtml(el: Element | null): string {
  if (!el) return "";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const para = (p: Element) => esc(p.textContent ?? "").trim();
  const lines: string[] = [];
  for (const node of [...el.childNodes]) {
    if (!(node as Element).tagName) continue;
    const t = (node as Element).tagName;
    if (t === "text:p") { const s = para(node as Element); lines.push(s); }
    else if (t === "text:list" || t === "text:list-item") {
      for (const li of [...(node as Element).getElementsByTagName("text:p")])
        lines.push(`• ${para(li)}`);
    }
  }
  return lines.join("<br/>");
}

/** ODF chart object → series from the chart's embedded local-table */
async function odpChart(zip: import("jszip"), href: string): Promise<SlideObject["chart"] | undefined> {
  const base = href.replace(/^\.\//, "").replace(/\/$/, "");
  const file = zip.file(`${base}/content.xml`);
  if (!file) return undefined;
  const doc = new DOMParser().parseFromString(await file.async("text"), "text/xml");
  const tbl = doc.getElementsByTagName("table:table")[0];
  if (!tbl) return undefined;
  const rows = [...tbl.getElementsByTagName("table:table-row")].map((tr) =>
    [...tr.getElementsByTagName("table:table-cell")].map((tc) =>
      tc.getAttribute("office:value") ?? tc.textContent ?? ""));
  if (rows.length < 2) return undefined;
  const labels = rows[0].slice(1);
  const series = rows.slice(1).map((r) => ({ name: r[0] || "Series", values: r.slice(1).map((v) => Number(v) || 0) }));
  return { type: "bar", labels, series };
}

/** Import an .odp file into a Deck (best-effort ODF mapping) */
export async function importOdp(file: File): Promise<Deck> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const parser = new DOMParser();
  const contentFile = zip.file("content.xml");
  if (!contentFile) throw new Error("Not an ODP file (missing content.xml)");
  const doc = parser.parseFromString(await contentFile.async("text"), "text/xml");
  const styles = odpStyles(doc);
  // common named styles live in styles.xml — content.xml only carries automatic styles
  const stylesFile = zip.file("styles.xml");
  if (stylesFile) {
    const sdoc = parser.parseFromString(await stylesFile.async("text"), "text/xml");
    for (const [k, v] of odpStyles(sdoc)) if (!styles.has(k)) styles.set(k, v);
  }
  const resolved = odpResolve(styles);
  const stOf = (el: Element): OdpStyle => resolved.get(el.getAttribute("draw:style-name") ?? el.getAttribute("text:style-name") ?? "") ?? {};

  // page size from a page-layout-properties (first wins)
  let slideW = 960, slideH = 540;
  const pl = doc.getElementsByTagName("style:page-layout-properties")[0];
  if (pl) {
    slideW = cm(pl.getAttribute("fo:page-width"), 960);
    slideH = cm(pl.getAttribute("fo:page-height"), 540);
  }

  const geom = (el: Element) => ({
    x: cm(el.getAttribute("svg:x")), y: cm(el.getAttribute("svg:y")),
    w: Math.max(8, cm(el.getAttribute("svg:width"), 80)), h: Math.max(8, cm(el.getAttribute("svg:height"), 60)),
  });
  const textFields = (st: OdpStyle, html: string): Partial<SlideObject> =>
    ({ html, fontSize: st.fontSize, color: st.color, bold: st.bold, italic: st.italic, align: st.align });

  const slides: Slide[] = [];
  const pres = doc.getElementsByTagName("office:presentation")[0] ?? doc.documentElement;
  for (const page of [...pres.getElementsByTagName("draw:page")]) {
    if (page.parentElement?.tagName === "presentation:notes") continue;
    const objects: SlideObject[] = [];
    for (const el of [...page.children]) {
      const tag = el.tagName;
      const st = stOf(el);
      if (tag === "draw:frame") {
        const img = el.getElementsByTagName("draw:image")[0];
        const oTbl = el.getElementsByTagName("table:table")[0];
        const oObj = el.getElementsByTagName("draw:object")[0];
        if (oTbl) {
          // ODF table in a frame — rows × cells (repeated cells expand)
          const rows = [...oTbl.getElementsByTagName("table:table-row")].map((tr) => {
            const row: string[] = [];
            for (const tc of [...tr.getElementsByTagName("table:table-cell")]) {
              const rep = Math.min(64, Number(tc.getAttribute("table:number-columns-repeated") ?? 1));
              const txt = (tc.textContent ?? "").trim();
              for (let k = 0; k < rep; k++) row.push(txt);
            }
            return row;
          });
          objects.push({ id: newId(), type: "table", table: rows.length ? rows : [["", ""]], ...geom(el), z: objects.length, fontSize: 14, color: st.color ?? "var(--ink)" });
          continue;
        }
        if (oObj) {
          const chart = await odpChart(zip, oObj.getAttribute("xlink:href") ?? "");
          if (chart) { objects.push({ id: newId(), type: "chart", ...geom(el), z: objects.length, chart }); continue; }
        }
        if (img) {
          const href = img.getAttribute("xlink:href") ?? "";
          const target = href.replace(/^\.\//, "");
          const f = zip.file(target);
          if (f) {
            const ext = target.split(".").pop()?.toLowerCase() ?? "png";
            const b64 = await f.async("base64");
            objects.push({ id: newId(), type: "image", ...geom(el), z: objects.length, src: `data:${MIME[ext] ?? "image/png"};base64,${b64}`, alt: el.getAttribute("draw:name") ?? "image" });
          }
          continue;
        }
        const box = el.getElementsByTagName("draw:text-box")[0] ?? el;
        const html = odpTextHtml(box);
        const ph = el.getAttribute("presentation:class");
        if (!html.trim() && !ph) continue;
        objects.push({ id: newId(), type: "text", ...geom(el), z: objects.length, fontSize: 20, color: "var(--ink)", ...textFields(st, html) });
      } else if (tag === "draw:custom-shape" || tag === "draw:rect" || tag === "draw:ellipse" || tag === "draw:circle" || tag === "draw:path" || tag === "draw:polygon") {
        const html = odpTextHtml(el);
        const shape = tag === "draw:ellipse" || tag === "draw:circle" ? "ellipse" : "rect";
        objects.push({
          id: newId(), type: "shape", shape, ...geom(el), z: objects.length,
          fill: st.fill ?? "transparent", stroke: st.stroke ?? "none", strokeW: st.strokeW,
          ...(html.trim() ? textFields(st, html) : {}),
        });
      } else if (tag === "draw:line" || tag === "draw:connector") {
        const x1 = cm(el.getAttribute("svg:x1")), y1 = cm(el.getAttribute("svg:y1"));
        const x2 = cm(el.getAttribute("svg:x2")), y2 = cm(el.getAttribute("svg:y2"));
        objects.push({ id: newId(), type: "line", x: x1, y: y1, w: Math.max(1, Math.abs(x2 - x1)), h: Math.max(1, Math.abs(y2 - y1)), x2: x2 - x1, y2: y2 - y1, z: objects.length, stroke: st.stroke ?? "#171717", strokeW: st.strokeW ?? 2 });
      }
    }
    // notes — presentation:notes/text:p
    let notes: string | undefined;
    for (const n of [...page.getElementsByTagName("presentation:notes")]) {
      const html = odpTextHtml(n).replace(/<br\/>/g, " ").replace(/<[^>]+>/g, "").trim();
      if (html) { notes = html; break; }
    }
    slides.push({ id: newId(), objects, notes });
  }
  return {
    theme: "kreatix",
    slides: slides.length ? slides : [{ id: newId(), objects: [] }],
    slideW, slideH,
  };
}
