import type { Deck, SlideObject } from "./model";

// slide is 960×540 px → 10in × 5.625in at 96dpi
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

export async function exportPptx(deck: Deck, title: string) {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "K", width: 10, height: 5.625 });
  pptx.layout = "K";
  pptx.title = title;

  for (const s of deck.slides) {
    const slide = pptx.addSlide();
    if (s.bg) slide.background = { color: hex(s.bg) };
    for (const o of [...s.objects].sort((a, b) => a.z - b.z)) addObj(pptx, slide, o);
    if (s.notes) slide.addNotes(stripHtml(s.notes));
  }
  await pptx.writeFile({ fileName: `${title.replace(/\.[^.]+$/, "")}.pptx` });
}

function addObj(pptx: InstanceType<typeof import("pptxgenjs").default>, slide: { addText: Function; addShape: Function; addImage: Function; addTable: Function; addChart: Function }, o: SlideObject) {
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
      slide.addChart(types[c.type] as never, [{ name: "Series 1", labels: c.labels, values: c.values }], {
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
  }
}

