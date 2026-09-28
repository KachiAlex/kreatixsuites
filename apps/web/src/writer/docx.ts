import {
  AlignmentType, ColumnBreak as DocxColumnBreak, Document, Footer, FootnoteReferenceRun,
  Header, HeadingLevel, ImageRun, Math as DocxMath, MathRun, Packer, Paragraph,
  PageBreak as DocxPageBreak, SectionType, Table, TableCell, TableRow,
  TextDirection, TextRun, VerticalAlignTable, WidthType,
  type File as DocxFile, type ISectionOptions, type ISectionPropertiesOptions,
} from "docx";
import mammoth from "mammoth";

type Json = Record<string, unknown>;

interface Mark { type: string; attrs?: Record<string, unknown> }
interface Inline { type: string; text?: string; marks?: Mark[]; attrs?: Record<string, unknown> }
interface Block {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Block[] | Inline[];
  text?: string;
  marks?: Mark[];
}

const HEADINGS: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4, 5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6,
};

const ALIGN: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED,
};

const footnoteTexts = new Map<string, string>();
let footnoteSeq = 0;

function textStyle(n: Inline | Block, inherited: Mark[]): { font?: string; color?: string; size?: number; highlight?: string } {
  const marks = [...inherited, ...(n.marks ?? [])];
  const ts = marks.find((m) => m.type === "textStyle")?.attrs;
  const hl = marks.find((m) => m.type === "highlight")?.attrs;
  return {
    font: (ts?.fontFamily as string | undefined)?.replace(/['"]/g, "").split(",")[0],
    color: (ts?.color as string | undefined)?.replace("#", ""),
    size: ts?.fontSize ? Math.round(parseInt(ts.fontSize as string) * 2) : undefined,
    highlight: (hl?.color as string | undefined)?.replace("#", ""),
  };
}

type Run = TextRun | FootnoteReferenceRun | ImageRun | DocxMath;

function inlineRuns(nodes: Inline[] | undefined, inherited: Mark[] = []): Run[] {
  return (nodes ?? []).flatMap((n): Run[] => {
    if (n.type === "hardBreak") return [new TextRun({ break: 1 })];
    if (n.type === "footnote") {
      footnoteSeq += 1;
      footnoteTexts.set(String(footnoteSeq), (n.attrs?.note as string) ?? "");
      return [new FootnoteReferenceRun(footnoteSeq)];
    }
    if (n.type === "inlineMath") {
      // native OMML equation zone — Word renders it as a real equation object
      // and can rebuild the LaTeX source from its equation editor
      return [new DocxMath({ children: [new MathRun((n.attrs?.latex as string) ?? "")] })];
    }
    if (n.type === "image") {
      const src = (n.attrs?.src as string) ?? "";
      const data = imgCache.get(src);
      if (!data) return [new TextRun({ text: "[image]" })];
      try {
        return [new ImageRun({
          type: src.startsWith("data:image/png") ? "png" : src.startsWith("data:image/jpeg") || src.startsWith("data:image/jpg") ? "jpg" : src.startsWith("data:image/gif") ? "gif" : "png",
          data,
          transformation: { width: Math.min(600, Number(n.attrs?.width) || 400), height: 300 },
          altText: { name: (n.attrs?.alt as string) ?? "image", title: (n.attrs?.alt as string) ?? "image", description: (n.attrs?.alt as string) ?? "" },
        })];
      } catch {
        return [new TextRun({ text: "[image]" })];
      }
    }
    if (n.type !== "text" || !n.text) return [];
    const marks = [...inherited, ...(n.marks ?? [])];
    const has = (t: string) => marks.some((m) => m.type === t);
    const st = textStyle(n, []);
    const link = marks.find((m) => m.type === "link");
    return [new TextRun({
      text: n.text,
      bold: has("bold") || undefined,
      italics: has("italic") || undefined,
      underline: has("underline") || link ? {} : undefined,
      strike: has("strike") || undefined,
      color: link ? "0563C1" : st.color,
      font: st.font,
      size: st.size,
      superScript: has("superscript") || undefined,
      subScript: has("subscript") || undefined,
    })];
  });
}

const imgCache = new Map<string, Uint8Array>();

/** Pre-fetch image bytes so they can be embedded in the docx. */
async function prefetchImages(doc: Block): Promise<void> {
  imgCache.clear();
  const jobs: Promise<void>[] = [];
  const collect = (n: Block | Inline) => {
    if (n.type === "image" && n.attrs?.src) {
      const src = n.attrs.src as string;
      jobs.push((async () => {
        try {
          if (src.startsWith("data:")) {
            const b64 = src.split(",")[1] ?? "";
            imgCache.set(src, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
          } else {
            const res = await fetch(src);
            if (res.ok) imgCache.set(src, new Uint8Array(await res.arrayBuffer()));
          }
        } catch { /* placeholder */ }
      })());
    }
    ((n as Block).content ?? []).forEach(collect);
  };
  (doc.content ?? []).forEach(collect);
  await Promise.all(jobs);
}

function spacing(node: Block) {
  const line = node.attrs?.lineHeight as string | undefined;
  const before = node.attrs?.spaceBefore as number | undefined;
  const after = node.attrs?.spaceAfter as number | undefined;
  if (!line && !before && !after) return undefined;
  return {
    line: line ? Math.round(parseFloat(line) * 240) : undefined,
    before: before ? before * 20 : undefined,
    after: after ? after * 20 : undefined,
  };
}

/** Word ▸ Paragraph ▸ Line and Page Breaks attrs → OOXML pPr props. */
function paginationProps(node: Block) {
  const a = node.attrs ?? {};
  return {
    pageBreakBefore: a.pageBreakBefore ? true : undefined,
    keepNext: a.keepNext ? true : undefined,
    keepLines: a.keepLines ? true : undefined,
    widowControl: a.widowOrphan ? true : undefined,
  };
}

function blockToParagraphs(node: Block): Paragraph[] {
  switch (node.type) {
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      return [new Paragraph({
        heading: HEADINGS[level] ?? HeadingLevel.HEADING_6,
        alignment: ALIGN[(node.attrs?.textAlign as string) ?? ""] as never,
        spacing: spacing(node),
        ...paginationProps(node),
        indent: node.attrs?.indent ? { left: (node.attrs.indent as number) * 480 } : undefined,
        children: inlineRuns(node.content as Inline[]) as never,
      })];
    }
    case "paragraph":
      return [new Paragraph({
        alignment: ALIGN[(node.attrs?.textAlign as string) ?? ""] as never,
        spacing: spacing(node),
        ...paginationProps(node),
        indent: node.attrs?.indent ? { left: (node.attrs.indent as number) * 480 } : undefined,
        children: inlineRuns(node.content as Inline[]) as never,
      })];
    case "blockquote":
      return (node.content as Block[]).flatMap(blockToParagraphs).map(
        (p) => new Paragraph({ ...p, indent: { left: 400 }, border: undefined }),
      );
    case "bulletList":
      return (node.content as Block[]).flatMap((li) =>
        (li.content as Block[]).flatMap((p) =>
          p.type === "paragraph"
            ? [new Paragraph({ bullet: { level: 0 }, children: inlineRuns(p.content as Inline[]) as never })]
            : blockToParagraphs(p),
        ),
      );
    case "orderedList":
      return (node.content as Block[]).flatMap((li, i) =>
        (li.content as Block[]).flatMap((p) =>
          p.type === "paragraph"
            ? [new Paragraph({ children: [new TextRun({ text: `${i + 1}. ` }), ...(inlineRuns(p.content as Inline[]) as TextRun[])] })]
            : blockToParagraphs(p),
        ),
      );
    case "taskList":
      return (node.content as Block[]).flatMap((li) =>
        (li.content as Block[]).flatMap((p) =>
          p.type === "paragraph"
            ? [new Paragraph({ children: [new TextRun({ text: li.attrs?.checked ? "☑ " : "☐ " }), ...(inlineRuns(p.content as Inline[]) as TextRun[])] })]
            : blockToParagraphs(p),
        ),
      );
    case "codeBlock":
      return [new Paragraph({
        shading: { fill: "F4F0EC" },
        children: [new TextRun({ text: textOf(node), font: "Consolas", size: 20 })],
      })];
    case "horizontalRule":
      return [new Paragraph({ children: [new TextRun({ text: "─".repeat(40), color: "BBBBBB" })] })];
    case "pageBreak":
      return [new Paragraph({ children: [new DocxPageBreak()] })];
    case "columnBreak":
      return [new Paragraph({ children: [new DocxColumnBreak()] })];
    case "sectionBreak":
      // handled at section-splitting level in exportDocxBytes
      return [];
    case "blockMath":
      return [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new DocxMath({ children: [new MathRun((node.attrs?.latex as string) ?? "")] })] as never,
      })];
    case "toc": {
      // TOC is live in-editor; export a static snapshot of headings
      return [];
    }
    case "embed":
      return [new Paragraph({ children: [new TextRun({ text: `Embedded content: ${(node.attrs?.src as string) ?? ""}` })] })];
    case "image": {
      const runs = inlineRuns([node as unknown as Inline]);
      return [new Paragraph({ children: runs as never })];
    }
    default:
      return [];
  }
}

