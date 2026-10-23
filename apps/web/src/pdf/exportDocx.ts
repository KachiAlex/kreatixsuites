import type { PDFDocumentProxy } from "pdfjs-dist";
import { saveFile } from "../lib/saveFile";

/**
 * PDF-13.1 — extract the document's text and write it out as a .docx.
 * Text items are bucketed into lines by baseline-y and become paragraphs;
 * font height maps to the run size. Positioning/layout fidelity is
 * best-effort — this is a text export, not a visual reconstruction.
 *
 * Structure recovery beyond raw text:
 *  - Lines in a noticeably larger font than the page median → bold (headers,
 *    titles) — same heuristic as the XLSX export.
 *  - Lines that start deeper than the page's dominant left margin and begin
 *    with a bullet-ish glyph, or sit at an indent band many lines share,
 *    become real bullet-list paragraphs. PDF renderers often draw the dot as
 *    a vector path (no text item), so indented lines without a glyph get the
 *    "• " prefix to keep the list readable.
 */
export async function exportPdfToDocx(doc: PDFDocumentProxy, fileName: string): Promise<void> {
  const { AlignmentType, Document, LevelFormat, Packer, Paragraph, TextRun, PageBreak } = await import("docx");
  const children: InstanceType<typeof Paragraph>[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const lines = new Map<number, { x: number; s: string; h: number }[]>();
    for (const it of tc.items as { str?: string; transform?: number[] }[]) {
      if (!it.str?.trim() || !it.transform) continue;
      const y = Math.round(it.transform[5]);
      const key = [...lines.keys()].find((k) => Math.abs(k - y) < 2.5) ?? y;
      const arr = lines.get(key) ?? [];
      arr.push({ x: it.transform[4], s: it.str, h: Math.hypot(it.transform[2], it.transform[3]) });
      lines.set(key, arr);
    }
    const ordered = [...lines.entries()].sort((a, b) => b[0] - a[0]);

    // Page font median → header threshold; dominant left margin → indent bands.
    const hs = ordered.flatMap(([, items]) => items.map((i) => i.h)).sort((a, b) => a - b);
    const median = hs[Math.floor(hs.length / 2)] || 0;
    const xFreq = new Map<number, number>();
    for (const [, items] of ordered) {
      const x0 = Math.round(Math.min(...items.map((i) => i.x)) / 5) * 5;
      xFreq.set(x0, (xFreq.get(x0) ?? 0) + 1);
    }
    const margin = [...xFreq.entries()].sort((a, b) => a[0] - b[0])[0]?.[0] ?? 0;
    const indentBands = [...xFreq.entries()].filter(([x, n]) => x > margin + 8 && n >= 2).map(([x]) => x);

    for (const [, items] of ordered) {
      items.sort((a, b) => a.x - b.x);
      const text = items.map((i) => i.s).join(" ").trim();
      if (!text) continue;
      const h = Math.max(...items.map((i) => i.h));
      const x0 = Math.min(...items.map((i) => i.x));
      const bold = median > 0 && h > median * 1.15;
      const hasGlyph = /^\s*[•\u2022\u25CF\u25AA\u00B7\u25E6\u25B8▪▸‣-]/.test(text);
      const indented = indentBands.some((b) => Math.abs(x0 - b) < 6);
      children.push(new Paragraph({
        ...(indented && !hasGlyph ? { numbering: { reference: "kx-pdf-bullets", level: 0 } } : {}),
        children: [new TextRun({ text, bold: bold || undefined, size: Math.max(10, Math.round(h * 2)) })],
      }));
    }
    if (p < doc.numPages) children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  const blob = await Packer.toBlob(new Document({
    numbering: {
      config: [{
        reference: "kx-pdf-bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
      }],
    },
    sections: [{ children }],
  }));
  void saveFile(blob, fileName.replace(/\.pdf$/i, "") + ".docx");
}
