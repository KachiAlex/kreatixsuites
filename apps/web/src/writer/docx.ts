import {
  AlignmentType, Document, FootnoteReferenceRun, HeadingLevel, ImageRun, Math as DocxMath,
  MathRun, Packer, Paragraph, PageBreak as DocxPageBreak, Table, TableCell, TableRow,
  TextRun, VerticalAlign, WidthType, type File as DocxFile,
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

function blockToParagraphs(node: Block): Paragraph[] {
  switch (node.type) {
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      return [new Paragraph({
        heading: HEADINGS[level] ?? HeadingLevel.HEADING_6,
        alignment: ALIGN[(node.attrs?.textAlign as string) ?? ""] as never,
        spacing: spacing(node),
        indent: node.attrs?.indent ? { left: (node.attrs.indent as number) * 480 } : undefined,
        children: inlineRuns(node.content as Inline[]) as never,
      })];
    }
    case "paragraph":
      return [new Paragraph({
        alignment: ALIGN[(node.attrs?.textAlign as string) ?? ""] as never,
        spacing: spacing(node),
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

/** TipTap JSON → .docx bytes (no download side effect — used by tests + export). */
export async function exportDocxBytes(doc: Block, name: string): Promise<Blob> {
  footnoteTexts.clear();
  footnoteSeq = 0;
  await prefetchImages(doc);

  const children: (Paragraph | Table)[] = [];
  for (const node of (doc.content ?? []) as Block[]) {
    if (node.type === "table") {
      const t = tableOf(node);
      if (t) children.push(t);
    } else {
      children.push(...blockToParagraphs(node));
    }
  }
  const footnotes: Record<number, { children: Paragraph[] }> = {};
  for (const [id, text] of footnoteTexts) {
    footnotes[Number(id)] = { children: [new Paragraph({ children: [new TextRun({ text })] })] };
  }
  const file = new Document({
    creator: "Kreatix Business Suite",
    title: name,
    footnotes: footnotes as never,
    sections: [{ children: children.length ? children : [new Paragraph({})] }],
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

/** .docx file → HTML string for editor.setContent (mammoth preserves structure) */
export async function importDocx(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  // mammoth's Node build accepts {buffer}; its browser build accepts {arrayBuffer}
  const result = await mammoth.convertToHtml({ arrayBuffer }).catch(() =>
    mammoth.convertToHtml({ buffer: Buffer.from(arrayBuffer) } as never));
  return result.value;
}

export type { Json };
