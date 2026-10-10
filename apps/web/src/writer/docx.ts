import {
  AlignmentType, ColumnBreak as DocxColumnBreak, CommentRangeEnd, CommentRangeStart,
  CommentReference, Document, Footer, FootnoteReferenceRun,
  Header, HeadingLevel, ImageRun, ImportedXmlComponent, LevelFormat, LevelSuffix,
  Math as DocxMath, MathFraction, MathFunction, MathRadical, MathRun,
  MathSubScript, MathSubSuperScript, MathSuperScript, type MathComponent,
  Packer, PageBreak as DocxPageBreak, PageOrientation, Paragraph, SectionType,
  Table, TableCell, TableRow,
  TextDirection, TextRun, DeletedTextRun, InsertedTextRun,
  VerticalAlignSection, VerticalAlignTable, WidthType,
  type File as DocxFile, type IParagraphStyleOptions, type ISectionOptions,
  type ISectionPropertiesOptions, type ParagraphChild, type SectionVerticalAlign,
} from "docx";
import mammoth from "mammoth";
import type { Editor } from "@tiptap/core";
import { DEFAULT_STYLES, cssFor, loadStyleDefs, styleDefsOf, type StyleDef } from "./extensions/styles";
import type { DocProps } from "./DocProps";
import { applyPageSetup, readPageSetup, type PageSetup } from "./PageSetup";
import { ensureDecryptedFile } from "../lib/passwordPrompt";
import { saveFile } from "../lib/saveFile";

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
  /** settings.xml + first-section geometry → doc-level page setup merge. */
  settings?: DocxSettings;
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
    const omml = (n.attrs?.omml as string) || "";
    if (omml) {
      try {
        const x = b64dec(omml);
        if (x.startsWith("<m:oMath")) {
          // imported equation — emit its original OMML byte-for-byte
          return [ImportedXmlComponent.fromXmlString(x) as unknown as Run];
        }
      } catch { /* fall through to structured rebuild */ }
    }
    // authored equation — build real OMML structure (sSup/f/rad/…) from the
    // linear source so Word renders actual math, not literal "x^2" text
    return [new DocxMath({ children: linearToOmml((n.attrs?.latex as string) ?? "") })];
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
  const opts = {
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
  };
  // tracked-change marks → real w:ins / w:del revisions (they'd otherwise
  // export as plain text — silent "accept all")
  const del = marks.find((m) => m.type === "deletion");
  const ins = marks.find((m) => m.type === "insertion");
  if (del || ins) {
    const m = (del ?? ins)!;
    const changed = {
      id: Number(String(m.attrs?.changeId ?? "").replace(/\D+/g, "")) || 1,
      author: (m.attrs?.authorName as string) || "Kreatix",
      date: (m.attrs?.timestamp as string) || new Date().toISOString(),
    };
    return [del ? new DeletedTextRun({ ...opts, ...changed }) : new InsertedTextRun({ ...opts, ...changed })];
  }
  return [new TextRun(opts)];
}

/** sdt mark → <w:sdt> component wrapping a live sdtContent the caller pushes
 *  runs into. The raw sdtPr XML is stored in the mark attr (base64) so every
 *  control property survives the round-trip byte-for-byte; checkboxes get
 *  their w14:checked state patched to the toggled value. */
function sdtComponent(mark: Mark): { root: ImportedXmlComponent; content: ImportedXmlComponent } {
  let prXml = b64dec(String(mark.attrs?.pr ?? ""));
  if (mark.attrs?.kind === "checkbox" && mark.attrs?.checked != null) {
    const on = mark.attrs.checked === "1" || mark.attrs.checked === true ? "1" : "0";
    prXml = /<w14:checked\b/.test(prXml)
      ? prXml.replace(/(<w14:checked\b[^>]*?w14:val=")[^"]*"/, `$1${on}"`)
      : prXml.replace(/<w14:checkbox\b[^>]*>/, (m) => `${m}<w14:checked w14:val="${on}"/>`);
  }
  const root = new ImportedXmlComponent("w:sdt");
  root.push(ImportedXmlComponent.fromXmlString(prXml));
  const content = new ImportedXmlComponent("w:sdtContent");
  root.push(content);
  return { root, content };
}

/** Inline nodes → Paragraph children, interleaving comment range boundaries
 *  (commentRangeStart/End + a trailing commentReference run per comment) and
 *  wrapping runs that carry an `sdt` mark in a real <w:sdt> control. */
function inlineRuns(nodes: Inline[] | undefined, inherited: Mark[] = []): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  let open: string | null = null;
  const used = new Set<string>();
  let sdtRun: { key: string; root: ImportedXmlComponent; content: ImportedXmlComponent } | null = null;
  const flushSdt = () => {
    if (sdtRun) { out.push(sdtRun.root as unknown as ParagraphChild); sdtRun = null; }
  };
  const setOpen = (next: string | null) => {
    if (open != null) { out.push(new CommentRangeEnd(commentNum(open))); open = null; }
    if (next != null) { out.push(new CommentRangeStart(commentNum(next))); open = next; used.add(next); }
  };
  for (const n of nodes ?? []) {
    const runs = runsFor(n, inherited);
    if (!runs.length) continue;
    const cid = ((n.marks ?? []).find((m) => m.type === "comment")?.attrs?.commentId as string | undefined) ?? null;
    if (cid !== open) setOpen(cid);
    const sdt = (n.marks ?? []).find((m) => m.type === "sdt");
    const sdtKey = sdt ? `${sdt.attrs?.pr ?? ""}|${sdt.attrs?.checked ?? ""}` : null;
    if (!sdtKey || sdtKey !== sdtRun?.key) flushSdt();
    if (sdt) {
      if (!sdtRun) sdtRun = { key: sdtKey!, ...sdtComponent(sdt) };
      for (const r of runs) sdtRun.content.push(r as never);
    } else {
      out.push(...runs);
    }
  }
  flushSdt();
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
    case "blockMath": {
      const omml = (node.attrs?.omml as string) || "";
      if (omml) {
        try {
          const x = b64dec(omml);
          const whole = x.startsWith("<m:oMathPara") ? x : `<m:oMathPara>${x}</m:oMathPara>`;
          return [ImportedXmlComponent.fromXmlString(whole) as unknown as Paragraph];
        } catch { /* fall through to structured rebuild */ }
      }
      const ommlPara = new ImportedXmlComponent("m:oMathPara");
      ommlPara.push(new DocxMath({ children: linearToOmml((node.attrs?.latex as string) ?? "") }) as never);
      return [ommlPara as unknown as Paragraph];
    }
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
  const VA_OUT: Record<string, SectionVerticalAlign> = {
    center: VerticalAlignSection.CENTER, bottom: VerticalAlignSection.BOTTOM,
    both: VerticalAlignSection.BOTH, top: VerticalAlignSection.TOP,
  };
  const properties: ISectionPropertiesOptions = {
    type: SECTION_TYPES[(attrs.type as string) ?? "nextPage"] ?? SectionType.NEXT_PAGE,
    ...(attrs.vAlign && VA_OUT[attrs.vAlign as string]
      ? { verticalAlign: VA_OUT[attrs.vAlign as string] } : {}),
  };
  const w = pxToDxa(attrs.pageWidth), h = pxToDxa(attrs.pageHeight);
  const margin: Record<string, number | undefined> = {
    top: pxToDxa(attrs.marginTop), bottom: pxToDxa(attrs.marginBottom),
    left: pxToDxa(attrs.marginLeft), right: pxToDxa(attrs.marginRight),
  };
  const pnStart = typeof attrs.pnStart === "number" ? attrs.pnStart : null;
  const pnFmt = typeof attrs.pnFmt === "string" ? PN_FMT_OOXML[attrs.pnFmt as PageSetup["pnFormat"]] : undefined;
  const page: NonNullable<ISectionPropertiesOptions["page"]> = {
    ...(w || h ? { size: { width: w ?? 12240, height: h ?? 15840 } } : {}),
    ...(Object.values(margin).some((v) => v != null) ? { margin: margin as never } : {}),
    ...(pnStart != null || pnFmt
      ? { pageNumbers: { ...(pnStart != null ? { start: pnStart } : {}), ...(pnFmt ? { formatType: pnFmt as never } : {}) } }
      : {}),
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
  // block-level content controls wrap consecutive blocks sharing one sdtPr
  let sdtAcc: { key: string; root: ImportedXmlComponent; content: ImportedXmlComponent } | null = null;
  const flushSdtBlock = () => {
    if (sdtAcc) { cur.push(sdtAcc.root as unknown as Paragraph); sdtAcc = null; }
  };
  let pending: {
    properties: ISectionPropertiesOptions;
    headers?: ISectionOptions["headers"];
    footers?: ISectionOptions["footers"];
  } | null = null;
  const flush = () => {
    flushSdtBlock();
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
    } else {
      const kids: (Paragraph | Table)[] =
        node.type === "table" ? (tableOf(node) ? [tableOf(node)!] : []) : blockToParagraphs(node);
      const sdtKey = (node.attrs?.sdt as string | undefined) ?? null;
      if (sdtKey && kids.length) {
        if ((sdtAcc as { key: string } | null)?.key !== sdtKey) {
          flushSdtBlock();
          const root = new ImportedXmlComponent("w:sdt");
          root.push(ImportedXmlComponent.fromXmlString(b64dec(sdtKey)));
          const content = new ImportedXmlComponent("w:sdtContent");
          root.push(content);
          sdtAcc = { key: sdtKey, root, content };
        }
        const acc = sdtAcc as { content: ImportedXmlComponent };
        for (const k of kids) acc.content.push(k as never);
      } else {
        flushSdtBlock();
        cur.push(...kids);
      }
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
          ...((ps.pnStart && ps.pnStart !== 1) || (ps.pnFormat && ps.pnFormat !== "decimal")
            ? { pageNumbers: {
                ...(ps.pnStart && ps.pnStart !== 1 ? { start: ps.pnStart } : {}),
                ...(ps.pnFormat && ps.pnFormat !== "decimal" ? { formatType: PN_FMT_OOXML[ps.pnFormat] as never } : {}),
              } }
            : {}),
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
  void saveFile(blob, name.replace(/\.[^.]+$/, "") + ".docx");
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

/** OMML → linear math text: recovers a LaTeX-ish source for editor display.
 *  The raw OMML rides alongside in the node's `omml` attr for verbatim
 *  re-export, so this only needs to be a good human-facing approximation. */
function ommlToLinear(xml: string): string {
  /** index of `</m:tag>` matching the open tag that ends at `from` (depth-aware).
   *  Open detection checks a boundary so <m:f> doesn't match <m:fPr>. */
  const closeAt = (s: string, tag: string, from: number): number => {
    const open = `<m:${tag}`, close = `</m:${tag}>`;
    let depth = 1, j = from;
    for (;;) {
      let o = s.indexOf(open, j);
      while (o >= 0 && !" \t\n\r/>".includes(s[o + open.length] ?? "")) o = s.indexOf(open, o + 1);
      const c = s.indexOf(close, j);
      if (c < 0) return s.length;
      if (o >= 0 && o < c) {
        const gt = s.indexOf(">", o);
        if (gt >= 0 && s[gt - 1] === "/") { j = gt + 1; continue; }
        depth++; j = gt + 1;
      } else {
        if (--depth === 0) return c;
        j = c + close.length;
      }
    }
  };
  /** inner XML of the first paired <m:tag> in s ("" when absent/self-closing). */
  const take = (s: string, tag: string): string => {
    const m = new RegExp(`<m:${tag}\\b[^>]*?>`).exec(s);
    if (!m || m[0].endsWith("/>")) return "";
    const start = m.index + m[0].length;
    return s.slice(start, closeAt(s, tag, start));
  };
  const takeAll = (s: string, tag: string): string[] => {
    const out: string[] = [];
    const re = new RegExp(`<m:${tag}\\b[^>]*?>`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      if (m[0].endsWith("/>")) continue;
      const start = m.index + m[0].length;
      const end = closeAt(s, tag, start);
      out.push(s.slice(start, end));
      re.lastIndex = end + tag.length + 5;
    }
    return out;
  };
  const NARY: Record<string, string> = {
    "∑": "\\sum", "∏": "\\prod", "∐": "\\coprod", "∫": "\\int", "∬": "\\iint",
    "∭": "\\iiint", "∮": "\\oint", "⋃": "\\bigcup", "⋂": "\\bigcap",
    "⋁": "\\bigvee", "⋀": "\\bigwedge", "⨁": "\\bigoplus", "⨂": "\\bigotimes",
  };
  const FUNCS = new Set(("sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth " +
    "log ln lg lim liminf limsup exp arg deg det dim gcd inf sup hom ker Pr").split(" "));
  /** script argument: a single char stays bare (x^2), longer gets braces. */
  const arg = (t: string) => (t.length === 1 ? t : `{${t}}`);
  const val = (s: string, tag: string) =>
    new RegExp(`<m:${tag}\\b[^>]*?\\b(?:m|w):val="([^"]*)"`).exec(s)?.[1] ?? null;

  const emit = (tag: string, body: string): string => {
    switch (tag) {
      case "t": return xmlUnescape(body);
      case "f": return `\\frac{${conv(take(body, "num"))}}{${conv(take(body, "den"))}}`;
      case "sSup": return `${conv(take(body, "e"))}^${arg(conv(take(body, "sup")))}`;
      case "sSub": return `${conv(take(body, "e"))}_${arg(conv(take(body, "sub")))}`;
      case "sSubSup":
        return `${conv(take(body, "e"))}_${arg(conv(take(body, "sub")))}^${arg(conv(take(body, "sup")))}`;
      case "pre":
        return `{}_${arg(conv(take(body, "sub")))}^${arg(conv(take(body, "sup")))}${conv(take(body, "e"))}`;
      case "rad": {
        const deg = conv(take(body, "deg"));
        const e = conv(take(body, "e"));
        return deg ? `\\sqrt[${deg}]{${e}}` : `\\sqrt{${e}}`;
      }
      case "nary": {
        const chr = xmlUnescape(val(body, "chr") ?? "∑");
        let s = NARY[chr] ?? chr;
        const sub = conv(take(body, "sub")), sup = conv(take(body, "sup")), e = conv(take(body, "e"));
        if (sub) s += `_${arg(sub)}`;
        if (sup) s += `^${arg(sup)}`;
        return e ? `${s} ${e}` : s;
      }
      case "d": {
        const beg = val(body, "begChr") ?? "(", end = val(body, "endChr") ?? ")";
        return `${beg}${conv(take(body, "e"))}${end}`;
      }
      case "func": {
        const name = conv(take(body, "fName"));
        const e = conv(take(body, "e"));
        return `${FUNCS.has(name) ? `\\${name}` : name}${e ? ` ${e}` : ""}`;
      }
      case "limLow": return `${conv(take(body, "e"))}_{${conv(take(body, "lim"))}}`;
      case "limUpp": return `${conv(take(body, "e"))}^{${conv(take(body, "lim"))}}`;
      case "m": {
        const rows = takeAll(body, "mr").map((r) => takeAll(r, "e").map(conv).join("&"));
        return `\\begin{matrix}${rows.join("\\\\")}\\end{matrix}`;
      }
      default: return conv(body);  // containers (e/r/oMath/…) and *Pr props
    }
  };
  const conv = (s: string): string => {
    let out = "", i = 0;
    for (;;) {
      const lt = s.indexOf("<", i);
      if (lt < 0) break;
      const head = /^<m:([A-Za-z]+)\b[^>]*?>/.exec(s.slice(lt));
      if (!head) { i = lt + 1; continue; }
      const tag = head[1];
      if (head[0].endsWith("/>")) { i = lt + head[0].length; continue; }
      const start = lt + head[0].length;
      const end = closeAt(s, tag, start);
      out += emit(tag, s.slice(start, end));
      i = Math.min(end + tag.length + 5, s.length);
    }
    return out;
  };
  return conv(xml);
}

