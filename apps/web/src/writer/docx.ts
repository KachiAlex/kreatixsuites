import {
  AlignmentType, ColumnBreak as DocxColumnBreak, CommentRangeEnd, CommentRangeStart,
  CommentReference, Document, Footer, FootnoteReferenceRun,
  Header, HeadingLevel, ImageRun, LevelFormat, LevelSuffix, Math as DocxMath, MathRun,
  Packer, PageBreak as DocxPageBreak, PageOrientation, Paragraph, SectionType,
  Table, TableCell, TableRow,
  TextDirection, TextRun, VerticalAlignTable, WidthType,
  type File as DocxFile, type IParagraphStyleOptions, type ISectionOptions,
  type ISectionPropertiesOptions, type ParagraphChild,
} from "docx";
import mammoth from "mammoth";
import type { Editor } from "@tiptap/core";
import { DEFAULT_STYLES, loadStyleDefs, styleDefsOf, type StyleDef } from "./extensions/styles";
import type { DocProps } from "./DocProps";
import type { PageSetup } from "./PageSetup";

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

/** Optional context for a full-fidelity export (comments, named styles,
 *  doc properties, page geometry). */
export interface DocxExportOpts {
  comments?: { anchor?: string | null; body: string; author?: { displayName?: string } | string; createdAt?: string; resolved?: boolean }[];
  docProps?: DocProps;
  styles?: Record<string, StyleDef>;
  pageSetup?: PageSetup;
}

