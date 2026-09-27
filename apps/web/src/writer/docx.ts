import {
  Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from "docx";
import mammoth from "mammoth";

type Json = Record<string, unknown>;

interface Mark { type: string; attrs?: Record<string, unknown> }
interface Inline { type: string; text?: string; marks?: Mark[] }
interface Block {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Block[] | Inline[];
}

const HEADINGS: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3,
};

function inlineRuns(nodes: Inline[] | undefined, inherited: Mark[] = []): TextRun[] {
  return (nodes ?? []).flatMap((n) => {
    if (n.type === "hardBreak") return [new TextRun({ break: 1 })];
    if (n.type !== "text" || !n.text) return [];
    const marks = [...inherited, ...(n.marks ?? [])];
    const has = (t: string) => marks.some((m) => m.type === t);
    const color = marks.find((m) => m.type === "textStyle")?.attrs?.color as string | undefined;
    return [new TextRun({
      text: n.text,
      bold: has("bold") || undefined,
      italics: has("italic") || undefined,
      underline: has("underline") ? {} : undefined,
      strike: has("strike") || undefined,
      color: color?.replace("#", ""),
      font: (marks.find((m) => m.type === "textStyle")?.attrs?.fontFamily as string | undefined)?.replace(/['"]/g, "").split(",")[0],
    })];
  });
}

function blockToParagraphs(node: Block): Paragraph[] {
  switch (node.type) {
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      return [new Paragraph({ heading: HEADINGS[level] ?? HeadingLevel.HEADING_3, children: inlineRuns(node.content as Inline[]) })];
    }
    case "paragraph":
      return [new Paragraph({ children: inlineRuns(node.content as Inline[]) })];
    case "blockquote":
      return (node.content as Block[]).flatMap(blockToParagraphs).map(
        (p) => new Paragraph({ ...p, indent: { left: 400 }, border: undefined }),
      );
    case "bulletList":
      return (node.content as Block[]).flatMap((li) =>
        (li.content as Block[]).flatMap((p) =>
          p.type === "paragraph"
            ? [new Paragraph({ bullet: { level: 0 }, children: inlineRuns(p.content as Inline[]) })]
            : blockToParagraphs(p),
        ),
      );
    case "orderedList":
      return (node.content as Block[]).flatMap((li, i) =>
        (li.content as Block[]).flatMap((p) =>
          p.type === "paragraph"
            ? [new Paragraph({ children: [new TextRun({ text: `${i + 1}. ` }), ...inlineRuns(p.content as Inline[])] })]
            : blockToParagraphs(p),
        ),
      );
    case "codeBlock":
      return [new Paragraph({ children: [new TextRun({ text: textOf(node), font: "Consolas" })] })];
    case "horizontalRule":
      return [new Paragraph({ children: [new TextRun({ text: "─".repeat(40), color: "BBBBBB" })] })];
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
          }),
        ),
      }),
    ),
  });
}

/** TipTap JSON → .docx bytes (no download side effect — used by tests + export). */
export async function exportDocxBytes(doc: Block, name: string): Promise<Blob> {
  const children: (Paragraph | Table)[] = [];
  for (const node of (doc.content ?? []) as Block[]) {
    if (node.type === "table") {
      const t = tableOf(node);
      if (t) children.push(t);
    } else {
      children.push(...blockToParagraphs(node));
    }
  }
  const file = new Document({
    creator: "Kreatix Business Suite",
    title: name,
    sections: [{ children: children.length ? children : [new Paragraph({})] }],
  });
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