/** Linear math source (Word UnicodeMath / our LaTeX-ish editor text) →
 *  structured OMML components, so authored equations open in Word as real
 *  equation objects rather than literal "x^2" text. Covers scripts, \frac,
 *  \sqrt, functions, delimiters and Greek/symbol names; anything unknown
 *  passes through as literal math text. */
function linearToOmml(src: string): MathComponent[] {
  const SYMS: Record<string, string> = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ", eta: "η",
    theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
    rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
    varepsilon: "ε", varphi: "φ", vartheta: "ϑ", varsigma: "ς",
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ",
    Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
    pm: "±", mp: "∓", times: "×", div: "÷", cdot: "·", ast: "∗", circ: "∘", bullet: "•",
    leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", equiv: "≡", approx: "≈",
    sim: "∼", simeq: "≃", cong: "≅", propto: "∝",
    infty: "∞", partial: "∂", nabla: "∇", aleph: "ℵ", hbar: "ℏ", ell: "ℓ",
    forall: "∀", exists: "∃", nexists: "∄", neg: "¬", lnot: "¬", therefore: "∴", because: "∵",
    in: "∈", notin: "∉", ni: "∋", subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇",
    cup: "∪", cap: "∩", setminus: "∖", emptyset: "∅", varnothing: "∅",
    to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", Leftarrow: "⇐",
    leftrightarrow: "↔", Leftrightarrow: "⇔", mapsto: "↦", uparrow: "↑", downarrow: "↓",
    ldots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱",
    angle: "∠", perp: "⊥", parallel: "∥", mid: "∣",
    sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭", oint: "∮",
    bigcup: "⋃", bigcap: "⋂", bigoplus: "⨁", bigotimes: "⨂",
    oplus: "⊕", ominus: "⊖", otimes: "⊗", odot: "⊙",
    lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", langle: "⟨", rangle: "⟩",
  };
  const FUNCS = new Set(("sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth " +
    "log ln lg lim liminf limsup exp arg deg det dim gcd inf sup min max hom ker Pr mod").split(" "));
  let i = 0;
  const n = src.length;
  const ws = () => { while (i < n && src[i] === " ") i++; };
  const run = (t: string): MathComponent[] => [new MathRun(t)];
  const atom = (): MathComponent[] => {
    ws();
    if (i >= n) return [];
    const c = src[i];
    if (c === "_" || c === "^") return [];  // seq() applies it to an empty base
    if (c === "{") { i++; return seq("}"); }
    if (c === "\\") {
      i++;
      if (i < n && /[A-Za-z]/.test(src[i])) {
        const st = i;
        while (i < n && /[A-Za-z]/.test(src[i])) i++;
        const name = src.slice(st, i);
        if (name === "frac" || name === "dfrac" || name === "tfrac") {
          return [new MathFraction({ numerator: atom(), denominator: atom() })];
        }
        if (name === "sqrt") {
          ws();
          let degree: MathComponent[] | undefined;
          if (src[i] === "[") { i++; degree = seq("]"); }
          const children = atom();
          return [new MathRadical(degree ? { children, degree } : { children })];
        }
        if (name === "left" || name === "right" || /^[bB]ig[glr]?$/.test(name)) {
          ws();
          if (src[i] === "\\") i++;
          if (i < n) { const d = src[i++]; return d === "." ? [] : run(d); }
          return [];
        }
        if (/^(?:overline|underline|vec|bar|hat|tilde|dot|ddot|text|mathrm|mathbf|mathit|mathbb|mathcal|operatorname)$/.test(name)) {
          return atom();  // accents/style wrappers — content survives, style is visual-only
        }
        if (name === "quad" || name === "qquad") return run("    ");
        if (FUNCS.has(name)) return [new MathFunction({ name: run(name), children: atom() })];
        if (SYMS[name]) return run(SYMS[name]);
        return run(`\\${name}`);  // unknown command — keep the source visible
      }
      if (i >= n) return [];
      const d = src[i++];
      return run(" ,;:!".includes(d) ? " " : d);  // thin spaces / escaped chars
    }
    i++;
    return run(c);
  };
  const seq = (close?: string): MathComponent[] => {
    const out: MathComponent[] = [];
    for (;;) {
      ws();
      if (i >= n || (close !== undefined && src[i] === close)) {
        if (i < n && close !== undefined) i++;
        break;
      }
      let comps = atom();
      for (;;) {
        ws();
        if (i >= n || (src[i] !== "_" && src[i] !== "^")) break;
        const sub = src[i++] === "_";
        const first = atom();
        ws();
        if (i < n && src[i] === (sub ? "^" : "_")) {  // x_i^2 / x^2_i → sSubSup
          i++;
          const second = atom();
          comps = [new MathSubSuperScript({
            children: comps,
            subScript: sub ? first : second,
            superScript: sub ? second : first,
          })];
        } else {
          comps = sub
            ? [new MathSubScript({ children: comps, subScript: first })]
            : [new MathSuperScript({ children: comps, superScript: first })];
        }
      }
      out.push(...comps);
    }
    return out;
  };
  return seq();
}

