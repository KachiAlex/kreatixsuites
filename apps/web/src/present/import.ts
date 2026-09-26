import type { Deck, Slide, SlideObject, Theme } from "./model";
import { newId } from "./model";

// OOXML DrawingML units → px (960×540 deck, 96dpi)
const EMU = 1 / 9525;
const emu = (v: string | null | undefined, dflt = 0) => (v == null ? dflt : Math.round(Number(v) * EMU));
const pt = (v: string | null | undefined) => (v == null ? undefined : Math.round(Number(v) / 100 * (96 / 72)));

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", bmp: "image/bmp", webp: "image/webp" };

interface Ctx {
  zip: import("jszip");
  rels: Map<string, string>; // rId -> target path (resolved)
  base: string;              // directory of the current part, e.g. "ppt/slides"
  scheme: Record<string, string>; // schemeClr name -> resolved hex
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

function textBodyToHtml(tx: Element | null, ink: string, scheme: Record<string, string>): { html: string; fontSize?: number; color?: string; bold?: boolean; italic?: boolean; align?: "left" | "center" | "right" } {
  const paras = children(tx, "a:p");
  const out: string[] = [];
  let fontSize: number | undefined, color: string | undefined, bold = false, italic = false, align: "left" | "center" | "right" | undefined;
  for (const p of paras) {
    const pPr = children(p, "a:pPr")[0];
    const algn = attr(pPr ?? null, "algn");
    if (!align && algn) align = algn === "ctr" ? "center" : algn === "r" ? "right" : "left";
    if (children(pPr ?? null, "a:buChar").length || children(pPr ?? null, "a:buAutoNum").length) out.push("• ");
    for (const node of [...p.childNodes]) {
      const el = node as Element;
      if (el.tagName === "a:br") { out.push("<br/>"); continue; }
      if (el.tagName !== "a:r" && el.tagName !== "a:fld") continue;
      const t = first(el, "a:t");
      const text = t?.textContent ?? "";
      const rPr = children(el, "a:rPr")[0];
      if (rPr) {
        const sz = pt(attr(rPr, "sz"));
        if (sz && !fontSize) fontSize = sz;
        const col = fillColor(rPr, ink, scheme);
        if (col && !color) color = col;
        if (attr(rPr, "b") === "1") bold = true;
        if (attr(rPr, "i") === "1") italic = true;
      }
      out.push(text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    }
    out.push("<br/>");
  }
  return { html: out.join("").replace(/(<br\/>)+$/, ""), fontSize, color, bold, italic, align };
}

function shapeKind(prst: string | null | undefined): SlideObject["shape"] {
  const map: Record<string, SlideObject["shape"]> = {
    rect: "rect", roundRect: "roundrect", round1Rect: "roundrect", round2SameRect: "roundrect",
    ellipse: "ellipse", triangle: "triangle", rtTriangle: "triangle",
    rightArrow: "arrow", star5: "star",
  };
  return prst ? map[prst] : undefined;
}

async function parseSp(sp: Element, ink: string, scheme: Record<string, string>, transform: { ox: number; oy: number; sx: number; sy: number }): Promise<SlideObject | null> {
  const spPr = children(sp, "p:spPr")[0];
  const xfrm = children(spPr ?? null, "a:xfrm")[0];
  const off = children(xfrm ?? null, "a:off")[0];
  const ext = children(xfrm ?? null, "a:ext")[0];
  const x = emu(attr(off, "x")) * transform.sx + transform.ox;
  const y = emu(attr(off, "y")) * transform.sy + transform.oy;
  const w = Math.max(16, emu(attr(ext, "cx")) * transform.sx);
  const h = Math.max(16, emu(attr(ext, "cy")) * transform.sy);
  const rot = attr(xfrm ?? null, "rot");
  const prst = attr(children(spPr ?? null, "a:prstGeom")[0] ?? null, "prst");
  const tx = children(sp, "p:txBody")[0];
  const { html, fontSize, color, bold, italic, align } = textBodyToHtml(tx ?? null, ink, scheme);
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

  if (isPictureLike) {
    return { ...base, type: "line", x2: Math.round(w), y2: 0, stroke: stroke ?? ink, strokeW: strokeW ?? 2 };
  }
  if (kind && kind !== "rect" || hasFill || stroke) {
    // shape (may carry text)
    return { ...base, type: "shape", shape: kind ?? "rect", fill: fill ?? "transparent", stroke: stroke ?? "none", strokeW, html: hasText ? html : undefined, fontSize, color: color ?? "#FFFFFF", bold, italic, align };
  }
  if (hasText) {
    return { ...base, type: "text", html, fontSize: fontSize ?? 20, color: color ?? ink, bold, italic, align };
  }
  return null;
}

async function parsePic(pic: Element, ctx: Ctx): Promise<SlideObject | null> {
  const spPr = children(pic, "p:spPr")[0];
  const xfrm = children(spPr ?? null, "a:xfrm")[0];
  const off = children(xfrm ?? null, "a:off")[0];
  const ext = children(xfrm ?? null, "a:ext")[0];
  const blip = children(children(pic, "p:blipFill")[0] ?? null, "a:blip")[0];
  const rId = attr(blip ?? null, "r:embed");
  const target = rId ? ctx.rels.get(rId) : undefined;
  if (!target) return null;
  const file = ctx.zip.file(target);
  if (!file) return null;
  const ext2 = target.split(".").pop()?.toLowerCase() ?? "png";
  const b64 = await file.async("base64");
  const name = attr(children(children(pic, "p:nvPicPr")[0] ?? null, "p:cNvPr")[0] ?? null, "name") ?? "image";
  return {
    id: newId(), type: "image", x: emu(attr(off, "x")), y: emu(attr(off, "y")),
    w: Math.max(16, emu(attr(ext, "cx"), 100)), h: Math.max(16, emu(attr(ext, "cy"), 100)),
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
  const type = first(doc.documentElement, "c:barChart") ? "bar"
    : first(doc.documentElement, "c:pieChart") ? "pie"
    : (first(doc.documentElement, "c:lineChart") ?? first(doc.documentElement, "c:areaChart")) ? "line"
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

async function parseGraphicFrame(gf: Element, ctx: Ctx, ink: string): Promise<SlideObject | null> {
  const uri = attr(first(gf, "a:graphicData") ?? null, "uri") ?? "";
  if (uri.includes("chart")) return parseChart(gf, ctx);
  const tbl = first(gf, "a:tbl");
  const xfrm = children(gf, "p:xfrm")[0];
  const off = children(xfrm ?? null, "a:off")[0];
  const ext = children(xfrm ?? null, "a:ext")[0];
  if (!tbl) return null;
  const rows: string[][] = children(tbl, "a:tr").map((tr) =>
    children(tr, "a:tc").map((tc) => {
      const { html } = textBodyToHtml(children(tc, "a:txBody")[0] ?? null, ink, ctx.scheme);
      return html.replace(/<br\/>/g, " ").replace(/<[^>]+>/g, "").trim();
    }));
  return {
    id: newId(), type: "table", table: rows.length ? rows : [["", ""]],
    x: emu(attr(off, "x")), y: emu(attr(off, "y")), w: Math.max(80, emu(attr(ext, "cx"), 400)), h: Math.max(40, emu(attr(ext, "cy"), 120)),
    z: 0, fontSize: 14, color: ink,
  };
}

async function parseChildren(parent: Element | null, ctx: Ctx, ink: string, t: { ox: number; oy: number; sx: number; sy: number }, out: SlideObject[]) {
  for (const el of [...(parent?.children ?? [])]) {
    if (el.tagName === "p:sp") {
      const o = await parseSp(el, ink, ctx.scheme, t);
      if (o) out.push(o);
    } else if (el.tagName === "p:pic") {
      const o = await parsePic(el, ctx);
      if (o) out.push(o);
    } else if (el.tagName === "p:graphicFrame") {
      const o = await parseGraphicFrame(el, ctx, ink);
      if (o) out.push(o);
    } else if (el.tagName === "p:grpSp") {
      const gspPr = children(el, "p:grpSpPr")[0];
      const gx = children(gspPr ?? null, "a:xfrm")[0];
      const goff = children(gx ?? null, "a:off")[0];
      const gext = children(gx ?? null, "a:ext")[0];
      const coff = children(gx ?? null, "a:chOff")[0];
      const cext = children(gx ?? null, "a:chExt")[0];
      const sx = cext ? emu(attr(gext, "cx"), 1) / Math.max(1, emu(attr(cext, "cx"), 1)) : 1;
      const sy = cext ? emu(attr(gext, "cy"), 1) / Math.max(1, emu(attr(cext, "cy"), 1)) : 1;
      await parseChildren(el, ctx, ink, {
        ox: t.ox + emu(attr(goff, "x")) * t.sx - (coff ? emu(attr(coff, "x")) * sx * t.sx : 0),
        oy: t.oy + emu(attr(goff, "y")) * t.sy - (coff ? emu(attr(coff, "y")) * sy * t.sy : 0),
        sx: t.sx * sx, sy: t.sy * sy,
      }, out);
    }
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

/** Import a .pptx file into a Deck (best-effort OOXML mapping) */
export async function importPptx(file: File): Promise<Deck> {
  const JSZip = (await import("jszip")).default;
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

  const slides: Slide[] = [];
  for (const path of slidePaths) {
    const file = zip.file(path);
    if (!file) continue;
    const dir = path.slice(0, path.lastIndexOf("/"));
    const name = path.slice(path.lastIndexOf("/") + 1);
    const rels = await parseRels(zip, `${dir}/_rels/${name}.rels`, dir);
    const ctx: Ctx = { zip, rels, base: dir, scheme };
    const doc = parser.parseFromString(await file.async("text"), "text/xml");
    const tree = doc.getElementsByTagName("p:spTree")[0];
    const objects: SlideObject[] = [];
    await parseChildren(tree ?? doc.documentElement, ctx, ink, { ox: 0, oy: 0, sx: 1, sy: 1 }, objects);
    objects.forEach((o, i) => { o.z = i; });

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
    slides.push({ id: newId(), objects, notes, bg });
  }
  return {
    theme: "kreatix",
    customTheme: importedTheme,
    slides: slides.length ? slides : [{ id: newId(), objects: [] }],
  };
}
