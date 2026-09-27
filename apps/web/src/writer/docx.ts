import {
  AlignmentType, ColumnBreak as DocxColumnBreak, Document, Footer, FootnoteReferenceRun,
  Header, HeadingLevel, ImageRun, Math as DocxMath, MathRun, Packer, Paragraph,
  PageBreak as DocxPageBreak, SectionType, Table, TableCell, TableRow,
  TextRun, VerticalAlign, WidthType,
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

function tableOf(node: Block): Table | null {
  const rows = (node.content ?? []) as Block[];
  if (!rows.length) return null;
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      (r) => new TableRow({
        children: ((r.content ?? []) as Block[]).map(
          (c) => new TableCell({
            children: ((c.content ?? []) as Block[]).flatMap(blockToParagraphs),
            verticalAlign: VerticalAlign.TOP,
          }),
        ),
      }),
    ),
  });
}

const pxToDxa = (px: unknown): number | undefined =>
  typeof px === "number" && Number.isFinite(px) ? Math.round(px * 15) : undefined;

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
  const page: NonNullable<ISectionPropertiesOptions["page"]> = {
    ...(w || h ? { size: { width: w ?? 12240, height: h ?? 15840 } } : {}),
    ...(Object.values(margin).some((v) => v != null) ? { margin: margin as never } : {}),
  };
  if (page.size || page.margin) (properties as { page?: unknown }).page = page;
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

/** Rewrite math zones in document.xml as sentinel text runs. */
async function tagMathZones(arrayBuffer: ArrayBuffer): Promise<ArrayBuffer> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(arrayBuffer);
  const docXml = await zip.file("word/document.xml")?.async("text");
  if (!docXml || !docXml.includes("<m:oMath")) return arrayBuffer;
  const run = (body: string, tag: string) =>
    `<w:r><w:t xml:space="preserve">⟦${tag}:${b64enc(mathText(body))}⟧</w:t></w:r>`;
  const tagged = docXml
    .replace(/<m:oMathPara\b[\s\S]*?<\/m:oMathPara>/g, (m) => run(m, "KXMB"))
    .replace(/<m:oMath\b[\s\S]*?<\/m:oMath>/g, (m) => run(m, "KXMI"));
  zip.file("word/document.xml", tagged);
  return zip.generateAsync({ type: "arraybuffer" });
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

/** .docx file → HTML string for editor.setContent (mammoth preserves structure) */
export async function importDocx(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const source = await tagMathZones(arrayBuffer).catch(() => arrayBuffer);
  // mammoth's Node build accepts {buffer}; its browser build accepts {arrayBuffer}
  const result = await mammoth.convertToHtml({ arrayBuffer: source }).catch(() =>
    mammoth.convertToHtml({ buffer: Buffer.from(source) } as never));
  return mathMarkersToHtml(result.value);
}

export type { Json };