const MATH_I = /⟦KXMI:([A-Za-z0-9+/=]*)⟧/g;

// ---- OOXML package metadata (styles/numbering/comments/doc-props) ----------

interface ImportedStyle {
  id: string; name: string;
  def: Partial<StyleDef> & { node: "paragraph" };
  nextId?: string;
}
interface NumberingInfo { fmt: string; start?: number }
/** word/settings.xml + first-section geometry that maps onto PageSetup. */
interface DocxSettings {
  hyphenate?: boolean;
  /** w:hyphenationZone (twips) → px — Word's distance-from-margin hyphen zone. */
  hyphenZone?: number;
  /** w:consecutiveHyphenLimit → CSS hyphenate-limit-lines. */
  hyphenLimit?: number;
  /** w:evenAndOddHeaders → PageSetup.oddEven. */
  evenOdd?: boolean;
  /** First section's page geometry → doc-level page setup (px). */
  page?: { w: number; h: number; mt: number; mb: number; ml: number; mr: number };
  /** First section's w:pgNumType → doc-level number format + start. */
  pn?: { fmt?: PageSetup["pnFormat"]; start?: number };
  /** First section's header/footer text → doc-level header/footer strings. */
  hf?: { headerLeft?: string; footerLeft?: string };
}

interface DocxMeta {
  /** OOXML styleId → parsed paragraph style. */
  styles: Map<string, ImportedStyle>;
  /** w:docDefaults — baseline paragraph/run props every block inherits. */
  docDefaults: StyleDef;
  /** OOXML character styleId → direct-format props (w:rStyle → run payload). */
  charStyles: Map<string, { props: Record<string, unknown>; basedOn?: string }>;
  /** "numId:ilvl" → number format + start. */
  numFmt: Map<string, NumberingInfo>;
  comments: { id: string; author?: string; date?: string; body: string }[];
  docProps: DocProps;
  settings: DocxSettings;
}

/** w:pgNumType w:fmt (OOXML) → CSS counter-style name (our PageNumberFormat). */
const OOXML_PN_FMT: Record<string, PageSetup["pnFormat"]> = {
  decimal: "decimal", lowerRoman: "lower-roman", upperRoman: "upper-roman",
  lowerLetter: "lower-alpha", upperLetter: "upper-alpha",
};
/** CSS counter-style name → OOXML w:fmt. */
const PN_FMT_OOXML: Record<PageSetup["pnFormat"], string> = {
  decimal: "decimal", "lower-roman": "lowerRoman", "upper-roman": "upperRoman",
  "lower-alpha": "lowerLetter", "upper-alpha": "upperLetter",
};

const wAttr = (tag: string, attr: string) =>
  tag.match(new RegExp(`w:${attr}="([^"]*)"`))?.[1];

const tagText = (xml: string, tag: string) => {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? xmlUnescape(m[1]).trim() : undefined;
};

/** w:docDefaults → the baseline every paragraph inherits (spacing, font). */
function parseDocDefaults(xml: string): StyleDef {
  const dd = xml.match(/<w:docDefaults>[\s\S]*?<\/w:docDefaults>/)?.[0] ?? "";
  const rpr = dd.match(/<w:rPrDefault>[\s\S]*?<w:rPr>([\s\S]*?)<\/w:rPr>/)?.[1] ?? "";
  const ppr = dd.match(/<w:pPrDefault>[\s\S]*?<w:pPr>([\s\S]*?)<\/w:pPr>/)?.[1] ?? "";
  const def: StyleDef = { key: "normal", label: "Normal", node: "paragraph" };
  const font = wAttr(rpr.match(/<w:rFonts\b[^>]*>/)?.[0] ?? "", "ascii")
    ?? wAttr(rpr.match(/<w:rFonts\b[^>]*>/)?.[0] ?? "", "hAnsi");
  if (font) def.fontFamily = `'${font}', serif`;
  const sz = rpr.match(/<w:sz\b[^>]*w:val="(\d+)"/)?.[1];
  if (sz) def.fontSize = `${Math.round(parseInt(sz) * 2 / 3)}px`;
  const spacing = ppr.match(/<w:spacing\b[^>]*>/)?.[0] ?? "";
  const sb = spacing.match(/w:before="(\d+)"/)?.[1];
  const sa = spacing.match(/w:after="(\d+)"/)?.[1];
  if (sb) def.spaceBefore = Math.round(parseInt(sb) / 15);
  if (sa) def.spaceAfter = Math.round(parseInt(sa) / 15);
  const line = spacing.match(/w:line="(\d+)"/)?.[1];
  if (line) {
    const rule = wAttr(spacing, "lineRule") ?? "auto";
    def.lineHeight = rule === "auto" ? String(+(parseInt(line) / 240).toFixed(2)) : `${Math.round(parseInt(line) / 15)}px`;
  }
  return def;
}

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

/** Parse word/styles.xml character styles → run-prop payloads, so a run's
 *  w:rStyle contributes its font/size/color when mammoth drops the style. */
function parseCharStylesXml(xml: string): DocxMeta["charStyles"] {
  const out: DocxMeta["charStyles"] = new Map();
  for (const m of xml.matchAll(/<w:style\b[^>]*w:type="character"[\s\S]*?<\/w:style>/g)) {
    const s = m[0];
    const id = s.match(/w:styleId="([^"]+)"/)?.[1];
    if (!id) continue;
    const rpr = s.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)?.[1] ?? "";
    out.set(id, {
      props: readRunProps(rpr),
      basedOn: wAttr(s.match(/<w:basedOn\b[^>]*>/)?.[0] ?? "", "val"),
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

/** Parse word/settings.xml → doc-level switches that map onto PageSetup. */
function parseSettingsXml(xml: string): DocxSettings {
  const on = (tag: string) => {
    const t = xml.match(new RegExp(`<w:${tag}\\b[^>]*>`))?.[0];
    return t ? !/w:val="(0|false|off|none)"/.test(t) : false;
  };
  const twips = (tag: string) => {
    const v = xml.match(new RegExp(`<w:${tag}\\b[^>]*w:val="(\\d+)"`))?.[1];
    return v ? Math.round(parseInt(v) / 15) : undefined;
  };
  const lim = xml.match(/<w:consecutiveHyphenLimit\b[^>]*w:val="(\d+)"/)?.[1];
  return {
    hyphenate: on("autoHyphenation") || undefined,
    hyphenZone: twips("hyphenationZone"),
    hyphenLimit: lim ? Math.max(1, parseInt(lim)) : undefined,
    evenOdd: on("evenAndOddHeaders") || undefined,
  };
}

/** First sectPr's page geometry → doc-level setup (the first pPr-level sectPr
 *  describes section 1; with none, the trailing body sectPr does). */
function firstSectionPage(docXml: string): DocxSettings["page"] {
  const sect = docXml.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/)?.[0];
  if (!sect) return undefined;
  const tw = (tag: string, name: string) => {
    const v = sect.match(new RegExp(`<w:${tag}\\b[^>]*w:${name}="([^"]*)"`))?.[1];
    return v != null ? Math.round(parseInt(v) / 15) : null;
  };
  const w = tw("pgSz", "w"), h = tw("pgSz", "h");
  const mt = tw("pgMar", "top"), mb = tw("pgMar", "bottom"),
    ml = tw("pgMar", "left"), mr = tw("pgMar", "right");
  if (w == null && h == null && mt == null && mb == null && ml == null && mr == null) return undefined;
  return { w: w ?? 0, h: h ?? 0, mt: mt ?? 0, mb: mb ?? 0, ml: ml ?? 0, mr: mr ?? 0 };
}

/** First sectPr's w:pgNumType → doc-level page-number format/start. */
function firstSectionPn(docXml: string): DocxSettings["pn"] {
  const sect = docXml.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/)?.[0];
  if (!sect) return undefined;
  const fmt = OOXML_PN_FMT[wAttr(sect.match(/<w:pgNumType\b[^>]*\/?>/)?.[0] ?? "", "fmt") ?? ""];
  const start = sect.match(/<w:pgNumType\b[^>]*w:start="(\d+)"/)?.[1];
  if (!fmt && !start) return undefined;
  return { fmt, start: start ? parseInt(start) : undefined };
}