/** Result of a DOCX import — editor HTML plus the parts mammoth can't carry. */
export interface DocxImportResult {
  html: string;
  /** Named-style defs recovered from styles.xml, keyed for KxStyles. */
  styles: Record<string, StyleDef>;
  docProps: DocProps;
  /** Anchored comments from comments.xml → post to the comments API. */
  comments: { anchor: string; body: string; author?: string; createdAt?: string }[];
  /** True when the converter dropped all text and raw document.xml text was
   *  salvaged instead — formatting fidelity is reduced. */
  degraded?: boolean;
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

/** anchor (comment mark id) → OOXML comment id, assigned in doc order. */
const commentNums = new Map<string, number>();
const commentNum = (anchor: string): number => {
  let n = commentNums.get(anchor);
  if (n == null) { n = commentNums.size + 1; commentNums.set(anchor, n); }
  return n;
};

function runsFor(n: Inline, inherited: Mark[]): Run[] {
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
  if (n.type === "citation") {
    return [new TextRun({ text: (n.attrs?.display as string) ?? "(?)", color: "C55A11" })];
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
}

/** Inline nodes → Paragraph children, interleaving comment range boundaries
 *  (commentRangeStart/End + a trailing commentReference run per comment). */
function inlineRuns(nodes: Inline[] | undefined, inherited: Mark[] = []): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  let open: string | null = null;
  const used = new Set<string>();
  const setOpen = (next: string | null) => {
    if (open != null) { out.push(new CommentRangeEnd(commentNum(open))); open = null; }
    if (next != null) { out.push(new CommentRangeStart(commentNum(next))); open = next; used.add(next); }
  };
  for (const n of nodes ?? []) {
    const runs = runsFor(n, inherited);
    if (!runs.length) continue;
    const cid = ((n.marks ?? []).find((m) => m.type === "comment")?.attrs?.commentId as string | undefined) ?? null;
    if (cid !== open) setOpen(cid);
    out.push(...runs);
  }
  setOpen(null);
  for (const c of used) out.push(new TextRun({ children: [new CommentReference(commentNum(c))] }));
  return out;
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

const pxToDxa = (px: unknown): number | undefined =>
  typeof px === "number" && Number.isFinite(px) ? Math.round(px * 15) : undefined;

const cssPx = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : undefined;
};

const STYLE_ID = (key: string) => `kx-${key.replace(/[^\w-]/g, "")}`;

/** Style keys actually referenced by document paragraphs — styles.xml emits
 *  these plus every definition in the doc payload. */
const usedStyleKeys = new Set<string>();

/** OOXML numbering definitions: reference → format/start. */
const numRefs = new Map<string, { fmt: (typeof LevelFormat)[keyof typeof LevelFormat]; start: number; bullet: boolean }>();

const OL_FORMAT: Record<string, (typeof LevelFormat)[keyof typeof LevelFormat]> = {
  "lower-alpha": LevelFormat.LOWER_LETTER,
  "upper-alpha": LevelFormat.UPPER_LETTER,
  "lower-roman": LevelFormat.LOWER_ROMAN,
  "upper-roman": LevelFormat.UPPER_ROMAN,
  decimal: LevelFormat.DECIMAL,
};

const BULLET_FORMAT: Record<string, string> = {
  disc: "•", circle: "◦", square: "▪",
};

function numberingRef(node: Block, bullet: boolean, level: number): { reference: string; level: number } {
  const a = node.attrs ?? {};
  const css = (a.listStyle as string) || (bullet ? "disc" : "decimal");
  const start = Number(a.start ?? 1) || 1;
  const ref = bullet ? `kx-ul-${css}` : `kx-ol-${css}-${start}`;
  if (!numRefs.has(ref)) {
    numRefs.set(ref, {
      fmt: bullet ? LevelFormat.BULLET : (OL_FORMAT[css] ?? LevelFormat.DECIMAL),
      start, bullet,
    });
  }
  return { reference: ref, level };
}

function spacing(node: Block) {
  const a = node.attrs ?? {};
  const before = cssPx(a.spaceBefore);
  const after = cssPx(a.spaceAfter);
  const rule = a.lineSpacingRule as string | undefined; // "mode:value"
  const lh = a.lineHeight as string | undefined;
  const sp: Record<string, number | string | undefined> = {};
  if (before != null) sp.before = pxToDxa(before);
  if (after != null) sp.after = pxToDxa(after);
  if (rule) {
    const [mode, v] = rule.split(":");
    if (mode === "multiple") sp.line = Math.round((parseFloat(v) || 1) * 240);
    else if (v) {
      const px = v.endsWith("pt") ? parseFloat(v) * 96 / 72 : parseFloat(v);
      if (Number.isFinite(px)) { sp.line = pxToDxa(px); sp.lineRule = mode; }
    }
  } else if (lh) {
    if (/px$/.test(lh)) { sp.line = pxToDxa(parseFloat(lh)); sp.lineRule = "exact"; }
    else if (/pt$/.test(lh)) { sp.line = Math.round(parseFloat(lh) * 20); sp.lineRule = "exact"; }
    else sp.line = Math.round((parseFloat(lh) || 1) * 240);
  }
  return Object.values(sp).some((v) => v != null) ? sp as never : undefined;
}

const TAB_TYPES: Record<string, "left" | "right" | "center" | "decimal"> = {
  left: "left", right: "right", center: "center", decimal: "decimal",
};

/** All paragraph-format attrs (Phase 2) + pagination → OOXML pPr options. */
function paraProps(node: Block) {
  const a = node.attrs ?? {};
  const ind: Record<string, number | undefined> = {};
  if (a.indentPx != null) ind.left = pxToDxa(cssPx(a.indentPx));
  else if (a.indent) ind.left = pxToDxa((a.indent as number) * 24);
  const ir = cssPx(a.indentRight);
  if (ir != null) ind.right = pxToDxa(ir);
  const fl = cssPx(a.firstLine);
  if (fl != null) { if (fl >= 0) ind.firstLine = pxToDxa(fl); else ind.hanging = pxToDxa(-fl); }

  const pb = a.pBorders as { top?: BorderSpec; right?: BorderSpec; bottom?: BorderSpec; left?: BorderSpec } | null | undefined;
  const border = pb ? {
    top: docxBorder(pb.top), right: docxBorder(pb.right),
    bottom: docxBorder(pb.bottom), left: docxBorder(pb.left),
  } as never : undefined;

  const tabs = Array.isArray(a.tabs) ? (a.tabs as { pos: number; align: string }[]) : null;

  return {
    alignment: ALIGN[(a.textAlign as string) ?? ""] as never,
    spacing: spacing(node),
    indent: Object.keys(ind).length ? ind as never : undefined,
    pageBreakBefore: a.pageBreakBefore ? true : undefined,
    keepNext: a.keepNext ? true : undefined,
    keepLines: a.keepLines ? true : undefined,
    widowControl: a.widowOrphan ? true : undefined,
    border,
    shading: a.pShading ? { fill: hex(String(a.pShading)) } as never : undefined,
    tabStops: tabs?.length
      ? tabs.map((t) => ({ type: TAB_TYPES[t.align] ?? "left", position: pxToDxa(t.pos) ?? 0 })) as never
      : undefined,
    bidirectional: a.dir === "rtl" ? true : undefined,
  };
}

function blockToParagraphs(node: Block, listDepth = 0): Paragraph[] {
  switch (node.type) {
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      return [new Paragraph({
        heading: HEADINGS[level] ?? HeadingLevel.HEADING_6,
        ...paraProps(node),
        children: inlineRuns(node.content as Inline[]) as never,
      })];
    }
    case "paragraph": {
      const key = node.attrs?.styleName as string | undefined;
      if (key) usedStyleKeys.add(key);
      return [new Paragraph({
        ...paraProps(node),
        style: key ? STYLE_ID(key) : undefined,
        children: inlineRuns(node.content as Inline[]) as never,
      })];
    }
    case "blockquote":
      return (node.content as Block[]).flatMap((b) => blockToParagraphs(b, listDepth)).map(
        (p) => new Paragraph({ ...p, indent: { left: 400 }, border: undefined }),
      );
    case "bulletList":
      return (node.content as Block[]).flatMap((li) =>
        (li.content as Block[]).flatMap((p) =>
          p.type === "paragraph"
            ? [new Paragraph({
                numbering: numberingRef(node, true, listDepth),
                children: inlineRuns(p.content as Inline[]) as never,
              })]
            : blockToParagraphs(p, listDepth + 1),
        ),
      );
    case "orderedList":
      return (node.content as Block[]).flatMap((li) =>
        (li.content as Block[]).flatMap((p) =>
          p.type === "paragraph"
            ? [new Paragraph({
                numbering: numberingRef(node, false, listDepth),
                ...paraProps(p),
                children: inlineRuns(p.content as Inline[]) as never,
              })]
            : blockToParagraphs(p, listDepth + 1),
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
    case "textBox":
      // boxed text — export contents as normal paragraphs (border is visual-only)
      return (node.content ?? []).flatMap((c) => blockToParagraphs(c as Block));
    case "chart":
      return [new Paragraph({ children: [new TextRun({ text: `[Chart] ${(node.attrs?.title as string) || "Untitled chart"}` })] })];
    case "shape":
      return [new Paragraph({ children: [new TextRun({ text: `[${(node.attrs?.shape as string) ?? "shape"}]` })] })];
    case "wordArt":
      return [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: (node.attrs?.text as string) ?? "", bold: true, size: Math.min(72, (node.attrs?.size as number) ?? 44) * 2 })],
      })];
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

