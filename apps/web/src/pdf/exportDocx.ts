import type { PDFDocumentProxy } from "pdfjs-dist";

/**
 * PDF-13.1 — extract the document's text and write it out as a .docx.
 * Text items are bucketed into lines by baseline-y and become paragraphs;
 * font height maps to the run size. Positioning/layout fidelity is
 * best-effort — this is a text export, not a visual reconstruction.
 */
export async function exportPdfToDocx(doc: PDFDocumentProxy, fileName: string): Promise<void> {
  const { Document, Packer, Paragraph, TextRun, PageBreak } = await import("docx");
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
    for (const [, items] of [...lines.entries()].sort((a, b) => b[0] - a[0])) {
      items.sort((a, b) => a.x - b.x);
      const text = items.map((i) => i.s).join(" ");
      const h = Math.max(...items.map((i) => i.h));
      children.push(new Paragraph({ children: [new TextRun({ text, size: Math.max(10, Math.round(h * 2)) })] }));
    }
    if (p < doc.numPages) children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  const blob = await Packer.toBlob(new Document({ sections: [{ children }] }));
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName.replace(/\.pdf$/i, "") + ".docx";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