const sentinel = (text: string) =>
  `<w:r><w:t xml:space="preserve">⟦${text}⟧</w:t></w:r>`;

/** Rewrite math zones + break constructs in document.xml as sentinel text
 *  runs; returns the (possibly rewritten) package and the rewritten xml. */
async function preprocessDocx(arrayBuffer: ArrayBuffer): Promise<{ buffer: ArrayBuffer; docXml: string; meta: DocxMeta }> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(arrayBuffer);
  const stylesXml = await zip.file("word/styles.xml")?.async("text") ?? "";
  const meta: DocxMeta = {
    styles: parseStylesXml(stylesXml),
    docDefaults: parseDocDefaults(stylesXml),
    charStyles: parseCharStylesXml(stylesXml),
    numFmt: parseNumberingXml(await zip.file("word/numbering.xml")?.async("text") ?? ""),
    comments: parseCommentsXml(await zip.file("word/comments.xml")?.async("text") ?? ""),
    docProps: parseCoreXml(await zip.file("docProps/core.xml")?.async("text") ?? ""),
    settings: parseSettingsXml(await zip.file("word/settings.xml")?.async("text") ?? ""),
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
  meta.settings.page = firstSectionPage(docXml);
  meta.settings.pn = firstSectionPn(docXml);

  // w:pStyle / w:numPr / comment ranges → sentinel runs (mammoth drops the
  // original constructs; the sentinels survive as literal text we post-process).
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
    // payload carries {t: linear source for display, x: raw OMML for verbatim re-export}
    const run = (body: string, tag: string) =>
      `<w:r><w:t xml:space="preserve">⟦${tag}:${b64enc(JSON.stringify({ t: ommlToLinear(body) || mathText(body), x: body }))}⟧</w:t></w:r>`;
    docXml = docXml
      .replace(/<m:oMathPara\b[\s\S]*?<\/m:oMathPara>/g, (m, off: number, whole: string) => {
        const r = run(m, "KXMB");
        // block-level oMathPara needs a w:p wrapper for mammoth to keep it;
        // one nested inside a w:p already gets run-level treatment
        const before = whole.slice(0, off);
        const inP = Math.max(before.lastIndexOf("<w:p>"), before.lastIndexOf("<w:p ")) > before.lastIndexOf("</w:p>");
        return inP ? r : `<w:p>${r}</w:p>`;
      })
      .replace(/<m:oMath\b[\s\S]*?<\/m:oMath>/g, (m) => run(m, "KXMI"));
  }

  // <w:r><w:br w:type="page|column"/></w:r> → sentinel runs (mammoth drops them)
  docXml = docXml.replace(
    /<w:r\b[^>]*>\s*<w:br\b[^>]*w:type="(page|column)"[^>]*\/?>\s*<\/w:r>/g,
    (_, t) => `<w:r><w:t xml:space="preserve">⟦${t === "page" ? "KXPB" : "KXCB"}⟧</w:t></w:r>`,
  );

  // Tracked changes — mammoth drops w:del outright and flattens w:ins. Unwrap
  // both into sentinel pairs; the HTML pass turns them into real ins/del
  // marks so changes remain reviewable (accept/reject) after import.
  docXml = docXml
    .replace(/<w:delInstrText\b[\s\S]*?<\/w:delInstrText>/g, "")
    .replace(/<w:delText\b([^>]*)>/g, "<w:t$1>")
    .replace(/<\/w:delText>/g, "</w:t>");
  const trackAttrs = (attrs: string) => b64enc(JSON.stringify({
    id: attrs.match(/w:id="([^"]*)"/)?.[1] ?? "",
    author: attrs.match(/w:author="([^"]*)"/)?.[1] ?? "",
    date: attrs.match(/w:date="([^"]*)"/)?.[1] ?? "",
  }));
  docXml = docXml
    // self-closing <w:del/> (deleted paragraph mark in rPr) excluded via [^/]
    .replace(/<w:(ins|del|moveFrom|moveTo)\b((?:[^>]*[^/])?)>/g, (_m, tag: string, attrs: string) =>
      sentinel(`KXT${tag === "ins" || tag === "moveTo" ? "I" : "D"}:${trackAttrs(attrs)}`))
    .replace(/<\/w:(ins|del|moveFrom|moveTo)>/g, sentinel("KXTE"));

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

    if (sects.length) {
      const relsXml = await zip.file("word/_rels/document.xml.rels")?.async("text") ?? "";
      const relMap: Record<string, string> = {};
      for (const r of relsXml.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) relMap[r[1]] = r[2];
      const hfText = async (sect: string, kind: "header" | "footer") => {
        const refs = [...sect.matchAll(new RegExp(`<w:${kind}Reference\\b[^>]*>`, "g"))].map((r) => r[0]);
        const def = refs.find((r) => /w:type="default"/.test(r)) ?? refs[0];
        const rid = def?.match(/r:id="([^"]+)"/)?.[1];
        const part = rid && relMap[rid]
          ? await zip.file(`word/${relMap[rid]}`)?.async("text") : undefined;
        if (!part) return null;
        const text = [...part.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => xmlUnescape(m[1])).join("");
        return text.trim() || null;
      };
      if (pPrSects.length) {
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
          pnFmt: OOXML_PN_FMT[wv("pgNumType", "fmt") ?? ""] ?? null,
          vAlign: wv("vAlign", "val") ?? null,
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
      // Section 1's own header/footer text never reaches a marker — carry it
      // into doc-level setup (later sections get theirs via KXSB payloads).
      const fs = pPrSects[0]?.xml ?? bodySect?.xml;
      if (fs) {
        const hl = await hfText(fs, "header"), fl = await hfText(fs, "footer");
        if (hl || fl) meta.settings.hf = { headerLeft: hl ?? undefined, footerLeft: fl ?? undefined };
      }
    }
    // Section 1's own vAlign (title-page centering) never reaches a marker —
    // carry it into the document's first block instead.
    const firstSect = pPrSects[0]?.xml ?? bodySect?.xml;
    const va = firstSect?.match(/<w:vAlign\b[^>]*w:val="([^"]+)"/)?.[1];
    if (va && va !== "top")
      docXml = docXml.replace(/<w:p\b[^>]*>/, (m) => `${m}${sentinel(`KXSA:${b64enc(JSON.stringify({ vAlign: va }))}`)}`);
  }

  // mammoth silently drops w:sdt content controls and floating-object
  // geometry — anchored images and text boxes lost their position, wrap mode
  // and size entirely (boxes were previously hoisted to the document end,
  // scrambling order). Extract txbxContent up front, then walk each drawing /
  // VML picture: anchored objects emit ⟦KXFO⟧/⟦KXTB⟧ sentinels carrying the
  // wp:anchor geometry; box bodies are appended at body end between
  // ⟦KXTBB⟧/⟦KXTBE⟧ markers so mammoth still converts their paragraphs.
  {
    let prev = "";
    // mc:Fallback duplicates the mc:Choice payload as VML — drop it or every
    // DrawingML object would be extracted twice.
    while (prev !== docXml) {
      prev = docXml;
      docXml = docXml.replace(/<mc:Fallback\b[^>]*>[\s\S]*?<\/mc:Fallback>/g, "");
    }
    prev = "";
    while (prev !== docXml) {
      prev = docXml;
      docXml = docXml.replace(
        // `(?!<w:sdt[\s>])` blocks only nested <w:sdt> opens — sdtPr /
        // sdtContent share the prefix and must be consumable
        /<w:sdt\b[^>]*>((?:(?!<w:sdt[\s>])[\s\S])*)<\/w:sdt\s*>/g,
        (_, inner: string) => {
          const pr = inner.match(/<w:sdtPr\b[^>]*>[\s\S]*?<\/w:sdtPr>/)?.[0] ?? "";
          const content = inner.match(/<w:sdtContent\b[^>]*>([\s\S]*?)<\/w:sdtContent>/)?.[1] ?? "";
          if (!pr) return content; // no properties → nothing worth round-tripping
          const b64 = b64enc(pr);
          // block-level controls wrap whole paragraphs/tables — bracket them
          // with sentinel paragraphs so each enclosed block gets data-sdt
          if (/^\s*<w:(p|tbl)\b/.test(content))
            return `<w:p>${sentinel(`KXSDB:${b64}`)}</w:p>${content}<w:p>${sentinel("KXSDE")}</w:p>`;
          return `${sentinel(`KXSD:${b64}`)}${content}${sentinel("KXSDE")}`;
        },
      );
    }

    const boxes: { inner: string; geo: Record<string, unknown>; plain?: boolean }[] = [];
    // pass A — text-box bodies out to placeholders (placeholder is plain text
    // inside the drawing markup; the drawing pass below swaps in real sentinels)
    do {
      prev = docXml;
      docXml = docXml.replace(
        /<w:txbxContent[^>]*>((?:(?!<w:txbxContent)[\s\S])*)<\/w:txbxContent>/g,
        (_, inner: string) => `⟦KXTBBOX:${boxes.push({ inner, geo: {} }) - 1}⟧`,
      );
    } while (prev !== docXml);

    const EMU = 9525;
    const docGeo = (() => {
      const sect = docXml.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/)?.[0] ?? "";
      const tw = (tag: string, name: string) => {
        const v = sect.match(new RegExp(`<w:${tag}\\b[^>]*w:${name}="([^"]*)"`))?.[1];
        return v != null ? Math.round(parseInt(v) / 15) : null;
      };
      return {
        pw: tw("pgSz", "w") ?? 816, ph: tw("pgSz", "h") ?? 1056,
        mt: tw("pgMar", "top") ?? 96, mb: tw("pgMar", "bottom") ?? 96,
        ml: tw("pgMar", "left") ?? 96, mr: tw("pgMar", "right") ?? 96,
      };
    })();
    /** wp:anchor/wp:inline geometry → node attrs. posX/posY are deltas from
     *  the object's flow position (what our translate() offsets mean): page-
     *  relative offsets are re-based to margin-relative, paragraph/margin
     *  offsets pass through. Vertical page/margin alignment assumes the anchor
     *  paragraph sits at the band top — the common case for floats. */
    const anchorGeo = (ax: string): Record<string, unknown> => {
      const extent = ax.match(/<wp:extent\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
      const w = extent ? Math.round(+extent[1] / EMU) : 0;
      const h = extent ? Math.round(+extent[2] / EMU) : 0;
      const contentW = Math.max(1, docGeo.pw - docGeo.ml - docGeo.mr);
      const innerH = Math.max(1, docGeo.ph - docGeo.mt - docGeo.mb);
      let posX = 0, posY = 0, align: string | undefined;
      const pos = (axis: "H" | "V") =>
        ax.match(new RegExp(`<wp:position${axis}\\b[^>]*relativeFrom="([^"]+)"[^>]*>([\\s\\S]*?)</wp:position${axis}>`));
      const ph = pos("H"), pv = pos("V");
      const offOf = (body: string) => {
        const v = body.match(/<wp:posOffset>(-?\d+)<\/wp:posOffset>/)?.[1];
        return v != null ? Math.round(+v / EMU) : null;
      };
      const alignOf = (body: string) => body.match(/<wp:align>(\w+)<\/wp:align>/)?.[1];
      if (ph) {
        const a = alignOf(ph[2]), o = offOf(ph[2]);
        const base = ph[1] === "page" ? -docGeo.ml : 0;
        if (a === "center" || a === "right") {
          const ref = ph[1] === "page" ? docGeo.pw : contentW;
          posX = base + (a === "center" ? Math.round((ref - w) / 2) : ref - w);
          align = a;
        } else if (a) { posX = base; align = "left"; }
        else if (o != null) posX = base + o;
      }
      if (pv) {
        const a = alignOf(pv[2]), o = offOf(pv[2]);
        const base = pv[1] === "page" ? -docGeo.mt : 0;
        if (a === "center" || a === "bottom") {
          const ref = pv[1] === "page" ? docGeo.ph : innerH;
          posY = base + (a === "center" ? Math.round((ref - h) / 2) : ref - h);
        } else if (a) posY = base;
        else if (o != null) posY = base + o;
      }
      const behind = /behindDoc="1"/.test(ax);
      const wrap = behind ? "behind"
        : /<wp:wrapNone\b/.test(ax) ? "front"
        : /<wp:wrapTight\b|<wp:wrapThrough\b/.test(ax) ? "tight"
        : /<wp:wrapTopAndBottom\b/.test(ax) ? "topBottom"
        : "square";
      // float wraps need a left/right side — infer it from the h position
      if ((wrap === "square" || wrap === "tight") && align !== "right")
        align = posX > contentW / 2 ? "right" : "left";
      return { wrap, align, posX, posY, w, h };
    };
    const mtext = (s: string) => `<w:t xml:space="preserve">${s}</w:t>`;

    // pass B — DrawingML objects. Sentinels go inside the same run just before
    // <w:drawing> so mammoth emits them adjacent to (or instead of) the img.
    docXml = docXml.replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, (block) => {
      const anchor = block.match(/<wp:anchor\b[\s\S]*?<\/wp:anchor>/)?.[0];
      const geo = anchor ? anchorGeo(anchor) : (() => {
        const ext = block.match(/<wp:extent\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
        return ext ? { wrap: "inline", w: Math.round(+ext[1] / EMU), h: Math.round(+ext[2] / EMU) } : {};
      })();
      let marker = "";
      let out = block.replace(/⟦KXTBBOX:(\d+)⟧/g, (_m, i) => {
        boxes[+i].geo = geo;
        marker += `⟦KXTB:${b64enc(JSON.stringify({ i: +i, ...geo }))}⟧`;
        return "";
      });
      if (/<a:blip\b/.test(out)) marker += `⟦KXFO:${b64enc(JSON.stringify(geo))}⟧`;
      return marker ? `${mtext(marker)}${out}` : out;
    });

    // pass C — VML pictures: v:textbox (older shape text) gets a textbox
    // sentinel; standalone v:shape geometry comes from its inline style.
    docXml = docXml.replace(/<w:pict>[\s\S]*?<\/w:pict>/g, (block) => {
      if (!/⟦KXTBBOX:\d+⟧/.test(block)) return block;
      const st = block.match(/<v:shape\b[^>]*style="([^"]*)"/)?.[1] ?? "";
      const pt = (k: string) => {
        const v = st.match(new RegExp(`(?:^|;)\\s*${k}:([^;]+)`))?.[1]?.trim();
        return v ? Math.round(parseFloat(v) * 4 / 3) : 0; // pt → px
      };
      const geo: Record<string, unknown> = { wrap: "front", posX: pt("margin-left"), posY: pt("margin-top"), w: pt("width") };
      const fill = block.match(/<v:shape\b[^>]*fillcolor="([^"]+)"/)?.[1];
      if (fill && fill !== "none") geo.bg = fill;
      let marker = "";
      const out = block.replace(/⟦KXTBBOX:(\d+)⟧/g, (_m, i) => {
        boxes[+i].geo = geo;
        marker += `⟦KXTB:${b64enc(JSON.stringify({ i: +i, ...geo }))}⟧`;
        return "";
      });
      return `${mtext(marker)}${out}`;
    });

    // stray placeholders (txbx outside any drawing/pict — e.g. detached boxes)
    // keep the old behavior: plain paragraphs appended at body end.
    docXml = docXml.replace(/⟦KXTBBOX:(\d+)⟧/g, (_m, i) => { boxes[+i].plain = true; return ""; });

    if (boxes.length) {
      const parts: string[] = [];
      boxes.forEach((b, i) => {
        if (b.plain) { parts.push(b.inner); return; }
        parts.push(
          `<w:p>${sentinel(`KXTBB:${i}`)}</w:p>`,
          b.inner,
          `<w:p>${sentinel("KXTBE")}</w:p>`,
        );
      });
      docXml = docXml.replace(/<\/w:body>/, `${parts.join("")}</w:body>`);
    }
  }

  docXml = injectFormatSentinels(docXml, meta);

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