const ALIGN_STYLES: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT, center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED,
};

const halfPoints = (css: string | undefined): number | undefined => {
  if (!css) return undefined;
  if (css.endsWith("pt")) return Math.round(parseFloat(css) * 2);
  return Math.round(parseFloat(css) * 1.5); // px → half-points
};

/** StyleDef → OOXML paragraph style entry for styles.xml. */
function docxStyleOf(def: StyleDef): IParagraphStyleOptions {
  return {
    id: STYLE_ID(def.key),
    name: def.label,
    ...(def.nextStyle ? { next: STYLE_ID(def.nextStyle) } : {}),
    run: {
      font: def.fontFamily?.replace(/['"]/g, "").split(",")[0].trim() || undefined,
      size: halfPoints(def.fontSize),
      bold: def.bold || undefined,
      italics: def.italic || undefined,
      underline: def.underline ? {} : undefined,
      color: def.color ? hex(def.color) : undefined,
    },
    paragraph: {
      alignment: def.align ? ALIGN_STYLES[def.align] : undefined,
      indent: def.indent ? { left: pxToDxa(def.indent * 28) } : undefined,
      spacing: (def.spaceBefore != null || def.spaceAfter != null || def.lineHeight) ? {
        before: def.spaceBefore != null ? pxToDxa(def.spaceBefore) : undefined,
        after: def.spaceAfter != null ? pxToDxa(def.spaceAfter) : undefined,
        line: def.lineHeight
          ? /px$/.test(def.lineHeight) ? pxToDxa(parseFloat(def.lineHeight)) : Math.round(parseFloat(def.lineHeight) * 240)
          : undefined,
      } : undefined,
    },
  };
}

/** TipTap JSON → .docx bytes (no download side effect — used by tests + export). */
export async function exportDocxBytes(doc: Block, name: string, opts: DocxExportOpts = {}): Promise<Blob> {
  footnoteTexts.clear();
  footnoteSeq = 0;
  commentNums.clear();
  numRefs.clear();
  usedStyleKeys.clear();
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

  // styles.xml — every used key resolves (payload defs > built-in defaults)
  const stylesPayload = opts.styles ?? {};
  const emitKeys = new Set([...Object.keys(stylesPayload), ...usedStyleKeys]);
  const paragraphStyles = [...emitKeys]
    .map((k) => ({ ...DEFAULT_STYLES.find((d) => d.key === k), ...stylesPayload[k], key: k } as StyleDef))
    .filter((d) => d.node === "paragraph")
    .map(docxStyleOf);

  // numbering.xml — real numbering instances for ordered + bulleted lists
  const numConfigs = [...numRefs].map(([reference, r]) => ({
    reference,
    levels: Array.from({ length: 9 }, (_, lvl) => ({
      level: lvl,
      format: r.fmt,
      text: r.bullet ? (BULLET_FORMAT[reference.split("-").pop() ?? "disc"] ?? "•") : `%${lvl + 1}.`,
      alignment: AlignmentType.START as never,
      start: r.bullet ? undefined : r.start,
      suffix: LevelSuffix.TAB as never,
      style: { paragraph: { indent: { left: (lvl + 1) * 360, hanging: 240 } } },
    })),
  }));

  // comments.xml — anchored comments carry their text + author
  const commentDefs = (opts.comments ?? []).map((c) => ({
    id: commentNum(c.anchor ?? `unanchored-${Math.random()}`),
    author: typeof c.author === "string" ? c.author : c.author?.displayName ?? "",
    date: c.createdAt ? new Date(c.createdAt) : undefined,
    children: [new Paragraph({ children: [new TextRun({ text: c.body })] })],
  }));

  // first section carries the doc's page setup (size/margins/orientation/gutter)
  const ps = opts.pageSetup;
  if (ps && sections.length) {
    const w = pxToDxa(ps.width), h = pxToDxa(ps.height);
    sections[0] = {
      ...sections[0],
      properties: {
        ...(sections[0].properties ?? {}),
        page: {
          size: {
            width: w, height: h,
            orientation: (ps.orientation === "landscape" ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT) as never,
          },
          margin: {
            top: pxToDxa(ps.marginTop), bottom: pxToDxa(ps.marginBottom),
            left: pxToDxa(ps.marginLeft), right: pxToDxa(ps.marginRight),
            gutter: pxToDxa(ps.gutter ?? 0),
          },
          ...(ps.pnStart && ps.pnStart !== 1 ? { pageNumbers: { start: ps.pnStart } } : {}),
        } as never,
      },
    };
  }

  const dp = opts.docProps ?? {};
  const file = new Document({
    creator: dp.author || "Kreatix Business Suite",
    title: dp.title || name,
    subject: dp.subject || undefined,
    keywords: dp.keywords || undefined,
    description: dp.comments || undefined,
    styles: paragraphStyles.length ? { paragraphStyles } : undefined,
    numbering: numConfigs.length ? { config: numConfigs } : undefined,
    comments: commentDefs.length ? { children: commentDefs } : undefined,
    footnotes: footnotes as never,
    sections,
  }) as DocxFile;
  return Packer.toBlob(file);
}

/** TipTap JSON → .docx download (KBS-WRITER-001) */
export async function exportDocx(doc: Block, name: string, opts: DocxExportOpts = {}) {
  const blob = await exportDocxBytes(doc, name, opts);
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

// ---- OOXML package metadata (styles/numbering/comments/doc-props) ----------

interface ImportedStyle {
  id: string; name: string;
  def: Partial<StyleDef> & { node: "paragraph" };
  nextId?: string;
}
interface NumberingInfo { fmt: string; start?: number }
interface DocxMeta {
  /** OOXML styleId → parsed paragraph style. */
  styles: Map<string, ImportedStyle>;
  /** "numId:ilvl" → number format + start. */
  numFmt: Map<string, NumberingInfo>;
  comments: { id: string; author?: string; date?: string; body: string }[];
  docProps: DocProps;
}

const wAttr = (tag: string, attr: string) =>
  tag.match(new RegExp(`w:${attr}="([^"]*)"`))?.[1];

const tagText = (xml: string, tag: string) => {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? xmlUnescape(m[1]).trim() : undefined;
};

/** Parse word/styles.xml paragraph styles into KxStyle-shaped defs. */
function parseStylesXml(xml: string): Map<string, ImportedStyle> {
  const out = new Map<string, ImportedStyle>();
  for (const m of xml.matchAll(/<w:style\b[^>]*w:type="paragraph"[\s\S]*?<\/w:style>/g)) {
    const s = m[0];
    const id = s.match(/<w:style\b[^>]*w:styleId="([^"]+)"/)?.[1];
    if (!id) continue;
    const name = wAttr(s.match(/<w:name\b[^>]*>/)?.[0] ?? "", "val") ?? id;
    const rpr = s.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)?.[1] ?? "";
    const ppr = s.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/)?.[1] ?? "";
    const sz = rpr.match(/<w:sz\b[^>]*w:val="(\d+)"/)?.[1];
    const jc = wAttr(ppr.match(/<w:jc\b[^>]*>/)?.[0] ?? "", "val");
    const spacing = ppr.match(/<w:spacing\b[^>]*>/)?.[0] ?? "";
    const ind = ppr.match(/<w:ind\b[^>]*>/)?.[0] ?? "";
    const line = spacing.match(/w:line="(\d+)"/)?.[1];
    const lineRule = wAttr(spacing, "lineRule") ?? "auto";
    const off = (tag: string) => rpr.match(new RegExp(`<w:${tag}\\b[^>]*>`))?.[0];
    const boolOn = (tag: string) => {
      const t = off(tag); if (!t) return undefined;
      return !/w:val="(0|false|off|none)"/.test(t);
    };
    const color = wAttr(off("color") ?? "", "val");
    const indLeft = ind.match(/w:left="(\d+)"/)?.[1];
    const def: ImportedStyle["def"] = { node: "paragraph" };
    const font = wAttr(rpr.match(/<w:rFonts\b[^>]*>/)?.[0] ?? "", "ascii");
    if (font) def.fontFamily = `'${font}', serif`;
    if (sz) def.fontSize = `${Math.round(parseInt(sz) * 2 / 3)}px`; // half-pt → px
    if (boolOn("b")) def.bold = true;
    if (boolOn("i")) def.italic = true;
    if (boolOn("u")) def.underline = true;
    if (color && color !== "auto") def.color = `#${color}`;
    if (jc === "center" || jc === "right" || jc === "both") def.align = jc === "both" ? "justify" : jc;
    const sb = spacing.match(/w:before="(\d+)"/)?.[1];
    const sa = spacing.match(/w:after="(\d+)"/)?.[1];
    if (sb) def.spaceBefore = Math.round(parseInt(sb) / 15);
    if (sa) def.spaceAfter = Math.round(parseInt(sa) / 15);
    if (line) def.lineHeight = lineRule === "auto" ? String(parseInt(line) / 240) : `${Math.round(parseInt(line) / 15)}px`;
    if (indLeft) def.indent = Math.round(parseInt(indLeft) / 15 / 28) || undefined;
    out.set(id, {
      id, name, def,
      nextId: wAttr(s.match(/<w:next\b[^>]*>/)?.[0] ?? "", "val"),
    });
  }
  return out;
}

