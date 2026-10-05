import type { Deck, Slide, SlideObject } from "./model";
import { chartSeries, deckSize, resolveConn } from "./model";
import { saveFile } from "../lib/saveFile";

// slide px → inches at 96dpi
const IN = 1 / 96;
const px2in = (v: number) => v * IN;
const px2pt = (v: number) => v * 0.75;

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n").trim();
}

const hex = (c?: string) => (c ?? "#000000").replace("#", "");

/** Deck → .pptx bytes (no download side effect — used by tests + export). */
export async function exportPptxBytes(deck: Deck, title: string): Promise<ArrayBuffer> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  const dims = deckSize(deck);
  pptx.defineLayout({ name: "K", width: px2in(dims.w), height: px2in(dims.h) });
  pptx.layout = "K";
  pptx.title = title;

  for (const s of deck.slides) {
    const slide = pptx.addSlide();
    if (s.bgImage) slide.background = { data: s.bgImage };
    else if (s.bg) slide.background = { color: hex(s.bg) };
    for (const o of [...s.objects].sort((a, b) => a.z - b.z)) addObj(pptx, slide, o, s);
    if (s.notes) slide.addNotes(stripHtml(s.notes));
  }
  return (await pptx.write({ outputType: "arraybuffer" })) as ArrayBuffer;
}

export async function exportPptx(deck: Deck, title: string) {
  const buf = await exportPptxBytes(deck, title);
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
  void saveFile(blob, `${title.replace(/\.[^.]+$/, "")}.pptx`);
}

function addObj(pptx: InstanceType<typeof import("pptxgenjs").default>, slide: { addText: Function; addShape: Function; addImage: Function; addTable: Function; addChart: Function; addMedia?: Function }, o: SlideObject, s?: Slide) {
  const pos = { x: px2in(o.x), y: px2in(o.y), w: px2in(o.w), h: px2in(o.h), rotate: o.rotate ?? 0 };
  switch (o.type) {
    case "text":
      slide.addText(stripHtml(o.html ?? ""), {
        ...pos, fontSize: px2pt(o.fontSize ?? 20), color: hex(o.color ?? "#171717"),
        bold: o.bold, italic: o.italic, align: o.align ?? "left", fontFace: o.fontFamily ?? "Inter",
        valign: "top",
      });
      break;
    case "shape": {
      const map: Record<string, string> = {
        rect: pptx.ShapeType.rect, roundrect: pptx.ShapeType.roundRect,
        ellipse: pptx.ShapeType.ellipse, triangle: pptx.ShapeType.triangle,
        arrow: pptx.ShapeType.rightArrow, star: pptx.ShapeType.star5,
      };
      slide.addShape((map[o.shape ?? "rect"] ?? pptx.ShapeType.rect) as never, {
        ...pos,
        fill: { color: hex(o.fill ?? "#F2782E") },
        line: o.stroke === "none" ? { type: "none" } : { color: hex(o.stroke ?? "#F2782E"), width: o.strokeW ?? 1 },
      });
      break;
    }
    case "image":
      if (o.src) slide.addImage({ data: o.src, ...pos });
      break;
    case "table":
      slide.addTable((o.table ?? []).map((r) => r.map((c) => ({
        text: c, options: { fontSize: px2pt(o.fontSize ?? 14), color: hex(o.color ?? "#171717"), border: { pt: 0.75, color: "D8D2CC" } },
      }))), pos);
      break;
    case "chart": {
      const c = o.chart!;
      const types: Record<string, string> = { bar: pptx.ChartType.bar, line: pptx.ChartType.line, pie: pptx.ChartType.pie };
      slide.addChart(types[c.type] as never, chartSeries(c).map((s) => ({ name: s.name, labels: c.labels, values: s.values })), {
        ...pos, showTitle: !!c.title, title: c.title, chartColors: ["F2782E", "3578E5", "1F9D66", "D84B57", "8E6BC8"],
      });
      break;
    }
    case "line":
      slide.addShape(pptx.ShapeType.line, {
        x: px2in(o.x), y: px2in(o.y), w: px2in(o.x2 ?? o.w), h: px2in(o.y2 ?? 0),
        line: { color: hex(o.stroke ?? "#171717"), width: o.strokeW ?? 2, endArrowType: o.shape === "arrow" ? "triangle" : "none" },
      });
      break;
    case "connector": {
      // pptxgenjs has no connector shape types — emit a line with direction flips
      const p = s ? resolveConn(o, s) : { x1: o.x, y1: o.y, x2: o.x + o.w, y2: o.y + o.h };
      slide.addShape(pptx.ShapeType.line, {
        x: px2in(Math.min(p.x1, p.x2)), y: px2in(Math.min(p.y1, p.y2)),
        w: px2in(Math.abs(p.x2 - p.x1)), h: px2in(Math.abs(p.y2 - p.y1)),
        flipH: p.x2 < p.x1, flipV: p.y2 < p.y1,
        line: { color: hex(o.stroke ?? "#171717"), width: o.strokeW ?? 2, endArrowType: "triangle" },
      });
      break;
    }
    case "media":
      if (o.mediaSrc && slide.addMedia)
        slide.addMedia({ type: o.mediaKind ?? "video", data: o.mediaSrc, x: px2in(o.x), y: px2in(o.y), w: px2in(o.w), h: px2in(o.h) });
      break;
  }
}