/** Markers → the math extensions' parse HTML (div/span[data-type=*-math]).
 *  data-omml carries the original OMML (b64 — attribute-safe) so export can
 *  emit the equation byte-for-byte. */
function mathMarkersToHtml(html: string): string {
  const dec = (b: string): { t: string; x: string } => {
    const s = b64dec(b);
    try {
      const o = JSON.parse(s) as { t?: string; x?: string };
      if (o && typeof o === "object") return { t: o.t ?? "", x: o.x ?? "" };
    } catch { /* legacy payload: bare linear text */ }
    return { t: s, x: "" };
  };
  return html
    .replace(/<p>⟦KXMB:([A-Za-z0-9+/=]*)⟧<\/p>/g, (_, b) => {
      const m = dec(b);
      return `<div data-type="block-math" data-latex="${attrEsc(m.t)}" data-omml="${m.x ? b64enc(m.x) : ""}"></div>`;
    })
    .replace(MATH_I, (_, b) => {
      const m = dec(b);
      return `<span data-type="inline-math" data-latex="${attrEsc(m.t)}" data-omml="${m.x ? b64enc(m.x) : ""}"></span>`;
    });
}

interface SectMarkerProps {
  type?: string; pageWidth?: number | null; pageHeight?: number | null;
  marginTop?: number | null; marginBottom?: number | null;
  marginLeft?: number | null; marginRight?: number | null;
  cols?: number | null; colGap?: number | null; pnStart?: number | null;
  pnFmt?: string | null; vAlign?: string | null;
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
  // A page-break run in the same paragraph as a section break is redundant —
  // the boundary already breaks the page, and keeping both makes a blank page.
  html = html.replace(/⟦KXSB:([A-Za-z0-9+/=]*)⟧⟦KXPB⟧|⟦KXPB⟧⟦KXSB:([A-Za-z0-9+/=]*)⟧/g,
    (m, a?: string, b?: string) => {
      const b64 = a ?? b ?? "";
      try {
        const p = JSON.parse(b64dec(b64)) as SectMarkerProps;
        if (p.type !== "continuous") return `⟦KXSB:${b64}⟧`;
      } catch { /* keep both */ }
      return m;
    });
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
    if (p.pnFmt) s += ` data-pn-fmt="${esc(p.pnFmt)}"`;
    if (p.vAlign && p.vAlign !== "top") s += ` data-v-align="${esc(p.vAlign)}"`;
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
      return inject(tok,
        (row.cantSplit ? ` data-cant-split="true"` : "") +
        (row.exact ? ` data-height-mode="exact"` : ""),
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
    const attrs = cell.colw ? ` colwidth="${cell.colw}"` : "";
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
  // docDefaults + the document's default (Normal) style → the "normal" def,
  // which targets paragraphs carrying no data-style (see selectorFor).
  const normalStyle = [...meta.styles.values()].find((s) =>
    s.name.toLowerCase().replace(/[^a-z0-9]/g, "") === "normal");
  const normalDef: StyleDef = { ...meta.docDefaults, ...(normalStyle?.def ?? {}), key: "normal", label: "Normal", node: "paragraph" };
  if (cssFor(normalDef)) styles.normal = normalDef;
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
 *  <ol>; sentinels stripped afterward. Word numbering continues across the
 *  whole document per numId — including across table cells — but mammoth
 *  emits a fresh <ol> per run of adjacent items, each rendering from 1.
 *  Track a counter per numId and stamp each <ol>'s start with the ordinal
 *  of its first numbered item. */
function numMarkersToHtml(html: string, meta: DocxMeta): string {
  html = html.replace(
    /<(ol|ul)>((?:(?!<\/?(?:ol|ul)\b)[\s\S]){0,1200}?)(⟦KXN:(\d+):(\d+)⟧)/g,
    (m, tag, pre, sentinel, numId, lvl) => {
      const info = meta.numFmt.get(`${numId}:${lvl}`) ?? meta.numFmt.get(numId);
      if (tag !== "ol" || !info || info.fmt === "bullet") return m;
      const css = NUM_CSS[info.fmt];
      const attrs = css && css !== "decimal" ? ` style="list-style-type:${css}"` : "";
      return `<${tag}${attrs}>${pre}${sentinel}`;
    },
  );
  const counters = new Map<string, number>();
  const startFor = (id: string, lvl: string) =>
    meta.numFmt.get(`${id}:${lvl}`)?.start ?? meta.numFmt.get(id)?.start ?? 1;
  const inserts: { pos: number; text: string }[] = [];
  const stack: { tag: string; pending: boolean; pos: number }[] = [];
  const token = /<(ol|ul)\b[^>]*>|<\/(?:ol|ul)>|⟦KXN:(\d+):(\d+)⟧/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(html))) {
    if (m[1]) stack.push({ tag: m[1], pending: true, pos: m.index + m[0].length - 1 });
    else if (m[2] == null) stack.pop();
    else {
      const next = counters.get(m[2]) ?? startFor(m[2], m[3]);
      counters.set(m[2], next + 1);
      const top = stack[stack.length - 1];
      if (top?.tag === "ol" && top.pending) {
        top.pending = false;
        if (next > 1) inserts.push({ pos: top.pos, text: ` start="${next}"` });
      }
    }
  }
  for (const ins of inserts.reverse())
    html = html.slice(0, ins.pos) + ins.text + html.slice(ins.pos);
  return html.replace(/⟦KXN:\d+:\d+⟧/g, "");
}