/** Parse word/numbering.xml → "numId:ilvl" → fmt + start. */
function parseNumberingXml(xml: string): Map<string, NumberingInfo> {
  const out = new Map<string, NumberingInfo>();
  const numToAbs = new Map<string, string>();
  for (const m of xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[\s\S]*?<\/w:num>/g)) {
    const abs = m[0].match(/<w:abstractNumId\b[^>]*w:val="(\d+)"/)?.[1];
    if (abs) numToAbs.set(m[1], abs);
  }
  const absMap = new Map<string, Map<string, NumberingInfo>>();
  for (const m of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[\s\S]*?<\/w:abstractNum>/g)) {
    const lvls = new Map<string, NumberingInfo>();
    for (const l of m[0].matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[\s\S]*?<\/w:lvl>/g)) {
      lvls.set(l[1], {
        fmt: wAttr(l[0].match(/<w:numFmt\b[^>]*>/)?.[0] ?? "", "val") ?? "decimal",
        start: parseInt(wAttr(l[0].match(/<w:start\b[^>]*>/)?.[0] ?? "", "val") ?? "1") || 1,
      });
    }
    absMap.set(m[1], lvls);
  }
  for (const [numId, absId] of numToAbs) {
    const lvls = absMap.get(absId);
    if (!lvls) continue;
    for (const [ilvl, info] of lvls) out.set(`${numId}:${ilvl}`, info);
    if (lvls.get("0")) out.set(numId, lvls.get("0")!);
  }
  return out;
}