function textOf(node: Block): string {
  return ((node.content ?? []) as (Block & Inline)[])
    .map((n) => ("text" in n && n.text) || textOf(n as Block))
    .join("");
}

const pxToDxa = (px: unknown): number | undefined =>
  typeof px === "number" && Number.isFinite(px) ? Math.round(px * 15) : undefined;

const DOCX_ALIGN: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT,
};

const DOCX_BORDER: Record<string, string> = {
  solid: "single", dashed: "dashed", dotted: "dotted", double: "double", none: "nil",
};

const VALIGN: Record<string, (typeof VerticalAlignTable)[keyof typeof VerticalAlignTable]> = {
  top: VerticalAlignTable.TOP, middle: VerticalAlignTable.CENTER, bottom: VerticalAlignTable.BOTTOM,
};

const TEXT_DIR: Record<string, (typeof TextDirection)[keyof typeof TextDirection]> = {
  "vertical-rl": TextDirection.TOP_TO_BOTTOM_RIGHT_TO_LEFT,
  "vertical-lr": TextDirection.BOTTOM_TO_TOP_LEFT_TO_RIGHT,
};

interface BorderSpec { style: string; width: number; color: string }
interface CellBorders { top?: BorderSpec; right?: BorderSpec; bottom?: BorderSpec; left?: BorderSpec }