/** mammoth renders w:footnoteReference/endnoteReference as
 *  <sup><a href="#footnote-N">[n]</a></sup> plus a trailing <ol> of
 *  <li id="footnote-N"> bodies. Fold them into real footnote nodes so the
 *  paginator places them at page bottoms and re-export keeps them notes. */
function footnoteMarkersToHtml(html: string): string {
  const notes = new Map<string, { kind: string; text: string }>();
  html = html.replace(
    /<li id="(foot|end)note-(\d+)">([\s\S]*?)<\/li>/g,
    (_m, kind: string, id: string, body: string) => {
      const text = body
        .replace(/<a href="#(?:foot|end)note-ref-\d+"[^>]*>[\s\S]*?<\/a>/g, "")
        .replace(/<[^>]+>/g, "");
      notes.set(`${kind}-${id}`, {
        kind: kind === "foot" ? "footnote" : "endnote",
        text: xmlUnescape(text).replace(/\s+/g, " ").trim(),
      });
      return "";
    });
  if (!notes.size) return html;
  return html
    .replace(/<ol>\s*<\/ol>/g, "")
    .replace(/<sup><a href="#(foot|end)note-(\d+)"[^>]*>[\s\S]*?<\/a><\/sup>/g,
      (_m, kind: string, id: string) => {
        const n = notes.get(`${kind}-${id}`);
        return `<sup data-type="footnote" data-kind="${n?.kind ?? "footnote"}" data-note="${attrEsc(n?.text ?? "")}"></sup>`;
      });
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

/** ⟦KXTI:b64⟧…⟦KXTE⟧ → <ins>, ⟦KXTD:b64⟧…⟦KXTE⟧ → <del> — the schema's
 *  track-change marks parse ins/del[data-change-id] so imported revisions
 *  stay reviewable. Stray markers (block-level w:ins mammoth skipped) are
 *  stripped so they never leak as literal text. */
function trackMarkersToHtml(html: string): string {
  html = html.replace(
    /⟦KXT([ID]):([A-Za-z0-9+/=]*)⟧([\s\S]*?)⟦KXTE⟧/g,
    (_m, kind: string, b64: string, body: string) => {
      const meta = JSON.parse(b64dec(b64) || "{}") as
        { id?: string; author?: string; date?: string };
      const tag = kind === "I" ? "ins" : "del";
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      const attrs = ` data-change-id="imp-${esc(meta.id || `${Math.random().toString(36).slice(2)}`)}"`
        + (meta.author ? ` data-author-name="${esc(meta.author)}"` : "")
        + (meta.date ? ` data-timestamp="${esc(meta.date)}"` : "");
      return `<${tag}${attrs}>${body}</${tag}>`;
    },
  );
  return html.replace(/⟦KXT[ID]:[A-Za-z0-9+/=]*⟧|⟦KXTE⟧/g, "");
}

// ---- content controls (w:sdt) -----------------------------------------------

const SDT_KINDS = [
  "checkbox", "dropDownList", "comboBox", "date", "docPartObj",
  "buildingBlockGallery", "repeatingSection", "entityPicker", "bibliography",
  "citation", "equation", "picture", "group", "richText", "text",
] as const;

/** sdtPr XML → the bits the editor surface needs (the raw XML is kept whole
 *  in the mark attr — every other property round-trips untouched). */
function sdtMeta(prXml: string): { kind: string; alias: string; checked: string | null } {
  let kind = "text";
  for (const k of SDT_KINDS) {
    if (new RegExp(`<w(?:14)?:${k}\\b`).test(prXml)) { kind = k; break; }
  }
  const alias = prXml.match(/<w:alias\b[^>]*?w:val="([^"]*)"/)?.[1] ?? "";
  const checked = kind === "checkbox"
    ? (prXml.match(/<w14:checked\b[^>]*?w14:val="([^"]*)"/)?.[1] ?? "0")
    : null;
  return { kind, alias, checked };
}

/** ⟦KXSD:b64⟧…⟦KXSDE⟧ → <span data-sdt> marks; ⟦KXSDB:b64⟧…⟦KXSDE⟧ sentinel
 *  paragraphs → data-sdt attrs on the enclosed block elements. Stack-matched
 *  so nested controls pair correctly. */
function sdtMarkersToHtml(html: string): string {
  type Pair = { s: number; slen: number; e: number; elen: number; b64: string };
  const pairUp = (openRe: RegExp, closeTok: string): Pair[] => {
    const re = new RegExp(`${openRe.source}|${closeTok.replace(/[⟦⟧]/g, (c) => `\\${c}`)}`, "g");
    const stack: { pos: number; len: number; b64: string }[] = [];
    const pairs: Pair[] = [];
    for (const m of html.matchAll(re)) {
      const tok = m[0];
      if (tok === closeTok) {
        const open = stack.pop();
        if (open) pairs.push({ s: open.pos, slen: open.len, e: m.index!, elen: tok.length, b64: open.b64 });
      } else {
        stack.push({ pos: m.index!, len: tok.length, b64: m[1]! });
      }
    }
    return pairs.sort((a, b) => b.s - a.s); // last→first keeps offsets valid
  };

  // block-level first so its marker paragraphs can't confuse the inline pass
  for (const p of pairUp(/<p>⟦KXSDB:([A-Za-z0-9+/=]*)⟧<\/p>/g, "<p>⟦KXSDE⟧</p>")) {
    const inner = html.slice(p.s + p.slen, p.e)
      .replace(/<(p|h[1-6]|ul|ol|table|blockquote|div)\b(?![^>]*\bdata-sdt=)/g, `<$1 data-sdt="${p.b64}"`);
    html = html.slice(0, p.s) + inner + html.slice(p.e + p.elen);
  }
  for (const p of pairUp(/⟦KXSD:([A-Za-z0-9+/=]*)⟧/g, "⟦KXSDE⟧")) {
    const meta = sdtMeta(b64dec(p.b64));
    const attrs = `data-sdt="${p.b64}" data-sdt-kind="${meta.kind}"` +
      (meta.alias ? ` data-sdt-alias="${attrEsc(meta.alias)}"` : "") +
      (meta.checked != null ? ` data-sdt-checked="${meta.checked}"` : "");
    html = html.slice(0, p.s) + `<span ${attrs}>` + html.slice(p.s + p.slen, p.e) + "</span>" + html.slice(p.e + p.elen);
  }
  return html.replace(/⟦KXSD[^⟧]*⟧/g, "").replace(/⟦KXSDE⟧/g, "");
}

// ---- direct formatting (w:pPr / w:rPr direct props) -------------------------
// Mammoth reads w:jc, w:sz, w:rFonts, w:color, w:spacing, w:ind into its
// document model but emits none of them — a centered 22pt title collapses to
// body text. Encode direct props as sentinel runs (same pattern as pStyle /
// breaks) and rebuild them as inline CSS / data attrs on the HTML afterwards.

const HI_COLOR: Record<string, string> = {
  yellow: "yellow", green: "green", cyan: "cyan", magenta: "magenta",
  blue: "blue", red: "red", black: "black", white: "white",
  lightGray: "lightgray", darkGray: "darkgray", darkYellow: "#808000",
  darkGreen: "darkgreen", darkCyan: "teal", darkMagenta: "purple",
  darkBlue: "darkblue", darkRed: "darkred",
};

const U_DECO: Record<string, string> = {
  single: "solid", double: "double", thick: "solid", dotted: "dotted",
  dash: "dashed", dotDash: "dashed", dotDotDash: "dashed", wave: "wavy",
  wavyHeavy: "wavy", wavyDouble: "wavy", dashHeavy: "dashed", dashLong: "dashed",
};