/** Parse word/comments.xml → comment list. */
function parseCommentsXml(xml: string): DocxMeta["comments"] {
  const out: DocxMeta["comments"] = [];
  for (const m of xml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const id = wAttr(m[1], "id"); if (!id) continue;
    const body = [...m[2].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((t) => xmlUnescape(t[1])).join("").trim();
    out.push({ id, author: wAttr(m[1], "author"), date: wAttr(m[1], "date"), body });
  }
  return out;
}

/** Parse docProps/core.xml → document properties. */
function parseCoreXml(xml: string): DocProps {
  const get = (tag: string) => tagText(xml, tag) || undefined;
  return {
    title: get("dc:title"), subject: get("dc:subject"), author: get("dc:creator"),
    keywords: get("cp:keywords"), category: get("cp:category"), comments: get("dc:description"),
  };
}

/** Rewrite math zones + break constructs in document.xml as sentinel text
 *  runs; returns the (possibly rewritten) package and the rewritten xml. */
async function preprocessDocx(arrayBuffer: ArrayBuffer): Promise<{ buffer: ArrayBuffer; docXml: string; meta: DocxMeta }> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(arrayBuffer);
  const meta: DocxMeta = {
    styles: parseStylesXml(await zip.file("word/styles.xml")?.async("text") ?? ""),
    numFmt: parseNumberingXml(await zip.file("word/numbering.xml")?.async("text") ?? ""),
    comments: parseCommentsXml(await zip.file("word/comments.xml")?.async("text") ?? ""),
    docProps: parseCoreXml(await zip.file("docProps/core.xml")?.async("text") ?? ""),
  };
  let docXml = await zip.file("word/document.xml")?.async("text");
  if (!docXml) {
    // a zip that isn't a word package — name the actual format if we can
    const mime = (await zip.file("mimetype")?.async("text") ?? "").trim();
    if (mime.includes("opendocument"))
      throw new Error("ODF files (.odt) can't be imported yet — save as .docx and try again");
    throw new Error("This file isn't a Word .docx document");
  }
  const original = docXml;

  // w:pStyle / w:numPr / comment ranges → sentinel runs (mammoth drops the
  // original constructs; the sentinels survive as literal text we post-process).
  const sentinel = (text: string) =>
    `<w:r><w:t xml:space="preserve">⟦${text}⟧</w:t></w:r>`;
  docXml = docXml.replace(
    /<w:pPr>(?:(?!<\/w:pPr>)[\s\S])*?<w:pStyle\b[^>]*w:val="([^"]+)"[^>]*\/?>[\s\S]*?<\/w:pPr>/g,
    (m, id) => `${m}${sentinel(`KXPS:${id}`)}`,
  );
  docXml = docXml.replace(
    /<w:pPr>(?:(?!<\/w:pPr>)[\s\S])*?<w:numPr>([\s\S]*?)<\/w:numPr>[\s\S]*?<\/w:pPr>/g,
    (m, numpr) => {
      const id = numpr.match(/<w:numId\b[^>]*w:val="(\d+)"/)?.[1] ?? "0";
      const lvl = numpr.match(/<w:ilvl\b[^>]*w:val="(\d+)"/)?.[1] ?? "0";
      return `${m}${sentinel(`KXN:${id}:${lvl}`)}`;
    },
  );
  docXml = docXml
    .replace(/<w:commentRangeStart\b[^>]*w:id="([^"]+)"[^>]*\/?>/g, (_, id) => sentinel(`KXCS:${id}`))
    .replace(/<w:commentRangeEnd\b[^>]*w:id="([^"]+)"[^>]*\/?>/g, (_, id) => sentinel(`KXCE:${id}`))
    // comment-reference runs carry no text — drop them entirely
    .replace(/<w:r>(?:(?!<\/w:r>)[\s\S])*?<w:commentReference\b[^>]*\/?>[\s\S]*?<\/w:r>/g, "");

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

  // mammoth silently drops w:sdt content controls and w:txbxContent text
  // boxes — a doc built from them opens blank. Unwrap controls in place and
  // hoist text-box paragraphs to the end of the body so their content survives.
  {
    let prev = "";
    while (prev !== docXml) {
      prev = docXml;
      docXml = docXml.replace(
        /<w:sdt\b[^>]*>((?:(?!<w:sdt)[\s\S])*)<\/w:sdt>/g,
        (_, inner: string) => inner.match(/<w:sdtContent[^>]*>([\s\S]*?)<\/w:sdtContent>/)?.[1] ?? "",
      );
    }
    const boxes: string[] = [];
    do {
      prev = docXml;
      docXml = docXml.replace(
        /<w:txbxContent[^>]*>((?:(?!<w:txbxContent)[\s\S])*)<\/w:txbxContent>/g,
        (_, inner: string) => { boxes.push(inner); return ""; },
      );
    } while (prev !== docXml);
    if (boxes.length)
      docXml = docXml.replace(/<\/w:body>/, `${boxes.join("")}</w:body>`);
  }

  if (docXml === original) return { buffer: arrayBuffer, docXml, meta };
  zip.file("word/document.xml", docXml);
  return { buffer: await zip.generateAsync({ type: "arraybuffer" }), docXml, meta };
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