const hex = (c: string) => c.replace(/^#/, "").toUpperCase();

function docxBorder(side?: BorderSpec) {
  if (!side) return undefined;
  const style = DOCX_BORDER[side.style] ?? "single";
  if (style === "nil") return { style: "nil", size: 0, color: "FFFFFF" };
  return {
    style,
    size: Math.max(1, Math.round(side.width * 6)), // eighths of a point ≈ px*6
    color: hex(side.color),
  };
}

function docxCell(c: Block): TableCell {
  const a = (c.attrs ?? {}) as Record<string, unknown>;
  const borders = a.borders as CellBorders | null | undefined;
  const pad = a.padding as number | null | undefined;
  const cw = Array.isArray(a.colwidth) ? (a.colwidth as number[])[0] : null;
  return new TableCell({
    children: ((c.content ?? []) as Block[]).flatMap(blockToParagraphs),
    columnSpan: (a.colspan as number) > 1 ? (a.colspan as number) : undefined,
    rowSpan: (a.rowspan as number) > 1 ? (a.rowspan as number) : undefined,
    width: cw ? { size: pxToDxa(cw)!, type: WidthType.DXA } : undefined,
    shading: a.backgroundColor ? { fill: hex(a.backgroundColor as string) } : undefined,
    verticalAlign: VALIGN[(a.vAlign as string) ?? ""] ?? VerticalAlignTable.TOP,
    textDirection: TEXT_DIR[(a.textDirection as string) ?? ""] ?? undefined,
    margins: pad != null
      ? { top: pxToDxa(pad), bottom: pxToDxa(pad), left: pxToDxa(pad), right: pxToDxa(pad), marginUnitType: WidthType.DXA }
      : undefined,
    borders: borders ? {
      top: docxBorder(borders.top), right: docxBorder(borders.right),
      bottom: docxBorder(borders.bottom), left: docxBorder(borders.left),
    } as never : undefined,
  });
}

function tableOf(node: Block): Table | null {
  const rows = (node.content ?? []) as Block[];
  if (!rows.length) return null;
  const ta = (node.attrs ?? {}) as Record<string, unknown>;

  // rowspan: the docx lib auto-generates <w:tc vMerge="continue"> placeholders
  // in the following rows from cell.options.rowSpan — no manual tracking needed.
  const tableRows = rows.map((r, ri) => {
    const ra = (r.attrs ?? {}) as Record<string, unknown>;
    const cells: TableCell[] = ((r.content ?? []) as Block[]).map(docxCell);
    return new TableRow({
      children: cells,
      tableHeader: ta.repeatHeader && ri === 0 ? true : undefined,
      cantSplit: ra.cantSplit ? true : undefined,
      height: ra.height ? {
        value: pxToDxa(ra.height as number)!,
        rule: (ra.heightMode === "exact" ? "exact" : "atLeast") as never,
      } : undefined,
    });
  });

  const firstRowCells = ((rows[0]?.content ?? []) as Block[]);
  const columnWidths = firstRowCells
    .map((c) => { const w = (c.attrs as Record<string, unknown> | undefined)?.colwidth; return Array.isArray(w) && w[0] ? pxToDxa(w[0] as number) : 0; });

  return new Table({
    width: ta.widthMode === "pct" && ta.widthPct
      ? { size: ta.widthPct as number, type: WidthType.PERCENTAGE } // lib emits w:w="60%" — valid OOXML percent literal
      : { size: 100, type: WidthType.PERCENTAGE },
    alignment: DOCX_ALIGN[(ta.align as string) ?? ""] ?? undefined,
    indent: ta.indent ? { size: pxToDxa((ta.indent as number) * 24)!, type: WidthType.DXA } : undefined,
    layout: ta.widthMode === "fixed" ? ("fixed" as never) : undefined,
    columnWidths: columnWidths.some((w) => w) ? columnWidths.map((w) => w ?? 0) : undefined,
    rows: tableRows,
  });
}

const SECTION_TYPES: Record<string, (typeof SectionType)[keyof typeof SectionType]> = {
  nextPage: SectionType.NEXT_PAGE,
  continuous: SectionType.CONTINUOUS,
  evenPage: SectionType.EVEN_PAGE,
  oddPage: SectionType.ODD_PAGE,
};

/** SectionBreak attrs (describing the section that follows the break) → OOXML
 *  sectPr properties + optional header/footer parts. */
function sectionProps(attrs: Record<string, unknown>): {
  properties: ISectionPropertiesOptions;
  headers?: ISectionOptions["headers"];
  footers?: ISectionOptions["footers"];
} {
  const properties: ISectionPropertiesOptions = {
    type: SECTION_TYPES[(attrs.type as string) ?? "nextPage"] ?? SectionType.NEXT_PAGE,
  };
  const w = pxToDxa(attrs.pageWidth), h = pxToDxa(attrs.pageHeight);
  const margin: Record<string, number | undefined> = {
    top: pxToDxa(attrs.marginTop), bottom: pxToDxa(attrs.marginBottom),
    left: pxToDxa(attrs.marginLeft), right: pxToDxa(attrs.marginRight),
  };
  const pnStart = typeof attrs.pnStart === "number" ? attrs.pnStart : null;
  const page: NonNullable<ISectionPropertiesOptions["page"]> = {
    ...(w || h ? { size: { width: w ?? 12240, height: h ?? 15840 } } : {}),
    ...(Object.values(margin).some((v) => v != null) ? { margin: margin as never } : {}),
    ...(pnStart != null ? { pageNumbers: { start: pnStart } } : {}),
  };
  if (page.size || page.margin || page.pageNumbers) (properties as { page?: unknown }).page = page;
  const hf = (l: unknown, r: unknown) =>
    new Paragraph({
      children: [
        new TextRun({ text: String(l ?? "") }),
        new TextRun({ text: "\t" }),
        new TextRun({ text: String(r ?? "") }),
      ],
    });
  const headers = attrs.headerLeft != null || attrs.headerRight != null
    ? { default: new Header({ children: [hf(attrs.headerLeft, attrs.headerRight)] }) }
    : undefined;
  const footers = attrs.footerLeft != null || attrs.footerRight != null
    ? { default: new Footer({ children: [hf(attrs.footerLeft, attrs.footerRight)] }) }
    : undefined;
  return { properties, headers, footers };
}

/** TipTap JSON → .docx bytes (no download side effect — used by tests + export). */
export async function exportDocxBytes(doc: Block, name: string): Promise<Blob> {
  footnoteTexts.clear();
  footnoteSeq = 0;
  await prefetchImages(doc);

  // Split top-level blocks into OOXML sections: sectionBreak closes the
  // current section (its attrs describe the section that follows, mirroring
  // our in-editor model); a `columns` node becomes its own continuous section.
  const sections: ISectionOptions[] = [];
  let cur: (Paragraph | Table)[] = [];
  let pending: {
    properties: ISectionPropertiesOptions;
    headers?: ISectionOptions["headers"];
    footers?: ISectionOptions["footers"];
  } | null = null;
  const flush = () => {
    const p = pending;
    pending = null;
    sections.push({
      children: cur.length ? cur : [new Paragraph({})],
      ...(p ?? {}),
    });
    cur = [];
  };
  for (const node of (doc.content ?? []) as Block[]) {
    if (node.type === "sectionBreak") {
      flush();
      pending = sectionProps(node.attrs ?? {});
    } else if (node.type === "columns") {
      flush();
      const a = node.attrs ?? {};
      sections.push({
        properties: {
          type: SectionType.CONTINUOUS,
          column: { count: (a.count as number) ?? 2, space: pxToDxa(a.gap) ?? 480, equalWidth: true },
        },
        children: ((node.content ?? []) as Block[]).flatMap(blockToParagraphs),
      });
      pending = { properties: { type: SectionType.CONTINUOUS } }; // resume single-column
    } else if (node.type === "table") {
      const t = tableOf(node);
      if (t) cur.push(t);
    } else {
      cur.push(...blockToParagraphs(node));
    }
  }
  flush();

  const footnotes: Record<number, { children: Paragraph[] }> = {};
  for (const [id, text] of footnoteTexts) {
    footnotes[Number(id)] = { children: [new Paragraph({ children: [new TextRun({ text })] })] };
  }
  const file = new Document({
    creator: "Kreatix Business Suite",
    title: name,
    footnotes: footnotes as never,
    sections,
  }) as DocxFile;
  return Packer.toBlob(file);
}

/** TipTap JSON → .docx download (KBS-WRITER-001) */
export async function exportDocx(doc: Block, name: string) {
  const blob = await exportDocxBytes(doc, name);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name.replace(/\.[^.]+$/, "") + ".docx";
  a.click();
  URL.revokeObjectURL(url);
}

// ---- DOCX math re-import ---------------------------------------------------
// Mammoth drops <m:oMath> zones. Pre-tag them as text markers before
// conversion, then emit the math nodes' HTML so setContent restores them.

const b64enc = (s: string) =>
  typeof Buffer !== "undefined"
    ? Buffer.from(s, "utf8").toString("base64")
    : btoa(unescape(encodeURIComponent(s)));

const xmlUnescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");

/** Concatenated linear text of a math zone (LaTeX source for our own exports,
 *  linear-format text for foreign OMML). */
const mathText = (xml: string) =>
  xmlUnescape([...xml.matchAll(/<m:t[^>]*>([\s\S]*?)<\/m:t>/g)].map((m) => m[1]).join(""));

const MATH_I = /⟦KXMI:([A-Za-z0-9+/=]*)⟧/g;

/** Rewrite math zones + break constructs in document.xml as sentinel text
 *  runs; returns the (possibly rewritten) package and the rewritten xml. */
async function preprocessDocx(arrayBuffer: ArrayBuffer): Promise<{ buffer: ArrayBuffer; docXml: string }> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(arrayBuffer);
  let docXml = await zip.file("word/document.xml")?.async("text");
  if (!docXml) return { buffer: arrayBuffer, docXml: "" };
  const original = docXml;

  if (docXml.includes("<m:oMath")) {
    const run = (body: string, tag: string) =>
      `<w:r><w:t xml:space="preserve">⟦${tag}:${b64enc(mathText(body))}⟧</w:t></w:r>`;
    docXml = docXml
      .replace(/<m:oMathPara\b[\s\S]*?<\/m:oMathPara>/g, (m) => run(m, "KXMB"))
      .replace(/<m:oMath\b[\s\S]*?<\/m:oMath>/g, (m) => run(m, "KXMI"));
  }

  // <w:r><w:br w:type="page|column"/></w:r> → sentinel runs (mammoth drops them)
  docXml = docXml.replace(
    /<w:r\b[^>]*>\s*<w:br\b[^>]*w:type="(page|column)"[^>]*\/?>\s*<\/w:r>/g,
    (_, t) => `<w:r><w:t xml:space="preserve">⟦${t === "page" ? "KXPB" : "KXCB"}⟧</w:t></w:r>`,
  );

  // OOXML sectPr describes the section it CLOSES; our sectionBreak node
  // describes the section it INTRODUCES. So the marker at the end of
  // section i (i-th pPr-level sectPr) carries props of sectPr i+1 (or the
  // body-level trailing sectPr for the final boundary). Marker payload is
  // JSON: section type, page geometry, columns, page-numbering restart,
  // and header/footer text resolved through document.xml.rels.
  {
    const src = docXml;
    const sects = [...src.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)]
      .map((m) => ({ xml: m[0], idx: m.index ?? 0, pPr: /^\s*<\/w:pPr>/.test(src.slice((m.index ?? 0) + m[0].length)) }));
    const pPrSects = sects.filter((s) => s.pPr);
    const bodySect = sects.find((s) => !s.pPr);

    if (pPrSects.length) {
      const relsXml = await zip.file("word/_rels/document.xml.rels")?.async("text") ?? "";
      const relMap: Record<string, string> = {};
      for (const r of relsXml.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) relMap[r[1]] = r[2];
      const hfText = async (sect: string, kind: "header" | "footer") => {
        const rid = sect.match(new RegExp(`<w:${kind}Reference\\b[^>]*r:id="([^"]+)"`))?.[1];
        const part = rid && relMap[rid]
          ? await zip.file(`word/${relMap[rid]}`)?.async("text") : undefined;
        if (!part) return null;
        const text = [...part.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => xmlUnescape(m[1])).join("");
        return text.trim() || null;
      };
      const sectProps = async (sect: string) => {
        const wv = (tag: string, name: string) =>
          sect.match(new RegExp(`<w:${tag}\\b[^>]*w:${name}="([^"]*)"`))?.[1];
        const dxa = (tag: string, name: string) => {
          const v = wv(tag, name); return v ? Math.round(parseInt(v) / 15) : null;
        };
        return {
          type: wv("type", "val") ?? "nextPage",
          pageWidth: dxa("pgSz", "w"), pageHeight: dxa("pgSz", "h"),
          marginTop: dxa("pgMar", "top"), marginBottom: dxa("pgMar", "bottom"),
          marginLeft: dxa("pgMar", "left"), marginRight: dxa("pgMar", "right"),
          cols: wv("cols", "num") ? parseInt(wv("cols", "num")!) : null,
          colGap: wv("cols", "space") ? Math.round(parseInt(wv("cols", "space")!) / 15) : null,
          pnStart: wv("pgNumType", "start") ? parseInt(wv("pgNumType", "start")!) : null,
          headerText: await hfText(sect, "header"),
          footerText: await hfText(sect, "footer"),
        };
      };
      const payloads: string[] = [];
      for (let i = 0; i < pPrSects.length; i++) {
        const next = i + 1 < pPrSects.length ? pPrSects[i + 1].xml : bodySect?.xml ?? "";
        payloads.push(b64enc(JSON.stringify(next ? await sectProps(next) : {})));
      }
      let mi = 0;
      docXml = docXml.replace(
        /<w:sectPr\b[\s\S]*?<\/w:sectPr>(\s*<\/w:pPr>)/g,
        (_, tail) => `${tail}<w:r><w:t xml:space="preserve">⟦KXSB:${payloads[mi++] ?? ""}⟧</w:t></w:r>`,
      );
    }
  }

  if (docXml === original) return { buffer: arrayBuffer, docXml };
  zip.file("word/document.xml", docXml);
  return { buffer: await zip.generateAsync({ type: "arraybuffer" }), docXml };
}