const on = (tag: string) => !/w:val="(0|false|off|none|nil)"/.test(tag);

/** w:rPr fragment → compact payload (f=font, s=pt, c/h=colors, ls=pt,
 *  caps/scaps/hid/ds flags, us/uc underline style+color). */
function readRunProps(rpr: string): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  const attr = (tag: string, a: string) =>
    rpr.match(new RegExp(`<w:${tag}\\b[^>]*w:${a}="([^"]*)"`))?.[1];
  const flag = (tag: string) => {
    const t = rpr.match(new RegExp(`<w:${tag}\\b[^>]*>`))?.[0];
    return t ? on(t) : false;
  };
  const font = attr("rFonts", "ascii") ?? attr("rFonts", "hAnsi");
  if (font) p.f = font;
  const sz = attr("sz", "val");
  if (sz && /^\d+$/.test(sz)) p.s = parseInt(sz) / 2;
  const color = attr("color", "val");
  if (color && color !== "auto") p.c = `#${color}`;
  const hl = attr("highlight", "val");
  if (hl && hl !== "none") p.h = HI_COLOR[hl] ?? "yellow";
  const shd = attr("shd", "fill");
  if (shd && shd !== "auto" && shd !== "clear" && !p.h) p.h = `#${shd}`;
  const sp = attr("spacing", "val");
  if (sp && /^-?\d+$/.test(sp)) p.ls = parseInt(sp) / 20; // twentieths of a pt
  if (flag("caps")) p.caps = 1;
  if (flag("smallCaps")) p.scaps = 1;
  if (flag("vanish")) p.hid = 1;
  if (flag("dstrike")) p.ds = 1;
  const u = attr("u", "val");
  if (u && u !== "none" && u !== "single") p.us = U_DECO[u] ?? "solid";
  const uc = attr("u", "color");
  if (uc && uc !== "auto") p.uc = `#${uc}`;
  return p;
}

/** w:pPr fragment → compact payload (a=align, sb/sa=px, lh="mode:value",
 *  il/ir/fl px, pbb/kn/kl/wo flags, bg, dir). Borders → ParaBorders shape. */
function readParaProps(ppr: string): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  const attr = (tag: string, a: string) =>
    ppr.match(new RegExp(`<w:${tag}\\b[^>]*w:${a}="([^"]*)"`))?.[1];
  const flag = (tag: string) => {
    const t = ppr.match(new RegExp(`<w:${tag}\\b[^>]*>`))?.[0];
    return t ? on(t) : false;
  };
  const JC: Record<string, string> = {
    center: "center", right: "right", end: "right",
    both: "justify", distribute: "justify", mediumKashida: "justify",
  };
  const jc = attr("jc", "val");
  if (jc && JC[jc]) p.a = JC[jc];
  const spacing = ppr.match(/<w:spacing\b[^>]*\/?>/)?.[0] ?? "";
  const sv = (n: string) => spacing.match(new RegExp(`w:${n}="(-?\\d+)"`))?.[1];
  const sb = sv("before"), sa = sv("after"), line = sv("line");
  if (sb) p.sb = Math.round(parseInt(sb) / 15);
  if (sa) p.sa = Math.round(parseInt(sa) / 15);
  if (line) {
    const rule = spacing.match(/w:lineRule="([^"]+)"/)?.[1] ?? "auto";
    p.lh = rule === "auto" ? `multiple:${+(parseInt(line) / 240).toFixed(2)}`
      : `${rule === "exact" ? "exact" : "atLeast"}:${Math.round(parseInt(line) / 15)}px`;
  }
  const ind = ppr.match(/<w:ind\b[^>]*\/?>/)?.[0] ?? "";
  const iv = (n: string) => ind.match(new RegExp(`w:${n}="(-?\\d+)"`))?.[1];
  const il = iv("left") ?? iv("start"), ir = iv("right") ?? iv("end");
  const fl = iv("firstLine"), hang = iv("hanging");
  if (il) p.il = Math.round(parseInt(il) / 15);
  if (ir) p.ir = Math.round(parseInt(ir) / 15);
  if (fl) p.fl = Math.round(parseInt(fl) / 15);
  else if (hang) p.fl = -Math.round(parseInt(hang) / 15);
  if (flag("pageBreakBefore")) p.pbb = 1;
  if (flag("keepNext")) p.kn = 1;
  if (flag("keepLines")) p.kl = 1;
  if (flag("widowControl")) p.wo = 1;
  if (flag("suppressAutoHyphens")) p.nh = 1;
  const shd = attr("shd", "fill");
  if (shd && shd !== "auto" && shd !== "clear") p.bg = `#${shd}`;
  if (flag("bidi")) p.dir = "rtl";
  const tabsXml = ppr.match(/<w:tabs>[\s\S]*?<\/w:tabs>/)?.[0];
  if (tabsXml) {
    const TVAL: Record<string, string> = {
      left: "left", start: "left", center: "center",
      right: "right", end: "right", decimal: "decimal",
    };
    const LEAD: Record<string, string> = {
      dot: "dot", middleDot: "dot", hyphen: "dash", underscore: "line",
      heavy: "line", none: "none",
    };
    const tabs = [...tabsXml.matchAll(/<w:tab\b[^>]*\/?>/g)]
      .map((t) => ({
        pos: Math.round(parseInt(t[0].match(/w:pos="(-?\d+)"/)?.[1] ?? "0") / 15),
        align: TVAL[t[0].match(/w:val="([^"]*)"/)?.[1] ?? "left"] ?? "left",
        ...(t[0].match(/w:leader="([^"]*)"/)?.[1]
          ? { leader: LEAD[t[0].match(/w:leader="([^"]*)"/)?.[1] ?? "none"] ?? "dot" } : {}),
      }))
      .filter((t) => t.pos > 0);
    if (tabs.length) p.tabs = tabs;
  }
  const pBdr = ppr.match(/<w:pBdr>[\s\S]*?<\/w:pBdr>/)?.[0];
  if (pBdr) {
    const borders: Record<string, { style: string; width: number; color: string }> = {};
    for (const side of ["top", "right", "bottom", "left"]) {
      const t = pBdr.match(new RegExp(`<w:${side}\\b[^>]*>`))?.[0];
      if (!t) continue;
      const val = t.match(/w:val="([^"]*)"/)?.[1];
      if (!val || val === "nil" || val === "none") continue;
      borders[side] = {
        style: BSTYLE_IN[val] ?? "solid",
        width: Math.max(1, Math.round(parseInt(t.match(/w:sz="(\d+)"/)?.[1] ?? "8") / 8)),
        color: "#" + (t.match(/w:color="([^"]*)"/)?.[1] ?? "auto").replace(/^auto$/, "000000"),
      };
    }
    if (Object.keys(borders).length) p.pb = borders;
  }
  return p;
}

/** Character-style rPr (following w:basedOn a few levels) merged into a run
 *  payload — direct formatting still wins over it. */
function charStyleProps(meta: DocxMeta, id: string, depth = 0): Record<string, unknown> {
  const s = meta.charStyles.get(id);
  if (!s || depth > 4) return {};
  return { ...(s.basedOn ? charStyleProps(meta, s.basedOn, depth + 1) : {}), ...s.props };
}

/** Inject ⟦KXPF⟧/⟦KXRF⟧ sentinels for direct formatting into every w:p. */
function injectFormatSentinels(docXml: string, meta: DocxMeta): string {
  return docXml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (pXml) => {
    // wrap each formatted run in ⟦KXRF:props⟧…⟦KXRF⟧
    let body = pXml.replace(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g, (rXml) => {
      const rpr = rXml.match(/^<w:r\b[^>]*>(<w:rPr>[\s\S]*?<\/w:rPr>)/)?.[1];
      if (!rpr) return rXml;
      // runs whose only child is a page/column break carry no text to style —
      // leaving them bare keeps the break sentinel unpolluted
      if (!/<w:t[\s>]/.test(rXml)) return rXml;
      const rStyle = rpr.match(/<w:rStyle\b[^>]*w:val="([^"]+)"/)?.[1];
      const props = { ...(rStyle ? charStyleProps(meta, rStyle) : {}), ...readRunProps(rpr) };
      return Object.keys(props).length
        ? `${sentinel(`KXRF:${b64enc(JSON.stringify(props))}`)}${rXml}${sentinel("KXRF:")}`
        : rXml;
    });
    // paragraph direct props → ⟦KXPF:props⟧ right after pPr
    const ppr = body.match(/^<w:p\b[^>]*>(<w:pPr>[\s\S]*?<\/w:pPr>)/)?.[1];
    if (ppr) {
      const props = readParaProps(ppr);
      if (Object.keys(props).length)
        body = body.replace(/<\/w:pPr>/, `</w:pPr>${sentinel(`KXPF:${b64enc(JSON.stringify(props))}`)}`);
    }
    return body;
  });
}

/** payload → inline CSS for the run span (props map onto textStyle/highlight
 *  mark attrs via el.style parsing). */
function runPropsCss(p: Record<string, unknown>): string {
  const css: string[] = [];
  if (p.f) css.push(`font-family:'${String(p.f).replace(/['"\\]/g, "")}'`);
  if (p.s) css.push(`font-size:${p.s}pt`);
  if (p.c) css.push(`color:${p.c}`);
  if (p.h) css.push(`background-color:${p.h}`);
  if (p.ls) css.push(`letter-spacing:${p.ls}pt`);
  if (p.caps) css.push("text-transform:uppercase");
  if (p.scaps) css.push("font-variant:small-caps");
  const decoLine = [p.us ? "underline" : "", p.ds ? "line-through" : ""].filter(Boolean).join(" ");
  if (decoLine) css.push(`text-decoration-line:${decoLine}`);
  if (p.us) css.push(`text-decoration-style:${p.us}`);
  if (p.uc) css.push(`text-decoration-color:${p.uc}`);
  return css.join(";");
}