// ---- pStyle / numbering / comment sentinel post-processing -----------------

const BUILTIN_STYLE_KEYS: Record<string, string> = {
  title: "title", subtitle: "subtitle", caption: "caption",
  listparagraph: "listParagraph", quote: "imp_quote", intensequote: "imp_intenseQuote",
};

/** OOXML styleId → Kreatix style key; null = structural (normal/headings). */
function styleKeyFor(meta: DocxMeta, id: string): string | null {
  const name = meta.styles.get(id)?.name ?? id;
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (norm === "normal" || /^heading[1-6]$/.test(norm)) return null; // native
  if (norm.startsWith("heading") && /^heading\d+$/.test(norm)) return null;
  return BUILTIN_STYLE_KEYS[norm] ?? `imp_${id.replace(/[^\w-]/g, "")}`;
}

/** styleId → key map + the KxStyle defs those keys resolve to. */
function buildStyleMaps(meta: DocxMeta): { idToKey: Map<string, string>; styles: Record<string, StyleDef> } {
  const idToKey = new Map<string, string>();
  const styles: Record<string, StyleDef> = {};
  for (const [id, s] of meta.styles) {
    const key = styleKeyFor(meta, id);
    if (!key) continue;
    idToKey.set(id, key);
    const builtin = DEFAULT_STYLES.find((d) => d.key === key);
    styles[key] = { ...builtin, ...s.def, key, label: s.name };
  }
  // resolve OOXML next-style ids → keys
  for (const [id, s] of meta.styles) {
    const key = idToKey.get(id);
    if (key && s.nextId) {
      const nk = styleKeyFor(meta, s.nextId);
      styles[key].nextStyle = nk ?? "normal";
    }
  }
  return { idToKey, styles };
}