const b64dec = (s: string) =>
  typeof Buffer !== "undefined"
    ? Buffer.from(s, "base64").toString("utf8")
    : decodeURIComponent(escape(atob(s)));

const attrEsc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** Markers → the math extensions' parse HTML (div/span[data-type=*-math]). */
function mathMarkersToHtml(html: string): string {
  return html
    .replace(/<p>⟦KXMB:([A-Za-z0-9+/=]*)⟧<\/p>/g, (_, b) =>
      `<div data-type="block-math" data-latex="${attrEsc(b64dec(b))}"></div>`)
    .replace(MATH_I, (_, b) =>
      `<span data-type="inline-math" data-latex="${attrEsc(b64dec(b))}"></span>`);
}

interface SectMarkerProps {
  type?: string; pageWidth?: number | null; pageHeight?: number | null;
  marginTop?: number | null; marginBottom?: number | null;
  marginLeft?: number | null; marginRight?: number | null;
  cols?: number | null; colGap?: number | null; pnStart?: number | null;
  headerText?: string | null; footerText?: string | null;
}

/** Page/column/section break sentinels → the break nodes' parse HTML.
 *  A cols>1 incoming section opens a `columns` wrapper that closes at the
 *  next section boundary (tracked sequentially). */
function breakMarkersToHtml(html: string): string {
  const DIV: Record<string, string> = {
    KXPB: `<div data-type="page-break" class="page-break"></div>`,
    KXCB: `<div data-type="column-break" class="page-break column-break"></div>`,
  };
  html = html
    .replace(/<p>⟦(KXPB|KXCB)⟧<\/p>/g, (_, t) => DIV[t])
    .replace(/⟦(KXPB|KXCB)⟧/g, (_, t) => `</p>${DIV[t]}<p>`);

  const esc = (s: string | null | undefined) =>
    (s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const sectDiv = (p: SectMarkerProps) => {
    let s = `data-section-type="${esc(p.type ?? "nextPage")}"`;
    const pairs: [string, number | null | undefined][] = [
      ["data-page-width", p.pageWidth], ["data-page-height", p.pageHeight],
      ["data-margin-top", p.marginTop], ["data-margin-bottom", p.marginBottom],
      ["data-margin-left", p.marginLeft], ["data-margin-right", p.marginRight],
      ["data-pn-start", p.pnStart],
    ];
    for (const [k, v] of pairs) if (v != null) s += ` ${k}="${v}"`;
    if (p.headerText) s += ` data-header-left="${esc(p.headerText)}"`;
    if (p.footerText) s += ` data-footer-left="${esc(p.footerText)}"`;
    return `<div data-type="section-break" ${s} class="page-break section-break"></div>`;
  };

  const re = /(<p>)?⟦KXSB:([A-Za-z0-9+/=]*)⟧(<\/p>)?/g;
  let out = "", colsOpen = false, pos = 0;
  const closeCols = () => { if (colsOpen) { out += "</div>"; colsOpen = false; } };
  for (const m of html.matchAll(re)) {
    const [tok, openP, b64, closeP] = m;
    out += html.slice(pos, m.index);
    pos = (m.index ?? 0) + tok.length;
    const p: SectMarkerProps = b64 ? JSON.parse(b64dec(b64)) : {};
    closeCols();
    const wholePara = Boolean(openP && closeP);
    const hasCols = (p.cols ?? 0) > 1;
    if (!wholePara) out += "</p>";
    // continuous + columns == our bare `columns` node (no visible break)
    if (!hasCols || p.type !== "continuous") out += sectDiv(p);
    if (hasCols) {
      out += `<div data-type="columns" data-cols="${p.cols}" style="column-gap:${p.colGap ?? 36}px">`;
      colsOpen = true;
    }
    if (!wholePara) out += "<p>";
  }
  closeCols();
  return out + html.slice(pos);
}

// ---- DOCX table props re-import --------------------------------------------
// Mammoth emits plain <table><tr><td> — all tblPr/trPr/tcPr are lost. Walk
// document.xml's table tree, then annotate the HTML in encounter order.

interface XmlCell {
  bg?: string; vAlign?: string; pad?: number; colw?: number; dir?: string;
  /** vMerge-continue placeholder — mammoth drops these from the HTML. */
  merged?: boolean;
  borders?: { side: string; w: number; style: string; color: string }[];
}
interface XmlRow { height?: number; exact?: boolean; cantSplit?: boolean; header?: boolean; cells: XmlCell[] }
interface XmlTbl { align?: string; widthPct?: number; indent?: number; fixed?: boolean; repeatHeader?: boolean; rows: XmlRow[] }

const wVal = (tag: string, prop: string, name: string) =>
  tag.match(new RegExp(`<w:${prop}\\b[^>]*w:${name}="([^"]*)"`))?.[1];

const VALIGN_IN: Record<string, string> = { center: "middle", top: "top", bottom: "bottom", both: "middle" };
const BSTYLE_IN: Record<string, string> = {
  single: "solid", dashed: "dashed", dotted: "dotted", double: "double",
  thick: "solid", wave: "solid", nil: "none", none: "none",
};
const DIR_IN: Record<string, string> = { tbRl: "vertical-rl", btLr: "vertical-lr" };

function extractXmlTables(docXml: string): XmlTbl[] {
  const tables: XmlTbl[] = [];
  // stack of open containers; cur = innermost {tbl,row}
  const stack: { kind: string; tbl?: XmlTbl; row?: XmlRow }[] = [];
  const curTbl = () => [...stack].reverse().find((s) => s.tbl)?.tbl;
  const curRow = () => [...stack].reverse().find((s) => s.row)?.row;
  const props = (xml: string, from: number, tag: string) =>
    xml.slice(from).match(new RegExp(`^\\s*<w:${tag}Pr\\b[\\s\\S]*?<\\/w:${tag}Pr>`))?.[0] ?? "";

  const re = /<\/?w:(tbl|tr|tc)\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(docXml))) {
    const [tok, name] = m;
    const open = !tok.startsWith("</");
    const selfClose = tok.endsWith("/>");
    if (!open) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].kind === name) { stack.length = i; break; }
      }
      continue;
    }
    if (name === "tbl") {
      const pr = props(docXml, re.lastIndex, "tbl");
      const tblW = pr.match(/<w:tblW\b[^>]*>/)?.[0] ?? "";
      const jc = wVal(pr, "jc", "val");
      const tbl: XmlTbl = {
        align: jc === "center" || jc === "right" || jc === "left" ? jc : undefined,
        widthPct: /w:type="pct"/.test(tblW)
          ? (() => { const w = wVal(tblW, "tblW", "w") ?? "0"; return w.includes("%") ? parseInt(w) : Math.round(parseInt(w) / 50); })()
          : undefined,
        indent: (() => { const v = wVal(pr, "tblInd", "w"); return v ? Math.round(parseInt(v) / 15 / 24) : undefined; })(),
        fixed: /w:tblLayout\b[^>]*w:type="fixed"/.test(pr) || undefined,
        rows: [],
      };
      tables.push(tbl);
      if (!selfClose) stack.push({ kind: "tbl", tbl });
    } else if (name === "tr") {
      const pr = props(docXml, re.lastIndex, "tr");
      const h = pr.match(/<w:trHeight\b[^>]*>/)?.[0] ?? "";
      const row: XmlRow = {
        height: wVal(h, "trHeight", "val") ? Math.round(parseInt(wVal(h, "trHeight", "val")!) / 15) : undefined,
        exact: wVal(h, "trHeight", "hRule") === "exact" || undefined,
        cantSplit: /<w:cantSplit\b/.test(pr) || undefined,
        header: /<w:tblHeader\b/.test(pr) || undefined,
        cells: [],
      };
      curTbl()?.rows.push(row);
      if (row.header && curTbl()) curTbl()!.repeatHeader = true;
      if (!selfClose) stack.push({ kind: "tr", row });
    } else {
      // w:tc
      const pr = props(docXml, re.lastIndex, "tc");
      const cell: XmlCell = {};
      const vm = pr.match(/<w:vMerge\b[^>]*>/)?.[0];
      if (vm && (!/w:val="/.test(vm) || /w:val="continue"/.test(vm))) cell.merged = true;
      const shd = wVal(pr, "shd", "fill");
      if (shd && shd !== "auto") cell.bg = "#" + shd;
      const va = wVal(pr, "vAlign", "val");
      if (va && VALIGN_IN[va]) cell.vAlign = VALIGN_IN[va];
      const tcW = pr.match(/<w:tcW\b[^>]*>/)?.[0] ?? "";
      if (/w:type="dxa"/.test(tcW)) cell.colw = Math.round(parseInt(wVal(tcW, "tcW", "w") ?? "0") / 15);
      const tcMar = pr.match(/<w:tcMar\b[\s\S]*?<\/w:tcMar>/)?.[0];
      if (tcMar) {
        const top = tcMar.match(/<w:top\b[^>]*w:w="(\d+)"/)?.[1];
        if (top) cell.pad = Math.round(parseInt(top) / 15);
      }
      const dir = wVal(pr, "textDirection", "val");
      if (dir && DIR_IN[dir]) cell.dir = DIR_IN[dir];
      const tcB = pr.match(/<w:tcBorders\b[\s\S]*?<\/w:tcBorders>/)?.[0];
      if (tcB) {
        cell.borders = [];
        for (const side of ["top", "right", "bottom", "left"]) {
          const t = tcB.match(new RegExp(`<w:${side}\\b[^>]*>`))?.[0];
          if (!t) continue;
          const val = wVal(t, side, "val");
          if (!val || val === "nil" || val === "none") continue;
          cell.borders.push({
            side,
            w: Math.max(1, Math.round(parseInt(wVal(t, side, "sz") ?? "8") / 6)),
            style: BSTYLE_IN[val] ?? "solid",
            color: "#" + (wVal(t, side, "color") ?? "000000").replace(/^auto$/, "000000"),
          });
        }
      }
      curRow()?.cells.push(cell);
      if (!selfClose) stack.push({ kind: "tc" });
    }
  }
  return tables;
}