/** ⟦KXRF:b64⟧…⟦KXRF:⟧ → styled <span> carrying Word's direct run props. */
function runFmtMarkersToHtml(html: string): string {
  return html
    .replace(/⟦KXRF:([A-Za-z0-9+/=]*)⟧([\s\S]*?)⟦KXRF:⟧/g, (_m, b, body) => {
      const p = JSON.parse(b64dec(b)) as Record<string, unknown>;
      const css = runPropsCss(p);
      const hid = p.hid ? ` data-hidden="1"` : "";
      return `<span style="${css}"${hid}>${body}</span>`;
    })
    .replace(/⟦KXRF:([A-Za-z0-9+/=]*)?⟧/g, "");
}

/** ⟦KXPF:b64⟧ at a block's start → style/data attrs on the element. Tolerates
 *  other sentinels (KXPS, KXN, comment marks) sitting ahead of it. */
function paraFmtMarkersToHtml(html: string): string {
  html = html.replace(
    /<(p|h[1-6]|li|td|th)\b([^>]*)>((?:(?:<[^>]+>)|⟦KX[A-Z]+(?::[^⟧]*)?⟧)*)⟦KXPF:([A-Za-z0-9+/=]*)⟧/g,
    (_m, tag, attrs: string, lead: string, b: string) => {
      const p = JSON.parse(b64dec(b)) as Record<string, unknown>;
      let style = "";
      if (p.a) style += `text-align:${p.a};`;
      if (p.sb != null) style += `margin-top:${p.sb}px;`;
      if (p.sa != null) style += `margin-bottom:${p.sa}px;`;
      if (p.il != null) style += `margin-left:${p.il}px;`;
      if (p.ir != null) style += `margin-right:${p.ir}px;`;
      if (p.fl != null) style += `text-indent:${p.fl}px;`;
      if (p.bg) style += `background-color:${p.bg};`;
      if (p.lh) {
        const v = String(p.lh).split(":")[1];
        style += `line-height:${v};`;
        attrs += ` data-line-rule="${attrEsc(String(p.lh))}"`;
      }
      if (p.pbb) attrs += ` data-pb-before="1"`;
      if (p.kn) attrs += ` data-keep-next="1"`;
      if (p.kl) attrs += ` data-keep-lines="1"`;
      if (p.wo) attrs += ` data-widow-orphan="1"`;
      if (p.nh) style += "hyphens:manual;";
      if (p.dir) attrs += ` dir="${p.dir}"`;
      if (p.pb) attrs += ` data-p-borders="${attrEsc(JSON.stringify(p.pb))}"`;
      if (p.tabs) attrs += ` data-tabs="${attrEsc(JSON.stringify(p.tabs))}"`;
      if (style) {
        attrs = /style="([^"]*)"/.test(attrs)
          ? attrs.replace(/style="([^"]*)"/, `style="$1;${style}"`)
          : `${attrs} style="${style.slice(0, -1)}"`;
      }
      return `<${tag}${attrs}>${lead}`;
    },
  );
  return html.replace(/⟦KXPF:[A-Za-z0-9+/=]*⟧/g, "");
}

/** ⟦KXSA:b64⟧ (first section's props, emitted at the document start) → data
 *  attrs on the first block element. */
function firstSectionMarkerToHtml(html: string): string {
  const m = html.match(/⟦KXSA:([A-Za-z0-9+/=]*)⟧/);
  if (!m) return html;
  html = html.replace(m[0], "");
  const p = JSON.parse(b64dec(m[1])) as { vAlign?: string };
  if (p.vAlign && p.vAlign !== "top") {
    html = html.replace(
      /<(p|h[1-6]|table|ul|ol|blockquote|div)\b([^>]*)>/,
      `<$1$2 data-v-align="${p.vAlign}">`,
    );
  }
  return html;
}

/** Floating objects: ⟦KXTB⟧→ kx-textbox divs (body HTML recovered from the
 *  ⟦KXTBB⟧…⟦KXTBE⟧ staging region); ⟦KXFO⟧+img → figure wrap/position attrs. */
function floatMarkersToHtml(html: string): string {
  const bodies = new Map<string, string>();
  html = html.replace(/<p>⟦KXTBB:(\d+)⟧<\/p>([\s\S]*?)<p>⟦KXTBE⟧<\/p>/g, (_m, i, body) => {
    bodies.set(i, body);
    return "";
  });
  const tb = (b: string) => {
    const p = JSON.parse(b64dec(b)) as Record<string, unknown>;
    const inner = bodies.get(String(p.i)) ?? "";
    const a = [`data-type="kx-textbox"`];
    if (p.align) a.push(`data-align="${p.align}"`);
    if (p.w) a.push(`data-w="${p.w}"`);
    if (p.h) a.push(`data-h="${p.h}"`);
    if (p.wrap && p.wrap !== "inline") a.push(`data-wrap="${p.wrap}"`);
    if (p.posX) a.push(`data-posx="${p.posX}"`);
    if (p.posY) a.push(`data-posy="${p.posY}"`);
    if (p.bg) a.push(`data-bg="${attrEsc(String(p.bg))}"`);
    return `<div ${a.join(" ")}>${inner}</div>`;
  };
  html = html
    .replace(/<p[^>]*>⟦KXTB:([A-Za-z0-9+/=]*)⟧<\/p>/g, (_m, b) => tb(b))
    .replace(/⟦KXTB:([A-Za-z0-9+/=]*)⟧/g, (_m, b) => `</p>${tb(b)}<p>`);
  // ⟦KXFO⟧ sits in the run just before its drawing → immediately ahead of
  // the <img> mammoth emits (allow inline tag churn between them).
  html = html.replace(
    /⟦KXFO:([A-Za-z0-9+/=]*)⟧((?:<[^>]+>)*)<img\b([^>]*?)\/?>/g,
    (_m, b, mid: string, attrs: string) => {
      const p = JSON.parse(b64dec(b)) as Record<string, unknown>;
      let a = attrs;
      if (p.w && !/\bwidth="/.test(a)) a += ` width="${p.w}"`;
      if (p.h && !/\bheight="/.test(a)) a += ` height="${p.h}"`;
      if (!p.wrap || p.wrap === "inline") return `${mid}<img${a}>`;
      return `${mid}<figure data-wrap="${p.wrap}" data-align="${p.align ?? "none"}" data-posx="${p.posX ?? 0}" data-posy="${p.posY ?? 0}"><img${a}></figure>`;
    },
  );
  return html.replace(/⟦KX(?:FO|TB|TBBOX)[^⟧]*⟧/g, "");
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
  file = await ensureDecryptedFile(file); // password-protected OOXML → ZIP
  const arrayBuffer = await file.arrayBuffer();
  sniffDocxFormat(arrayBuffer);
  const { buffer, docXml, meta } = await preprocessDocx(arrayBuffer);
  // mammoth's Node build accepts {buffer}; its browser build accepts {arrayBuffer}
  const result = await mammoth.convertToHtml({ arrayBuffer: buffer }).catch(() =>
    mammoth.convertToHtml({ buffer: Buffer.from(buffer) } as never));
  let html = footnoteMarkersToHtml(breakMarkersToHtml(mathMarkersToHtml(result.value)));
  html = runFmtMarkersToHtml(html);
  html = paraFmtMarkersToHtml(html);
  const { idToKey, styles } = buildStyleMaps(meta);
  let degraded = false;
  if (docXml) {
    html = annotateTableHtml(html, extractXmlTables(docXml));
    html = styleMarkersToHtml(html, idToKey);
    html = numMarkersToHtml(html, meta);
    html = commentMarkersToHtml(html);
    html = trackMarkersToHtml(html);
    html = sdtMarkersToHtml(html);
    html = floatMarkersToHtml(html);
    html = firstSectionMarkerToHtml(html);
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
    settings: meta.settings,
  };
}

/** Post-import: register imported named-style defs in the editor so
 *  data-style'd paragraphs render + persist in the styles payload. */
export function applyDocxImport(editor: Editor, res: DocxImportResult): void {
  if (Object.keys(res.styles).length) {
    loadStyleDefs(editor, { ...styleDefsOf(editor), ...res.styles });
  }
  const s = res.settings;
  if (s && Object.values(s).some((v) => v != null)) {
    const next: PageSetup = { ...readPageSetup(editor) };
    if (s.hyphenate != null) next.hyphenate = s.hyphenate;
    if (s.hyphenZone != null) next.hyphenZone = s.hyphenZone;
    if (s.hyphenLimit != null) next.hyphenLimit = s.hyphenLimit;
    if (s.evenOdd != null) next.oddEven = s.evenOdd;
    if (s.page) {
      if (s.page.w) next.width = s.page.w;
      if (s.page.h) next.height = s.page.h;
      if (s.page.mt) next.marginTop = s.page.mt;
      if (s.page.mb) next.marginBottom = s.page.mb;
      if (s.page.ml) next.marginLeft = s.page.ml;
      if (s.page.mr) next.marginRight = s.page.mr;
    }
    if (s.pn?.fmt) next.pnFormat = s.pn.fmt;
    if (s.pn?.start != null) next.pnStart = s.pn.start;
    if (s.hf?.headerLeft) next.headerLeft = s.hf.headerLeft;
    if (s.hf?.footerLeft) next.footerLeft = s.hf.footerLeft;
    applyPageSetup(editor, next);
  }
}

export type { Json };