/** ⟦KXPS:id⟧ at a paragraph's start → data-style attr on the <p>. */
function styleMarkersToHtml(html: string, idToKey: Map<string, string>): string {
  html = html.replace(
    /<(p|h[1-6])\b([^>]*)>((?:<[a-z][^>]*>)*)⟦KXPS:([^⟧]+)⟧/g,
    (_m, tag, attrs, lead, id) => {
      if (tag !== "p") return `<${tag}${attrs}>${lead}`;
      const key = idToKey.get(id) ?? `imp_${String(id).replace(/[^\w-]/g, "")}`;
      return `<p${attrs} data-style="${attrEsc(key)}">${lead}`;
    },
  );
  return html.replace(/⟦KXPS:[^⟧]+⟧/g, "");
}

const NUM_CSS: Record<string, string> = {
  decimal: "decimal", decimalZero: "decimal-leading-zero",
  upperLetter: "upper-alpha", lowerLetter: "lower-alpha",
  upperRoman: "upper-roman", lowerRoman: "lower-roman",
  bullet: "disc", none: "none",
};

/** ⟦KXN:numId:ilvl⟧ inside list items → list-style-type/start on the parent
 *  <ol>; sentinels stripped afterward. */
function numMarkersToHtml(html: string, meta: DocxMeta): string {
  html = html.replace(
    /<(ol|ul)>((?:(?!<\/?(?:ol|ul)\b)[\s\S]){0,1200}?)(⟦KXN:(\d+):(\d+)⟧)/g,
    (m, tag, pre, sentinel, numId, lvl) => {
      const info = meta.numFmt.get(`${numId}:${lvl}`) ?? meta.numFmt.get(numId);
      if (tag !== "ol" || !info || info.fmt === "bullet") return m;
      const css = NUM_CSS[info.fmt];
      const attrs =
        (css && css !== "decimal" ? ` style="list-style-type:${css}"` : "") +
        (info.start && info.start > 1 ? ` start="${info.start}"` : "");
      return `<${tag}${attrs}>${pre}${sentinel}`;
    },
  );
  return html.replace(/⟦KXN:\d+:\d+⟧/g, "");
}