/** Inject the extracted props into mammoth's <table>/<tr>/<td> tags. */
function annotateTableHtml(html: string, tables: XmlTbl[]): string {
  if (!tables.length) return html;
  let ti = 0;
  const ctx: { tbl: XmlTbl | null; r: number; c: number; headerRow: boolean }[] = [];
  const inject = (tag: string, attrs: string, style: string) => {
    let out = tag;
    if (style) {
      out = /style="[^"]*"/.test(out)
        ? out.replace(/style="([^"]*)"/, `style="$1;${attrEsc(style)}"`)
        : out.replace(/\s*\/?>$/, ` style="${attrEsc(style)}">`);
    }
    if (attrs) out = out.replace(/\s*\/?>$/, `${attrs}>`);
    return out;
  };
  return html.replace(/<\/?(table|tr|td|th)\b[^>]*>/gi, (tok) => {
    const isClose = tok.startsWith("</");
    const name = tok.match(/<\/?(table|tr|td|th)/i)?.[1].toLowerCase();
    const top = ctx[ctx.length - 1];
    if (name === "table" && !isClose) {
      const tbl = tables[ti++] ?? null;
      ctx.push({ tbl, r: -1, c: -1, headerRow: false });
      if (!tbl) return tok;
      const style = [
        tbl.widthPct ? `width:${tbl.widthPct}%` : "",
        tbl.indent ? `margin-left:${tbl.indent * 24}px` : "",
      ].filter(Boolean).join(";");
      const attrs =
        (tbl.align ? ` data-align="${tbl.align}"` : "") +
        (tbl.widthPct ? ` data-width-mode="pct"` : tbl.fixed ? ` data-width-mode="fixed"` : "") +
        (tbl.repeatHeader ? ` data-repeat-header="true"` : "");
      return inject(tok, attrs, style);
    }
    if (name === "table" && isClose) { ctx.pop(); return tok; }
    if (!top) return tok;
    if (name === "tr" && !isClose) {
      top.r++; top.c = -1;
      const row = top.tbl?.rows[top.r];
      top.headerRow = !!row?.header;
      if (!row) return tok;
      return inject(tok, row.cantSplit ? ` data-cant-split="true"` : "",
        row.height ? `height:${row.height}px` : "");
    }
    if (name === "tr") return tok;
    // td / th — skip XML vMerge-continue cells (mammoth emits no td for them)
    if (isClose) return top.headerRow ? "</th>" : tok;
    top.c++;
    let cell = top.tbl?.rows[top.r]?.cells[top.c];
    while (cell?.merged) { top.c++; cell = top.tbl?.rows[top.r]?.cells[top.c]; }
    const open = top.headerRow && name === "td" ? tok.replace(/<td/, "<th") : tok;
    if (!cell) return open;
    const style = [
      cell.bg ? `background-color:${cell.bg}` : "",
      cell.vAlign ? `vertical-align:${cell.vAlign}` : "",
      cell.pad != null ? `padding:${cell.pad}px` : "",
      cell.dir ? `writing-mode:${cell.dir}` : "",
      ...(cell.borders ?? []).map((b) => `border-${b.side}:${b.w}px ${b.style} ${b.color}`),
    ].filter(Boolean).join("; ");
    const attrs = cell.colw ? ` data-colwidth="${cell.colw}"` : "";
    return inject(open, attrs, style);
  });
}

/** .docx file → HTML string for editor.setContent (mammoth preserves structure) */
export async function importDocx(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const { buffer, docXml } = await preprocessDocx(arrayBuffer).catch(() => ({ buffer: arrayBuffer, docXml: "" }));
  // mammoth's Node build accepts {buffer}; its browser build accepts {arrayBuffer}
  const result = await mammoth.convertToHtml({ arrayBuffer: buffer }).catch(() =>
    mammoth.convertToHtml({ buffer: Buffer.from(buffer) } as never));
  let html = breakMarkersToHtml(mathMarkersToHtml(result.value));
  if (docXml) html = annotateTableHtml(html, extractXmlTables(docXml));
  return html;
}

export type { Json };
