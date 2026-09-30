import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { PdfAnn } from "./model";

const PW = 612, PH = 792, M = 54;
const INK = rgb(0.15, 0.13, 0.12);
const MUTED = rgb(0.45, 0.43, 0.41);

/** word-wrap at ~chars per line */
const wrap = (text: string, width = 88): string[] => {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let line = "";
    for (const word of raw.split(/\s+/)) {
      if (line && (line + " " + word).length > width) { out.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
};

/**
 * Acrobat's "Summarize Comments" — a printable PDF listing every annotation
 * with page, type, author, status, contents, and replies.
 */
export async function summarizeComments(anns: PdfAnn[], title: string): Promise<void> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([PW, PH]);
  let y = PH - M;
  const line = (text: string, opts: { size?: number; b?: boolean; dy?: number; muted?: boolean } = {}) => {
    if (y < M + 16) { page = doc.addPage([PW, PH]); y = PH - M; }
    page.drawText(text.replace(/[^\x20-\xFF]/g, "?"), {
      x: M, y, size: opts.size ?? 10, font: opts.b ? bold : helv,
      color: opts.muted ? MUTED : INK,
    });
    y -= opts.dy ?? 14;
  };

  line(`Comment summary — ${title.replace(/\.pdf$/i, "")}`, { size: 15, b: true, dy: 24 });
  line(`${anns.length} annotation${anns.length === 1 ? "" : "s"} · generated ${new Date().toLocaleString()}`, { size: 9, muted: true, dy: 22 });

  const sorted = [...anns].sort((a, b) => a.page - b.page || a.id.localeCompare(b.id));
  for (const a of sorted) {
    if (y < M + 48) { page = doc.addPage([PW, PH]); y = PH - M; }
    const head = [`Page ${a.page}`, a.type, a.author, a.status && a.status !== "none" ? a.status : null]
      .filter(Boolean).join("  ·  ");
    line(head, { b: true, dy: 13 });
    if (a.text) for (const w of wrap(a.text)) line(`   ${w}`, { size: 9.5, dy: 12 });
    for (const r of a.replies ?? [])
      for (const [i, w] of wrap(`↳ ${r.by}: ${r.text}`).entries()) line(`   ${w}`, { size: 9.5, muted: true, dy: i ? 11 : 12 });
    if (!a.text && !a.replies?.length) line("   (markup — no text)", { size: 9.5, muted: true, dy: 12 });
    y -= 7;
  }
  if (!anns.length) line("No comments or annotations in this document.", { muted: true });

  const bytes = await doc.save();
  const url = URL.createObjectURL(new Blob([bytes.buffer.slice(0) as ArrayBuffer], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title.replace(/\.pdf$/i, "")}-comments.pdf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