/** ⟦KXCS:id⟧…⟦KXCE:id⟧ → <span data-comment-id> marks. */
function commentMarkersToHtml(html: string): string {
  const ids = [...html.matchAll(/⟦KXCS:(\d+)⟧/g)].map((m) => m[1]);
  for (const id of new Set(ids)) {
    html = html.replace(
      new RegExp(`⟦KXCS:${id}⟧([\\s\\S]*?)⟦KXCE:${id}⟧`),
      (_, body) => `<span data-comment-id="docx-${id}">${body}</span>`,
    );
  }
  return html.replace(/⟦KX[CS][SE]:\d+⟧/g, "");
}

/** Reject non-docx payloads with a user-readable reason before they reach
 *  mammoth — legacy .doc (OLE), RTF and ODF files all get routed to Writer by
 *  the open-file flow but can't be converted here. */
function sniffDocxFormat(arrayBuffer: ArrayBuffer) {
  const head = new Uint8Array(arrayBuffer.slice(0, Math.min(8, arrayBuffer.byteLength)));
  if (head[0] === 0x50 && head[1] === 0x4b) return; // PK zip — a real OOXML package
  const text = new TextDecoder("utf-8", { fatal: false }).decode(arrayBuffer.slice(0, 16));
  if (head[0] === 0xd0 && head[1] === 0xcf)
    throw new Error("This is a legacy .doc file — save it as .docx and open it again");
  if (text.startsWith("{\\rtf"))
    throw new Error("RTF files can't be imported yet — save as .docx and try again");
  throw new Error("This file isn't a Word .docx document");
}

/** Last-resort text salvage: pull every w:p's w:t runs straight from
 *  document.xml when the structured conversion produced no visible text. */
function salvageDocxText(docXml: string): string {
  const paras: string[] = [];
  for (const p of docXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    const text = [...p[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((t) => xmlUnescape(t[1])).join("").replace(/⟦KX[^\]]*⟧/g, "").trim();
    if (text) paras.push(text);
  }
  return paras
    .map((t) => `<p>${t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`)
    .join("");
}

/** .docx file → editor HTML + recovered package metadata. */
export async function importDocx(file: File): Promise<DocxImportResult> {
  const arrayBuffer = await file.arrayBuffer();
  sniffDocxFormat(arrayBuffer);
  const { buffer, docXml, meta } = await preprocessDocx(arrayBuffer);
  // mammoth's Node build accepts {buffer}; its browser build accepts {arrayBuffer}
  const result = await mammoth.convertToHtml({ arrayBuffer: buffer }).catch(() =>
    mammoth.convertToHtml({ buffer: Buffer.from(buffer) } as never));
  let html = breakMarkersToHtml(mathMarkersToHtml(result.value));
  const { idToKey, styles } = buildStyleMaps(meta);
  let degraded = false;
  if (docXml) {
    html = annotateTableHtml(html, extractXmlTables(docXml));
    html = styleMarkersToHtml(html, idToKey);
    html = numMarkersToHtml(html, meta);
    html = commentMarkersToHtml(html);
    // conversion came back textless but the package has real text (text boxes,
    // content controls, exotic runs mammoth skipped) — salvage it so the file
    // doesn't open as a blank page
    if (!html.replace(/<[^>]+>/g, "").trim()) {
      const salvaged = salvageDocxText(docXml);
      if (salvaged) { html = salvaged; degraded = true; }
    }
  }
  return {
    html,
    styles,
    docProps: meta.docProps,
    comments: meta.comments.map((c) => ({
      anchor: `docx-${c.id}`, body: c.body, author: c.author, createdAt: c.date,
    })),
    degraded,
  };
}

/** Post-import: register imported named-style defs in the editor so
 *  data-style'd paragraphs render + persist in the styles payload. */
export function applyDocxImport(editor: Editor, res: DocxImportResult): void {
  if (Object.keys(res.styles).length) {
    loadStyleDefs(editor, { ...styleDefsOf(editor), ...res.styles });
  }
}

export type { Json };
